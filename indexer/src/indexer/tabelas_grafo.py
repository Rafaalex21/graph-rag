"""Tabelas e perguntas hipotéticas no Neo4j (F2.7): carga idempotente, embeddings e `question_vec`.

Complementa `indexer.tabelas` (que gera o texto). Precisa do Neo4j no ar e, para embutir as perguntas, do
llama-swap com o perfil `vetorizar` (modelo `qwen3-embed-0.6b-lote`).
"""

from __future__ import annotations

from pathlib import Path
from typing import Any

from indexer.embeddings import (
    DIMENSOES,
    MODELO_CONSULTA,
    MODELO_LOTE,
    em_lotes,
    embutidor_llama,
    formatar_consulta,
)
from indexer.grafo import aplicar_constraints, conectar
from indexer.tabelas import linhas_para_o_grafo

CRIAR_INDICE = (
    "CREATE VECTOR INDEX question_vec IF NOT EXISTS FOR (n:HypotheticalQuestion) ON n.embedding "
    f"OPTIONS {{indexConfig: {{`vector.dimensions`: {DIMENSOES}, `vector.similarity_function`: 'cosine'}}}}"
)
NOS_TABELA = "UNWIND $rows AS r MERGE (n:Table {id: r.id}) SET n += r"
NOS_PERGUNTA = "UNWIND $rows AS r MERGE (n:HypotheticalQuestion {id: r.id}) SET n += r"
TEM_TABELA = (
    "UNWIND $rows AS r MATCH (a:Section {id: r.de}), (b:Table {id: r.para}) MERGE (a)-[:HAS_TABLE]->(b)"
)
TEM_PERGUNTA = (
    "UNWIND $rows AS r MATCH (a:Table {id: r.de}), (b:HypotheticalQuestion {id: r.para}) "
    "MERGE (a)-[:HAS_QUESTION]->(b)"
)
GRAVAR_VETOR = (
    "UNWIND $rows AS r MATCH (q:HypotheticalQuestion {id: r.id}) "
    "CALL db.create.setNodeVectorProperty(q, 'embedding', r.vetor) "
    "SET q.embeddingModel = $modelo, q.embeddingDims = $dims"
)
SANIDADE = {
    "tabelas_sem_secao": "MATCH (t:Table) WHERE NOT (:Section)-[:HAS_TABLE]->(t) RETURN count(t)",
    "tabelas_sem_pergunta": "MATCH (t:Table) WHERE NOT (t)-[:HAS_QUESTION]->() RETURN count(t)",
    "tabelas_com_menos_de_3_ou_mais_de_5": (
        "MATCH (t:Table) WITH t, count { (t)-[:HAS_QUESTION]->() } AS n WHERE n < 3 OR n > 5 RETURN count(t)"
    ),
    "tabelas_sem_descricao": (
        "MATCH (t:Table) WHERE t.description IS NULL OR size(t.description) < 30 RETURN count(t)"
    ),
    "perguntas_orfas": (
        "MATCH (q:HypotheticalQuestion) WHERE NOT (:Table)-[:HAS_QUESTION]->(q) RETURN count(q)"
    ),
    "perguntas_sem_vetor": "MATCH (q:HypotheticalQuestion) WHERE q.embedding IS NULL RETURN count(q)",
}
CONTAGENS = {
    "tabelas": "MATCH (t:Table) RETURN count(t)",
    "perguntas": "MATCH (q:HypotheticalQuestion) RETURN count(q)",
    "tem_tabela": "MATCH ()-[r:HAS_TABLE]->() RETURN count(r)",
    "tem_pergunta": "MATCH ()-[r:HAS_QUESTION]->() RETURN count(r)",
}


def _escalar(driver: Any, cypher: str, banco: str) -> int:
    registros, _, _ = driver.execute_query(cypher, database_=banco)
    return int(registros[0][0])


def carregar_no_grafo(tabelas: list[dict], doc_id: str, swap: str, raiz: Path, banco: str = "neo4j") -> dict:
    """Constraints, nós, relações, embeddings das perguntas sem vetor e `question_vec`; devolve a sanidade."""
    linhas = linhas_para_o_grafo(tabelas, doc_id)
    driver = conectar(raiz)
    try:
        aplicar_constraints(driver, banco)
        for cypher, chave in (
            (NOS_TABELA, "tabelas"),
            (NOS_PERGUNTA, "perguntas"),
            (TEM_TABELA, "tem_tabela"),
            (TEM_PERGUNTA, "tem_pergunta"),
        ):
            for lote in em_lotes(linhas[chave], 200):
                driver.execute_query(cypher, {"rows": lote}, database_=banco)
        registros, _, _ = driver.execute_query(
            "MATCH (q:HypotheticalQuestion) WHERE q.embedding IS NULL RETURN q.id AS id, q.text AS text",
            database_=banco,
        )
        faltam = [{"id": r["id"], "text": r["text"]} for r in registros]
        embute = embutidor_llama(swap, MODELO_LOTE)
        for lote in em_lotes(faltam, 16):
            vetores = embute([q["text"] for q in lote])
            rows = [{"id": q["id"], "vetor": v} for q, v in zip(lote, vetores, strict=True)]
            driver.execute_query(
                GRAVAR_VETOR, {"rows": rows, "modelo": MODELO_LOTE, "dims": DIMENSOES}, database_=banco
            )
        driver.execute_query(CRIAR_INDICE, database_=banco)
        driver.execute_query("CALL db.awaitIndexes(300)", database_=banco)
        registros, _, _ = driver.execute_query(
            "SHOW INDEXES YIELD name, state, populationPercent WHERE name = 'question_vec' "
            "RETURN state, populationPercent",
            database_=banco,
        )
        return {
            "enviados": {k: len(v) for k, v in linhas.items()},
            "embutidas_agora": len(faltam),
            "indice_question_vec": {
                "estado": registros[0]["state"],
                "populado_pct": registros[0]["populationPercent"],
            }
            if registros
            else None,
            "contagens": {k: _escalar(driver, q, banco) for k, q in CONTAGENS.items()},
            "problemas": {k: _escalar(driver, q, banco) for k, q in SANIDADE.items()},
        }
    finally:
        driver.close()


def autoteste_perguntas(swap: str, raiz: Path, banco: str = "neo4j") -> dict:
    """(a) cada pergunta re-embutida pela CPU deve ser a vizinha nº 1 de si mesma (consistência GPU × CPU);
    (b) informativo, sem a própria pergunta nos resultados: a vizinha mais próxima (e, em outra métrica,
    alguma das 3 mais próximas) deve ser de outra pergunta DA MESMA tabela. Mede se as perguntas distinguem
    tabelas parecidas (por exemplo os cenários I, II e III de risco de mercado)."""
    cpu = embutidor_llama(swap, MODELO_CONSULTA)
    driver = conectar(raiz)
    try:
        registros, _, _ = driver.execute_query(
            "MATCH (t:Table)-[:HAS_QUESTION]->(q:HypotheticalQuestion) WHERE q.embedding IS NOT NULL "
            "RETURN q.id AS id, q.text AS text, t.id AS tabela, count { (t)-[:HAS_QUESTION]->() } AS irmas "
            "ORDER BY q.id",
            database_=banco,
        )
        busca = (
            "CALL db.index.vector.queryNodes('question_vec', $k, $v) YIELD node "
            "MATCH (t:Table)-[:HAS_QUESTION]->(node) RETURN node.id AS id, t.id AS tabela"
        )
        acertos = mesma_1 = mesma_3 = 0
        for r in registros:
            (v,) = cpu([r["text"]])
            topo, _, _ = driver.execute_query(busca, {"k": 1, "v": v}, database_=banco)
            acertos += bool(topo) and topo[0]["id"] == r["id"]
            (v,) = cpu([formatar_consulta(r["text"])])
            top, _, _ = driver.execute_query(busca, {"k": 6, "v": v}, database_=banco)
            outras = [x["tabela"] for x in top if x["id"] != r["id"]]
            mesma_1 += bool(outras) and outras[0] == r["tabela"]
            mesma_3 += r["tabela"] in outras[:3]
        n = len(registros)
        return {
            "perguntas": n,
            "recall_at_1_pergunta_para_si_mesma": round(acertos / n, 4) if n else None,
            "vizinha_mais_proxima_e_da_mesma_tabela": round(mesma_1 / n, 4) if n else None,
            "alguma_das_3_vizinhas_e_da_mesma_tabela": round(mesma_3 / n, 4) if n else None,
        }
    finally:
        driver.close()
