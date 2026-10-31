"""Extração dirigida a esquema por Pai e por Tabela (ARQUITETURA §5 I-5, tarefa F4.2).

Cada Pai (texto corrido) e cada Tabela (Markdown) vira uma chamada ao Qwen3.6 do perfil `indexar`, com
`response_format: json_schema` do contêiner `ExtracaoDirigida` (F4.1): a gramática do `llama-server` impõe o
formato. Mesmo assim a resposta é validada pelo Pydantic, e uma retentativa leva a mensagem de erro anexada
(ou, se a saída foi cortada por tamanho, o pedido de devolver menos fatos).

* **Cache por hash** do pedido, do modelo e das versões do prompt e do schema; gravação atômica. Só entrada
  válida é reaproveitada, então interromper e retomar não repete nenhuma chamada que deu certo.
* **Sem lastro ainda:** os fatos saem como o LLM os devolveu; a rejeição por lastro numérico é a F4.3.
* O texto de origem não é copiado para a saída (fica em `chunks.json` e `tabelas.json`); a saída guarda, por
  unidade, o id do Pai ou da Tabela, as páginas e a resposta.

Uso (a partir de indexer/, com llama-swap no perfil `indexar` no ar):
    uv run python -m indexer.extrair executar ../data/parsed/bb_fre_2026_recorte
    uv run python -m indexer.extrair executar ../data/parsed/bb_fre_2026_recorte --limite 5   # amostra
    uv run python -m indexer.extrair resumo ../data/parsed/bb_fre_2026_recorte               # sem LLM
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import sys
import time
import urllib.request
from collections.abc import Callable
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from typing import Any

from pydantic import ValidationError

from indexer.schemas import MAX_FATOS, ExtracaoDirigida
from indexer.schemas import VERSAO as VERSAO_DO_SCHEMA
from indexer.schemas.extracao import PONTOS_BASE

MODELO_LLM = "qwen36-35b-a3b"
VERSAO_DO_PROMPT = "v3"
MIN_TOKENS_PAI = 30  # Pais menores (títulos, linhas soltas) não têm o que extrair
LIMITE_MARKDOWN = 14000  # caracteres; o mesmo teto da F2.7
MAX_TOKENS_SAIDA = 8000  # 60 fatos ≈ 7 mil tokens; cabe no slot de 16 mil com um pedido de até ~6 mil
DOCUMENTO = "Formulário de Referência 2026 (ano-base 2025) do Banco do Brasil S.A."

SISTEMA = (
    "Você extrai dados estruturados de um Formulário de Referência de uma empresa brasileira. "
    "Responda apenas com o JSON do esquema, sem comentários.\n"
    "Regras:\n"
    "1. Extraia só o que o trecho diz de forma explícita; nunca complete com o que você sabe de memória.\n"
    "2. Em cada lista, devolva [] se o trecho não trouxer nada daquele tipo.\n"
    "3. Fatos financeiros: um objeto por valor numérico que tenha métrica, período e entidade claros. "
    '"value" é o número como escrito, SEM aplicar a escala, e "scale" é a palavra que o acompanha: '
    '"R$ 625 milhões" -> value 625, scale 1000000; "85,2 mil funcionários" -> value 85.2, scale 1000; '
    '"R$ 5,82" -> value 5.82, scale 1; "27,1%" -> value 27.1, unit percent. Negativos entre '
    "parênteses viram negativos. "
    '"metric" fica em português, como no texto. '
    '"evidence" é cópia literal do trecho (até 200 caracteres) que contém o número, com a mesma grafia.\n'
    "4. Períodos: o exercício de referência do documento é 2025, ou seja, 2025-FY; use 2025-12-31 para "
    "saldos em uma data e 2025-Q4 para trimestres. Não extraia números que não sejam fatos financeiros "
    "(páginas, numeração de itens, datas de versão, códigos).\n"
    '5. Sem informação para um campo opcional, omita-o ou use null; não escreva "n/d". O papel "issuer" é só '
    "do Banco do Brasil S.A.; as demais empresas são subsidiária, controlada, coligada ou contraparte.\n"
    "6. No máximo 40 fatos por resposta: priorize totais e o exercício mais recente."
)

PEDIDO_PAI = """Documento: {documento}
Seção: {caminho}
Páginas: {paginas}

Trecho:
{texto}"""

PEDIDO_TABELA = """Documento: {documento}
Seção: {caminho}
Página: {paginas}
Texto que antecede a tabela: {anterior}
Notas da tabela: {notas}
Escala/moeda declarada: {escala}

Tabela (Markdown; células vazias podem ser parte de cabeçalhos mesclados):
{texto}

Use os cabeçalhos da tabela para o período, o segmento e a entidade de cada valor."""

Resposta = dict[str, Any]
Gerador = Callable[[list[dict]], Resposta]


def _paginas(ini: int, fim: int) -> str:
    return str(ini) if ini == fim else f"{ini}-{fim}"


def unidades(chunks: dict, tabelas: list[dict], documento: str = DOCUMENTO) -> list[dict]:
    """Uma unidade por Pai com texto e por Tabela: id, tipo, páginas e o pedido ao LLM."""
    saida = []
    for p in chunks["pais"]:
        if p["tokens"] < MIN_TOKENS_PAI:
            continue
        pedido = PEDIDO_PAI.format(
            documento=documento,
            caminho=" › ".join(p["caminho"]),
            paginas=_paginas(p["pagina_inicio"], p["pagina_fim"]),
            texto=p["texto"],
        )
        saida.append(
            {"id": p["id"], "tipo": "pai", "paginas": [p["pagina_inicio"], p["pagina_fim"]], "pedido": pedido}
        )
    for t in tabelas:
        md = t["markdown"]
        if len(md) > LIMITE_MARKDOWN:
            md = md[:LIMITE_MARKDOWN] + "\n[... tabela cortada ...]"
        pag = t["paginas"]
        escala = "nenhuma declarada"
        if t["escala"] or t["moeda"]:
            escala = f"fator {t['escala'] or 1}, moeda {t['moeda'] or 'n/d'}"
        pedido = PEDIDO_TABELA.format(
            documento=documento,
            caminho=" › ".join(t["caminho"]),
            paginas=_paginas(pag[0], pag[-1]),
            anterior=t["anterior"] or "(nenhum)",
            notas=" | ".join(t["notas"]) or "(nenhuma)",
            escala=escala,
            texto=md,
        )
        saida.append({"id": t["id"], "tipo": "tabela", "paginas": [pag[0], pag[-1]], "pedido": pedido})
    return saida


def esquema_de_resposta() -> dict:
    """O JSON Schema que vai em `response_format` (o mesmo de `contracts/extraction.schema.json`)."""
    return ExtracaoDirigida.model_json_schema()


def gerador_llama(base: str, modelo: str = MODELO_LLM, timeout: int = 900) -> Gerador:
    """Função mensagens -> {conteudo, finish, tokens_prompt, tokens_saida}; o schema vai por gramática."""
    esquema = esquema_de_resposta()

    def gera(mensagens: list[dict]) -> Resposta:
        corpo = {
            "model": modelo,
            "messages": mensagens,
            "temperature": 0.1,
            "max_tokens": MAX_TOKENS_SAIDA,
            "chat_template_kwargs": {"enable_thinking": False},
            "response_format": {
                "type": "json_schema",
                "json_schema": {"name": "extracao", "strict": True, "schema": esquema},
            },
        }
        req = urllib.request.Request(
            f"{base}/v1/chat/completions",
            data=json.dumps(corpo).encode("utf-8"),
            headers={"Content-Type": "application/json; charset=utf-8"},
        )
        with urllib.request.urlopen(req, timeout=timeout) as r:
            dados = json.load(r)
        escolha = dados["choices"][0]
        uso = dados.get("usage", {})
        return {
            "conteudo": escolha["message"]["content"],
            "finish": escolha.get("finish_reason"),
            "tokens_prompt": uso.get("prompt_tokens", 0),
            "tokens_saida": uso.get("completion_tokens", 0),
        }

    return gera


MOEDAS = (("US$", "USD"), ("R$", "BRL"))


def reparar_unidades(conteudo: str) -> tuple[str, int]:
    """Corrige `unit = basis_points` quando a evidência traz R$ ou US$ e não fala de pontos-base.

    O Qwen3.6 rotula assim, de forma sistemática, valores em "R$ bilhões"; a própria evidência desmente o
    rótulo, então o reparo não inventa nada. Devolve o JSON e quantos fatos foram corrigidos (vão para o
    relatório da execução)."""
    try:
        dados = json.loads(conteudo)
        fatos = dados["financial_facts"]
    except (ValueError, KeyError, TypeError):
        return conteudo, 0
    n = 0
    for f in fatos if isinstance(fatos, list) else []:
        ev = f.get("evidence") if isinstance(f, dict) else None
        if not isinstance(ev, str) or f.get("unit") != "basis_points" or PONTOS_BASE.search(ev):
            continue
        for simbolo, codigo in MOEDAS:
            if simbolo in ev:
                f["unit"] = "currency"
                f["currency"] = f.get("currency") or codigo
                n += 1
                break
    return (json.dumps(dados, ensure_ascii=False), n) if n else (conteudo, 0)


def tipo_do_periodo(periodo: str) -> str:
    """`period_type` que o formato canônico do período determina (o LLM o erra: 'quarter' para 2025-FY)."""
    if periodo.endswith("FY"):
        return "fiscal_year"
    return "quarter" if "-Q" in periodo else "point_in_time"


def ajustar_fatos(obj: dict) -> dict[str, int]:
    """Ajustes determinísticos nos fatos (no lugar): `period_type` pelo período e `currency` pelo símbolo
    na evidência. Idempotente; devolve quantos fatos mudaram em cada campo."""
    n = {"period_type": 0, "currency": 0}
    for f in obj["financial_facts"]:
        certo = tipo_do_periodo(f["period"])
        if f["period_type"] != certo:
            f["period_type"] = certo
            n["period_type"] += 1
        if f["unit"] == "currency" and not f["currency"]:
            for simbolo, codigo in MOEDAS:
                if simbolo in f["evidence"]:
                    f["currency"] = codigo
                    n["currency"] += 1
                    break
    return n


def validar(resposta: Resposta) -> tuple[dict | None, str | None, int]:
    """(objeto validado, None, reparos) ou (None, problema, 0). Saída cortada por tamanho é inválida."""
    if resposta.get("finish") == "length":
        return (
            None,
            f"saída cortada por tamanho: devolva no máximo {MAX_FATOS // 2} fatos, só os principais",
            0,
        )
    conteudo, reparos = reparar_unidades(resposta["conteudo"])
    try:
        return ExtracaoDirigida.model_validate_json(conteudo).model_dump(mode="json"), None, reparos
    except ValidationError as e:
        if any(x["type"] == "json_invalid" for x in e.errors()):
            return None, f"JSON inválido: {e.errors()[0]['msg']}", 0
        return None, "; ".join(f"{'.'.join(map(str, x['loc']))}: {x['msg']}" for x in e.errors()[:5]), 0


def extrair(unidade: dict, gera: Gerador, tentativas_max: int = 2) -> dict:
    """Extrai uma unidade; se a resposta for inválida, anexa o erro e pede de novo (no máximo 2 chamadas)."""
    t0 = time.perf_counter()
    mensagens = [{"role": "system", "content": SISTEMA}, {"role": "user", "content": unidade["pedido"]}]
    tokens_prompt = tokens_saida = tentativas = 0
    primeira_valida = False
    obj, erro, reparos = None, None, 0
    while tentativas < tentativas_max:
        r = gera(mensagens)
        tentativas += 1
        tokens_prompt += r.get("tokens_prompt", 0)
        tokens_saida += r.get("tokens_saida", 0)
        obj, erro, reparos = validar(r)
        if tentativas == 1:
            primeira_valida = obj is not None
        if obj is not None:
            break
        mensagens += [
            {"role": "assistant", "content": r.get("conteudo") or ""},
            {"role": "user", "content": f"A resposta é inválida ({erro}). Corrija e responda de novo."},
        ]
    return {
        "valida": obj is not None,
        "resposta": obj,
        "erro": erro,
        "tentativas": tentativas,
        "primeira_valida": primeira_valida,
        "reparos": reparos,
        "tokens_prompt": tokens_prompt,
        "tokens_saida": tokens_saida,
        "segundos": round(time.perf_counter() - t0, 1),
    }


def chave_de_cache(unidade: dict, modelo: str = MODELO_LLM) -> str:
    # o patch do schema (1.1.x) não muda o que o modelo deve devolver; só maior.menor entra na chave
    versao_schema = VERSAO_DO_SCHEMA.rsplit(".", 1)[0]
    base = f"{VERSAO_DO_PROMPT}|{versao_schema}|{modelo}|{unidade['pedido']}"
    return hashlib.sha1(base.encode("utf-8")).hexdigest()[:20]


def _gravar(arq: Path, dados: dict) -> None:
    """Escrita atômica: uma interrupção no meio nunca deixa um arquivo pela metade."""
    tmp = arq.with_suffix(".tmp")
    tmp.write_text(json.dumps(dados, ensure_ascii=False, indent=1), encoding="utf-8")
    os.replace(tmp, arq)


def extrair_todas(
    lista: list[dict], gera: Gerador, cache: Path, paralelismo: int = 2, modelo: str = MODELO_LLM, log=None
) -> list[dict]:
    """Extrai todas as unidades com cache por hash; só entrada válida do cache é reaproveitada."""
    cache.mkdir(parents=True, exist_ok=True)

    def uma(u: dict) -> dict:
        arq = cache / f"{chave_de_cache(u, modelo)}.json"
        if arq.exists():
            guardada = json.loads(arq.read_text(encoding="utf-8"))
            if guardada.get("valida"):
                r = {**guardada, "do_cache": True, "chamadas": 0}  # o cache guarda o que o LLM devolveu
                tag = "cache"
            else:
                r = None
        else:
            r = None
        if r is None:
            r = extrair(u, gera)
            _gravar(arq, r)
            r = {**r, "do_cache": False, "chamadas": r["tentativas"]}
            tag = "ok" if r["valida"] else "INVÁLIDA"
        r["ajustes"] = ajustar_fatos(r["resposta"]) if r["valida"] else {}
        if log:
            log(f"{u['tipo']} {u['id']} p. {u['paginas'][0]}: {tag}")
        return {"id": u["id"], "tipo": u["tipo"], "paginas": u["paginas"], **r}

    with ThreadPoolExecutor(max_workers=paralelismo) as pool:
        return list(pool.map(uma, lista))


TIPOS = ("financial_facts", "organizations", "people", "segments", "risk_factors", "events", "instruments")


def resumir(resultados: list[dict]) -> dict:
    """Contagens da execução: validade, chamadas, itens extraídos por tipo, tokens e tempo."""
    itens = {t: 0 for t in TIPOS}
    for r in resultados:
        if r["valida"]:
            for t in TIPOS:
                itens[t] += len(r["resposta"][t])
    ativas = [r for r in resultados if not r["do_cache"]]
    return {
        "unidades": len(resultados),
        "por_tipo": {t: sum(1 for r in resultados if r["tipo"] == t) for t in ("pai", "tabela")},
        "validas": sum(r["valida"] for r in resultados),
        "validas_na_primeira": sum(r["primeira_valida"] for r in resultados),
        "invalidas": [r["id"] for r in resultados if not r["valida"]],
        "do_cache": sum(r["do_cache"] for r in resultados),
        "chamadas": sum(r["chamadas"] for r in resultados),
        "reparos_de_unidade": sum(r.get("reparos", 0) for r in resultados),
        "ajustes": {
            c: sum(r.get("ajustes", {}).get(c, 0) for r in resultados) for c in ("period_type", "currency")
        },
        "no_teto_de_fatos": sum(
            1 for r in resultados if r["valida"] and len(r["resposta"]["financial_facts"]) >= MAX_FATOS
        ),
        "itens": itens,
        "tokens_prompt": sum(r["tokens_prompt"] for r in ativas),
        "tokens_saida": sum(r["tokens_saida"] for r in ativas),
        "segundos_de_llm": round(sum(r["segundos"] for r in ativas), 1),
    }


def _carregar(prefixo: Path) -> tuple[dict, list[dict]]:
    chunks = json.loads(Path(f"{prefixo}.chunks.json").read_text(encoding="utf-8"))
    tabelas = json.loads(Path(f"{prefixo}.tabelas.json").read_text(encoding="utf-8"))
    return chunks, tabelas


def main() -> None:  # pragma: no cover - orquestração de CLI; as peças acima têm testes
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest="acao", required=True)
    e = sub.add_parser("executar")
    e.add_argument("prefixo", type=Path, help="ex.: ../data/parsed/bb_fre_2026_recorte")
    e.add_argument("--swap", default="http://127.0.0.1:8080")
    e.add_argument("--paralelismo", type=int, default=2)
    e.add_argument("--limite", type=int, default=0, help="só as K primeiras unidades (amostra)")
    r = sub.add_parser("resumo")
    r.add_argument("prefixo", type=Path)
    a = ap.parse_args()

    destino = Path(f"{a.prefixo}.extracao.json")
    if a.acao == "resumo":
        print(
            json.dumps(resumir(json.loads(destino.read_text(encoding="utf-8"))), ensure_ascii=False, indent=1)
        )
        return
    chunks, tabelas = _carregar(a.prefixo)
    lista = unidades(chunks, tabelas)
    if a.limite:
        lista = lista[: a.limite]
    cache = a.prefixo.parent / "extracao_cache"
    resultados = extrair_todas(
        lista,
        gerador_llama(a.swap),
        cache,
        a.paralelismo,
        log=lambda m: print(m, file=sys.stderr, flush=True),
    )
    if not a.limite:
        _gravar(destino, resultados)
    print(json.dumps(resumir(resultados), ensure_ascii=False, indent=1))


if __name__ == "__main__":
    main()
