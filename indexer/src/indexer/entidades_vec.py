"""Embeddings dos resumos de entidade e índice `entity_vec` (§5 I-4 e §6.3, F5.7).

O texto de uma entidade é o nome, o tipo em português, o resumo da F5.4 e os apelidos (a resolução da F4.5 os
junta: "Bacen", "Banco Central do Brasil"...). Documentos vão ao embedder SEM instrução, em lote, pelo perfil
`vetorizar`; a consulta leva o prefixo `Instruct:` (como nos Filhos, F2.3). O vetor fica em
`__Entity__.embedding`, com o hash do texto em `embeddingHash`: `embutir` só refaz quem não tem vetor ou cujo
resumo mudou, então a F5.8 e as reexecuções custam o que mudou.

Autoteste, como o da F2.3: cada entidade é re-embutida pelo backend da CPU (outro processo, outro
arredondamento) e buscada no índice; o esperado é ela mesma em 1º lugar. Entidades de texto idêntico empatam
e o empate conta como acerto (`acertou_em_1`). Duas sondas só informativas: buscar pelo nome, com a instrução
de consulta, e buscar por um apelido; em ambas o esperado é a entidade entre as 3 primeiras.

Precisa do Neo4j e do llama-swap (perfil `vetorizar`). A partir de `indexer/`:
    uv run python -m indexer.entidades_vec embutir
    uv run python -m indexer.entidades_vec autoteste
    uv run python -m indexer.entidades_vec verificar
"""

from __future__ import annotations

import argparse
import hashlib
import json
import time
from collections.abc import Callable
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
from indexer.resumos import TIPOS_EM_PORTUGUES

MAX_ALIASES = 8
MAX_CHARS = 4000
TAREFA = "Given the name or a description of an entity in a company's annual report, retrieve that entity"

CRIAR_INDICE = (
    "CREATE VECTOR INDEX entity_vec IF NOT EXISTS FOR (n:__Entity__) ON n.embedding "
    f"OPTIONS {{indexConfig: {{`vector.dimensions`: {DIMENSOES}, `vector.similarity_function`: 'cosine'}}}}"
)
GRAVAR = (
    "UNWIND $rows AS r MATCH (e:__Entity__ {id: r.id}) "
    "CALL db.create.setNodeVectorProperty(e, 'embedding', r.vetor) "
    "SET e.embeddingModel = $modelo, e.embeddingDims = $dims, e.embeddingHash = r.hash"
)


def texto_da_entidade(e: dict) -> str:
    tipo = TIPOS_EM_PORTUGUES.get(e["type"], str(e["type"]).lower())
    linhas = [f"{e['name']} ({tipo}). {(e.get('summary') or '').strip()}".strip()]
    vistos = {e["name"].lower()}
    apelidos = []
    for a in e.get("aliases") or []:
        if a.strip() and a.lower() not in vistos:
            vistos.add(a.lower())
            apelidos.append(a.strip())
    if apelidos:
        linhas.append("Também chamada: " + " | ".join(apelidos[:MAX_ALIASES]))
    return "\n".join(linhas)[:MAX_CHARS]


def hash_do_texto(texto: str) -> str:
    return hashlib.sha256(texto.encode("utf-8")).hexdigest()[:16]


def precisam_de_vetor(entidades: list[dict], hash_gravado: dict[str, str | None]) -> list[dict]:
    return [e for e in entidades if hash_gravado.get(e["id"]) != hash_do_texto(texto_da_entidade(e))]


def acertou_em_1(esperado: str, achados: list[str], textos: dict[str, str]) -> bool:
    return bool(achados) and textos[achados[0]] == textos[esperado]


# ---- Neo4j ----------------------------------------------------------------------------------------------


def ler_entidades(driver: Any, banco: str = "neo4j") -> list[dict]:
    regs = driver.execute_query(
        "MATCH (e:__Entity__) RETURN e.id AS id, e.name AS name, e.type AS type, e.summary AS summary, "
        "coalesce(e.aliases, []) AS aliases, e.embeddingHash AS hash ORDER BY e.id",
        database_=banco,
    )[0]
    return [dict(r) for r in regs]


def embutir(driver: Any, embute: Callable, modelo: str, banco: str = "neo4j", lote: int = 16) -> dict:
    entidades = ler_entidades(driver, banco)
    faltam = precisam_de_vetor(entidades, {e["id"]: e["hash"] for e in entidades})
    t0 = time.perf_counter()
    for grupo in em_lotes(faltam, lote):
        textos = [texto_da_entidade(e) for e in grupo]
        vetores = embute(textos)
        rows = [
            {"id": e["id"], "vetor": v, "hash": hash_do_texto(t)}
            for e, t, v in zip(grupo, textos, vetores, strict=True)
        ]
        driver.execute_query(GRAVAR, {"rows": rows, "modelo": modelo, "dims": DIMENSOES}, database_=banco)
    driver.execute_query(CRIAR_INDICE, database_=banco)
    driver.execute_query("CALL db.awaitIndexes(300)", database_=banco)
    return {
        "entidades": len(entidades),
        "embutidas_agora": len(faltam),
        "segundos": round(time.perf_counter() - t0, 2),
        **estado_do_indice(driver, banco),
    }


def estado_do_indice(driver: Any, banco: str = "neo4j") -> dict:
    regs = driver.execute_query(
        "SHOW INDEXES YIELD name, type, state, populationPercent, options WHERE name = 'entity_vec' "
        "RETURN type, state, populationPercent, options",
        database_=banco,
    )[0]
    if not regs:
        return {"indice": False}
    r = regs[0]
    cfg = r["options"].get("indexConfig", {})
    return {
        "indice": True,
        "estado": r["state"],
        "populado_pct": r["populationPercent"],
        "dimensoes": cfg.get("vector.dimensions"),
        "similaridade": cfg.get("vector.similarity_function"),
    }


def autoteste(driver: Any, embute_consulta: Callable, banco: str = "neo4j") -> dict:
    entidades = ler_entidades(driver, banco)
    textos = {e["id"]: texto_da_entidade(e) for e in entidades}

    def buscar(vetor: list[float], k: int) -> list[str]:
        regs = driver.execute_query(
            "CALL db.index.vector.queryNodes('entity_vec', $k, $v) YIELD node RETURN node.id AS id",
            {"k": k, "v": vetor},
            database_=banco,
        )[0]
        return [r["id"] for r in regs]

    ids = [e["id"] for e in entidades]
    vetores = [v for g in em_lotes(ids, 16) for v in embute_consulta([textos[i] for i in g])]
    erradas = [i for i, v in zip(ids, vetores, strict=True) if not acertou_em_1(i, buscar(v, 1), textos)]

    def sonda(pares: list[tuple[str, str]]) -> dict:
        acertos = 0
        for i, consulta in pares:
            v = embute_consulta([formatar_consulta(consulta, TAREFA)])[0]
            acertos += any(textos[x] == textos[i] for x in buscar(v, 3))
        return {"consultas": len(pares), "top3": round(acertos / len(pares), 4) if pares else None}

    por_nome = sonda([(e["id"], e["name"]) for e in entidades])
    por_apelido = sonda(
        [(e["id"], a) for e in entidades for a in (e["aliases"] or [])[:MAX_ALIASES] if a.strip()]
    )
    return {
        "entidades": len(ids),
        "recall_at_1": round(1 - len(erradas) / len(ids), 4),
        "erradas": erradas[:20],
        "sonda_nome_top3": por_nome,
        "sonda_apelido_top3": por_apelido,
    }


SANIDADE = {
    "entidades_sem_embedding": "MATCH (e:__Entity__) WHERE e.embedding IS NULL RETURN count(e)",
    "entidades_sem_hash": "MATCH (e:__Entity__) WHERE e.embeddingHash IS NULL RETURN count(e)",
    "entidades_sem_resumo": "MATCH (e:__Entity__) WHERE e.summary IS NULL RETURN count(e)",
}


def main() -> None:  # pragma: no cover - orquestração de CLI; a lógica tem testes
    from indexer.grafo import conectar

    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("acao", choices=("embutir", "autoteste", "verificar"))
    ap.add_argument("--swap", default="http://127.0.0.1:8080")
    ap.add_argument("--raiz", type=Path, default=Path(".."))
    ap.add_argument("--banco", default="neo4j")
    a = ap.parse_args()
    driver = conectar(a.raiz)
    try:
        if a.acao == "embutir":
            r = embutir(driver, embutidor_llama(a.swap, MODELO_LOTE), MODELO_LOTE, a.banco)
        elif a.acao == "autoteste":
            r = {
                **estado_do_indice(driver, a.banco),
                **autoteste(driver, embutidor_llama(a.swap, MODELO_CONSULTA), a.banco),
            }
        else:
            r = {k: driver.execute_query(c, database_=a.banco)[0][0][0] for k, c in SANIDADE.items()}
        print(json.dumps(r, ensure_ascii=False, indent=1))
    finally:
        driver.close()


if __name__ == "__main__":
    main()
