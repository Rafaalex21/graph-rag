"""Tabela da escada de ablações (ARQUITETURA §13.3, tarefa F3.5): `eval/resultados/v0.md`.

Junta os relatórios por execução (`eval/resultados/<nome>.json`, F3.2 e F3.3) numa tabela com uma linha por
degrau. As métricas valem para as perguntas com `no_recorte = sim` (até a F5.8 só elas têm resposta possível).

Com `--v1` (F9.1) monta `eval/resultados/v1-ablacao.md`: a escada A0 a A6, documento inteiro, 60 perguntas.

Uso (a partir de indexer/, sem LLM):
    uv run python -m indexer.tabela [--v1]
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


LINHAS_V1 = [
    ("A0", "v1-a0", "LLM sem recuperação (de memória)"),
    ("A1", "v1-a1", "Vetor ingênuo: 6 Filhos"),
    ("A2", "v1-a2", "+ full-text (híbrido RRF): 6 Filhos"),
    ("A3", "v1-a3", "+ Pai e reranker (24 Pais → 6)"),
    ("A3ts", "v1-a3ts", "controle: só `buscar_trechos` pelo pipeline do agente em TypeScript e o redator"),
    ("A4", "v1-a4", "+ templates de fatos e Text2Cypher (`consultar_grafo`)"),
    ("A5", "v1-a5", "+ busca local (`entidade`) e global (`panorama`)"),
    ("A6", "v1-a6", "agente completo: 12 ferramentas e crítico (até 2 rodadas)"),
]
LINHAS_NOVAS = [("A3", "v1n-a3", "Pai e reranker"), ("A6", "v1n-a6", "agente completo com crítico")]


def _linha_v1(rotulo: str, rel: dict, escopo: str) -> str:
    r, m = rel[escopo], rel["mecanicas"][escopo]
    sem = rotulo == "A0"
    fid = "n/a" if sem else num(r["fidelidade"])
    rec = "n/a" if sem else num(r["recall_contexto"])
    lat = f"{seg(m['latencia_s']['p50'])} / {seg(m['latencia_s']['p95'])}"
    pr = m["page_recall"]
    return (
        f"| **{rotulo}** | {num(r['correcao'])} | {fid} | {rec} | {num(pr['@1'])} / {num(pr['@6'])} "
        f"| {num(m['pagina_citada'])} | {num(m['acerto_numerico'])} | {lat} "
        f"| {rel['erros_do_sistema']} | {rel['falhas_do_juiz']} |"
    )


CABECALHO_V1 = (
    "| Degrau | Correção | Fidelidade | Recall de contexto | Page recall@1 / @6 | Página citada "
    "| Acerto numérico | Latência p50 / p95 (s) | Erros do sistema | Falhas do juiz |\n"
    "|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|"
)


def montar_v1(relatorios: dict[str, dict], fora_do_recorte: set[str]) -> str:
    """A escada A0 a A6 no documento inteiro: as 60, o recorte, as 6 de fora, as categorias e o grupo novo."""
    pres = [(r, n, d) for r, n, d in LINHAS_V1 if n in relatorios]
    ausentes = [r for r, n, _ in LINHAS_V1 if n not in relatorios]
    n60 = next(iter(relatorios.values()))["geral"]["correcao"]["n"] if relatorios else 0
    por_cat = [
        "| Degrau | " + " | ".join(r for _, r in CATEGORIAS) + " |",
        "|---|" + "---:|" * len(CATEGORIAS),
    ]
    fora = ["| Degrau | Correção nas 6 de fora do recorte | Notas por pergunta |", "|---|---:|---|"]
    for rotulo, nome, _ in pres:
        rel = relatorios[nome]
        por_cat.append(
            f"| **{rotulo}** | "
            + " | ".join(num(rel["por_categoria"][c]["correcao"]) for c, _ in CATEGORIAS)
            + " |"
        )
        notas = {i: v.get("correcao") for i, v in rel["por_pergunta"].items() if i in fora_do_recorte}
        vals = [v for v in notas.values() if v is not None]
        media = sum(vals) / len(vals) if vals else None
        detalhe = ", ".join(f"{i} {str(v).replace('.', ',')}" for i, v in sorted(notas.items()))
        fora.append(f"| **{rotulo}** | {num({'media': media})} | {detalhe} |")
    novas = [(r, n, d) for r, n, d in LINHAS_NOVAS if n in relatorios]
    saida = [
        "# Escada de ablações v1: A0 a A6 no documento inteiro",
        "",
        f"Golden set de 60 perguntas (`eval/golden.csv`), **todas** (n = {n60}), no índice do documento "
        "inteiro (F5.8); juiz Gemma 4 26B-A4B "
        "([ADR-028](../../docs/adr/ADR-028-metricas-com-juiz-local.md)), "
        "métricas mecânicas do [ADR-029](../../docs/adr/ADR-029-metricas-mecanicas.md). Definição, degraus e "
        "limites em [`eval/f91-medida-ablacao.md`](../f91-medida-ablacao.md). Uma execução por degrau; "
        "**diferença menor que "
        "0,05 vale como empate** (3 perguntas).",
        "",
        "## Resultado (60 perguntas)",
        "",
        CABECALHO_V1,
        *[_linha_v1(r, relatorios[n], "geral") for r, n, _ in pres],
        "",
        *[f"- **{r}**: {d}" for r, _, d in pres],
        *([f"- Degraus sem relatório (não rodados): {', '.join(ausentes)}."] if ausentes else []),
        "",
        "Correção: 1 correta, 0,5 parcial, 0 incorreta. Fidelidade e recall de contexto medem o contexto "
        "entregue ao LLM (no A0 não existem). Nos degraus do TypeScript o contexto é o que o redator viu. "
        "A latência de A0 a A3 é a do `ask` em Python; a de A3ts a A6 inclui atualizador, roteador, redator "
        "e, no A6, "
        "o crítico: comparar as duas famílias é indicativo.",
        "",
        "## Só nas 54 do recorte (a comparação mais próxima do v0)",
        "",
        CABECALHO_V1,
        *[_linha_v1(r, relatorios[n], "so_no_recorte") for r, n, _ in pres],
        "",
        "## Correção por categoria (60 perguntas)",
        "",
        *por_cat,
        "",
        "## As 6 perguntas fora do recorte",
        "",
        *fora,
        "",
    ]
    if novas:
        saida += [
            "## Grupo novo (24 perguntas de `eval/golden_novas.csv`, fora do ajuste; só A3 e A6)",
            "",
            CABECALHO_V1,
            *[_linha_v1(r, relatorios[n], "geral") for r, n, _ in novas],
            "",
        ]
    saida += ["Regerar: `uv run python -m indexer.tabela --v1` (a partir de `indexer/`, sem LLM).", ""]
    return "\n".join(saida)


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--raiz", type=Path, default=Path(".."))
    ap.add_argument("--v1", action="store_true", help="a escada A0 a A6 no documento inteiro (F9.1)")
    a = ap.parse_args()
    pasta = a.raiz / "eval" / "resultados"
    if a.v1:
        import csv

        with (a.raiz / "eval" / "golden.csv").open(encoding="utf-8-sig", newline="") as f:
            fora = {c["id"] for c in csv.DictReader(f) if c["no_recorte"] != "sim"}
        rels = {
            nome: json.loads((pasta / f"{nome}.json").read_text(encoding="utf-8"))
            for _, nome, _ in [*LINHAS_V1, *LINHAS_NOVAS]
            if (pasta / f"{nome}.json").exists()
        }
        texto = montar_v1(rels, fora)
        (pasta / "v1-ablacao.md").write_text(texto, encoding="utf-8")
        print(texto)
        return
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
