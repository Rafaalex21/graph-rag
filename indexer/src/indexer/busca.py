"""Busca de Filhos: vetorial, full-text e híbrida (ARQUITETURA §2 degrau 2 e §6.3, tarefa F2.4).

Modos (flag `--modo`):

* `vetor`        — `child_vec` (cosseno), consulta com o prefixo `Instruct: ...`;
* `texto`        — `child_ft` (Lucene, analisador `brazilian`);
* `hibrido-max`  — normalização pelo máximo (cap. 2): cada lista é dividida pelo seu maior escore e
                   combinada por `alfa * vetor + (1 - alfa) * texto`; o que falta numa lista conta 0;
* `hibrido-rrf`  — *Reciprocal Rank Fusion*: soma de `1 / (k + posição)` nas duas listas (k = 60).

O ganho do híbrido é hipótese a medir (F3): estes modos só fazem a busca ser selecionável.

Uso (a partir de indexer/, com llama-swap e Neo4j no ar):
    uv run python -m indexer.busca criar-indice
    uv run python -m indexer.busca buscar "Quem preside o Conselho de Administração?" --modo hibrido-rrf --k 5
    uv run python -m indexer.busca comparar            # sondas de trecho e de palavra rara nos 4 modos
"""

from __future__ import annotations

import argparse
import json
import re
from collections import Counter
from pathlib import Path
from typing import Any

from indexer.embeddings import (
    MODELO_CONSULTA,
    Embutidor,
    embutidor_llama,
    formatar_consulta,
    trecho_do_meio,
)
from indexer.grafo import conectar

MODOS = ("vetor", "texto", "hibrido-max", "hibrido-rrf")
RRF_K = 60
ALFA_PADRAO = 0.5
FATOR_DE_CANDIDATOS = 4  # k x 4, como no cap. 3

CRIAR_INDICE_FT = (
    "CREATE FULLTEXT INDEX child_ft IF NOT EXISTS FOR (n:Child) ON EACH [n.text] "
    "OPTIONS {indexConfig: {`fulltext.analyzer`: 'brazilian'}}"
)
CONSULTA_VETOR = (
    "CALL db.index.vector.queryNodes('child_vec', $k, $v) YIELD node, score "
    "RETURN node.id AS id, score ORDER BY score DESC"
)
CONSULTA_TEXTO = (
    "CALL db.index.fulltext.queryNodes('child_ft', $q, {limit: $k}) YIELD node, score "
    "RETURN node.id AS id, score ORDER BY score DESC"
)
DETALHES = (
    "UNWIND $ids AS id MATCH (p:Parent)-[:HAS_CHILD]->(c:Child {id: id}) "
    "RETURN c.id AS id, c.text AS text, c.pageStart AS pageStart, c.pageEnd AS pageEnd, p.id AS parentId"
)

# caracteres especiais da sintaxe Lucene (mais as palavras reservadas, tratadas à parte)
ESPECIAIS = re.compile(r'([+\-&|!(){}\[\]^"~*?:\\/])')
RESERVADAS = {"AND", "OR", "NOT"}


def escapar_lucene(pergunta: str) -> str:
    """Pergunta em linguagem natural -> consulta Lucene segura (termos soltos, operador padrão OU)."""
    termos = []
    for t in re.split(r"\s+", pergunta.strip()):
        t = ESPECIAIS.sub(r"\\\1", t)
        if t and t.upper() not in RESERVADAS:
            termos.append(t)
    return " ".join(termos)


def normalizar_pelo_maximo(lista: list[tuple[str, float]]) -> dict[str, float]:
    """Divide cada escore pelo maior da lista (a lista vazia ou de máximo 0 vira zeros)."""
    if not lista:
        return {}
    topo = max(s for _, s in lista)
    return {i: (s / topo if topo > 0 else 0.0) for i, s in lista}


def fundir_max(
    vetor: list[tuple[str, float]], texto: list[tuple[str, float]], alfa: float = ALFA_PADRAO
) -> list[tuple[str, float]]:
    v, t = normalizar_pelo_maximo(vetor), normalizar_pelo_maximo(texto)
    ids = list(dict.fromkeys([i for i, _ in vetor] + [i for i, _ in texto]))
    fundida = [(i, alfa * v.get(i, 0.0) + (1 - alfa) * t.get(i, 0.0)) for i in ids]
    return sorted(fundida, key=lambda x: -x[1])


def fundir_rrf(
    vetor: list[tuple[str, float]], texto: list[tuple[str, float]], k: int = RRF_K
) -> list[tuple[str, float]]:
    pontos: Counter[str] = Counter()
    for lista in (vetor, texto):
        for posicao, (i, _) in enumerate(lista, start=1):
            pontos[i] += 1.0 / (k + posicao)
    return sorted(pontos.items(), key=lambda x: -x[1])


def listas(
    driver: Any, pergunta: str, embute_consulta: Embutidor | None, n: int, banco: str, modo: str
) -> tuple[list[tuple[str, float]], list[tuple[str, float]]]:
    vetor: list[tuple[str, float]] = []
    texto: list[tuple[str, float]] = []
    if modo in ("vetor", "hibrido-max", "hibrido-rrf"):
        (v,) = embute_consulta([formatar_consulta(pergunta)])
        r, _, _ = driver.execute_query(CONSULTA_VETOR, {"k": n, "v": v}, database_=banco)
        vetor = [(x["id"], x["score"]) for x in r]
    if modo in ("texto", "hibrido-max", "hibrido-rrf"):
        q = escapar_lucene(pergunta)
        if q:
            r, _, _ = driver.execute_query(CONSULTA_TEXTO, {"k": n, "q": q}, database_=banco)
            texto = [(x["id"], x["score"]) for x in r]
    return vetor, texto


def buscar(
    driver: Any,
    pergunta: str,
    embute_consulta: Embutidor | None,
    k: int = 5,
    modo: str = "vetor",
    alfa: float = ALFA_PADRAO,
    candidatos: int | None = None,
    banco: str = "neo4j",
) -> list[dict]:
    """Top-k Filhos para a pergunta, no modo escolhido. Cada item traz id, escore, páginas, Pai e texto."""
    if modo not in MODOS:
        raise ValueError(f"modo desconhecido: {modo!r} (use {', '.join(MODOS)})")
    n = candidatos or k * FATOR_DE_CANDIDATOS
    vetor, texto = listas(driver, pergunta, embute_consulta, n, banco, modo)
    if modo == "vetor":
        final = vetor
    elif modo == "texto":
        final = texto
    elif modo == "hibrido-max":
        final = fundir_max(vetor, texto, alfa)
    else:
        final = fundir_rrf(vetor, texto)
    final = final[:k]
    if not final:
        return []
    registros, _, _ = driver.execute_query(DETALHES, {"ids": [i for i, _ in final]}, database_=banco)
    por_id = {r["id"]: r for r in registros}
    pos_vetor = {i: n_ for n_, (i, _) in enumerate(vetor, start=1)}
    pos_texto = {i: n_ for n_, (i, _) in enumerate(texto, start=1)}
    return [
        {
            "id": i,
            "score": round(s, 6),
            "pageStart": por_id[i]["pageStart"],
            "pageEnd": por_id[i]["pageEnd"],
            "parentId": por_id[i]["parentId"],
            "text": por_id[i]["text"],
            "posicao_vetor": pos_vetor.get(i),
            "posicao_texto": pos_texto.get(i),
        }
        for i, s in final
        if i in por_id
    ]


def criar_indice_texto(driver: Any, banco: str = "neo4j", espera: int = 300) -> dict:
    driver.execute_query(CRIAR_INDICE_FT, database_=banco)
    driver.execute_query(f"CALL db.awaitIndexes({espera})", database_=banco)
    registros, _, _ = driver.execute_query(
        "SHOW INDEXES YIELD name, type, state, populationPercent, options WHERE name = 'child_ft' "
        "RETURN name, type, state, populationPercent, options",
        database_=banco,
    )
    if not registros:
        return {"existe": False}
    r = registros[0]
    return {
        "existe": True,
        "tipo": r["type"],
        "estado": r["state"],
        "populado_pct": r["populationPercent"],
        "analisador": r["options"].get("indexConfig", {}).get("fulltext.analyzer"),
    }


def palavras_raras(textos: dict[str, str], por_filho: int = 3) -> dict[str, list[str]]:
    """As palavras mais raras (menor frequência de documento, 5+ letras) de cada Filho: sonda lexical."""
    palavras = {i: set(re.findall(r"[^\W\d_]{5,}", t.split("\n", 1)[-1].lower())) for i, t in textos.items()}
    df: Counter[str] = Counter(w for ws in palavras.values() for w in ws)
    return {i: sorted(ws, key=lambda w: (df[w], w))[:por_filho] for i, ws in palavras.items()}


def comparar(driver: Any, embute_consulta: Embutidor, k: int = 5, banco: str = "neo4j") -> dict:
    """Sondas informativas (não são o benchmark): para cada Filho, (a) trecho do meio e (b) 3 palavras raras
    como pergunta; recall@1 e recall@k de cada modo."""
    registros, _, _ = driver.execute_query(
        "MATCH (c:Child) RETURN c.id AS id, c.text AS text ORDER BY c.id", database_=banco
    )
    textos = {r["id"]: r["text"] for r in registros}
    raras = palavras_raras(textos)
    sondas = {
        "trecho_do_meio": {i: trecho_do_meio(t) for i, t in textos.items()},
        "palavras_raras": {i: " ".join(raras[i]) for i in textos},
    }
    saida: dict = {"filhos": len(textos), "k": k}
    for nome, perguntas in sondas.items():
        saida[nome] = {}
        for modo in MODOS:
            no1 = nok = 0
            for i, pergunta in perguntas.items():
                if not pergunta.strip():
                    continue
                ids = [x["id"] for x in buscar(driver, pergunta, embute_consulta, k, modo, banco=banco)]
                no1 += bool(ids) and ids[0] == i
                nok += i in ids
            saida[nome][modo] = {
                "recall_at_1": round(no1 / len(textos), 4),
                f"recall_at_{k}": round(nok / len(textos), 4),
            }
    return saida


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest="acao", required=True)
    sub.add_parser("criar-indice")
    b = sub.add_parser("buscar")
    b.add_argument("pergunta")
    b.add_argument("--modo", choices=MODOS, default="vetor")
    b.add_argument("--k", type=int, default=5)
    b.add_argument("--alfa", type=float, default=ALFA_PADRAO)
    b.add_argument("--json", action="store_true", help="saída completa em JSON")
    c = sub.add_parser("comparar")
    c.add_argument("--k", type=int, default=5)
    for p in (sub.choices["criar-indice"], b, c):
        p.add_argument("--swap", default="http://127.0.0.1:8080")
        p.add_argument("--raiz", type=Path, default=Path(".."))
        p.add_argument("--banco", default="neo4j")
    a = ap.parse_args()

    driver = conectar(a.raiz)
    try:
        if a.acao == "criar-indice":
            print(json.dumps(criar_indice_texto(driver, a.banco), ensure_ascii=False, indent=2))
            return
        embute = embutidor_llama(a.swap, MODELO_CONSULTA)
        if a.acao == "buscar":
            achados = buscar(driver, a.pergunta, embute, a.k, a.modo, a.alfa, banco=a.banco)
            if a.json:
                print(json.dumps(achados, ensure_ascii=False, indent=2))
            for x in achados:
                pag = x["pageStart"] if x["pageStart"] == x["pageEnd"] else f"{x['pageStart']}-{x['pageEnd']}"
                corpo = x["text"].replace("\n", " › ", 1)[:110]
                print(f"{x['score']:.4f}  p. {pag}  v#{x['posicao_vetor']} t#{x['posicao_texto']}  {corpo}")
        else:
            print(json.dumps(comparar(driver, embute, a.k, a.banco), ensure_ascii=False, indent=2))
    finally:
        driver.close()


if __name__ == "__main__":
    main()
