"""Harness de avaliação com juiz local (ARQUITETURA §13.2, tarefa F3.2).

Três métricas do cap. 8, julgadas pelo Gemma 4 26B-A4B (perfil `avaliar`, raciocínio ligado, temperatura 0,
saída em JSON por gramática):

* **recall de contexto**: o gabarito é decomposto em afirmações atômicas e cada uma é checada contra o
  contexto recuperado; recall = afirmações sustentadas / afirmações do gabarito (não vale para recusas);
* **fidelidade**: a RESPOSTA é decomposta em afirmações e cada uma é checada contra o contexto; fidelidade =
  sustentadas / afirmações (uma recusa não afirma nada e vale 1,0, marcada como `sem_afirmacoes`);
* **correção**: a resposta contra o gabarito, `correta` = 1, `parcial` = 0,5, `incorreta` = 0.

Duas fases no mesmo comando, porque usam modelos diferentes do llama-swap (que troca de perfil sozinho):
`gerar` roda o sistema avaliado (pipeline do `ask`, degrau A3) em cada pergunta e `julgar` aplica o juiz. As
respostas e as justificativas (que citam o documento) ficam em `data/avaliacao/<nome>/`, fora do git; só as
notas vão para `eval/resultados/<nome>.json`. Cada nota do juiz é gravada ao terminar, então uma execução
interrompida continua de onde parou, e uma chamada que falha duas vezes é registrada e não derruba a rodada.

As métricas mecânicas (page recall@k, acerto numérico, latência; F3.3) vêm de `indexer.metricas` e entram no
mesmo relatório `eval/resultados/<nome>.json`; `relatorio` o refaz sem LLM a partir de `data/avaliacao/`.

Uso (a partir de indexer/, com llama-swap e Neo4j no ar):
    uv run python -m indexer.avaliar executar --nome v0-a3-fumaca [--so-recorte] [--limite 5]
    uv run python -m indexer.avaliar relatorio --nome v0-a3-fumaca
"""

from __future__ import annotations

import argparse
import json
import statistics
import time
import urllib.request
from collections import defaultdict
from collections.abc import Callable
from pathlib import Path
from typing import Any

from indexer.degraus import DEGRAUS

MODELO_JUIZ = "gemma4-26b-a4b-juiz"
PONTUACAO = {"correta": 1.0, "parcial": 0.5, "incorreta": 0.0}
METRICAS = ("recall_contexto", "fidelidade", "correcao")

ESQ_AFIRMACOES = {
    "type": "object",
    "properties": {
        "afirmacoes": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {"afirmacao": {"type": "string"}, "sustentada": {"type": "boolean"}},
                "required": ["afirmacao", "sustentada"],
                "additionalProperties": False,
            },
        },
        "justificativa": {"type": "string"},
    },
    "required": ["afirmacoes", "justificativa"],
    "additionalProperties": False,
}
ESQ_CORRECAO = {
    "type": "object",
    "properties": {
        "veredito": {"type": "string", "enum": list(PONTUACAO)},
        "justificativa": {"type": "string"},
    },
    "required": ["veredito", "justificativa"],
    "additionalProperties": False,
}

SISTEMA_JUIZ = (
    "Você é um avaliador rigoroso e imparcial de sistemas de perguntas e respostas sobre um Formulário de "
    "Referência de uma companhia brasileira. Use apenas as informações fornecidas; não use conhecimento "
    "externo. Diferenças de formatação numérica (159.254 e 159254) são aceitáveis; valores, sinais, "
    "unidades ou escalas diferentes, não. Responda somente com o JSON pedido."
)
PROMPT_RECALL = """Pergunta: {pergunta}

Gabarito (resposta de referência): {gabarito}
{pontos}
Contexto recuperado:
{contexto}

Tarefa: decomponha o GABARITO em afirmações atômicas (fatos curtos e independentes; se houver \
pontos-chave, use-os como base) e diga, para cada uma, se ela pode ser confirmada SOMENTE com o contexto \
recuperado acima. Em "afirmacoes", "sustentada" = true quando o contexto contém a informação."""
PROMPT_FIDELIDADE = """Pergunta: {pergunta}

Contexto recuperado:
{contexto}

Resposta a avaliar: {resposta}

Tarefa: decomponha a RESPOSTA em afirmações atômicas e diga, para cada uma, se é sustentada pelo \
contexto recuperado acima. Ignore as citações de página ([p. N]) e frases de recusa como "Não encontrei \
essa informação": elas não são afirmações. Se a resposta não afirma nada, devolva "afirmacoes" vazio."""
PROMPT_CORRECAO = """Pergunta: {pergunta}

Gabarito (resposta de referência): {gabarito}
{valor}
Resposta a avaliar: {resposta}

Tarefa: compare a resposta com o gabarito e dê o veredito:
- "correta": contém todos os fatos do gabarito, sem contradição (informação extra coerente é aceitável);
- "parcial": contém parte dos fatos do gabarito, ou está incompleta, sem contradição;
- "incorreta": contradiz o gabarito, erra valor ou unidade, ou não responde.
{recusa}"""
TEXTO_RECUSA = (
    "Esta é uma pergunta SEM resposta no documento (ou uma saudação): o gabarito descreve o comportamento "
    'esperado. A resposta é "correta" se declina responder ou diz que a informação não consta (ou, numa '
    'saudação, cumprimenta), e "incorreta" se inventa conteúdo.'
)

Juiz = Callable[[list[dict], dict, int], dict]
Sistema = Callable[[dict], dict]


def juiz_llama(base: str, modelo: str = MODELO_JUIZ, timeout: int = 900) -> Juiz:
    """Função (mensagens, esquema, max_tokens) -> JSON; temperatura 0 e raciocínio ligado."""

    def julga(mensagens: list[dict], esquema: dict, max_tokens: int = 4000) -> dict:
        corpo = {
            "model": modelo,
            "messages": mensagens,
            "temperature": 0,
            "max_tokens": max_tokens,
            "chat_template_kwargs": {"enable_thinking": True},
            "response_format": {
                "type": "json_schema",
                "json_schema": {"name": "juizo", "strict": True, "schema": esquema},
            },
        }
        req = urllib.request.Request(
            f"{base}/v1/chat/completions",
            data=json.dumps(corpo).encode("utf-8"),
            headers={"Content-Type": "application/json; charset=utf-8"},
        )
        t0 = time.perf_counter()
        with urllib.request.urlopen(req, timeout=timeout) as r:
            resposta = json.load(r)
        saida = json.loads(resposta["choices"][0]["message"]["content"])
        uso = resposta.get("usage", {})
        saida["__uso__"] = {
            "prompt_tokens": uso.get("prompt_tokens"),
            "completion_tokens": uso.get("completion_tokens"),
            "segundos": round(time.perf_counter() - t0, 1),
        }
        return saida

    return julga


def texto_do_contexto(contexto: list[dict]) -> str:
    return "\n\n".join(f"[{c['paginas']}] {c['caminho']}\n{c['texto']}" for c in contexto) or "(vazio)"


def _fracao(afirmacoes: list[dict]) -> float | None:
    return sum(1 for a in afirmacoes if a["sustentada"]) / len(afirmacoes) if afirmacoes else None


def recall_de_contexto(juiz: Juiz, caso: dict, resposta: dict) -> dict:
    """Fração do gabarito que o contexto recuperado sustenta (None nas perguntas de recusa)."""
    if caso["tipo_gabarito"] == "recusa":
        return {"nota": None, "motivo": "recusa: não se aplica"}
    pontos = f"Pontos-chave: {caso['pontos_chave'].replace('|', '; ')}\n" if caso["pontos_chave"] else ""
    prompt = PROMPT_RECALL.format(
        pergunta=caso["pergunta"], gabarito=caso["gabarito"], pontos=pontos,
        contexto=texto_do_contexto(resposta["contexto"]),
    )  # fmt: skip
    r = juiz(
        [{"role": "system", "content": SISTEMA_JUIZ}, {"role": "user", "content": prompt}],
        ESQ_AFIRMACOES,
        4000,
    )
    return {
        "nota": _fracao(r["afirmacoes"]),
        "afirmacoes": r["afirmacoes"],
        "justificativa": r["justificativa"],
        "uso": r.get("__uso__"),
    }


def fidelidade(juiz: Juiz, caso: dict, resposta: dict) -> dict:
    """Fração das afirmações da resposta que o contexto sustenta (1,0 se a resposta não afirma nada)."""
    prompt = PROMPT_FIDELIDADE.format(
        pergunta=caso["pergunta"],
        resposta=resposta["resposta"],
        contexto=texto_do_contexto(resposta["contexto"]),
    )
    r = juiz(
        [{"role": "system", "content": SISTEMA_JUIZ}, {"role": "user", "content": prompt}],
        ESQ_AFIRMACOES,
        4000,
    )
    nota = _fracao(r["afirmacoes"])
    return {
        "nota": 1.0 if nota is None else nota,
        "sem_afirmacoes": nota is None,
        "afirmacoes": r["afirmacoes"],
        "justificativa": r["justificativa"],
        "uso": r.get("__uso__"),
    }


def correcao(juiz: Juiz, caso: dict, resposta: dict) -> dict:
    valor = (
        f"Valor esperado: {caso['valor']} ({caso['unidade']})\n" if caso["tipo_gabarito"] == "valor" else ""
    )
    prompt = PROMPT_CORRECAO.format(
        pergunta=caso["pergunta"], gabarito=caso["gabarito"], valor=valor, resposta=resposta["resposta"],
        recusa=TEXTO_RECUSA if caso["tipo_gabarito"] == "recusa" else "",
    )  # fmt: skip
    r = juiz(
        [{"role": "system", "content": SISTEMA_JUIZ}, {"role": "user", "content": prompt}], ESQ_CORRECAO, 3000
    )
    return {
        "nota": PONTUACAO[r["veredito"]],
        "veredito": r["veredito"],
        "justificativa": r["justificativa"],
        "uso": r.get("__uso__"),
    }


FUNCOES = {"recall_contexto": recall_de_contexto, "fidelidade": fidelidade, "correcao": correcao}


def gerar(casos: list[dict], sistema: Sistema, saida: Path) -> list[dict]:
    """Roda o sistema em cada pergunta e grava `respostas.jsonl` (retomável: pula ids já gravados)."""
    saida.mkdir(parents=True, exist_ok=True)
    arq = saida / "respostas.jsonl"
    feitas = (
        {json.loads(x)["id"]: json.loads(x) for x in arq.read_text(encoding="utf-8").splitlines()}
        if arq.exists()
        else {}
    )
    resultado = []
    with arq.open("a", encoding="utf-8") as f:
        for c in casos:
            if c["id"] in feitas:
                resultado.append(feitas[c["id"]])
                continue
            t0 = time.perf_counter()
            try:
                r = sistema(c)
                linha = {
                    "id": c["id"],
                    "pergunta": c["pergunta"],
                    "resposta": r["resposta"],
                    "contexto": r.get("contexto", []),
                    "citacoes": [x["texto"] for x in r.get("citacoes", [])],
                    "citacoes_invalidas": r.get("citacoes_invalidas", 0),
                    "erro": None,
                }
            except Exception as e:  # uma pergunta que falha não derruba a rodada
                linha = {
                    "id": c["id"],
                    "pergunta": c["pergunta"],
                    "resposta": "",
                    "contexto": [],
                    "citacoes": [],
                    "citacoes_invalidas": 0,
                    "erro": f"{type(e).__name__}: {e}"[:300],
                }
            linha["segundos"] = round(time.perf_counter() - t0, 1)
            f.write(json.dumps(linha, ensure_ascii=False) + "\n")
            f.flush()
            resultado.append(linha)
    return resultado


def julgar(
    casos: list[dict], respostas: list[dict], juiz: Juiz, saida: Path, metricas: tuple[str, ...] = METRICAS
) -> list[dict]:
    """Aplica as métricas pedidas (padrão: as três), gravando cada nota em `juizo.jsonl`; retomável."""
    saida.mkdir(parents=True, exist_ok=True)
    arq = saida / "juizo.jsonl"
    prontos: dict[tuple[str, str], dict] = {}
    if arq.exists():
        for x in arq.read_text(encoding="utf-8").splitlines():
            j = json.loads(x)
            prontos[(j["id"], j["metrica"])] = j
    por_id = {r["id"]: r for r in respostas}
    with arq.open("a", encoding="utf-8") as f:
        for c in casos:
            r = por_id[c["id"]]
            for metrica in metricas:
                if (c["id"], metrica) in prontos:
                    continue
                if r["erro"]:
                    j = {"id": c["id"], "metrica": metrica, "nota": 0.0 if metrica == "correcao" else None,
                         "falha_do_juiz": False, "motivo": "o sistema falhou nesta pergunta"}  # fmt: skip
                else:
                    j = _chamar(FUNCOES[metrica], juiz, c, r)
                    j.update(id=c["id"], metrica=metrica)
                f.write(json.dumps(j, ensure_ascii=False) + "\n")
                f.flush()
                prontos[(c["id"], metrica)] = j
    return list(prontos.values())


def _chamar(funcao, juiz: Juiz, caso: dict, resposta: dict) -> dict:
    """Uma retentativa; se falhar de novo, devolve nota ausente e marca a falha do juiz."""
    erro = ""
    for _ in range(2):
        try:
            return {**funcao(juiz, caso, resposta), "falha_do_juiz": False}
        except Exception as e:
            erro = f"{type(e).__name__}: {e}"[:300]
    return {"nota": None, "falha_do_juiz": True, "motivo": erro}


def agregar(casos: list[dict], notas: list[dict]) -> dict:
    """Média de cada métrica no conjunto, por categoria e só nas perguntas dentro do recorte."""
    cat = {c["id"]: c["categoria"] for c in casos}
    rec = {c["id"]: c["no_recorte"] for c in casos}
    por = defaultdict(lambda: defaultdict(list))
    for j in notas:
        if j["nota"] is not None:
            por[j["metrica"]][j["id"]].append(j["nota"])

    def media(metrica: str, filtro) -> dict:
        v = [n for i, ns in por[metrica].items() if filtro(i) for n in ns]
        return {"n": len(v), "media": round(statistics.mean(v), 4) if v else None}

    return {
        "perguntas": len(casos),
        "falhas_do_juiz": sum(1 for j in notas if j["falha_do_juiz"]),
        "sem_afirmacoes_na_fidelidade": sum(1 for j in notas if j.get("sem_afirmacoes")),
        "geral": {m: media(m, lambda i: True) for m in METRICAS},
        "so_no_recorte": {m: media(m, lambda i: rec[i] == "sim") for m in METRICAS},
        "por_categoria": {
            k: {m: media(m, lambda i, k=k: cat[i] == k) for m in METRICAS} for k in sorted(set(cat.values()))
        },
    }


def montar_relatorio(
    nome: str, casos: list[dict], respostas: list[dict], notas: list[dict], degrau: str | None = None
) -> dict:
    """O relatório único da execução: métricas do juiz (F3.2) e métricas mecânicas (F3.3) lado a lado."""
    from indexer.metricas import calcular, concordancia_numerica_com_o_juiz

    resumo = agregar(casos, notas)
    resumo["nome"] = nome
    resumo["degrau"] = degrau
    resumo["erros_do_sistema"] = sum(1 for r in respostas if r["erro"])
    mec = calcular(casos, respostas)
    resumo.update(mecanicas=mec["mecanicas"])
    resumo["numerico_regra_x_juiz"] = concordancia_numerica_com_o_juiz(
        casos, mec["por_pergunta_mecanicas"], notas
    )
    notas_por_id = {
        c["id"]: {j["metrica"]: j["nota"] for j in notas if j["id"] == c["id"]} for c in casos
    }  # fmt: skip
    resumo["por_pergunta"] = {
        i: {**notas_por_id[i], **mec["por_pergunta_mecanicas"][i]} for i in notas_por_id
    }
    return resumo


def ler_golden(caminho: Path) -> list[dict]:
    import csv

    with caminho.open(encoding="utf-8", newline="") as f:
        return list(csv.DictReader(f))


def sistema_ask(driver: Any, embute, notas, chat, **opcoes) -> Sistema:
    """O sistema avaliado nesta etapa: o pipeline do `ask` (degrau A3, sem reescrita por padrão)."""
    from indexer.ask import responder

    return lambda caso: responder(driver, caso["pergunta"], embute, notas, chat, **opcoes)


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("acao", choices=["executar", "relatorio"], help="relatorio: refaz o relatório sem LLM")
    ap.add_argument("--nome", required=True)
    ap.add_argument("--golden", type=Path, default=Path("../eval/golden.csv"))
    ap.add_argument("--so-recorte", action="store_true", help="só as perguntas com no_recorte = sim")
    ap.add_argument("--limite", type=int, help="só as N primeiras (teste rápido)")
    ap.add_argument("--modo", default="hibrido-rrf")
    ap.add_argument("--degrau", choices=DEGRAUS, default="a3", help="degrau da escada de ablações (F3.5)")
    ap.add_argument("--metricas", nargs="+", choices=METRICAS, help="padrão: as três (no a0, só a correção)")
    ap.add_argument("--swap", default="http://127.0.0.1:8080")
    ap.add_argument("--raiz", type=Path, default=Path(".."))
    ap.add_argument("--banco", default="neo4j")
    a = ap.parse_args()

    casos = ler_golden(a.golden)
    if a.so_recorte:
        casos = [c for c in casos if c["no_recorte"] == "sim"]
    if a.limite:
        casos = casos[: a.limite]
    pasta = a.raiz / "data" / "avaliacao" / a.nome

    if a.acao == "relatorio":
        respostas = [
            json.loads(x) for x in (pasta / "respostas.jsonl").read_text(encoding="utf-8").splitlines()
        ]
        notas = [json.loads(x) for x in (pasta / "juizo.jsonl").read_text(encoding="utf-8").splitlines()]
        casos = [c for c in casos if c["id"] in {r["id"] for r in respostas}]
    else:
        from indexer.ask import chat_llama
        from indexer.degraus import sistema_a0, sistema_a3, sistema_filhos
        from indexer.embeddings import MODELO_CONSULTA, embutidor_llama
        from indexer.grafo import conectar
        from indexer.reranker import reranqueador_llama

        driver = conectar(a.raiz)
        try:
            embute = embutidor_llama(a.swap, MODELO_CONSULTA)
            chat = chat_llama(a.swap)
            if a.degrau == "a0":
                sistema = sistema_a0(chat)
            elif a.degrau in ("a1", "a2"):
                modo = "vetor" if a.degrau == "a1" else "hibrido-rrf"
                sistema = sistema_filhos(driver, embute, chat, modo, banco=a.banco)
            else:
                sistema = sistema_a3(
                    driver, embute, reranqueador_llama(a.swap), chat, a.swap, a.degrau == "a3r", a.banco
                )
            if not (pasta / "respostas.jsonl").exists():
                sistema(casos[0])  # aquece os modelos do llama-swap: a latência não inclui a carga fria
            respostas = gerar(casos, sistema, pasta)
        finally:
            driver.close()
        metricas = tuple(a.metricas or (("correcao",) if a.degrau == "a0" else METRICAS))
        notas = julgar(casos, respostas, juiz_llama(a.swap), pasta, metricas)
    resumo = montar_relatorio(a.nome, casos, respostas, notas, a.degrau)
    destino = a.raiz / "eval" / "resultados" / f"{a.nome}.json"
    destino.parent.mkdir(parents=True, exist_ok=True)
    destino.write_text(json.dumps(resumo, ensure_ascii=False, indent=1), encoding="utf-8")
    print(json.dumps({k: v for k, v in resumo.items() if k != "por_pergunta"}, ensure_ascii=False, indent=1))


if __name__ == "__main__":
    main()
