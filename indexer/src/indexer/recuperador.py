"""Retriever parent-document (ARQUITETURA §7 e cap. 3 do livro, tarefa F2.5).

Pergunta -> k × 4 Filhos (vetor, texto ou híbrido, ver `indexer.busca`) -> deduplicação por Pai -> top-k Pais.
O Pai é o contexto entregue ao reranker (F2.6) e ao LLM; o Filho só serve para achá-lo. O escore de um Pai é o
do seu melhor Filho, e a ordem é a do melhor Filho na lista fundida.

Uso (a partir de indexer/, com llama-swap e Neo4j no ar):
    uv run python -m indexer.recuperador buscar "pergunta" --modo hibrido-rrf --k 6
    uv run python -m indexer.recuperador medir --k 24    # latência e duplicatas (eval/perguntas_latencia.txt)
"""

from __future__ import annotations

import argparse
import json
import statistics
import time
from pathlib import Path
from typing import Any

from indexer.busca import ALFA_PADRAO, FATOR_DE_CANDIDATOS, MODOS, fundir, listas
from indexer.embeddings import MODELO_CONSULTA, Embutidor, embutidor_llama
from indexer.grafo import conectar

K_PADRAO = 6
LIMITE_MS = 300

DETALHES_PAIS = (
    "UNWIND $ids AS id MATCH (s:Section)-[:HAS_PARENT]->(p:Parent {id: id}) "
    "RETURN p.id AS id, p.text AS text, p.tokens AS tokens, p.pageStart AS pageStart, "
    "p.pageEnd AS pageEnd, s.id AS secaoId, s.path AS caminho"
)
DETALHES_FILHOS = (
    "UNWIND $ids AS id MATCH (p:Parent)-[:HAS_CHILD]->(c:Child {id: id}) RETURN c.id AS id, p.id AS pai"
)


def agrupar_por_pai(filhos: list[tuple[str, float]], pai_de: dict[str, str], k: int) -> list[dict]:
    """Colapsa a lista fundida de Filhos em Pais únicos: melhor Filho define escore e ordem; corta em k."""
    pais: dict[str, dict] = {}
    for filho_id, escore in filhos:
        pai = pai_de.get(filho_id)
        if pai is None:
            continue
        if pai not in pais:
            pais[pai] = {"id": pai, "score": escore, "filhos": []}
        pais[pai]["filhos"].append(filho_id)
    return list(pais.values())[:k]


def recuperar(
    driver: Any,
    pergunta: str,
    embute_consulta: Embutidor | None,
    k: int = K_PADRAO,
    modo: str = "vetor",
    alfa: float = ALFA_PADRAO,
    fator: int = FATOR_DE_CANDIDATOS,
    banco: str = "neo4j",
) -> dict:
    """Top-k Pais para a pergunta, sem repetir Pai, com a latência de cada etapa em milissegundos."""
    if modo not in MODOS:
        raise ValueError(f"modo desconhecido: {modo!r} (use {', '.join(MODOS)})")
    t0 = time.perf_counter()
    gasto_embedding = 0.0

    def medido(textos: list[str]) -> list[list[float]]:
        nonlocal gasto_embedding
        t = time.perf_counter()
        try:
            return embute_consulta(textos)  # type: ignore[misc]
        finally:
            gasto_embedding += time.perf_counter() - t

    n = k * fator
    vetor, texto = listas(driver, pergunta, medido, n, banco, modo)
    t_listas = time.perf_counter()
    filhos = fundir(modo, vetor, texto, alfa)[:n]
    pai_de: dict[str, str] = {}
    pais: list[dict] = []
    if filhos:
        registros, _, _ = driver.execute_query(
            DETALHES_FILHOS, {"ids": [i for i, _ in filhos]}, database_=banco
        )
        pai_de = {r["id"]: r["pai"] for r in registros}
        escolhidos = agrupar_por_pai(filhos, pai_de, k)
        registros, _, _ = driver.execute_query(
            DETALHES_PAIS, {"ids": [p["id"] for p in escolhidos]}, database_=banco
        )
        por_id = {r["id"]: r for r in registros}
        pais = [
            {
                "id": p["id"],
                "score": round(p["score"], 6),
                "pageStart": por_id[p["id"]]["pageStart"],
                "pageEnd": por_id[p["id"]]["pageEnd"],
                "secaoId": por_id[p["id"]]["secaoId"],
                "caminho": por_id[p["id"]]["caminho"],
                "tokens": por_id[p["id"]]["tokens"],
                "text": por_id[p["id"]]["text"],
                "filhos": p["filhos"],
            }
            for p in escolhidos
            if p["id"] in por_id
        ]
    fim = time.perf_counter()
    return {
        "pais": pais,
        "filhos_considerados": len(filhos),
        "latencia_ms": {
            "total": round((fim - t0) * 1000, 1),
            "embedding_da_consulta": round(gasto_embedding * 1000, 1),
            "busca_nos_indices": round((t_listas - t0 - gasto_embedding) * 1000, 1),
            "pais": round((fim - t_listas) * 1000, 1),
        },
    }


def percentil(valores: list[float], p: float) -> float:
    v = sorted(valores)
    return v[min(len(v) - 1, int(round(p * (len(v) - 1))))]


def medir(
    driver: Any, embute: Embutidor, perguntas: list[str], k: int, banco: str = "neo4j", repeticoes: int = 3
) -> dict:
    """Latência (após aquecer) e duplicatas de Pai por modo, em todas as perguntas, `repeticoes` vezes."""
    recuperar(driver, perguntas[0], embute, k, "hibrido-rrf", banco=banco)  # aquece modelo, índices e cache
    saida: dict = {"k": k, "perguntas": len(perguntas), "repeticoes": repeticoes, "limite_ms": LIMITE_MS}
    for modo in MODOS:
        totais, parciais, duplicatas, retornados = [], [], 0, []
        for _ in range(repeticoes):
            for q in perguntas:
                r = recuperar(driver, q, embute, k, modo, banco=banco)
                ids = [p["id"] for p in r["pais"]]
                duplicatas += len(ids) - len(set(ids))
                retornados.append(len(ids))
                totais.append(r["latencia_ms"]["total"])
                parciais.append(r["latencia_ms"])
        saida[modo] = {
            "consultas": len(totais),
            "pais_duplicados": duplicatas,
            "pais_por_consulta_media": round(statistics.mean(retornados), 1),
            "ms_p50": round(percentil(totais, 0.5), 1),
            "ms_p95": round(percentil(totais, 0.95), 1),
            "ms_max": round(max(totais), 1),
            "ms_medio_por_etapa": {
                etapa: round(statistics.mean(p[etapa] for p in parciais), 1)
                for etapa in ("embedding_da_consulta", "busca_nos_indices", "pais")
            },
            "dentro_do_limite": max(totais) <= LIMITE_MS,
        }
    return saida


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest="acao", required=True)
    b = sub.add_parser("buscar")
    b.add_argument("pergunta")
    b.add_argument("--modo", choices=MODOS, default="vetor")
    b.add_argument("--k", type=int, default=K_PADRAO)
    b.add_argument("--alfa", type=float, default=ALFA_PADRAO)
    b.add_argument("--json", action="store_true")
    m = sub.add_parser("medir")
    m.add_argument("--k", type=int, default=K_PADRAO)
    m.add_argument("--perguntas", type=Path, default=Path("../eval/perguntas_latencia.txt"))
    m.add_argument("--repeticoes", type=int, default=3)
    for p in (b, m):
        p.add_argument("--swap", default="http://127.0.0.1:8080")
        p.add_argument("--raiz", type=Path, default=Path(".."))
        p.add_argument("--banco", default="neo4j")
    a = ap.parse_args()

    driver = conectar(a.raiz)
    try:
        embute = embutidor_llama(a.swap, MODELO_CONSULTA)
        if a.acao == "buscar":
            r = recuperar(driver, a.pergunta, embute, a.k, a.modo, a.alfa, banco=a.banco)
            if a.json:
                print(json.dumps(r, ensure_ascii=False, indent=2))
                return
            for p in r["pais"]:
                pag = p["pageStart"] if p["pageStart"] == p["pageEnd"] else f"{p['pageStart']}-{p['pageEnd']}"
                print(
                    f"{p['score']:.4f}  p. {pag}  {p['tokens']:>4} tok  {len(p['filhos'])} filho(s)  "
                    f"{p['caminho'][:90]}"
                )
            print(f"{r['filhos_considerados']} Filhos -> {len(r['pais'])} Pais; {r['latencia_ms']}")
        else:
            perguntas = [
                x.strip()
                for x in a.perguntas.read_text(encoding="utf-8").splitlines()
                if x.strip() and not x.startswith("#")
            ]
            print(
                json.dumps(
                    medir(driver, embute, perguntas, a.k, a.banco, a.repeticoes), ensure_ascii=False, indent=2
                )
            )
    finally:
        driver.close()


if __name__ == "__main__":
    main()
