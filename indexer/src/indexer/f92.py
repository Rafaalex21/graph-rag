"""Bake-off da F9.2 (`eval/f92-medida-bakeoff.md`): tabela e aplicação das regras de decisão, sem LLM.

Junta (1) os relatórios do agente completo (A6) de três LLMs nas 60 perguntas do golden e nas 24 do grupo novo,
(2) as extrações abertas da amostra de Pais com os mesmos três LLMs e (3) os picos de VRAM medidos, e escreve
`eval/resultados/f92-bakeoff.md` e `eval/resultados/f92-extracao.json` (só contagens: nada do texto do documento, ADR-009).
As regras de decisão estão escritas em `eval/f92-medida-bakeoff.md` e foram commitadas antes da primeira rodada; aqui elas só são
aplicadas.

Uso (a partir de indexer/):
    uv run python -m indexer.f92
"""

# ruff: noqa: E501  (módulo de relatório: as linhas longas são texto de tabela em Markdown)
from __future__ import annotations

import argparse
import json
from pathlib import Path

from indexer.extracao_aberta import lastro_de_nome, resumir, unidades
from indexer.tabela import num, seg

DOCUMENTO = "banco_do_brasil_formulario_referencia_2026"
MODELOS = ("qwen", "gptoss", "gemma")
ROTULO = {
    "qwen": "Qwen3.6-35B-A3B (produção)",
    "gptoss": "gpt-oss-20b (raciocínio low)",
    "gemma": "Gemma 4 26B-A4B (Vulkan, sem raciocínio)",
}
# relatório do agente: (60 perguntas, 24 do grupo novo); o Qwen reaproveita as execuções da F9.1 (mesmo código)
RELATORIOS = {
    "qwen": ("v1-a6", "v1n-a6"),
    "gptoss": ("f92-a6-gptoss", "f92n-a6-gptoss"),
    "gemma": ("f92-a6-gemma", "f92n-a6-gemma"),
}
VRAM_ALVO_MB = 15_000
EMPATE = 0.05

# regras fixadas antes de rodar (eval/f92-medida-bakeoff.md)
MAX_ERROS_60, MAX_ERROS_24 = 3, 1
MAX_FALHAS_JUIZ_60, MAX_FALHAS_JUIZ_24 = 3, 1
EXTRACAO_LASTRO_PP = 2.0
EXTRACAO_RAZAO_ITENS = 0.9
EXTRACAO_RAZAO_TEMPO = 0.7
LATENCIA_RAZAO_P50 = 0.7


def _m(rel: dict, chave: str) -> float | None:
    return rel["geral"][chave]["media"]


def _mec(rel: dict, *caminho: str) -> float | None:
    x = rel["mecanicas"]["geral"]
    for c in caminho:
        x = x[c]
    return x.get("media") if "media" in x else x


def avaliar_agente(
    rels60: dict[str, dict], rels24: dict[str, dict], vram: dict[str, dict]
) -> dict[str, dict]:
    """Aplica a regra do agente e do redator a cada desafiante (gptoss e gemma) contra o Qwen."""
    q60, q24 = rels60["qwen"], rels24["qwen"]
    saida = {}
    for m in ("gptoss", "gemma"):
        if m not in rels60 or m not in rels24:
            saida[m] = {"veredito": "sem relatório (não rodou)", "substitui": False}
            continue
        r60, r24 = rels60[m], rels24[m]
        d60 = _m(r60, "correcao") - _m(q60, "correcao")
        d24 = _m(r24, "correcao") - _m(q24, "correcao")
        if d60 >= EMPATE and d24 >= EMPATE:
            qualidade = "melhor"
        elif d60 <= -EMPATE or d24 <= -EMPATE:
            qualidade = "pior"
        else:
            qualidade = "equivalente"
        lat, latq = r60["mecanicas"]["geral"]["latencia_s"], q60["mecanicas"]["geral"]["latencia_s"]
        pico = (vram.get(m) or {}).get("sonda_pico_mb")
        condicoes = {
            "erros_do_sistema": r60["erros_do_sistema"] <= MAX_ERROS_60
            and r24["erros_do_sistema"] <= MAX_ERROS_24,
            "falhas_do_juiz": r60["falhas_do_juiz"] <= MAX_FALHAS_JUIZ_60
            and r24["falhas_do_juiz"] <= MAX_FALHAS_JUIZ_24,
            "fidelidade_nao_pior": _m(r60, "fidelidade") >= _m(q60, "fidelidade") - EMPATE,
            "pagina_citada_nao_pior": _mec(r60, "pagina_citada") >= _mec(q60, "pagina_citada") - EMPATE,
            "acerto_numerico_nao_pior": _mec(r60, "acerto_numerico") >= _mec(q60, "acerto_numerico") - EMPATE,
            "vram_abaixo_do_alvo": pico is not None and pico < VRAM_ALVO_MB,
        }
        mais_rapido = lat["p50"] <= LATENCIA_RAZAO_P50 * latq["p50"] and lat["p95"] <= latq["p95"]
        ganho = qualidade == "melhor" or (qualidade == "equivalente" and mais_rapido)
        saida[m] = {
            "delta_correcao_60": round(d60, 4),
            "delta_correcao_24": round(d24, 4),
            "qualidade": qualidade,
            "mais_rapido": mais_rapido,
            "condicoes": condicoes,
            "substitui": bool(ganho and all(condicoes.values())),
        }
    candidatos = [m for m, v in saida.items() if v["substitui"]]
    escolhido = "qwen"
    if candidatos:
        escolhido = sorted(
            candidatos,
            key=lambda m: (
                -round(_m(rels60[m], "correcao") / EMPATE),
                rels60[m]["mecanicas"]["geral"]["latencia_s"]["p50"],
            ),
        )[0]
    return {"por_desafiante": saida, "escolhido": escolhido}


def metricas_extracao(resultados: list[dict], textos: dict[str, str]) -> dict:
    """Contagens mecânicas de uma extração (sem nomes nem texto do documento)."""
    ativas = [r for r in resultados if not r["do_cache"]]
    validas = [r for r in resultados if r["valida"]]
    ents = [e for r in validas for e in r["resposta"]["entities"]]
    sem_lastro = sum(
        not lastro_de_nome(e["name"], textos[r["id"]]) for r in validas for e in r["resposta"]["entities"]
    )
    n = len(resultados)
    base = resumir(resultados)
    return {
        "pais": n,
        "validas": base["validas"],
        "validade_pct": round(100 * base["validas"] / n, 1) if n else None,
        "validas_na_primeira": base["validas_na_primeira"],
        "chamadas_por_pai": round(base["chamadas"] / n, 2) if n else None,
        "entidades_por_pai": round(len(ents) / max(1, len(validas)), 2),
        "relacoes_por_pai": round(base["relacoes"] / max(1, len(validas)), 2),
        "sem_lastro_de_nome_pct": round(100 * sem_lastro / len(ents), 1) if ents else None,
        "nomes_repetidos": base["nomes_repetidos"],
        "no_teto_de_entidades": base["no_teto_de_entidades"],
        "tokens_saida_por_pai": round(base["tokens_saida"] / max(1, len(ativas))),
        "segundos_por_pai": round(sum(r["segundos"] for r in ativas) / max(1, len(ativas)), 1),
        "invalidas": base["invalidas"],
    }


def avaliar_extracao(ex: dict[str, dict]) -> dict:
    q = ex.get("qwen")
    saida = {}
    for m in ("gptoss", "gemma"):
        if m not in ex or q is None:
            saida[m] = {"candidato": False, "motivo": "sem execução"}
            continue
        x = ex[m]
        cond = {
            "validade_nao_menor": x["validade_pct"] >= q["validade_pct"],
            "lastro_ate_2pp_pior": x["sem_lastro_de_nome_pct"]
            <= q["sem_lastro_de_nome_pct"] + EXTRACAO_LASTRO_PP,
            "entidades_90pct": x["entidades_por_pai"] >= EXTRACAO_RAZAO_ITENS * q["entidades_por_pai"],
            "relacoes_90pct": x["relacoes_por_pai"] >= EXTRACAO_RAZAO_ITENS * q["relacoes_por_pai"],
            "tempo_ate_70pct": x["segundos_por_pai"] <= EXTRACAO_RAZAO_TEMPO * q["segundos_por_pai"],
        }
        saida[m] = {"candidato": all(cond.values()), "condicoes": cond}
    return saida


def _linha_agente(m: str, rel: dict, vram: dict) -> str:
    r, mec = rel["geral"], rel["mecanicas"]["geral"]
    lat = f"{seg(mec['latencia_s']['p50'])} / {seg(mec['latencia_s']['p95'])}"
    pico = vram.get("sonda_pico_mb")
    return (
        f"| **{ROTULO[m]}** | {num(r['correcao'])} | {num(r['fidelidade'])} | {num(r['recall_contexto'])} "
        f"| {num(mec['pagina_citada'])} | {num(mec['acerto_numerico'])} | {lat} | {rel['erros_do_sistema']} "
        f"| {rel['falhas_do_juiz']} | {f'{pico / 1000:.1f}'.replace('.', ',') if pico else '—'} |"
    )


CABECALHO = (
    "| LLM | Correção | Fidelidade | Recall de contexto | Página citada | Acerto numérico "
    "| Latência p50 / p95 (s) | Erros do sistema | Falhas do juiz | VRAM pico (GB) |\n"
    "|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|"
)


def _s(v: float | None, casas: int = 1) -> str:
    return "—" if v is None else f"{v:.{casas}f}".replace(".", ",")


def montar(rels60: dict, rels24: dict, vram: dict, extracao: dict, veredito: dict, ver_ext: dict) -> str:
    out = [
        "# Bake-off de modelos locais (F9.2): agente e redator, e extração em amostra",
        "",
        "Três LLMs no papel de **agente e redator** (atualizador, roteador, executor com Text2Cypher e panorama, crítico e "
        "redator, o A6 inteiro da F9.1) e na **extração aberta** de uma amostra de Pais. Mesmo código, mesmos "
        "prompts, mesmo juiz (Gemma 4 26B-A4B no perfil `avaliar`), mesmo índice. Definição, regras de decisão e limites em "
        "[`eval/f92-medida-bakeoff.md`](../f92-medida-bakeoff.md), fixados antes de rodar. Uma execução por LLM.",
        "",
        "## Agente e redator: 60 perguntas do `eval/golden.csv`",
        "",
        CABECALHO,
        *[_linha_agente(m, rels60[m], vram.get(m, {})) for m in MODELOS if m in rels60],
        "",
        "## Agente e redator: 24 perguntas do grupo novo (`eval/golden_novas.csv`, fora do ajuste)",
        "",
        CABECALHO,
        *[_linha_agente(m, rels24[m], vram.get(m, {})) for m in MODELOS if m in rels24],
        "",
        "Correção: 1 correta, 0,5 parcial, 0 incorreta. **Diferença menor que 0,05 vale como empate** (3 perguntas nas 60, "
        "1 nas 24). VRAM: pico da sonda de 8 perguntas (A6) com o reranker na GPU e o embedding na CPU, total do adaptador com "
        "o desktop incluído. O Qwen reaproveita as execuções da F9.1 (`v1-a6`, `v1n-a6`).",
        "",
        "### Aplicação da regra do agente",
        "",
        "| Desafiante | Δ correção (60) | Δ correção (24) | Qualidade | Mais rápido (p50 ≤ 0,7× e p95 ≤ Qwen) | Condições | Substitui o Qwen |",
        "|---|---:|---:|---|---|---|---|",
    ]
    for m, v in veredito["por_desafiante"].items():
        if "condicoes" not in v:
            out.append(f"| {ROTULO[m]} | — | — | {v['veredito']} | — | — | não |")
            continue
        falhas = [k for k, ok in v["condicoes"].items() if not ok]
        out.append(
            f"| {ROTULO[m]} | {_s(v['delta_correcao_60'], 2)} | {_s(v['delta_correcao_24'], 2)} | {v['qualidade']} "
            f"| {'sim' if v['mais_rapido'] else 'não'} | {'todas valem' if not falhas else 'falham: ' + ', '.join(falhas)} "
            f"| {'**sim**' if v['substitui'] else 'não'} |"
        )
    out += ["", f"**LLM do agente e do redator pela regra: {ROTULO[veredito['escolhido']]}.**", ""]
    out += [
        "## Extração aberta: amostra de Pais",
        "",
        "| LLM | Pais | Válidas | Válidas na 1ª | Chamadas/Pai | Entidades/Pai | Relações/Pai | Sem lastro de nome | Nomes repetidos | Tokens de saída/Pai | Segundos/Pai |",
        "|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|",
    ]
    for m in MODELOS:
        e = extracao.get(m)
        if not e:
            continue
        out.append(
            f"| **{ROTULO[m]}** | {e['pais']} | {e['validas']} ({_s(e['validade_pct'])}%) | {e['validas_na_primeira']} "
            f"| {_s(e['chamadas_por_pai'], 2)} | {_s(e['entidades_por_pai'], 2)} | {_s(e['relacoes_por_pai'], 2)} "
            f"| {_s(e['sem_lastro_de_nome_pct'])}% | {e['nomes_repetidos']} | {e['tokens_saida_por_pai']} | {_s(e['segundos_por_pai'])} |"
        )
    out += [
        "",
        "Medidas só mecânicas (validade do JSON no esquema, lastro do nome no texto do Pai, contagens, tempo): **não medem se as "
        "entidades e as relações estão certas nem completas**.",
        "",
        "### Aplicação da regra da extração",
        "",
        "| Desafiante | Condições | Candidato a substituir o Qwen |",
        "|---|---|---|",
    ]
    for m, v in ver_ext.items():
        if "condicoes" not in v:
            out.append(f"| {ROTULO[m]} | {v['motivo']} | não |")
            continue
        falhas = [k for k, ok in v["condicoes"].items() if not ok]
        out.append(
            f"| {ROTULO[m]} | {'todas valem' if not falhas else 'falham: ' + ', '.join(falhas)} "
            f"| {'**sim** (a validar ponta a ponta antes de reindexar)' if v['candidato'] else 'não'} |"
        )
    out += ["", "Regerar: `uv run python -m indexer.f92` (a partir de `indexer/`, sem LLM).", ""]
    return "\n".join(out)


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--raiz", type=Path, default=Path(".."))
    a = ap.parse_args()
    res = a.raiz / "eval" / "resultados"

    def carregar(nome: str) -> dict | None:
        p = res / f"{nome}.json"
        return json.loads(p.read_text(encoding="utf-8")) if p.exists() else None

    rels60 = {m: r for m in MODELOS if (r := carregar(RELATORIOS[m][0]))}
    rels24 = {m: r for m in MODELOS if (r := carregar(RELATORIOS[m][1]))}
    vram = carregar("f92-vram") or {}
    prefixo = a.raiz / "data" / "parsed" / DOCUMENTO
    chunks = json.loads(Path(f"{prefixo}.chunks.json").read_text(encoding="utf-8"))
    textos = {u["id"]: u["pedido"] for u in unidades(chunks)}
    extracao = {}
    for m in MODELOS:
        arq = Path(f"{prefixo}.f92_{m}.json")
        if arq.exists():
            extracao[m] = metricas_extracao(json.loads(arq.read_text(encoding="utf-8")), textos)
    veredito = avaliar_agente(rels60, rels24, vram) if "qwen" in rels60 and "qwen" in rels24 else None
    ver_ext = avaliar_extracao(extracao)
    (res / "f92-extracao.json").write_text(
        json.dumps(extracao, ensure_ascii=False, indent=1), encoding="utf-8"
    )
    texto = (
        montar(rels60, rels24, vram, extracao, veredito, ver_ext) if veredito else "Sem o relatório do Qwen."
    )
    (res / "f92-bakeoff.md").write_text(texto, encoding="utf-8")
    print(texto)


if __name__ == "__main__":
    main()
