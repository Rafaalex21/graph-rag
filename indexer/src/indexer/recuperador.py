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

from indexer.busca import (
    ALFA_PADRAO,
    FATOR_DE_CANDIDATOS,
    MODOS,
    busca_vetorial,
    fundir,
    fundir_variantes,
    listas,
)
from indexer.embeddings import MODELO_CONSULTA, Embutidor, embutidor_llama
from indexer.grafo import conectar
from indexer.reescrita import MODELO_LLM, llm_llama, reescrever

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
    stepback: str | None = None,
    hyde: str | None = None,
) -> dict:
    """Top-k Pais para a pergunta, sem repetir Pai, com a latência de cada etapa em milissegundos.

    `stepback` (pergunta mais geral) e `hyde` (trecho hipotético) são reescritas opcionais da F2.8: cada uma
    gera um ranking de Filhos próprio (o step-back pelo mesmo modo da pergunta; o HyDE só pelo vetor, sem
    instrução) e os rankings se unem por RRF com o da pergunta original. Sem elas, nada muda."""
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
    rankings = [fundir(modo, vetor, texto, alfa)[:n]]
    if stepback:
        v2, t2 = listas(driver, stepback, medido, n, banco, modo)
        rankings.append(fundir(modo, v2, t2, alfa)[:n])
    if hyde:
        (vh,) = medido([hyde])  # trecho hipotético = lado do documento: sem prefixo de instrução
        rankings.append(busca_vetorial(driver, vh, n, banco))
    t_listas = time.perf_counter()
    filhos = rankings[0] if len(rankings) == 1 else fundir_variantes(rankings)[:n]
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


def comparar_reescritas(
    driver: Any, embute: Embutidor, llm, perguntas: list[str], k: int, modo: str, banco: str = "neo4j"
) -> dict:
    """Informativo (a qualidade é da F3): custo das reescritas e quanto elas mudam o top-k de Pais.
    Para cada pergunta: baseline, +step-back, +HyDE e +ambos; mede a sobreposição (Jaccard) com o baseline."""
    tempos: dict[str, list[float]] = {"stepback": [], "hyde": [], "ambos_em_paralelo": []}
    erros = 0
    sobreposicao: dict[str, list[float]] = {"stepback": [], "hyde": [], "ambos": []}
    mudou_o_1o: dict[str, int] = {"stepback": 0, "hyde": 0, "ambos": 0}
    for q in perguntas:
        rew = reescrever(q, llm, stepback=True, hyde=True)
        erros += len(rew["erros"])
        tempos["stepback"].append(rew["ms"].get("stepback", 0.0))
        tempos["hyde"].append(rew["ms"].get("hyde", 0.0))
        tempos["ambos_em_paralelo"].append(max(rew["ms"].values(), default=0.0))
        base = [p["id"] for p in recuperar(driver, q, embute, k, modo, banco=banco)["pais"]]
        variantes = {
            "stepback": {"stepback": rew["stepback"]},
            "hyde": {"hyde": rew["hyde"]},
            "ambos": {"stepback": rew["stepback"], "hyde": rew["hyde"]},
        }
        for nome, extra in variantes.items():
            ids = [p["id"] for p in recuperar(driver, q, embute, k, modo, banco=banco, **extra)["pais"]]
            uniao = set(base) | set(ids)
            sobreposicao[nome].append(len(set(base) & set(ids)) / len(uniao) if uniao else 1.0)
            mudou_o_1o[nome] += bool(base and ids and base[0] != ids[0])
    n = len(perguntas)
    return {
        "perguntas": n,
        "k": k,
        "modo": modo,
        "reescritas_com_erro": erros,
        "ms_da_reescrita": {
            nome: {"p50": round(statistics.median(v), 1), "max": round(max(v), 1)}
            for nome, v in tempos.items()
        },
        "sobreposicao_media_com_o_baseline": {
            nome: round(statistics.mean(v), 3) for nome, v in sobreposicao.items()
        },
        "perguntas_em_que_o_1o_pai_mudou": mudou_o_1o,
    }


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest="acao", required=True)
    b = sub.add_parser("buscar")
    b.add_argument("pergunta")
    b.add_argument("--modo", choices=MODOS, default="vetor")
    b.add_argument("--k", type=int, default=K_PADRAO)
    b.add_argument("--alfa", type=float, default=ALFA_PADRAO)
    b.add_argument("--json", action="store_true")
    b.add_argument("--stepback", action="store_true", help="busca também com uma pergunta mais geral (LLM)")
    b.add_argument("--hyde", action="store_true", help="busca também com um trecho hipotético (LLM)")
    b.add_argument("--llm", default=MODELO_LLM, help="modelo que reescreve a consulta")
    m = sub.add_parser("medir")
    m.add_argument("--k", type=int, default=K_PADRAO)
    m.add_argument("--perguntas", type=Path, default=Path("../eval/perguntas_latencia.txt"))
    m.add_argument("--repeticoes", type=int, default=3)
    c = sub.add_parser("comparar-reescritas")
    c.add_argument("--k", type=int, default=K_PADRAO)
    c.add_argument("--modo", choices=MODOS, default="hibrido-rrf")
    c.add_argument("--perguntas", type=Path, default=Path("../eval/perguntas_latencia.txt"))
    c.add_argument("--llm", default=MODELO_LLM)
    for p in (b, m, c):
        p.add_argument("--swap", default="http://127.0.0.1:8080")
        p.add_argument("--raiz", type=Path, default=Path(".."))
        p.add_argument("--banco", default="neo4j")
    a = ap.parse_args()

    driver = conectar(a.raiz)
    try:
        embute = embutidor_llama(a.swap, MODELO_CONSULTA)
        if a.acao == "buscar":
            rew = reescrever(a.pergunta, llm_llama(a.swap, a.llm), a.stepback, a.hyde)
            r = recuperar(
                driver,
                a.pergunta,
                embute,
                a.k,
                a.modo,
                a.alfa,
                banco=a.banco,
                stepback=rew["stepback"],
                hyde=rew["hyde"],
            )
            r["reescrita"] = rew
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
            if a.stepback or a.hyde:
                print(f"reescritas: ms={r['reescrita']['ms']} erros={r['reescrita']['erros']}")
        elif a.acao == "comparar-reescritas":
            perguntas = [
                x.strip()
                for x in a.perguntas.read_text(encoding="utf-8").splitlines()
                if x.strip() and not x.startswith("#")
            ]
            llm = llm_llama(a.swap, a.llm)
            r = comparar_reescritas(driver, embute, llm, perguntas, a.k, a.modo, a.banco)
            print(json.dumps(r, ensure_ascii=False, indent=2))
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
