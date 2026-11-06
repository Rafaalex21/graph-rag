"""Comunidades por Leiden hierárquico no GDS (§5 I-9, F5.5).

Projeção: as `__Entity__` ligadas por `SUMMARIZED_RELATIONSHIP`, **sem o emissor** (`:Issuer`) e sem as
entidades que, tirado o emissor, ficam sem nenhuma aresta (não formam comunidade de verdade: o relatório da
F5.6 teria só uma entidade). As arestas viram não direcionadas e, se o par existe nos dois sentidos, vale o
maior peso (peso = força da relação, 1 a 10).

Leiden (`gds.leiden`) com `includeIntermediateCommunities`, `randomSeed` fixo e `concurrency 1`, que é o que
torna a partição reprodutível. Cada nível vira um conjunto de nós `(:__Community__ {id, level, size})`:
`(:__Entity__)-[:IN_COMMUNITY]->(:__Community__)` liga a entidade à comunidade do nível 0 (o mais fino) e
`(:__Community__)-[:PARENT_COMMUNITY]->(:__Community__)` liga cada comunidade à do nível seguinte. O id
vem do conteúdo (nível + membros), não do número que o GDS atribui, então a mesma partição gera os mesmos
ids em qualquer execução e a F5.6 pode guardar relatórios em cache por id. As comunidades são derivadas:
cada execução as apaga e refaz.

A modularidade de cada nível é registrada duas vezes: a do GDS (`modularities`) e a recalculada aqui, em
Python, sobre as mesmas arestas; a conferência pega divergência de peso, de direção ou de nível.

Precisa do Neo4j com o GDS. Uso, a partir de `indexer/`:
    uv run python -m indexer.comunidades executar
    uv run python -m indexer.comunidades verificar
"""

from __future__ import annotations

import argparse
import hashlib
import json
import statistics
from collections import defaultdict
from pathlib import Path
from typing import Any

GRAFO = "comunidades"
PARAMETROS = {
    "relationshipWeightProperty": "weight",
    "includeIntermediateCommunities": True,
    "maxLevels": 10,
    "gamma": 1.0,
    "theta": 0.01,
    "tolerance": 0.0001,
    "randomSeed": 42,
    "concurrency": 1,
}


def _id_da_comunidade(nivel: int, membros: list[str]) -> str:
    h = hashlib.sha256("\x1f".join(membros).encode("utf-8")).hexdigest()[:12]
    return f"com:{nivel}:{h}"


def refinar(atribuicoes: dict[str, list[int]]) -> tuple[dict[str, list[int]], list[int]]:
    """Divide as comunidades que o Leiden deixou com mais de um pai (achado da F5.8, ADR-045).

    O GDS promete níveis aninhados, mas no documento inteiro uma comunidade do nível 0 e uma do 1 tiveram
    membros em dois pais. A saída sem arbitrariedade é a partição mais grossa que é, ao mesmo tempo,
    refinamento do que o GDS deu e aninhada: cada entidade fica identificada pelo caminho `(comunidade no
    nível n, no n+1, ..., no topo)`, e quem tem caminhos diferentes se separa. Comunidades que já aninhavam
    ficam como estavam.
    Devolve as novas atribuições (números renumerados, só a identidade importa) e, por nível, quantas
    comunidades do GDS foram divididas."""
    tamanhos = {len(v) for v in atribuicoes.values()}
    if len(tamanhos) != 1:  # a hierarquia recusa com a mensagem certa
        return atribuicoes, []
    (n_niveis,) = tamanhos
    caminhos = {e: [tuple(ids[n:]) for n in range(n_niveis)] for e, ids in atribuicoes.items()}
    novas: dict[str, list[int]] = {e: [] for e in atribuicoes}
    divididas = []
    for n in range(n_niveis):
        indice = {c: i for i, c in enumerate(sorted({p[n] for p in caminhos.values()}))}
        for e, p in caminhos.items():
            novas[e].append(indice[p[n]])
        partes: dict[int, set[int]] = defaultdict(set)
        for e, ids in atribuicoes.items():
            partes[ids[n]].add(novas[e][n])
        divididas.append(sum(1 for v in partes.values() if len(v) > 1))
    return novas, divididas


def hierarquia(atribuicoes: dict[str, list[int]]) -> list[dict]:
    """Comunidades por nível a partir de `entidade -> [comunidade no nível 0, no nível 1, ...]`.

    Devolve dicionários `{id, nivel, membros (ordenados), pai (id ou None no nível mais alto)}`. Os níveis
    precisam se aninhar (todo membro de uma comunidade tem a mesma comunidade no nível acima); se não,
    `ValueError`, em vez de escolher um pai ao acaso."""
    if not atribuicoes:
        return []
    tamanhos = {len(v) for v in atribuicoes.values()}
    if len(tamanhos) != 1:
        raise ValueError(f"as entidades têm quantidades diferentes de niveis: {sorted(tamanhos)}")
    (n_niveis,) = tamanhos
    grupos: list[dict[int, list[str]]] = []
    for nivel in range(n_niveis):
        g: dict[int, list[str]] = defaultdict(list)
        for ent, ids in atribuicoes.items():
            g[ids[nivel]].append(ent)
        grupos.append({k: sorted(v) for k, v in g.items()})
    id_de = [{k: _id_da_comunidade(n, membros) for k, membros in grupos[n].items()} for n in range(n_niveis)]
    saida = []
    for n in range(n_niveis):
        for k, membros in grupos[n].items():
            pai = None
            if n + 1 < n_niveis:
                pais = {id_de[n + 1][atribuicoes[m][n + 1]] for m in membros}
                if len(pais) != 1:
                    raise ValueError(
                        f"niveis nao aninhados: a comunidade {k} do nivel {n} tem {len(pais)} pais"
                    )
                (pai,) = pais
            saida.append({"id": id_de[n][k], "nivel": n, "membros": membros, "pai": pai})
    return sorted(saida, key=lambda c: (c["nivel"], c["membros"]))


def resumo_por_nivel(comunidades: list[dict]) -> dict[int, int]:
    contagem: dict[int, int] = defaultdict(int)
    for c in comunidades:
        contagem[c["nivel"]] += 1
    return dict(sorted(contagem.items()))


def modularidade(
    arestas: list[tuple[str, str, float]], particao: dict[str, int], gamma: float = 1.0
) -> float:
    """Modularidade de uma partição em grafo não direcionado e ponderado (`gamma` 1 = a clássica)."""
    m = sum(w for _, _, w in arestas)
    if m == 0:
        return 0.0
    interno: dict[int, float] = defaultdict(float)
    grau: dict[int, float] = defaultdict(float)
    for a, b, w in arestas:
        grau[particao[a]] += w
        grau[particao[b]] += w
        if particao[a] == particao[b]:
            interno[particao[a]] += w
    return sum(interno[c] / m - gamma * (grau[c] / (2 * m)) ** 2 for c in grau)


# ---- Neo4j / GDS ----------------------------------------------------------------------------------------

PROJETAR = """
MATCH (a:__Entity__)-[r:SUMMARIZED_RELATIONSHIP]-(b:__Entity__)
WHERE NOT a:Issuer AND NOT b:Issuer AND elementId(a) < elementId(b)
WITH a, b, max(r.weight) AS w
WITH gds.graph.project($grafo, a, b, {relationshipProperties: {weight: w}},
                       {undirectedRelationshipTypes: ['*']}) AS g
RETURN g.nodeCount AS nos, g.relationshipCount AS arestas
"""
ARESTAS = """
MATCH (a:__Entity__)-[r:SUMMARIZED_RELATIONSHIP]-(b:__Entity__)
WHERE NOT a:Issuer AND NOT b:Issuer AND elementId(a) < elementId(b)
RETURN a.id AS a, b.id AS b, max(r.weight) AS w
"""
GRAVAR_NOS = """
UNWIND $rows AS r
CREATE (c:__Community__ {id: r.id, level: r.nivel, size: size(r.membros)})
"""
GRAVAR_PAIS = """
UNWIND $rows AS r
MATCH (f:__Community__ {id: r.id}), (p:__Community__ {id: r.pai})
CREATE (f)-[:PARENT_COMMUNITY]->(p)
"""
GRAVAR_MEMBROS = """
UNWIND $rows AS r
MATCH (e:__Entity__ {id: r.entidade}), (c:__Community__ {id: r.id})
CREATE (e)-[:IN_COMMUNITY]->(c)
"""


def _tamanhos(comunidades: list[dict], nivel: int) -> dict:
    t = [len(c["membros"]) for c in comunidades if c["nivel"] == nivel]
    return {"minimo": min(t), "mediana": statistics.median(t), "maximo": max(t), "unitarias": t.count(1)}


def executar(driver: Any, banco: str = "neo4j") -> dict:
    def q(cypher: str, **p: Any) -> list[dict]:
        return [dict(r) for r in driver.execute_query(cypher, p or None, database_=banco)[0]]

    q("CALL gds.graph.drop($g, false) YIELD graphName RETURN graphName", g=GRAFO)
    proj = q(PROJETAR, grafo=GRAFO)[0]
    try:
        stats = q(
            "CALL gds.leiden.stats($g, $p) YIELD communityCount, ranLevels, modularity, modularities "
            "RETURN communityCount, ranLevels, modularity, modularities",
            g=GRAFO,
            p=PARAMETROS,
        )[0]
        fluxo = q(
            "CALL gds.leiden.stream($g, $p) YIELD nodeId, communityId, intermediateCommunityIds "
            "RETURN gds.util.asNode(nodeId).id AS id, intermediateCommunityIds AS niveis",
            g=GRAFO,
            p=PARAMETROS,
        )
    finally:
        q("CALL gds.graph.drop($g, false) YIELD graphName RETURN graphName", g=GRAFO)
    atrib = {r["id"]: [int(x) for x in r["niveis"]] for r in fluxo}
    gravadas, divididas = refinar(atrib)  # o GDS nem sempre aninha os níveis (ADR-045)
    coms = hierarquia(gravadas)
    arestas = [(r["a"], r["b"], float(r["w"])) for r in q(ARESTAS)]
    por_nivel = []
    for n in range(len(stats["modularities"])):
        propria = modularidade(arestas, {e: ids[n] for e, ids in atrib.items()}, PARAMETROS["gamma"])
        gravada = modularidade(arestas, {e: ids[n] for e, ids in gravadas.items()}, PARAMETROS["gamma"])
        por_nivel.append(
            {
                "nivel": n,
                "comunidades": resumo_por_nivel(coms)[n],
                "modularidade_gds": stats["modularities"][n],
                "modularidade_recalculada": round(propria, 6),  # sobre a partição do GDS: tem de bater
                "modularidade_gravada": round(gravada, 6),  # sobre a hierarquia gravada, depois de dividir
                "comunidades_divididas": divididas[n],
                "tamanhos": _tamanhos(coms, n),
            }
        )
    q("MATCH (c:__Community__) DETACH DELETE c")
    q(GRAVAR_NOS, rows=coms)
    q(GRAVAR_PAIS, rows=[c for c in coms if c["pai"]])
    q(
        GRAVAR_MEMBROS,
        rows=[{"entidade": m, "id": c["id"]} for c in coms if c["nivel"] == 0 for m in c["membros"]],
    )
    total = q("MATCH (e:__Entity__) RETURN count(e) AS n")[0]["n"]
    emissores = q("MATCH (e:Issuer) RETURN count(e) AS n")[0]["n"]
    return {
        "parametros": PARAMETROS,
        "entidades_no_grafo": total,
        "emissores_excluidos": emissores,
        "entidades_sem_aresta_fora_do_emissor": total - emissores - proj["nos"],
        "projecao": {"nos": proj["nos"], "arestas_nao_direcionadas": proj["arestas"] // 2},
        "niveis_executados": stats["ranLevels"],
        "comunidades_no_ultimo_nivel": stats["communityCount"],
        "modularidade_final_gds": stats["modularity"],
        "por_nivel": por_nivel,
        "ids": [c["id"] for c in coms],
    }


SANIDADE = {
    "entidades_do_emissor_em_comunidade": "MATCH (:Issuer)-[:IN_COMMUNITY]->() RETURN count(*)",
    "entidades_em_mais_de_uma_comunidade_no_nivel_0": (
        "MATCH (e:__Entity__)-[:IN_COMMUNITY]->(c) WITH e, count(c) AS n WHERE n > 1 RETURN count(e)"
    ),
    "comunidades_nao_topo_sem_pai": (
        "MATCH (c:__Community__) WHERE c.level < $topo AND NOT (c)-[:PARENT_COMMUNITY]->() RETURN count(c)"
    ),
    "comunidades_com_mais_de_um_pai": (
        "MATCH (c:__Community__)-[:PARENT_COMMUNITY]->(p) WITH c, count(p) AS n WHERE n > 1 RETURN count(c)"
    ),
    "comunidades_vazias": (
        "MATCH (c:__Community__ {level: 0}) WHERE NOT ()-[:IN_COMMUNITY]->(c) RETURN count(c)"
    ),
    "tamanho_gravado_diferente_dos_membros": (
        "MATCH (c:__Community__ {level: 0}) WITH c, count { ()-[:IN_COMMUNITY]->(c) } AS n "
        "WHERE c.size <> n RETURN count(c)"
    ),
}


def verificar(driver: Any, banco: str = "neo4j") -> dict:
    topo = driver.execute_query("MATCH (c:__Community__) RETURN max(c.level) AS m", database_=banco)[0][0][
        "m"
    ]
    saida = {
        k: driver.execute_query(c, {"topo": topo}, database_=banco)[0][0][0] for k, c in SANIDADE.items()
    }
    niveis = driver.execute_query(
        "MATCH (c:__Community__) RETURN c.level AS nivel, count(*) AS comunidades ORDER BY nivel",
        database_=banco,
    )[0]
    saida["comunidades_por_nivel"] = {r["nivel"]: r["comunidades"] for r in niveis}
    return saida


def main() -> None:  # pragma: no cover - orquestração de CLI; a lógica tem testes
    from indexer.grafo import conectar

    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("acao", choices=("executar", "verificar"))
    ap.add_argument("--raiz", type=Path, default=Path(".."))
    ap.add_argument("--banco", default="neo4j")
    a = ap.parse_args()
    driver = conectar(a.raiz)
    try:
        r = executar(driver, a.banco) if a.acao == "executar" else verificar(driver, a.banco)
        print(json.dumps(r, ensure_ascii=False, indent=1))
    finally:
        driver.close()


if __name__ == "__main__":
    main()
