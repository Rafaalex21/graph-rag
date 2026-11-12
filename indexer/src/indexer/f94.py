# ruff: noqa: E501  (módulo de relatório: as linhas longas são texto de tabela em Markdown)
"""Ciclo de correção da F9.4 (`eval/f94-medida-correcao.md`): tabela e aplicação da regra de aceite, sem LLM.

Compara o A6 refeito de cada rodada (`f94<rodada>-a6` nas 60 perguntas, `f94<rodada>n-a6` nas 24 do grupo novo) com o A6 da F9.1
(`v1-a6`, `v1n-a6`) e escreve `eval/resultados/f94-correcao.md`. A regra foi escrita e commitada antes da primeira rodada.

Uso (a partir de indexer/):
    uv run python -m indexer.f94 [--rodadas r1 r2]
"""

from __future__ import annotations

import argparse
import json
from pathlib import Path

CATEGORIAS = (
    "factual_textual",
    "numerica",
    "agregacao_filtro",
    "tematica_global",
    "multi_hop",
    "fora_do_escopo",
)
ROTULO = {
    "factual_textual": "Factual",
    "numerica": "Numérica",
    "agregacao_filtro": "Agregação",
    "tematica_global": "Temática",
    "multi_hop": "Multi-hop",
    "fora_do_escopo": "Fora do escopo",
}
FRACAS = ("agregacao_filtro", "numerica")  # as duas de maior falha no A6 da F9.1, nas 60 (fixadas na medida)
QUEDA_MAXIMA_POR_CATEGORIA = 0.10
FIDELIDADE_MINIMA = 0.95
QUEDA_MAXIMA_GRUPO_NOVO = 0.05
CONFIRMACAO_GRUPO_NOVO = 0.05  # ganho que vale como "confirmado fora do ajuste"
LATENCIA_MAXIMA = 1.25  # vezes a da F9.1 (informativa, não reprova)


def _carregar(res: Path, nome: str) -> dict | None:
    p = res / f"{nome}.json"
    return json.loads(p.read_text(encoding="utf-8")) if p.exists() else None


def _corr(rel: dict, cat: str | None = None) -> float | None:
    bloco = rel["geral"]["correcao"] if cat is None else rel["por_categoria"][cat]["correcao"]
    return bloco["media"]


def _falha(rel: dict, cat: str) -> float | None:
    c = _corr(rel, cat)
    return None if c is None else 1 - c


def _n(v: float | None, casas: int = 2) -> str:
    return "—" if v is None else f"{v:.{casas}f}".replace(".", ",")


def avaliar(base: dict, novo: dict, base_n: dict, novo_n: dict) -> dict:
    itens: dict[str, dict] = {}
    for c in FRACAS:
        fb, fn = _falha(base, c), _falha(novo, c)
        itens[f"metade_{c}"] = {
            "base": fb,
            "novo": fn,
            "meta": fb / 2,
            "ok": fn is not None and fn <= fb / 2 + 1e-9,
        }
    quedas = {c: _corr(base, c) - _corr(novo, c) for c in CATEGORIAS if c != "fora_do_escopo"}
    itens["sem_regressao_por_categoria"] = {
        "quedas": quedas,
        "ok": all(q < QUEDA_MAXIMA_POR_CATEGORIA - 1e-9 for q in quedas.values()),
    }
    itens["fora_do_escopo"] = {
        "60": _corr(novo, "fora_do_escopo"),
        "24": _corr(novo_n, "fora_do_escopo"),
        "ok": _corr(novo, "fora_do_escopo") >= 1.0 and _corr(novo_n, "fora_do_escopo") >= 1.0,
    }
    fid = novo["geral"]["fidelidade"]["media"]
    itens["fidelidade"] = {"valor": fid, "ok": fid >= FIDELIDADE_MINIMA}
    d24 = _corr(novo_n) - _corr(base_n)
    itens["grupo_novo_sem_queda"] = {
        "base": _corr(base_n),
        "novo": _corr(novo_n),
        "delta": d24,
        "ok": d24 >= -QUEDA_MAXIMA_GRUPO_NOVO + 1e-9,
    }
    itens["sistema"] = {
        "erros_60": novo["erros_do_sistema"],
        "erros_24": novo_n["erros_do_sistema"],
        "falhas_juiz_60": novo["falhas_do_juiz"],
        "falhas_juiz_24": novo_n["falhas_do_juiz"],
    }
    lat_b = base["mecanicas"]["geral"]["latencia_s"]
    lat_n = novo["mecanicas"]["geral"]["latencia_s"]
    itens["latencia"] = {
        "base": (lat_b["p50"], lat_b["p95"]),
        "novo": (lat_n["p50"], lat_n["p95"]),
        "dentro_de_125pct": lat_n["p50"] <= lat_b["p50"] * LATENCIA_MAXIMA
        and lat_n["p95"] <= lat_b["p95"] * LATENCIA_MAXIMA,
    }
    cumprido = all(
        itens[k]["ok"]
        for k in (
            "metade_agregacao_filtro",
            "metade_numerica",
            "sem_regressao_por_categoria",
            "fora_do_escopo",
            "fidelidade",
            "grupo_novo_sem_queda",
        )
    )
    itens["aceite_cumprido"] = cumprido
    itens["confirmado_fora_do_ajuste"] = cumprido and d24 >= CONFIRMACAO_GRUPO_NOVO - 1e-9
    return itens


def montar(res: Path, rodadas: list[str]) -> str:
    base, base_n = _carregar(res, "v1-a6"), _carregar(res, "v1n-a6")
    out = [
        "# Ciclo de correção (F9.4): o A6 da F9.1 contra o A6 refeito",
        "",
        "Mesmo Qwen3.6, mesmo juiz (Gemma 4 26B-A4B), mesmo índice, mesmas perguntas; só muda o que cada rodada diz na medida. **Falha** de uma categoria = 1 − correção média (pontos perdidos por pergunta). Regra e limites em [`eval/f94-medida-correcao.md`](../f94-medida-correcao.md), fixados antes de rodar. Uma execução por rodada; **diferença menor que 0,05 vale como empate**.",
        "",
    ]
    for r in rodadas:
        novo, novo_n = _carregar(res, f"f94{r}-a6"), _carregar(res, f"f94{r}n-a6")
        if not (novo and novo_n and base and base_n):
            out += [f"## Rodada {r}: sem relatório (não rodou)", ""]
            continue
        v = avaliar(base, novo, base_n, novo_n)
        out += [
            f"## Rodada {r}",
            "",
            "### Correção e falha por categoria",
            "",
            "| Categoria | Correção F9.1 (60) | Correção agora (60) | Falha F9.1 | Falha agora | Correção F9.1 (24) | Correção agora (24) |",
            "|---|---:|---:|---:|---:|---:|---:|",
        ]
        for c in CATEGORIAS:
            fraca = " (fraca)" if c in FRACAS else ""
            out.append(
                f"| **{ROTULO[c]}**{fraca} | {_n(_corr(base, c))} | {_n(_corr(novo, c))} | {_n(_falha(base, c))} | {_n(_falha(novo, c))} | {_n(_corr(base_n, c))} | {_n(_corr(novo_n, c))} |"
            )
        out.append(
            f"| **Geral** | {_n(_corr(base))} | {_n(_corr(novo))} | {_n(1 - _corr(base))} | {_n(1 - _corr(novo))} | {_n(_corr(base_n))} | {_n(_corr(novo_n))} |"
        )
        gb, gn = base["geral"], novo["geral"]
        mb, mn = base["mecanicas"]["geral"], novo["mecanicas"]["geral"]
        out += [
            "",
            "### Outras métricas (60 perguntas)",
            "",
            "| | F9.1 | Agora |",
            "|---|---:|---:|",
            f"| Fidelidade | {_n(gb['fidelidade']['media'])} | {_n(gn['fidelidade']['media'])} |",
            f"| Recall de contexto (o contexto agora é maior: não comparável 1 a 1) | {_n(gb['recall_contexto']['media'])} | {_n(gn['recall_contexto']['media'])} |",
            f"| Página citada | {_n(mb['pagina_citada']['media'])} | {_n(mn['pagina_citada']['media'])} |",
            f"| Acerto numérico | {_n(mb['acerto_numerico']['media'])} | {_n(mn['acerto_numerico']['media'])} |",
            f"| Latência p50 / p95 (s) | {_n(mb['latencia_s']['p50'], 1)} / {_n(mb['latencia_s']['p95'], 1)} | {_n(mn['latencia_s']['p50'], 1)} / {_n(mn['latencia_s']['p95'], 1)} |",
            "",
            "### Aplicação da regra",
            "",
            "| Item | Resultado | Vale |",
            "|---|---|---|",
        ]
        for c in FRACAS:
            i = v[f"metade_{c}"]
            out.append(
                f"| Falha de {ROTULO[c].lower()} ≤ metade da F9.1 (≤ {_n(i['meta'])}) | {_n(i['novo'])} (era {_n(i['base'])}) | {'**sim**' if i['ok'] else 'não'} |"
            )
        i = v["sem_regressao_por_categoria"]
        piores = ", ".join(f"{ROTULO[c]} {_n(q)}" for c, q in i["quedas"].items() if q > 0) or "nenhuma queda"
        out.append(
            f"| Nenhuma categoria perde ≥ 0,10 de correção nas 60 | quedas: {piores} | {'**sim**' if i['ok'] else 'não'} |"
        )
        i = v["fora_do_escopo"]
        out.append(
            f"| Fora do escopo segue em 1,00 (60 e 24) | {_n(i['60'])} / {_n(i['24'])} | {'**sim**' if i['ok'] else 'não'} |"
        )
        i = v["fidelidade"]
        out.append(f"| Fidelidade ≥ 0,95 | {_n(i['valor'])} | {'**sim**' if i['ok'] else 'não'} |")
        i = v["grupo_novo_sem_queda"]
        out.append(
            f"| Grupo novo: correção geral não cai mais de 0,05 | {_n(i['base'])} → {_n(i['novo'])} ({_n(i['delta'])}) | {'**sim**' if i['ok'] else 'não'} |"
        )
        i = v["latencia"]
        out.append(
            f"| Latência p50 / p95 dentro de 125% da F9.1 (informativo) | {_n(i['novo'][0], 1)} / {_n(i['novo'][1], 1)} s | {'sim' if i['dentro_de_125pct'] else 'não'} |"
        )
        s = v["sistema"]
        out.append(
            f"| Erros do sistema (60; 24) / falhas do juiz (60; 24) | {s['erros_60']}; {s['erros_24']} / {s['falhas_juiz_60']}; {s['falhas_juiz_24']} | — |"
        )
        if v["aceite_cumprido"]:
            fim = (
                "confirmado fora do ajuste (grupo novo +0,05 ou mais)"
                if v["confirmado_fora_do_ajuste"]
                else "só nas 60 (conjunto de ajuste); o grupo novo não ganhou 0,05"
            )
            veredito = f"**Aceite da rodada {r}: CUMPRIDO**; {fim}."
        else:
            veredito = f"**Aceite da rodada {r}: NÃO cumprido.**"
        out += ["", veredito, ""]
    out += ["Regerar: `uv run python -m indexer.f94 --rodadas r1` (a partir de `indexer/`, sem LLM).", ""]
    return "\n".join(out)


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--raiz", type=Path, default=Path(".."))
    ap.add_argument("--rodadas", nargs="+", default=["r1"])
    a = ap.parse_args()
    res = a.raiz / "eval" / "resultados"
    texto = montar(res, a.rodadas)
    (res / "f94-correcao.md").write_text(texto, encoding="utf-8")
    print(texto)


if __name__ == "__main__":
    main()
