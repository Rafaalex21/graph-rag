"""Reranking dos Pais com o Qwen3-Reranker-0.6B (ARQUITETURA §7 e cap. 3, tarefa F2.6).

O retriever (`indexer.recuperador`) devolve até 24 Pais; o reranker (`/v1/rerank` do llama-swap, modelo
`qwen3-rerank-0.6b`, na GPU) lê cada par (pergunta, Pai) e dá uma nota; os 6 melhores seguem para o LLM.
O reranker roda com `-c 4096` (ADR-011) e o custo é proporcional aos tokens enviados (medido: 24 Pais de
~1.600 tokens, ~7.400 caracteres, passam de 2 s). Por isso o texto do Pai é cortado em `LIMITE_DE_CARACTERES`
antes do envio, o que limita o pior caso; o corte vale só para a nota, o LLM recebe o Pai inteiro, e a
contagem de cortes vai no resultado.

Uso (a partir de indexer/, com llama-swap e Neo4j no ar):
    uv run python -m indexer.reranker buscar "pergunta" --modo hibrido-rrf --k 24 --top 6
    uv run python -m indexer.reranker medir                # tempo (24 Pais reais e os 24 maiores) e sonda
"""

from __future__ import annotations

import argparse
import json
import statistics
import time
import urllib.request
from collections.abc import Callable
from pathlib import Path
from typing import Any

from indexer.busca import ALFA_PADRAO, MODOS
from indexer.embeddings import MODELO_CONSULTA, embutidor_llama, trecho_do_meio
from indexer.grafo import conectar
from indexer.recuperador import recuperar
from indexer.reescrita import MODELO_LLM, llm_llama, reescrever

MODELO_RERANK = "qwen3-rerank-0.6b"
CANDIDATOS = 24  # Pais enviados ao reranker (§5.1)
TOP_PADRAO = 6  # Pais enviados ao LLM (§5.1)
LIMITE_MS = 2000
LIMITE_DE_CARACTERES = (
    6000  # ~1.500 tokens do reranker; só Pais acima de ~1.300 tokens do Qwen3.6 são cortados
)

Reranqueador = Callable[[str, list[str]], list[float]]


def reranqueador_llama(base: str, modelo: str = MODELO_RERANK, timeout: int = 120) -> Reranqueador:
    """Função (pergunta, textos) -> nota por texto, na ordem de entrada, pelo `/v1/rerank` do llama-swap."""

    def notas(pergunta: str, textos: list[str]) -> list[float]:
        req = urllib.request.Request(
            f"{base}/v1/rerank",
            data=json.dumps({"model": modelo, "query": pergunta, "documents": textos}).encode("utf-8"),
            headers={"Content-Type": "application/json; charset=utf-8"},
        )
        with urllib.request.urlopen(req, timeout=timeout) as r:
            resultados = json.load(r)["results"]
        saida = [0.0] * len(textos)
        vistos = set()
        for x in resultados:
            saida[x["index"]] = float(x["relevance_score"])
            vistos.add(x["index"])
        if len(vistos) != len(textos):
            raise ValueError(f"{len(textos)} textos, {len(vistos)} notas")
        return saida

    return notas


def texto_do_pai(pai: dict, limite: int = LIMITE_DE_CARACTERES) -> tuple[str, bool]:
    """Texto enviado ao reranker: caminho da seção + corpo, cortado em `limite` caracteres."""
    texto = f"{pai['caminho']}\n{pai['text']}"
    return (texto[:limite], len(texto) > limite)


def reranquear_pais(pergunta: str, pais: list[dict], notas: Reranqueador, top: int = TOP_PADRAO) -> dict:
    """Reordena `pais` pela nota do reranker e devolve os `top` melhores, com posição de entrada e tempo."""
    if not pais:
        return {"pais": [], "cortados": 0, "ms": 0.0}
    enviados = [texto_do_pai(p) for p in pais]
    t0 = time.perf_counter()
    pontos = notas(pergunta, [t for t, _ in enviados])
    ms = (time.perf_counter() - t0) * 1000
    ordem = sorted(range(len(pais)), key=lambda i: (-pontos[i], i))  # empate: mantém a ordem da recuperação
    return {
        "pais": [
            {**pais[i], "nota_rerank": round(pontos[i], 6), "posicao_antes": i + 1} for i in ordem[:top]
        ],
        "cortados": sum(1 for _, c in enviados if c),
        "ms": round(ms, 1),
    }


def recuperar_e_reranquear(
    driver: Any,
    pergunta: str,
    embute_consulta,
    notas: Reranqueador,
    modo: str = "hibrido-rrf",
    candidatos: int = CANDIDATOS,
    top: int = TOP_PADRAO,
    alfa: float = ALFA_PADRAO,
    banco: str = "neo4j",
    stepback: str | None = None,
    hyde: str | None = None,
) -> dict:
    """Degrau 3: k×4 Filhos (com reescritas opcionais) -> até `candidatos` Pais -> rerank -> `top` Pais.
    O reranker sempre lê a pergunta ORIGINAL; step-back e HyDE só ampliam a recuperação."""
    r = recuperar(
        driver, pergunta, embute_consulta, candidatos, modo, alfa, banco=banco, stepback=stepback, hyde=hyde
    )
    rr = reranquear_pais(pergunta, r["pais"], notas, top)
    return {
        "pais": rr["pais"],
        "candidatos": len(r["pais"]),
        "cortados": rr["cortados"],
        "latencia_ms": {
            **r["latencia_ms"],
            "rerank": rr["ms"],
            "total": round(r["latencia_ms"]["total"] + rr["ms"], 1),
        },
    }


def medir(driver: Any, embute, notas: Reranqueador, perguntas: list[str], banco: str = "neo4j") -> dict:
    """Tempo do rerank com 24 Pais REAIS (de cada pergunta) e com os 24 MAIORES Pais do banco (pior caso)."""
    registros, _, _ = driver.execute_query(
        "MATCH (s:Section)-[:HAS_PARENT]->(p:Parent) RETURN p.id AS id, p.text AS text, p.tokens AS tokens, "
        "s.path AS caminho ORDER BY p.tokens DESC LIMIT $n",
        {"n": CANDIDATOS},
        database_=banco,
    )
    maiores = [
        {"id": r["id"], "text": r["text"], "tokens": r["tokens"], "caminho": r["caminho"]} for r in registros
    ]
    pergunta0 = perguntas[0]
    reranquear_pais(pergunta0, maiores[:4], notas)  # aquece o modelo
    reais, tokens_reais, cortes = [], [], 0
    for q in perguntas:
        r = recuperar(driver, q, embute, CANDIDATOS, "hibrido-rrf", banco=banco)
        rr = reranquear_pais(q, r["pais"], notas, TOP_PADRAO)
        reais.append(rr["ms"])
        tokens_reais.append(sum(p["tokens"] for p in r["pais"]))
        cortes += rr["cortados"]
    pior = [reranquear_pais(pergunta0, maiores, notas)["ms"] for _ in range(5)]
    base = (maiores[0]["text"] + " ") * (LIMITE_DE_CARACTERES // max(1, len(maiores[0]["text"])) + 2)
    teto = [{"id": f"s{i}", "text": base, "tokens": 0, "caminho": ""} for i in range(CANDIDATOS)]
    garantido = [reranquear_pais(pergunta0, teto, notas)["ms"] for _ in range(5)]
    return {
        "perguntas": len(perguntas),
        "pais_reais_24": {
            "ms_p50": round(statistics.median(reais), 1),
            "ms_max": round(max(reais), 1),
            "tokens_medios_enviados": round(statistics.mean(tokens_reais)),
            "pais_cortados": cortes,
        },
        "24_maiores_pais": {
            "tokens": sum(p["tokens"] for p in maiores),
            "ms": pior,
            "ms_max": max(pior),
            "cortados": sum(1 for p in maiores if texto_do_pai(p)[1]),
        },
        "teto_sintetico_24_x_limite_de_caracteres": {"ms": garantido, "ms_max": max(garantido)},
        "limite_ms": LIMITE_MS,
        "dentro_do_limite": max(reais + pior + garantido) <= LIMITE_MS,
    }


def sonda(driver: Any, embute, notas: Reranqueador, banco: str = "neo4j") -> dict:
    """Informativa: pergunta = trecho do meio de um Filho de cada Pai; o Pai de origem deve ficar em 1º.
    Compara a posição 1 antes (híbrido-RRF) e depois do rerank, entre 24 candidatos."""
    registros, _, _ = driver.execute_query(
        "MATCH (p:Parent)-[:HAS_CHILD]->(c:Child) WITH p, c ORDER BY c.ordinal "
        "WITH p, collect(c.text)[0] AS texto RETURN p.id AS pai, texto",
        database_=banco,
    )
    antes = depois = presentes = 0
    for r in registros:
        r_ = recuperar(driver, trecho_do_meio(r["texto"]), embute, CANDIDATOS, "hibrido-rrf", banco=banco)
        ids = [p["id"] for p in r_["pais"]]
        if r["pai"] not in ids:
            continue
        presentes += 1
        antes += ids[0] == r["pai"]
        rr = reranquear_pais(trecho_do_meio(r["texto"]), r_["pais"], notas, top=1)
        depois += rr["pais"][0]["id"] == r["pai"]
    return {
        "pais_testados": len(registros),
        "pai_entre_os_24_candidatos": presentes,
        "pai_em_1o_antes_do_rerank": antes,
        "pai_em_1o_depois_do_rerank": depois,
    }


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest="acao", required=True)
    b = sub.add_parser("buscar")
    b.add_argument("pergunta")
    b.add_argument("--modo", choices=MODOS, default="hibrido-rrf")
    b.add_argument("--k", type=int, default=CANDIDATOS)
    b.add_argument("--top", type=int, default=TOP_PADRAO)
    b.add_argument("--stepback", action="store_true", help="busca também com uma pergunta mais geral (LLM)")
    b.add_argument("--hyde", action="store_true", help="busca também com um trecho hipotético (LLM)")
    b.add_argument("--llm", default=MODELO_LLM, help="modelo que reescreve a consulta")
    m = sub.add_parser("medir")
    m.add_argument("--perguntas", type=Path, default=Path("../eval/perguntas_latencia.txt"))
    m.add_argument("--sem-sonda", action="store_true")
    for p in (b, m):
        p.add_argument("--swap", default="http://127.0.0.1:8080")
        p.add_argument("--raiz", type=Path, default=Path(".."))
        p.add_argument("--banco", default="neo4j")
    a = ap.parse_args()

    driver = conectar(a.raiz)
    try:
        embute = embutidor_llama(a.swap, MODELO_CONSULTA)
        notas = reranqueador_llama(a.swap)
        if a.acao == "buscar":
            rew = reescrever(a.pergunta, llm_llama(a.swap, a.llm), a.stepback, a.hyde)
            r = recuperar_e_reranquear(
                driver,
                a.pergunta,
                embute,
                notas,
                a.modo,
                a.k,
                a.top,
                banco=a.banco,
                stepback=rew["stepback"],
                hyde=rew["hyde"],
            )
            for p in r["pais"]:
                pag = p["pageStart"] if p["pageStart"] == p["pageEnd"] else f"{p['pageStart']}-{p['pageEnd']}"
                print(
                    f"{p['nota_rerank']:.4f}  (era #{p['posicao_antes']:>2})  p. {pag}  {p['tokens']:>4} tok "
                    f"{p['caminho'][:80]}"
                )
            print(f"{r['candidatos']} candidatos -> {len(r['pais'])}; {r['latencia_ms']}")
            if a.stepback or a.hyde:
                print(f"reescritas: ms={rew['ms']} erros={rew['erros']}")
        else:
            perguntas = [
                x.strip()
                for x in a.perguntas.read_text(encoding="utf-8").splitlines()
                if x.strip() and not x.startswith("#")
            ]
            resultado = medir(driver, embute, notas, perguntas, a.banco)
            if not a.sem_sonda:
                resultado["sonda_trecho_do_meio"] = sonda(driver, embute, notas, a.banco)
            print(json.dumps(resultado, ensure_ascii=False, indent=2))
    finally:
        driver.close()


if __name__ == "__main__":
    main()
