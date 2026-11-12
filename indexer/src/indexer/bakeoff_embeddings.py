# ruff: noqa: E501  (docstring e textos longos de relatório)
"""Bake-off de embeddings (F9.3, `eval/f93-medida-embeddings.md`): embute os Filhos com cada candidato e mede a recuperação.

Cada candidato grava os vetores dos Filhos em UMA PROPRIEDADE E UM ÍNDICE PRÓPRIOS (`embedding_<tag>`, `child_vec_<tag>`); o
índice de produção (`child_vec`, Qwen3-Embedding-0.6B) não é tocado. A medida usa os mesmos Filhos, o mesmo full-text, o mesmo
reranker e as mesmas perguntas; só muda o índice vetorial e o formato da consulta/do documento que o candidato pede.

Comandos (a partir de indexer/, com Neo4j e llama-swap no ar; o perfil do candidato é `f93-<tag>`):
    uv run python -m indexer.bakeoff_embeddings embutir  --candidato qwen4b
    uv run python -m indexer.bakeoff_embeddings latencia --candidato qwen4b          # consulta na CPU, p50/p95
    uv run python -m indexer.bakeoff_embeddings medir    --candidato qwen4b          # recuperação (sem LLM de resposta)
    uv run python -m indexer.bakeoff_embeddings julgar   --candidato qwen4b          # recall de contexto (juiz, perfil avaliar)
"""

from __future__ import annotations

import argparse
import json
import statistics
import time
from collections.abc import Callable
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from indexer import busca
from indexer.ask import recuperar_e_reranquear, rotulo_de_pagina
from indexer.avaliar import ler_golden, montar_relatorio
from indexer.embeddings import (
    GRAVAR,
    TAMANHO_DO_LOTE,
    em_lotes,
    embutidor_llama,
    formatar_consulta,
)
from indexer.grafo import conectar
from indexer.reranker import reranqueador_llama


@dataclass(frozen=True)
class Candidato:
    tag: str
    rotulo: str
    modelo_gpu: str  # nome no llama-swap: lote e consulta da medida (GPU)
    modelo_cpu: str  # nome no llama-swap: como a consulta roda na produção (CPU)
    dims: int
    arquivo: str
    documento: Callable[[str], str]
    consulta: Callable[[str], str]

    @property
    def propriedade(self) -> str:
        return "embedding" if self.tag == "qwen06" else f"embedding_{self.tag}"

    @property
    def indice(self) -> str:
        return "child_vec" if self.tag == "qwen06" else f"child_vec_{self.tag}"

    @property
    def perfil(self) -> str:
        return "f93-" + self.tag


def _simples(t: str) -> str:
    return t


CANDIDATOS: dict[str, Candidato] = {
    c.tag: c
    for c in (
        # incumbente: refeito aqui só para a medida (mesmo harness) e comparado ao índice de produção
        Candidato(
            "qwen06",
            "Qwen3-Embedding-0.6B Q8_0 (produção)",
            "qwen3-embed-0.6b-lote",
            "qwen3-embed-0.6b",
            1024,
            "Qwen3-Embedding-0.6B-Q8_0.gguf",
            _simples,
            formatar_consulta,
        ),  # fmt: skip
        Candidato(
            "qwen4b",
            "Qwen3-Embedding-4B Q8_0",
            "qwen3-embed-4b-lote",
            "qwen3-embed-4b",
            2560,
            "Qwen3-Embedding-4B-Q8_0.gguf",
            _simples,
            formatar_consulta,
        ),  # fmt: skip
        # EmbeddingGemma 2: "title: none | text:" no documento (o Filho já traz o caminho da seção no texto) e
        # "task: search result | query:" na consulta, como o cartão do modelo manda
        Candidato(
            "gemma2",
            "EmbeddingGemma 2 Q8_0 (768d)",
            "embeddinggemma-2-lote",
            "embeddinggemma-2",
            768,
            "embeddinggemma-2-Q8_0.gguf",
            lambda t: f"title: none | text: {t}",
            lambda q: f"task: search result | query: {q}",
        ),  # fmt: skip
        # bge-m3: sem instrução, nos dois lados
        Candidato(
            "bgem3", "bge-m3 Q8_0", "bge-m3-lote", "bge-m3", 1024, "bge-m3-q8_0.gguf", _simples, _simples
        ),
    )
}
K_FILHOS = 6
GOLDENS = {"60": "../eval/golden.csv", "24": "../eval/golden_novas.csv"}
DEGRAUS_DA_MEDIDA = {"r1": "vetor", "r2": "hibrido-rrf", "r3": "pipeline"}  # r3 = Pai + reranker (A3)
JULGADOS = ("r1", "r3")  # r2 só tem a parte mecânica (page recall)


def nome_da_execucao(cand: Candidato, degrau: str, grupo: str) -> str:
    return f"f93{'n' if grupo == '24' else ''}-{cand.tag}-{degrau}"


def embutir(driver: Any, cand: Candidato, swap: str, raiz: Path) -> dict:
    """Embute TODOS os Filhos com o candidato (retomável) e cria o índice próprio; grava tempo e vazão."""
    embute = embutidor_llama(swap, cand.modelo_gpu, cand.dims)
    pend, _, _ = driver.execute_query(
        f"MATCH (c:Child) WHERE c.{cand.propriedade} IS NULL RETURN c.id AS id, c.text AS text ORDER BY c.id"
    )
    total, _, _ = driver.execute_query("MATCH (c:Child) RETURN count(c) AS n, sum(c.tokens) AS tokens")
    # vazão comparável entre candidatos (inclusive o incumbente, que já tem vetores): 200 Filhos, sem gravar
    amostra, _, _ = driver.execute_query("MATCH (c:Child) RETURN c.text AS text ORDER BY c.id LIMIT 200")
    textos = [cand.documento(r["text"]) for r in amostra]
    embute(textos[:TAMANHO_DO_LOTE])  # aquecimento
    t1 = time.perf_counter()
    for grupo in em_lotes(textos, TAMANHO_DO_LOTE):
        embute(grupo)
    vazao = len(textos) / (time.perf_counter() - t1)
    gravar = GRAVAR.replace("'embedding'", f"'{cand.propriedade}'").replace(
        "c.embeddingModel", f"c.{cand.propriedade}Model"
    )
    gravar = gravar.replace("c.embeddingDims", f"c.{cand.propriedade}Dims")
    t0 = time.perf_counter()
    for grupo in em_lotes([dict(r) for r in pend], TAMANHO_DO_LOTE):
        vetores = embute([cand.documento(f["text"]) for f in grupo])
        rows = [{"id": f["id"], "vetor": v} for f, v in zip(grupo, vetores, strict=True)]
        driver.execute_query(gravar, {"rows": rows, "modelo": cand.modelo_gpu, "dims": cand.dims})
    seg = time.perf_counter() - t0
    driver.execute_query(
        f"CREATE VECTOR INDEX {cand.indice} IF NOT EXISTS FOR (n:Child) ON n.{cand.propriedade} "
        f"OPTIONS {{indexConfig: {{`vector.dimensions`: {cand.dims}, `vector.similarity_function`: 'cosine'}}}}"
    )
    driver.execute_query("CALL db.awaitIndexes(300)")
    n = total[0]["n"]
    r = {
        "candidato": cand.tag,
        "filhos": n,
        "tokens_dos_filhos": total[0]["tokens"],
        "embutidos_agora": len(pend),
        "segundos_agora": round(seg, 1),
        "filhos_por_segundo_amostra_de_200": round(vazao, 1),
        "filhos_por_segundo_na_carga": round(len(pend) / seg, 1) if len(pend) and seg else None,
        "dims": cand.dims,
        "mb_dos_vetores": round(n * cand.dims * 4 / 1e6, 1),
        "arquivo_mb": round((Path("C:/modelos") / cand.arquivo).stat().st_size / 1e6),
    }
    destino = raiz / "eval" / "resultados" / f"f93-embutir-{cand.tag}.json"
    destino.parent.mkdir(parents=True, exist_ok=True)
    destino.write_text(json.dumps(r, ensure_ascii=False, indent=1), encoding="utf-8")
    return r


def latencia_cpu(cand: Candidato, swap: str, raiz: Path, perguntas: list[str]) -> dict:
    """Tempo de embutir UMA consulta na CPU (como a produção faz), por pergunta, depois de 3 aquecimentos."""
    embute = embutidor_llama(swap, cand.modelo_cpu, cand.dims)
    for q in perguntas[:3]:
        embute([cand.consulta(q)])
    tempos = []
    for q in perguntas:
        t = time.perf_counter()
        embute([cand.consulta(q)])
        tempos.append((time.perf_counter() - t) * 1000)
    tempos.sort()
    r = {
        "candidato": cand.tag,
        "consultas": len(tempos),
        "p50_ms": round(statistics.median(tempos), 1),
        "p95_ms": round(tempos[max(0, round(0.95 * len(tempos)) - 1)], 1),
        "maximo_ms": round(tempos[-1], 1),
    }
    destino = raiz / "eval" / "resultados" / f"f93-latencia-{cand.tag}.json"
    destino.write_text(json.dumps(r, ensure_ascii=False, indent=1), encoding="utf-8")
    return r


def sistema(driver: Any, cand: Candidato, degrau: str, embute, notas):
    """Recuperação sem LLM de resposta: devolve só o `contexto` que o LLM veria naquele degrau."""

    def responde(caso: dict) -> dict:
        p = caso["pergunta"]
        if degrau == "r3":
            r = recuperar_e_reranquear(driver, p, embute, notas, "hibrido-rrf")
            ctx = [
                {"paginas": rotulo_de_pagina(x), "caminho": x["caminho"], "texto": x["text"]}
                for x in r["pais"]
            ]
        else:
            modo = "vetor" if degrau == "r1" else "hibrido-rrf"
            filhos = busca.buscar(driver, p, embute, k=K_FILHOS, modo=modo)
            ctx = [{"paginas": rotulo_de_pagina(f), "caminho": "", "texto": f["text"]} for f in filhos]
        return {"resposta": "", "contexto": ctx, "citacoes": [], "citacoes_invalidas": 0}

    return responde


def medir(driver: Any, cand: Candidato, swap: str, raiz: Path) -> None:
    from indexer.avaliar import gerar

    busca.INDICE_VETORIAL = cand.indice
    busca.FORMATADOR_DA_CONSULTA = cand.consulta
    embute = embutidor_llama(swap, cand.modelo_gpu, cand.dims)
    notas = reranqueador_llama(swap)
    primeira = ler_golden(Path(GOLDENS["60"]))[0]
    for grupo, golden in GOLDENS.items():
        casos = ler_golden(Path(golden))
        for degrau in DEGRAUS_DA_MEDIDA:
            nome = nome_da_execucao(cand, degrau, grupo)
            pasta = raiz / "data" / "avaliacao" / nome
            sis = sistema(driver, cand, degrau, embute, notas)
            if not (pasta / "respostas.jsonl").exists():
                sis(primeira)  # aquece embedding e reranker: a latência não inclui a carga fria
            gerar(casos, sis, pasta)
            print(nome, "ok", flush=True)


def julgar(cand: Candidato, swap: str, raiz: Path) -> None:
    from indexer.avaliar import juiz_llama
    from indexer.avaliar import julgar as julga

    juiz = juiz_llama(swap)
    for grupo, golden in GOLDENS.items():
        casos = ler_golden(Path(golden))
        for degrau in DEGRAUS_DA_MEDIDA:
            nome = nome_da_execucao(cand, degrau, grupo)
            pasta = raiz / "data" / "avaliacao" / nome
            respostas = [
                json.loads(x) for x in (pasta / "respostas.jsonl").read_text(encoding="utf-8").splitlines()
            ]
            notas = julga(casos, respostas, juiz, pasta, ("recall_contexto",)) if degrau in JULGADOS else []
            rel = montar_relatorio(nome, casos, respostas, notas, degrau)
            destino = raiz / "eval" / "resultados" / f"{nome}.json"
            destino.write_text(json.dumps(rel, ensure_ascii=False, indent=1), encoding="utf-8")
            print(nome, "julgado" if degrau in JULGADOS else "mecânico", flush=True)


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("acao", choices=["embutir", "latencia", "medir", "julgar"])
    ap.add_argument("--candidato", required=True, choices=sorted(CANDIDATOS))
    ap.add_argument("--swap", default="http://127.0.0.1:8080")
    ap.add_argument("--raiz", type=Path, default=Path(".."))
    a = ap.parse_args()
    cand = CANDIDATOS[a.candidato]
    if a.acao == "julgar":
        julgar(cand, a.swap, a.raiz)
        return
    driver = conectar(a.raiz)
    try:
        if a.acao == "embutir":
            print(json.dumps(embutir(driver, cand, a.swap, a.raiz), ensure_ascii=False, indent=1))
        elif a.acao == "latencia":
            perguntas = [c["pergunta"] for c in ler_golden(Path(GOLDENS["60"]))]
            print(json.dumps(latencia_cpu(cand, a.swap, a.raiz, perguntas), ensure_ascii=False, indent=1))
        else:
            medir(driver, cand, a.swap, a.raiz)
    finally:
        driver.close()


if __name__ == "__main__":
    main()
