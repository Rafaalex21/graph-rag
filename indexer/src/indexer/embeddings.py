"""I-4 · Embeddings dos Filhos e índice `child_vec` (ARQUITETURA §5 I-4 e §6.3, tarefa F2.3).

* Documentos (Filhos) são embutidos SEM instrução, em lote, pelo perfil `vetorizar` do llama-swap
  (Qwen3-Embedding-0.6B na GPU, `/v1/embeddings`); consultas levam o prefixo `Instruct: ...\\nQuery: ...`.
* Os vetores (1024 dims, norma 1) ficam na propriedade `embedding` do nó `Child`; o índice `child_vec`
  usa cosseno.
* Autoteste: cada Filho é re-embutido por OUTRO backend (o modelo na CPU, uma consulta por vez) e buscado
  no índice; o esperado é o próprio Filho em 1º lugar (recall@1). Isso cobre a consistência GPU × CPU e a
  acurácia do índice aproximado. Uma sonda mais difícil (trecho do meio do Filho, com instrução de
  consulta) é só informativa.

Uso (a partir de indexer/, com llama-swap e Neo4j no ar):
    uv run python -m indexer.embeddings embutir                # embute os Filhos sem vetor e cria o índice
    uv run python -m indexer.embeddings autoteste              # recall@1 (GPU -> CPU) e sonda de trecho
"""

from __future__ import annotations

import argparse
import json
import math
import time
import urllib.request
from collections.abc import Callable
from pathlib import Path
from typing import Any

from indexer.grafo import conectar

DIMENSOES = 1024
MODELO_LOTE = "qwen3-embed-0.6b-lote"  # perfil vetorizar: GPU, em lote
MODELO_CONSULTA = "qwen3-embed-0.6b"  # CPU, uma consulta por vez
TAREFA_PADRAO = "Given a question about a company's annual report, retrieve relevant passages that answer it"
TAMANHO_DO_LOTE = 16
LIMIAR_RECALL = 0.98

CRIAR_INDICE = (
    "CREATE VECTOR INDEX child_vec IF NOT EXISTS FOR (n:Child) ON n.embedding "
    f"OPTIONS {{indexConfig: {{`vector.dimensions`: {DIMENSOES}, `vector.similarity_function`: 'cosine'}}}}"
)
GRAVAR = (
    "UNWIND $rows AS r MATCH (c:Child {id: r.id}) "
    "CALL db.create.setNodeVectorProperty(c, 'embedding', r.vetor) "
    "SET c.embeddingModel = $modelo, c.embeddingDims = $dims"
)

Embutidor = Callable[[list[str]], list[list[float]]]


def formatar_consulta(pergunta: str, tarefa: str = TAREFA_PADRAO) -> str:
    """Formato de consulta recomendado para o Qwen3-Embedding (a instrução vai em inglês)."""
    return f"Instruct: {tarefa}\nQuery: {pergunta}"


def embutidor_llama(base: str, modelo: str, dimensoes: int = DIMENSOES) -> Embutidor:
    """Função texto(s) -> vetor(es) pelo `/v1/embeddings` do llama-swap; confere dimensão e norma."""

    def embute(textos: list[str]) -> list[list[float]]:
        req = urllib.request.Request(
            f"{base}/v1/embeddings",
            data=json.dumps({"model": modelo, "input": textos}).encode("utf-8"),
            headers={"Content-Type": "application/json; charset=utf-8"},
        )
        with urllib.request.urlopen(req, timeout=600) as r:
            dados = sorted(json.load(r)["data"], key=lambda d: d["index"])
        vetores = [d["embedding"] for d in dados]
        if len(vetores) != len(textos):
            raise ValueError(f"{len(textos)} textos, {len(vetores)} vetores")
        for v in vetores:
            conferir_vetor(v, dimensoes)
        return vetores

    return embute


def conferir_vetor(vetor: list[float], dimensoes: int = DIMENSOES, tolerancia: float = 1e-3) -> None:
    if len(vetor) != dimensoes:
        raise ValueError(f"vetor com {len(vetor)} dimensões, esperado {dimensoes}")
    norma = math.sqrt(sum(x * x for x in vetor))
    if abs(norma - 1) > tolerancia:
        raise ValueError(f"vetor não normalizado (norma {norma:.6f})")


def em_lotes(itens: list[Any], tamanho: int):
    for i in range(0, len(itens), tamanho):
        yield itens[i : i + tamanho]


def pendentes(driver: Any, banco: str = "neo4j") -> list[dict]:
    registros, _, _ = driver.execute_query(
        "MATCH (c:Child) WHERE c.embedding IS NULL RETURN c.id AS id, c.text AS text ORDER BY c.id",
        database_=banco,
    )
    return [{"id": r["id"], "text": r["text"]} for r in registros]


def embutir_filhos(
    driver: Any, embute: Embutidor, modelo: str, banco: str = "neo4j", lote: int = TAMANHO_DO_LOTE
) -> dict:
    """Embute os Filhos que ainda não têm vetor (retomável) e grava no banco."""
    faltam = pendentes(driver, banco)
    t0 = time.perf_counter()
    for grupo in em_lotes(faltam, lote):
        vetores = embute([f["text"] for f in grupo])
        rows = [{"id": f["id"], "vetor": v} for f, v in zip(grupo, vetores, strict=True)]
        driver.execute_query(GRAVAR, {"rows": rows, "modelo": modelo, "dims": DIMENSOES}, database_=banco)
    segundos = time.perf_counter() - t0
    return {
        "embutidos": len(faltam),
        "segundos": round(segundos, 2),
        "filhos_por_segundo": round(len(faltam) / segundos, 1) if faltam and segundos else None,
    }


def criar_indice(driver: Any, banco: str = "neo4j", espera: int = 300) -> dict:
    driver.execute_query(CRIAR_INDICE, database_=banco)
    driver.execute_query(f"CALL db.awaitIndexes({espera})", database_=banco)
    return estado_do_indice(driver, banco)


def estado_do_indice(driver: Any, banco: str = "neo4j") -> dict:
    registros, _, _ = driver.execute_query(
        "SHOW INDEXES YIELD name, type, state, populationPercent, options WHERE name = 'child_vec' "
        "RETURN name, type, state, populationPercent, options",
        database_=banco,
    )
    if not registros:
        return {"existe": False}
    r = registros[0]
    config = r["options"].get("indexConfig", {})
    return {
        "existe": True,
        "tipo": r["type"],
        "estado": r["state"],
        "populado_pct": r["populationPercent"],
        "dimensoes": config.get("vector.dimensions"),
        "similaridade": config.get("vector.similarity_function"),
    }


def buscar(driver: Any, vetor: list[float], k: int, banco: str = "neo4j") -> list[tuple[str, float]]:
    registros, _, _ = driver.execute_query(
        "CALL db.index.vector.queryNodes('child_vec', $k, $v) YIELD node, score RETURN node.id AS id, score",
        {"k": k, "v": vetor},
        database_=banco,
    )
    return [(r["id"], r["score"]) for r in registros]


def trecho_do_meio(texto: str, palavras: int = 40) -> str:
    """Trecho de ~`palavras` palavras do meio do corpo do Filho (sem a linha do prefixo)."""
    corpo = texto.split("\n", 1)[1] if "\n" in texto else texto
    p = corpo.split()
    if len(p) <= palavras:
        return corpo
    ini = (len(p) - palavras) // 2
    return " ".join(p[ini : ini + palavras])


def autoteste(driver: Any, embute_consulta: Embutidor, banco: str = "neo4j", sonda: bool = True) -> dict:
    registros, _, _ = driver.execute_query(
        "MATCH (c:Child) WHERE c.embedding IS NOT NULL RETURN c.id AS id, c.text AS text ORDER BY c.id",
        database_=banco,
    )
    filhos = [{"id": r["id"], "text": r["text"]} for r in registros]
    acertos, falhas = 0, []
    for f in filhos:
        (vetor,) = embute_consulta([f["text"]])  # texto do documento, sem instrução, pelo backend da CPU
        topo = buscar(driver, vetor, 1, banco)
        if topo and topo[0][0] == f["id"]:
            acertos += 1
        else:
            falhas.append({"id": f["id"], "obteve": topo[0][0] if topo else None})
    resultado = {
        "filhos": len(filhos),
        "recall_at_1": round(acertos / len(filhos), 4) if filhos else None,
        "acertos": acertos,
        "falhas": falhas[:10],
        "aprovado": bool(filhos) and acertos / len(filhos) >= LIMIAR_RECALL,
    }
    if sonda:
        no1 = no5 = 0
        for f in filhos:
            (vetor,) = embute_consulta([formatar_consulta(trecho_do_meio(f["text"]))])
            ids = [i for i, _ in buscar(driver, vetor, 5, banco)]
            no1 += bool(ids) and ids[0] == f["id"]
            no5 += f["id"] in ids
        resultado["sonda_trecho_do_meio"] = {
            "recall_at_1": round(no1 / len(filhos), 4),
            "recall_at_5": round(no5 / len(filhos), 4),
        }
    return resultado


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("acao", choices=["embutir", "autoteste"])
    ap.add_argument("--swap", default="http://127.0.0.1:8080")
    ap.add_argument("--raiz", type=Path, default=Path(".."))
    ap.add_argument("--banco", default="neo4j")
    a = ap.parse_args()

    driver = conectar(a.raiz)
    try:
        if a.acao == "embutir":
            print(
                json.dumps(embutir_filhos(driver, embutidor_llama(a.swap, MODELO_LOTE), MODELO_LOTE, a.banco))
            )
            print(json.dumps(criar_indice(driver, a.banco), ensure_ascii=False, indent=2))
        else:
            print(json.dumps(estado_do_indice(driver, a.banco), ensure_ascii=False))
            r = autoteste(driver, embutidor_llama(a.swap, MODELO_CONSULTA), a.banco)
            print(json.dumps(r, ensure_ascii=False, indent=2))
    finally:
        driver.close()


if __name__ == "__main__":
    main()
