"""I-10 · Camada léxica no Neo4j (ARQUITETURA §6, tarefa F2.2).

Aplica as *constraints* de unicidade da §6.3 e carrega Document, Section, Parent e Child (com as relações
HAS_SECTION, HAS_SUBSECTION, HAS_PARENT, HAS_CHILD e NEXT) a partir do `.chunks.json` (ADR-018) e da árvore de
seções (ADR-016). A carga é idempotente (MERGE por id): rodar duas vezes não muda nenhuma contagem.
Os índices vetorial e full-text ficam para a F2.3 e a F2.4; Table e HypotheticalQuestion, para a F2.7.

A conexão lê NEO4J_URI, NEO4J_USER e NEO4J_PASSWORD do `.env` (nunca impressos).

Uso (a partir de indexer/, com o Neo4j no ar: `infra\\neo4j.ps1 iniciar`):
    uv run python -m indexer.grafo carregar ../data/parsed/ARQUIVO.chunks.json \\
        ../data/parsed/ARQUIVO.secoes.json --doc-id ID --titulo "..." --emissor "..." --ano 2025 \\
        --arquivo ARQUIVO.pdf --paginas 423 --paginas-indexadas 79
    uv run python -m indexer.grafo sanidade [--esperado ../data/parsed/ARQUIVO.chunks.json]
"""

from __future__ import annotations

import argparse
import json
import os
from pathlib import Path
from typing import Any

SEPARADOR_DE_CAMINHO = " › "
LOTE = 500

# §6.3: unicidade (as dos rótulos que ainda não existem ficam prontas para as próximas fases)
CONSTRAINTS = [
    "CREATE CONSTRAINT document_id IF NOT EXISTS FOR (n:Document) REQUIRE n.id IS UNIQUE",
    "CREATE CONSTRAINT section_id IF NOT EXISTS FOR (n:Section) REQUIRE n.id IS UNIQUE",
    "CREATE CONSTRAINT parent_id IF NOT EXISTS FOR (n:Parent) REQUIRE n.id IS UNIQUE",
    "CREATE CONSTRAINT child_id IF NOT EXISTS FOR (n:Child) REQUIRE n.id IS UNIQUE",
    "CREATE CONSTRAINT table_id IF NOT EXISTS FOR (n:Table) REQUIRE n.id IS UNIQUE",
    "CREATE CONSTRAINT fact_id IF NOT EXISTS FOR (n:FinancialFact) REQUIRE n.id IS UNIQUE",
    "CREATE CONSTRAINT metric_name IF NOT EXISTS FOR (n:Metric) REQUIRE n.name IS UNIQUE",
    "CREATE CONSTRAINT period_id IF NOT EXISTS FOR (n:Period) REQUIRE n.id IS UNIQUE",
    "CREATE CONSTRAINT entity_id IF NOT EXISTS FOR (n:__Entity__) REQUIRE n.id IS UNIQUE",
    "CREATE CONSTRAINT community_id IF NOT EXISTS FOR (n:__Community__) REQUIRE n.id IS UNIQUE",
]

# §6.4 e verificações extras da camada léxica: todas devem dar 0
SANIDADE = {
    "filhos_orfaos": "MATCH (c:Child) WHERE NOT (c)<-[:HAS_CHILD]-(:Parent) RETURN count(c)",
    "pais_sem_filho": "MATCH (p:Parent) WHERE NOT (p)-[:HAS_CHILD]->(:Child) RETURN count(p)",
    "pais_sem_secao": "MATCH (p:Parent) WHERE NOT (:Section)-[:HAS_PARENT]->(p) RETURN count(p)",
    "pais_em_mais_de_uma_secao": (
        "MATCH (p:Parent) WHERE count { (:Section)-[:HAS_PARENT]->(p) } > 1 RETURN count(p)"
    ),
    "filhos_em_mais_de_um_pai": (
        "MATCH (c:Child) WHERE count { (:Parent)-[:HAS_CHILD]->(c) } > 1 RETURN count(c)"
    ),
    "secoes_fora_do_documento": (
        "MATCH (s:Section) WHERE NOT (:Document)-[:HAS_SECTION|HAS_SUBSECTION*1..]->(s) RETURN count(s)"
    ),
    "pai_fora_das_paginas_da_secao": (
        "MATCH (s:Section)-[:HAS_PARENT]->(p:Parent) "
        "WHERE p.pageStart < s.pageStart OR p.pageEnd > s.pageEnd RETURN count(p)"
    ),
    "filho_fora_das_paginas_do_pai": (
        "MATCH (p:Parent)-[:HAS_CHILD]->(c:Child) "
        "WHERE c.pageStart < p.pageStart OR c.pageEnd > p.pageEnd RETURN count(c)"
    ),
    "next_mal_formado": (
        "MATCH (p:Parent) WHERE count { (p)-[:NEXT]->() } > 1 OR count { ()-[:NEXT]->(p) } > 1 "
        "RETURN count(p)"
    ),
}

CONTAGENS = {
    "documentos": "MATCH (n:Document) RETURN count(n)",
    "secoes": "MATCH (n:Section) RETURN count(n)",
    "pais": "MATCH (n:Parent) RETURN count(n)",
    "filhos": "MATCH (n:Child) RETURN count(n)",
    "tem_secao": "MATCH ()-[r:HAS_SECTION]->() RETURN count(r)",
    "tem_subsecao": "MATCH ()-[r:HAS_SUBSECTION]->() RETURN count(r)",
    "tem_pai": "MATCH ()-[r:HAS_PARENT]->() RETURN count(r)",
    "tem_filho": "MATCH ()-[r:HAS_CHILD]->() RETURN count(r)",
    "next": "MATCH ()-[r:NEXT]->() RETURN count(r)",
    "constraints_de_unicidade": (
        "SHOW CONSTRAINTS YIELD type WHERE type CONTAINS 'UNIQUENESS' RETURN count(*)"
    ),
}


def ler_env(caminho: Path) -> dict[str, str]:
    """Pares CHAVE=valor de um .env (sem aspas, sem expansão); ignora comentários e linhas em branco."""
    saida: dict[str, str] = {}
    if not caminho.exists():
        return saida
    for linha in caminho.read_text(encoding="utf-8-sig").splitlines():
        linha = linha.strip()
        if linha and not linha.startswith("#") and "=" in linha:
            chave, valor = linha.split("=", 1)
            saida[chave.strip()] = valor.strip()
    return saida


def preparar(chunks: dict, arvore: list[dict], documento: dict) -> dict[str, list[dict]]:
    """Linhas prontas para os UNWIND: nós (`documento`, `secoes`, `pais`, `filhos`) e relações
    (`tem_secao`, `tem_subsecao`, `tem_pai`, `tem_filho`, `next`, cada uma com `de` e `para`)."""
    doc_id = documento["id"]

    def sid(no_id: str) -> str:
        return f"{doc_id}:{no_id}"

    secoes = [
        {
            "id": sid(n["id"]),
            "number": n.get("numero"),
            "title": n["titulo"],
            "level": n["nivel"],
            "path": SEPARADOR_DE_CAMINHO.join(n["caminho"]),
            "pageStart": n["pagina_inicio"],
            "pageEnd": n["pagina_fim"],
            "order": ordem,
        }
        for ordem, n in enumerate(arvore, start=1)
    ]
    pais = [
        {
            "id": p["id"],
            "text": p["texto"],
            "tokens": p["tokens"],
            "pageStart": p["pagina_inicio"],
            "pageEnd": p["pagina_fim"],
            "ordinal": p["ordem"],
        }
        for p in chunks["pais"]
    ]
    filhos = [
        {
            "id": f["id"],
            "text": f["texto"],
            "tokens": f["tokens"],
            "pageStart": f["pagina_inicio"],
            "pageEnd": f["pagina_fim"],
            "ordinal": f["ordem"],
        }
        for f in chunks["filhos"]
    ]
    ids_pais = [p["id"] for p in chunks["pais"]]
    return {
        "documento": [documento],
        "secoes": secoes,
        "pais": pais,
        "filhos": filhos,
        "tem_secao": [{"de": doc_id, "para": sid(n["id"])} for n in arvore if not n["pai"]],
        "tem_subsecao": [{"de": sid(n["pai"]), "para": sid(n["id"])} for n in arvore if n["pai"]],
        "tem_pai": [{"de": sid(p["secao_id"]), "para": p["id"]} for p in chunks["pais"]],
        "tem_filho": [{"de": f["pai_id"], "para": f["id"]} for f in chunks["filhos"]],
        "next": [{"de": a, "para": b} for a, b in zip(ids_pais, ids_pais[1:], strict=False)],
    }


def _nos(rotulo: str) -> str:
    return f"UNWIND $rows AS r MERGE (n:{rotulo} {{id: r.id}}) SET n += r"


def _relacao(de: str, tipo: str, para: str) -> str:
    return (
        f"UNWIND $rows AS r MATCH (a:{de} {{id: r.de}}), (b:{para} {{id: r.para}}) MERGE (a)-[:{tipo}]->(b)"
    )


# ordem importa: nós antes das relações
PASSOS = [
    ("documento", _nos("Document")),
    ("secoes", _nos("Section")),
    ("pais", _nos("Parent")),
    ("filhos", _nos("Child")),
    ("tem_secao", _relacao("Document", "HAS_SECTION", "Section")),
    ("tem_subsecao", _relacao("Section", "HAS_SUBSECTION", "Section")),
    ("tem_pai", _relacao("Section", "HAS_PARENT", "Parent")),
    ("tem_filho", _relacao("Parent", "HAS_CHILD", "Child")),
    ("next", _relacao("Parent", "NEXT", "Parent")),
]


def aplicar_constraints(driver: Any, banco: str = "neo4j") -> int:
    for cypher in CONSTRAINTS:
        driver.execute_query(cypher, database_=banco)
    return len(CONSTRAINTS)


def carregar(driver: Any, linhas: dict[str, list[dict]], banco: str = "neo4j", lote: int = LOTE) -> dict:
    """Executa os passos em lotes e devolve quantas linhas cada passo enviou."""
    enviadas: dict[str, int] = {}
    for chave, cypher in PASSOS:
        for i in range(0, len(linhas[chave]), lote):
            driver.execute_query(cypher, {"rows": linhas[chave][i : i + lote]}, database_=banco)
        enviadas[chave] = len(linhas[chave])
    return enviadas


def _escalar(driver: Any, cypher: str, banco: str) -> int:
    registros, _, _ = driver.execute_query(cypher, database_=banco)
    return int(registros[0][0])


def sanidade(driver: Any, banco: str = "neo4j") -> dict:
    return {
        "contagens": {k: _escalar(driver, q, banco) for k, q in CONTAGENS.items()},
        "problemas": {k: _escalar(driver, q, banco) for k, q in SANIDADE.items()},
    }


def conferir_com_arquivo(resultado: dict, chunks: dict, arvore: list[dict]) -> dict:
    """Compara as contagens do banco com o `.chunks.json` e a árvore (só vale com um documento no banco)."""
    c = resultado["contagens"]
    esperado = {
        "secoes": len(arvore),
        "pais": len(chunks["pais"]),
        "filhos": len(chunks["filhos"]),
        "tem_pai": len(chunks["pais"]),
        "tem_filho": len(chunks["filhos"]),
        "next": max(0, len(chunks["pais"]) - 1),
        "tem_secao": sum(1 for n in arvore if not n["pai"]),
        "tem_subsecao": sum(1 for n in arvore if n["pai"]),
        "constraints_de_unicidade": len(CONSTRAINTS),
    }
    return {k: {"banco": c[k], "arquivo": v, "ok": c[k] == v} for k, v in esperado.items()}


def conectar(raiz: Path):
    from neo4j import GraphDatabase

    env = {**ler_env(raiz / ".env"), **{k: v for k, v in os.environ.items() if k.startswith("NEO4J_")}}
    uri = env.get("NEO4J_URI", "bolt://127.0.0.1:7687")
    return GraphDatabase.driver(uri, auth=(env.get("NEO4J_USER", "neo4j"), env["NEO4J_PASSWORD"]))


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest="acao", required=True)
    c = sub.add_parser("carregar")
    c.add_argument("chunks", type=Path)
    c.add_argument("secoes", type=Path)
    c.add_argument("--doc-id", required=True)
    c.add_argument("--titulo", required=True)
    c.add_argument("--emissor", required=True)
    c.add_argument("--ano", type=int, required=True)
    c.add_argument("--idioma", default="pt-BR")
    c.add_argument("--arquivo", required=True)
    c.add_argument("--paginas", type=int, required=True)
    c.add_argument("--paginas-indexadas", type=int)
    s = sub.add_parser("sanidade")
    s.add_argument("--esperado", type=Path, help=".chunks.json para conferir as contagens")
    s.add_argument("--secoes", type=Path)
    for p in (c, s):
        p.add_argument("--raiz", type=Path, default=Path(".."))
        p.add_argument("--banco", default="neo4j")
    a = ap.parse_args()

    driver = conectar(a.raiz)
    try:
        if a.acao == "carregar":
            chunks = json.loads(a.chunks.read_text(encoding="utf-8"))
            arvore = json.loads(a.secoes.read_text(encoding="utf-8"))["arvore"]
            documento = {
                "id": a.doc_id,
                "title": a.titulo,
                "issuer": a.emissor,
                "fiscalYear": a.ano,
                "language": a.idioma,
                "sourceFile": a.arquivo,
                "pages": a.paginas,
                "pagesIndexed": a.paginas_indexadas,
            }
            n = aplicar_constraints(driver, a.banco)
            print(f"constraints aplicadas: {n}")
            print(json.dumps(carregar(driver, preparar(chunks, arvore, documento), a.banco)))
        resultado = sanidade(driver, a.banco)
        if a.acao == "sanidade" and a.esperado:
            chunks = json.loads(a.esperado.read_text(encoding="utf-8"))
            arvore = json.loads(a.secoes.read_text(encoding="utf-8"))["arvore"] if a.secoes else []
            resultado["conferencia"] = conferir_com_arquivo(resultado, chunks, arvore)
        print(json.dumps(resultado, ensure_ascii=False, indent=2))
    finally:
        driver.close()


if __name__ == "__main__":
    main()
