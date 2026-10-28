"""Tabelas: Markdown, descrição e perguntas hipotéticas (ARQUITETURA §5 I-3 e §6, tarefa F2.7).

A tabela é um nó atômico (ADR-018): o Markdown da grade do Docling, a seção, as páginas, as notas e o texto
que a antecede. O LLM (perfil `indexar`, Qwen3.6, JSON por gramática, sem raciocínio) escreve uma descrição e
3 a 5 perguntas hipotéticas; as perguntas são embutidas em `question_vec` e representam a tabela na busca
(estratégia do cap. 3). Duas fases, porque usam perfis diferentes do llama-swap:

    uv run python -m indexer.tabelas gerar ../data/parsed/X.docling.json ../data/parsed/X.normalizado.json \\
        ../data/parsed/X.secoes.json --doc-id ID          # llama-swap no perfil indexar (Qwen3.6)
    uv run python -m indexer.tabelas carregar ../data/parsed/X.tabelas.json --doc-id ID
        # Neo4j no ar + perfil vetorizar (embeddings em lote)
    uv run python -m indexer.tabelas autoteste            # question_vec: pergunta -> si mesma e -> sua tabela
"""

from __future__ import annotations

import argparse
import hashlib
import json
import re
import urllib.request
from collections.abc import Callable
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from typing import Any

from indexer.chunks import blocos_por_secao
from indexer.numeros import detectar_escala

MODELO_LLM = "qwen36-35b-a3b"
VERSAO_DO_PROMPT = "v2"
MIN_PERGUNTAS, MAX_PERGUNTAS = 3, 5
LIMITE_MARKDOWN = 14000  # caracteres; abaixo do contexto de 16 mil tokens por slot
MODELO_VETORIZAR = "qwen3-embed-0.6b-lote"
MODELO_CPU = "qwen3-embed-0.6b"

# valor com vírgula decimal ou milhar com ponto (anos, datas e números de seção como 7.3 não casam)
VALOR_NA_PERGUNTA = re.compile(r"\d+,\d+|\d{1,3}(?:\.\d{3})+")

ESQUEMA = {
    "type": "object",
    "properties": {
        "descricao": {"type": "string", "minLength": 30},
        "perguntas": {
            "type": "array",
            "items": {"type": "string", "minLength": 15},
            "minItems": MIN_PERGUNTAS,
            "maxItems": MAX_PERGUNTAS,
        },
    },
    "required": ["descricao", "perguntas"],
    "additionalProperties": False,
}

SISTEMA = (
    "Você prepara tabelas de um Formulário de Referência de uma empresa brasileira para um sistema de busca. "
    "Responda apenas com o JSON pedido, em português."
)
PEDIDO = """Documento: {documento}
Seção: {caminho}
Página: {pagina}
Texto que antecede a tabela: {anterior}
Notas da tabela: {notas}
Escala/moeda declarada: {escala}

Tabela (Markdown; células vazias podem ser parte de cabeçalhos mesclados):
{markdown}

Tarefa:
1. "descricao": 2 a 3 frases dizendo o que a tabela mede, a quem se refere, os períodos ou datas e a unidade.
Só afirme a unidade ou a escala (R$, milhões, %) se ela aparecer na tabela, nas notas, no texto anterior ou na
linha "Escala/moeda declarada"; na dúvida, não afirme. Não invente nada e não use a palavra "fator".
2. "perguntas": de 3 a 5 perguntas, em português, que um analista faria e que esta tabela responde. Cada
pergunta deve ser:
- autossuficiente: cite a métrica, o período ou a entidade; nunca escreva "esta tabela" nem "a tabela";
- específica desta tabela: a seção e o texto anterior podem distingui-la de outras parecidas do documento (por
  exemplo o cenário, o segmento, a empresa, o exercício); nesse caso, cite esse qualificador em TODAS as
  perguntas;
- respondível só com o que a tabela mostra (não peça um total que não existe na tabela);
- variada (valor pontual, comparação entre períodos, um componente ou total) e SEM os valores numéricos da
  resposta ou de qualquer célula (anos e datas podem aparecer)."""


def grade_para_markdown(grade: list[list[dict]]) -> str:
    """Markdown da grade do Docling. Célula mesclada só mostra o texto na posição de origem; a(s) linha(s) de
    cabeçalho (`column_header`) vêm antes do separador; sem cabeçalho marcado, a 1ª linha faz esse papel."""
    if not grade:
        return ""

    def celula(r: int, c: int, x: dict) -> str:
        origem = x.get("start_row_offset_idx", r) == r and x.get("start_col_offset_idx", c) == c
        return re.sub(r"\s+", " ", (x.get("text") or "")).replace("|", "\\|").strip() if origem else ""

    linhas = [[celula(r, c, x) for c, x in enumerate(linha)] for r, linha in enumerate(grade)]
    cabecalho = 0
    while cabecalho < len(grade) and any(x.get("column_header") for x in grade[cabecalho]):
        cabecalho += 1
    cabecalho = max(1, cabecalho)
    larg = max(len(linha) for linha in linhas)
    saida = []
    for i, linha in enumerate(linhas):
        saida.append("| " + " | ".join(linha + [""] * (larg - len(linha))) + " |")
        if i == cabecalho - 1:
            saida.append("|" + "---|" * larg)
    return "\n".join(saida)


def _id(*partes: object) -> str:
    return hashlib.sha1("|".join(str(p) for p in partes).encode("utf-8")).hexdigest()[:16]


def preparar_tabelas(docling: dict, elementos: list[dict], arvore: list[dict], doc_id: str) -> list[dict]:
    """Uma entrada por `table` normalizada: Markdown, seção, páginas, notas, texto anterior e escala."""
    _, fora = blocos_por_secao(elementos, arvore)
    contexto = {x["id"]: x for x in fora if x["tipo"] == "table"}
    caminho = {n["id"]: n["caminho"] for n in arvore}
    posicao = {e["id"]: i for i, e in enumerate(elementos)}
    por_ref = {t["self_ref"]: t for t in docling["tables"]}

    tabelas = []
    for ref, info in contexto.items():
        item = por_ref[ref]
        grade = item["data"]["grid"]
        markdown = grade_para_markdown(grade)
        anterior = []
        for e in reversed(elementos[: posicao[ref]]):
            if e["tipo"] in ("text", "list_item", "caption") and e.get("texto"):
                anterior.insert(0, e["texto"].strip())
                if len(anterior) == 2:
                    break
            else:
                break
        cab = " ".join(c["text"] for linha in grade[:2] for c in linha if c.get("text"))
        texto_escala = " ".join([cab, *info["notas"], *anterior])
        escala = detectar_escala(texto_escala)
        tabelas.append(
            {
                "id": _id(doc_id, "tabela", ref),
                "ref": ref,
                "secao_id": f"{doc_id}:{info['secao_id']}",
                "caminho": caminho[info["secao_id"]],
                "paginas": info["paginas"],
                "linhas": item["data"]["num_rows"],
                "colunas": item["data"]["num_cols"],
                "markdown": markdown,
                "notas": info["notas"],
                "anterior": " ".join(anterior)[:600],
                "escala": escala.fator if escala else None,
                "moeda": escala.moeda if escala else None,
            }
        )
    return tabelas


def montar_pedido(t: dict, documento: str) -> str:
    md = t["markdown"]
    if len(md) > LIMITE_MARKDOWN:
        md = md[:LIMITE_MARKDOWN] + "\n[... tabela cortada ...]"
    pag = t["paginas"]
    escala = "nenhuma declarada"
    if t["escala"] or t["moeda"]:
        escala = f"fator {t['escala'] or 1}, moeda {t['moeda'] or 'n/d'}"
    return PEDIDO.format(
        documento=documento,
        caminho=" › ".join(t["caminho"]),
        pagina=pag[0] if len(pag) == 1 else f"{pag[0]}-{pag[-1]}" if pag else "?",
        anterior=t["anterior"] or "(nenhum)",
        notas=" | ".join(t["notas"]) or "(nenhuma)",
        escala=escala,
        markdown=md,
    )


def validar(resposta: Any) -> list[str]:
    """Problemas da resposta do LLM (lista vazia = válida)."""
    if not isinstance(resposta, dict):
        return ["resposta não é um objeto JSON"]
    erros = []
    if len((resposta.get("descricao") or "").strip()) < 30:
        erros.append("descrição ausente ou curta")
    perguntas = resposta.get("perguntas")
    if not isinstance(perguntas, list) or not (MIN_PERGUNTAS <= len(perguntas) <= MAX_PERGUNTAS):
        return [*erros, f"são necessárias {MIN_PERGUNTAS} a {MAX_PERGUNTAS} perguntas"]
    limpas = [p.strip() for p in perguntas if isinstance(p, str)]
    if len(limpas) != len(perguntas):
        erros.append("pergunta que não é texto")
    if len({p.lower() for p in limpas}) != len(limpas):
        erros.append("perguntas repetidas")
    if re.search(r"\bfator\b", resposta.get("descricao") or "", re.IGNORECASE):
        erros.append("a descrição usa a palavra 'fator'")
    for p in limpas:
        if VALOR_NA_PERGUNTA.search(p):
            erros.append(f"pergunta com valor numérico: {p[:40]}")
        if not p.endswith("?"):
            erros.append(f"não termina com '?': {p[:40]}")
        if re.search(r"\b(esta|a|nesta) tabela\b", p, re.IGNORECASE):
            erros.append(f"cita 'a tabela': {p[:40]}")
    return erros


Gerador = Callable[[list[dict]], dict]


def gerador_llama(base: str, modelo: str = MODELO_LLM, timeout: int = 600) -> Gerador:
    """Função mensagens -> objeto JSON, pelo `/v1/chat/completions` com `json_schema` e sem raciocínio."""

    def gera(mensagens: list[dict]) -> dict:
        corpo = {
            "model": modelo,
            "messages": mensagens,
            "temperature": 0.3,
            "max_tokens": 1200,
            "chat_template_kwargs": {"enable_thinking": False},
            "response_format": {
                "type": "json_schema",
                "json_schema": {"name": "tabela", "strict": True, "schema": ESQUEMA},
            },
        }
        req = urllib.request.Request(
            f"{base}/v1/chat/completions",
            data=json.dumps(corpo).encode("utf-8"),
            headers={"Content-Type": "application/json; charset=utf-8"},
        )
        with urllib.request.urlopen(req, timeout=timeout) as r:
            conteudo = json.load(r)["choices"][0]["message"]["content"]
        return json.loads(conteudo)

    return gera


def descrever(t: dict, gera: Gerador, documento: str, tentativas_max: int = 3) -> dict:
    """Descrição e perguntas de uma tabela; se a resposta tiver problemas, anexa os erros e pede de novo
    (até `tentativas_max` respostas no total)."""
    mensagens = [
        {"role": "system", "content": SISTEMA},
        {"role": "user", "content": montar_pedido(t, documento)},
    ]
    resposta = gera(mensagens)
    erros = validar(resposta)
    tentativas = 1
    while erros and tentativas < tentativas_max:
        mensagens += [
            {"role": "assistant", "content": json.dumps(resposta, ensure_ascii=False)},
            {"role": "user", "content": "Corrija estes problemas e responda de novo: " + "; ".join(erros)},
        ]
        resposta = gera(mensagens)
        erros = validar(resposta)
        tentativas += 1
    return {
        "descricao": (resposta.get("descricao") or "").strip() if isinstance(resposta, dict) else "",
        "perguntas": [p.strip() for p in (resposta.get("perguntas") or [])]
        if isinstance(resposta, dict)
        else [],
        "valida": not erros,
        "erros": erros,
        "tentativas": tentativas,
    }


def gerar_todas(
    tabelas: list[dict], gera: Gerador, documento: str, cache: Path, paralelismo: int = 2
) -> list[dict]:
    """Descreve todas as tabelas com cache por hash (pedido + versão do prompt): retomável."""
    cache.mkdir(parents=True, exist_ok=True)

    def uma(t: dict) -> dict:
        chave = hashlib.sha1((VERSAO_DO_PROMPT + montar_pedido(t, documento)).encode("utf-8")).hexdigest()[
            :20
        ]
        arq = cache / f"{chave}.json"
        if arq.exists():
            guardada = json.loads(arq.read_text(encoding="utf-8"))
            if guardada.get("valida"):  # entrada inválida não é reaproveitada: tenta de novo
                return {**t, **guardada, "do_cache": True}
        r = descrever(t, gera, documento)
        arq.write_text(json.dumps(r, ensure_ascii=False, indent=1), encoding="utf-8")
        return {**t, **r, "do_cache": False}

    with ThreadPoolExecutor(max_workers=paralelismo) as pool:
        return list(pool.map(uma, tabelas))


def linhas_para_o_grafo(tabelas: list[dict], documento_id: str) -> dict[str, list[dict]]:
    """Linhas dos UNWIND: nós Table e HypotheticalQuestion e as relações HAS_TABLE e HAS_QUESTION."""
    nos_t, nos_q, tem_t, tem_q = [], [], [], []
    for t in tabelas:
        pag = t["paginas"]
        nos_t.append(
            {
                "id": t["id"],
                "ref": t["ref"],
                "markdown": t["markdown"],
                "description": t["descricao"],
                "page": pag[0],
                "pageStart": pag[0],
                "pageEnd": pag[-1],
                "rows": t["linhas"],
                "cols": t["colunas"],
                "scale": t["escala"],
                "currency": t["moeda"],
                "notes": t["notas"],
            }
        )
        tem_t.append({"de": t["secao_id"], "para": t["id"]})
        for n, texto in enumerate(t["perguntas"], start=1):
            qid = _id(t["id"], "pergunta", n, texto)
            nos_q.append({"id": qid, "text": texto, "ordinal": n})
            tem_q.append({"de": t["id"], "para": qid})
    return {"tabelas": nos_t, "perguntas": nos_q, "tem_tabela": tem_t, "tem_pergunta": tem_q}


def main() -> None:  # pragma: no cover - orquestração de CLI; as peças acima têm testes
    from indexer.tabelas_grafo import autoteste_perguntas, carregar_no_grafo

    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest="acao", required=True)
    g = sub.add_parser("gerar")
    g.add_argument("docling", type=Path)
    g.add_argument("normalizado", type=Path)
    g.add_argument("secoes", type=Path)
    g.add_argument("--doc-id", required=True)
    g.add_argument(
        "--documento", default="Formulário de Referência 2026 (ano-base 2025) do Banco do Brasil S.A."
    )
    g.add_argument("--swap", default="http://127.0.0.1:8080")
    g.add_argument("--paralelismo", type=int, default=2)
    c = sub.add_parser("carregar")
    c.add_argument("tabelas", type=Path)
    c.add_argument("--doc-id", required=True)
    t = sub.add_parser("autoteste")
    for p in (c, t):
        p.add_argument("--swap", default="http://127.0.0.1:8080")
        p.add_argument("--raiz", type=Path, default=Path(".."))
        p.add_argument("--banco", default="neo4j")
    a = ap.parse_args()

    if a.acao == "gerar":
        docling = json.loads(a.docling.read_text(encoding="utf-8"))
        elementos = json.loads(a.normalizado.read_text(encoding="utf-8"))["elementos"]
        arvore = json.loads(a.secoes.read_text(encoding="utf-8"))["arvore"]
        tabelas = preparar_tabelas(docling, elementos, arvore, a.doc_id)
        nome = a.normalizado.name.removesuffix(".normalizado.json")
        saida = gerar_todas(
            tabelas, gerador_llama(a.swap), a.documento, a.normalizado.parent / "tabelas_cache", a.paralelismo
        )
        destino = a.normalizado.parent / f"{nome}.tabelas.json"
        destino.write_text(json.dumps(saida, ensure_ascii=False, indent=1), encoding="utf-8")
        resumo = {
            "tabelas": len(saida),
            "validas": sum(x["valida"] for x in saida),
            "com_retentativa": sum(x["tentativas"] > 1 for x in saida),
            "do_cache": sum(x["do_cache"] for x in saida),
            "perguntas": sum(len(x["perguntas"]) for x in saida),
        }
        print(json.dumps(resumo, ensure_ascii=False))
    elif a.acao == "carregar":
        tabelas = json.loads(a.tabelas.read_text(encoding="utf-8"))
        print(
            json.dumps(
                carregar_no_grafo(tabelas, a.doc_id, a.swap, a.raiz, a.banco), ensure_ascii=False, indent=2
            )
        )
    else:
        print(json.dumps(autoteste_perguntas(a.swap, a.raiz, a.banco), ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
