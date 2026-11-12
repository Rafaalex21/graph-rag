# ruff: noqa: E501  (módulo de relatório: as linhas longas são texto de tabela em Markdown)
"""Bake-off de embeddings da F9.3 (`eval/f93-medida-embeddings.md`): tabela e aplicação das regras de decisão, sem LLM.

Junta os relatórios de recuperação de cada candidato (`f93-<tag>-r1|r2|r3` nas 60 perguntas, `f93n-...` nas 24 do grupo novo), os
custos medidos (`f93-embutir-<tag>.json`, `f93-latencia-<tag>.json`) e escreve `eval/resultados/f93-embeddings.md`. As regras
foram escritas e commitadas antes da primeira rodada; aqui elas só são aplicadas.

Uso (a partir de indexer/):
    uv run python -m indexer.f93
"""

from __future__ import annotations

import argparse
import json
from pathlib import Path

TAGS = ("qwen06", "qwen4b", "gemma2", "bgem3")
ROTULO = {
    "qwen06": "Qwen3-Embedding-0.6B (produção)",
    "qwen4b": "Qwen3-Embedding-4B",
    "gemma2": "EmbeddingGemma 2",
    "bgem3": "bge-m3",
}
MARGEM = 0.05  # diferença menor que isto vale como empate
QUEDA_MAXIMA_PAGE_RECALL = 0.02
LATENCIA_MAXIMA_CPU_MS = 1000.0
TOLERANCIA_DA_VALIDACAO = 0.02  # incumbente refeito x F9.1


def _carregar(res: Path, nome: str) -> dict | None:
    p = res / f"{nome}.json"
    return json.loads(p.read_text(encoding="utf-8")) if p.exists() else None


def _rc(rel: dict | None) -> float | None:
    return rel["geral"]["recall_contexto"]["media"] if rel else None


def _pr(rel: dict | None, k: str = "@6") -> float | None:
    return rel["mecanicas"]["geral"]["page_recall"][k]["media"] if rel else None


def _n(v: float | None, casas: int = 2) -> str:
    return "—" if v is None else f"{v:.{casas}f}".replace(".", ",")


def avaliar(rels: dict[str, dict[str, dict | None]], custos: dict[str, dict]) -> dict:
    """Regra do bake-off: cada candidato contra o incumbente (qwen06) no A3 (pipeline de produção)."""
    base = rels["qwen06"]
    saida = {}
    for tag in TAGS[1:]:
        r = rels[tag]
        if not all(r.get(k) and base.get(k) for k in ("60-r3", "24-r3")):
            saida[tag] = {"qualidade": "sem relatório (não rodou)", "substitui": False}
            continue
        d60 = _rc(r["60-r3"]) - _rc(base["60-r3"])
        d24 = _rc(r["24-r3"]) - _rc(base["24-r3"])
        dpr = _pr(r["60-r3"]) - _pr(base["60-r3"])
        if d60 >= MARGEM and d24 >= MARGEM and dpr >= -QUEDA_MAXIMA_PAGE_RECALL:
            qualidade = "melhor"
        elif d60 <= -MARGEM or d24 <= -MARGEM:
            qualidade = "pior"
        else:
            qualidade = "equivalente"
        lat = custos.get(tag, {}).get("latencia", {}).get("p50_ms")
        elegivel = lat is not None and lat <= LATENCIA_MAXIMA_CPU_MS
        saida[tag] = {
            "delta_recall_contexto_60": round(d60, 4),
            "delta_recall_contexto_24": round(d24, 4),
            "delta_page_recall_6_60": round(dpr, 4),
            "qualidade": qualidade,
            "latencia_cpu_p50_ms": lat,
            "elegivel_pela_latencia": elegivel,
            "substitui": qualidade == "melhor" and elegivel,
        }
    ranque = [t for t, v in saida.items() if v["substitui"]]
    escolhido = max(ranque, key=lambda t: _rc(rels[t]["60-r3"])) if ranque else "qwen06"
    return {"por_candidato": saida, "escolhido": escolhido}


def validar_harness(rels: dict, ref: dict[str, dict | None]) -> dict:
    """O incumbente refeito pelo harness da F9.3 tem de reproduzir o page recall@6 do A1 e do A3 da F9.1."""
    saida = {}
    for degrau, nome in (("r1", "v1-a1"), ("r3", "v1-a3")):
        novo, antigo = _pr(rels["qwen06"].get(f"60-{degrau}")), _pr(ref.get(nome))
        if novo is None or antigo is None:
            saida[degrau] = {"valido": False, "motivo": "sem relatório"}
            continue
        saida[degrau] = {
            "f93": round(novo, 4),
            "f91": round(antigo, 4),
            "diferenca": round(novo - antigo, 4),
            "valido": abs(novo - antigo) <= TOLERANCIA_DA_VALIDACAO,
        }
    return saida


def montar(rels: dict, custos: dict, veredito: dict, validacao: dict) -> str:
    def tabela(grupo: str, titulo: str) -> list[str]:
        linhas = [
            f"### {titulo}",
            "",
            "| Candidato | Recall de contexto A1 | Recall de contexto A3 | Page recall@1 / @3 / @6 (A1) | Page recall@1 / @3 / @6 (A2) | Page recall@1 / @3 / @6 (A3) |",
            "|---|---:|---:|---|---|---|",
        ]
        for t in TAGS:
            r = rels[t]

            def pr3(k: str, r: dict = r) -> str:
                return " / ".join(_n(_pr(r.get(f"{grupo}-{k}"), kk)) for kk in ("@1", "@3", "@6"))

            if not r.get(f"{grupo}-r3"):
                continue
            linhas.append(
                f"| **{ROTULO[t]}** | {_n(_rc(r.get(f'{grupo}-r1')))} | {_n(_rc(r.get(f'{grupo}-r3')))} | {pr3('r1')} | {pr3('r2')} | {pr3('r3')} |"
            )
        return [*linhas, ""]

    out = [
        "# Bake-off de embeddings (F9.3): Qwen3-Embedding-0.6B contra três candidatos",
        "",
        "Mesmos Filhos, mesmo full-text, mesmo reranker, mesmo juiz (Gemma 4 26B-A4B), mesmas perguntas; só mudam o índice vetorial dos Filhos e o formato "
        "da consulta e do documento que cada modelo pede. **A1** = só vetor (6 Filhos); **A2** = híbrido RRF (6 Filhos); **A3** = o pipeline de produção "
        "(24 Pais → rerank → 6 Pais). Recall de contexto = fração do gabarito que o contexto recuperado sustenta (juiz); sem LLM de resposta. Definição, regras e "
        "limites em [`eval/f93-medida-embeddings.md`](../f93-medida-embeddings.md), fixados antes de rodar. Uma execução por candidato; **diferença menor "
        "que 0,05 em recall de contexto vale como empate**.",
        "",
        "## Recuperação",
        "",
        *tabela("60", "60 perguntas do `eval/golden.csv`"),
        *tabela("24", "24 perguntas do grupo novo (`eval/golden_novas.csv`, fora do ajuste)"),
        "### Validação do harness (o incumbente refeito reproduz a F9.1)",
        "",
        "| Degrau | Page recall@6 aqui | Page recall@6 na F9.1 | Diferença | Dentro de ±0,02 |",
        "|---|---:|---:|---:|---|",
    ]
    for d, v in validacao.items():
        out.append(
            f"| {d} | {_n(v.get('f93'), 4)} | {_n(v.get('f91'), 4)} | {_n(v.get('diferenca'), 4)} | {'sim' if v['valido'] else 'NÃO: ' + str(v.get('motivo', ''))} |"
        )
    out += [
        "",
        "## Custo",
        "",
        "| Candidato | Arquivo (MB) | Dimensões | Vetores dos Filhos (MB) | Embutir Filhos (por s, GPU) | Consulta na CPU p50 / p95 (ms) |",
        "|---|---:|---:|---:|---:|---:|",
    ]
    for t in TAGS:
        c = custos.get(t, {})
        e, la = c.get("embutir", {}), c.get("latencia", {})
        out.append(
            f"| **{ROTULO[t]}** | {e.get('arquivo_mb', '—')} | {e.get('dims', '—')} | {e.get('mb_dos_vetores', '—')} | {_n(e.get('filhos_por_segundo_amostra_de_200'), 1)} "
            f"| {_n(la.get('p50_ms'), 1)} / {_n(la.get('p95_ms'), 1)} |"
        )
    out += [
        "",
        "## Aplicação da regra",
        "",
        "| Candidato | Δ recall de contexto A3 (60) | Δ recall de contexto A3 (24) | Δ page recall@6 A3 (60) | Qualidade | Consulta CPU p50 (ms) | Substitui o Qwen3-0.6B |",
        "|---|---:|---:|---:|---|---:|---|",
    ]
    for t, v in veredito["por_candidato"].items():
        if "delta_recall_contexto_60" not in v:
            out.append(f"| {ROTULO[t]} | — | — | — | {v['qualidade']} | — | não |")
            continue
        out.append(
            f"| {ROTULO[t]} | {_n(v['delta_recall_contexto_60'])} | {_n(v['delta_recall_contexto_24'])} | {_n(v['delta_page_recall_6_60'])} "
            f"| {v['qualidade']} | {_n(v['latencia_cpu_p50_ms'], 1)} | {'**sim**' if v['substitui'] else 'não'} |"
        )
    out += [
        "",
        f"**Embedding pela regra: {ROTULO[veredito['escolhido']]}.**",
        "",
        "Regerar: `uv run python -m indexer.f93` (a partir de `indexer/`, sem LLM).",
        "",
    ]
    return "\n".join(out)


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--raiz", type=Path, default=Path(".."))
    a = ap.parse_args()
    res = a.raiz / "eval" / "resultados"
    rels = {
        t: {
            f"{g}-{d}": _carregar(res, f"f93{'n' if g == '24' else ''}-{t}-{d}")
            for g in ("60", "24")
            for d in ("r1", "r2", "r3")
        }
        for t in TAGS
    }
    custos = {
        t: {
            "embutir": _carregar(res, f"f93-embutir-{t}") or {},
            "latencia": _carregar(res, f"f93-latencia-{t}") or {},
        }
        for t in TAGS
    }
    veredito = avaliar(rels, custos)
    validacao = validar_harness(rels, {"v1-a1": _carregar(res, "v1-a1"), "v1-a3": _carregar(res, "v1-a3")})
    texto = montar(rels, custos, veredito, validacao)
    (res / "f93-embeddings.md").write_text(texto, encoding="utf-8")
    print(texto)


if __name__ == "__main__":
    main()
