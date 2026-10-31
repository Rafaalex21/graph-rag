"""Tabela da escada de ablações (ARQUITETURA §13.3, tarefa F3.5): `eval/resultados/v0.md`.

Junta os relatórios por execução (`eval/resultados/<nome>.json`, F3.2 e F3.3) numa tabela com uma linha por
degrau. As métricas valem para as perguntas com `no_recorte = sim` (até a F5.8 só elas têm resposta possível).

Uso (a partir de indexer/, sem LLM):
    uv run python -m indexer.tabela
"""

from __future__ import annotations

import argparse
import json
from pathlib import Path

# (rótulo, relatório, descrição)
LINHAS = [
    ("A0", "v0-a0", "LLM sem recuperação (de memória)"),
    ("A1", "v0-a1", "Vetor ingênuo: 6 Filhos"),
    ("A2", "v0-a2", "+ full-text (híbrido RRF): 6 Filhos"),
    ("A3", "f3-2-a3-60", "+ Pai e reranker (24 Pais → 6)"),
    ("A3r", "v0-a3r", "A3 + reescrita (step-back e HyDE)"),
]
CATEGORIAS = [
    ("factual_textual", "Factual"),
    ("numerica", "Numérica"),
    ("agregacao_filtro", "Agregação"),
    ("tematica_global", "Temática"),
    ("multi_hop", "Multi-hop"),
    ("fora_do_escopo", "Fora do escopo"),
]


def num(x: dict | None, casas: int = 2) -> str:
    if not x or x.get("media") is None:
        return "—"
    return f"{x['media']:.{casas}f}".replace(".", ",")


def seg(v: float | None) -> str:
    return "—" if v is None else f"{v:.1f}".replace(".", ",")


def montar(relatorios: dict[str, dict]) -> str:
    """Markdown com a tabela principal (recorte) e a de correção por categoria."""
    principal = [
        "| Degrau | Configuração | Correção | Fidelidade | Recall de contexto | Page recall@6 "
        "| Acerto numérico | Latência p50 / p95 (s) |",
        "|---|---|---:|---:|---:|---:|---:|---:|",
    ]
    por_cat = [
        "| Degrau | " + " | ".join(r for _, r in CATEGORIAS) + " |",
        "|---|" + "---:|" * len(CATEGORIAS),
    ]
    for rotulo, nome, descricao in LINHAS:
        rel = relatorios.get(nome)
        if rel is None:
            principal.append(f"| {rotulo} | {descricao} | (não rodado) | | | | | |")
            continue
        r, m = rel["so_no_recorte"], rel["mecanicas"]["so_no_recorte"]
        sem = rotulo == "A0"  # sem contexto, recall e fidelidade não têm o que medir
        fid = "n/a" if sem else num(r["fidelidade"])
        rec = "n/a" if sem else num(r["recall_contexto"])
        lat = f"{seg(m['latencia_s']['p50'])} / {seg(m['latencia_s']['p95'])}"
        principal.append(
            f"| **{rotulo}** | {descricao} | {num(r['correcao'])} | {fid} | {rec} "
            f"| {num(m['page_recall']['@6'])} | {num(m['acerto_numerico'])} | {lat} |"
        )
        por_cat.append(
            f"| **{rotulo}** | "
            + " | ".join(num(rel["por_categoria"][c]["correcao"]) for c, _ in CATEGORIAS)
            + " |"
        )
    ns = relatorios.get("f3-2-a3-60") or next(iter(relatorios.values()))
    n = ns["so_no_recorte"]["correcao"]["n"]
    return "\n".join(
        [
            "# Linha de base v0: escada de ablações A0 a A3",
            "",
            f"Golden set de 60 perguntas, avaliadas **só nas {n} com `no_recorte` = sim** "
            "(índice de 79 páginas); juiz Gemma 4 26B-A4B "
            "([ADR-028](../../docs/adr/ADR-028-metricas-com-juiz-local.md)), "
            "métricas mecânicas do [ADR-029](../../docs/adr/ADR-029-metricas-mecanicas.md). "
            "O mesmo LLM de resposta (Qwen3.6, temperatura 0,2) e o mesmo prompt em A1 a A3r.",
            "",
            "## Resultado",
            "",
            *principal,
            "",
            "Correção: 1 correta, 0,5 parcial, 0 incorreta. Fidelidade e recall de contexto medem o contexto "
            "entregue ao LLM, então não existem no A0. A latência é a do `ask` de ponta a ponta "
            "(no A3r inclui a reescrita).",
            "",
            "## Correção por categoria (só no recorte)",
            "",
            *por_cat,
            "",
            "Regerar: `uv run python -m indexer.tabela` (a partir de `indexer/`, sem LLM).",
            "",
        ]
    )


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--raiz", type=Path, default=Path(".."))
    a = ap.parse_args()
    pasta = a.raiz / "eval" / "resultados"
    rels = {
        nome: json.loads((pasta / f"{nome}.json").read_text(encoding="utf-8"))
        for _, nome, _ in LINHAS
        if (pasta / f"{nome}.json").exists()
    }
    texto = montar(rels)
    (pasta / "v0.md").write_text(texto, encoding="utf-8")
    print(texto)


if __name__ == "__main__":
    main()
