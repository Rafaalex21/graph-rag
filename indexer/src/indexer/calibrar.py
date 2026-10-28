"""Calibração do juiz contra rótulos manuais (ARQUITETURA §13.2, tarefa F3.4).

O juiz só vale se concordar com uma pessoa. Este módulo:

* `amostrar`: escolhe 20 respostas de uma execução, estratificadas (numéricas, temáticas, multi-hop, factuais,
  fora do escopo e recusas de perguntas com resposta), com semente fixa, e as embaralha. A escolha usa o
  veredito do juiz só para garantir que a amostra tenha casos fáceis e difíceis; o veredito NÃO vai para a
  planilha, para o rótulo ser cego;
* `planilha`: o texto que a pessoa lê (pergunta, gabarito, resposta e os critérios do juiz), em
  `data/avaliacao/<nome>/calibracao_planilha.md` (fora do git: tem texto do documento);
* `concordancia`: compara os rótulos (`eval/calibracao_juiz.csv`, só `id` e `rotulo`) com o veredito de
  correção do juiz: concordância exata nas 3 classes, concordância correta × não correta, kappa de Cohen e a
  matriz de confusão.

Uso (a partir de indexer/, sem LLM):
    uv run python -m indexer.calibrar planilha --nome f3-2-a3-60
    uv run python -m indexer.calibrar concordancia --nome f3-2-a3-60
"""

from __future__ import annotations

import argparse
import csv
import json
import random
from collections import Counter
from pathlib import Path

from indexer.avaliar import ler_golden

SEMENTE = 34
RECUSA = "não encontrei"
ROTULOS = {"c": "correta", "p": "parcial", "i": "incorreta"}
# (rótulo do estrato, quantas) — a soma é 20
ESTRATOS = [
    ("numerica_respondida", 4),
    ("tematica_respondida", 4),
    ("multi_hop_respondida", 2),
    ("factual_respondida", 4),
    ("fora_do_escopo", 3),
    ("recusa_de_pergunta_com_resposta", 3),
]


def _estrato(caso: dict, resposta: dict) -> str:
    recusou = resposta["resposta"].lower().startswith(RECUSA)
    if caso["categoria"] == "fora_do_escopo":
        return "fora_do_escopo"
    if recusou:
        return "recusa_de_pergunta_com_resposta"
    return {
        "numerica": "numerica_respondida",
        "tematica_global": "tematica_respondida",
        "multi_hop": "multi_hop_respondida",
        "factual_textual": "factual_respondida",
    }.get(caso["categoria"], "outra")


def amostrar(casos: list[dict], respostas: list[dict], semente: int = SEMENTE) -> list[str]:
    """Ids das 20 respostas a rotular, embaralhados. Determinístico para a mesma execução."""
    rng = random.Random(semente)
    por_id = {r["id"]: r for r in respostas}
    grupos: dict[str, list[str]] = {}
    for c in sorted(casos, key=lambda c: c["id"]):
        grupos.setdefault(_estrato(c, por_id[c["id"]]), []).append(c["id"])
    escolhidos: list[str] = []
    for estrato, n in ESTRATOS:
        pool = grupos.get(estrato, [])
        escolhidos += rng.sample(pool, min(n, len(pool)))
    rng.shuffle(escolhidos)
    return escolhidos


CRITERIOS = """## Como rotular

Para cada item, compare a **resposta** com o **gabarito** e dê um rótulo, com o mesmo critério do juiz:

- **c = correta**: contém todos os fatos do gabarito, sem contradição (informação extra coerente é aceitável);
- **p = parcial**: contém parte dos fatos do gabarito, ou está incompleta, sem contradição;
- **i = incorreta**: contradiz o gabarito, erra valor ou unidade, ou não responde.

Diferenças de formatação numérica (159.254 e 159254) são aceitáveis; valor, sinal, unidade ou escala
diferentes, não. Nas perguntas **sem resposta no documento** (gabarito de recusa), a resposta é `c` se declina
ou diz que a informação não consta (ou cumprimenta, numa saudação) e `i` se inventa conteúdo. Uma recusa em
pergunta que **tem** resposta no gabarito é `i` (não respondeu).

Responda no chat com os 20 rótulos na ordem, por exemplo: `1c 2i 3p 4c ...`
"""


def planilha(casos: list[dict], respostas: list[dict], ids: list[str]) -> str:
    c_por_id = {c["id"]: c for c in casos}
    r_por_id = {r["id"]: r for r in respostas}
    partes = [f"# Rótulos manuais para calibrar o juiz ({len(ids)} respostas)\n", CRITERIOS]
    for n, i in enumerate(ids, start=1):
        c, r = c_por_id[i], r_por_id[i]
        extra = (
            f"\n**Valor de referência:** {c['valor']} {c['unidade']}" if c["tipo_gabarito"] == "valor" else ""
        )
        partes.append(
            f"---\n\n### {n}\n\n**Pergunta:** {c['pergunta']}\n\n**Gabarito:** {c['gabarito']}{extra}\n\n"
            f"**Resposta do sistema:** {r['resposta']}\n"
        )
    return "\n".join(partes)


def concordancia(rotulos: dict[str, str], notas: list[dict]) -> dict:
    """Rótulos humanos (`c`/`p`/`i`) contra o veredito de correção do juiz."""
    juiz = {j["id"]: j["veredito"] for j in notas if j["metrica"] == "correcao" and j.get("veredito")}
    pares = [(ROTULOS[rot], juiz[i]) for i, rot in rotulos.items() if i in juiz]
    n = len(pares)
    iguais = sum(h == j for h, j in pares)
    bin_iguais = sum((h == "correta") == (j == "correta") for h, j in pares)
    classes = list(ROTULOS.values())
    ch, cj = Counter(h for h, _ in pares), Counter(j for _, j in pares)
    esperado = sum(ch[k] * cj[k] for k in classes) / (n * n) if n else 0.0
    obs = iguais / n if n else 0.0
    return {
        "n": n,
        "sem_veredito_do_juiz": len(rotulos) - n,
        "concordancia": round(obs, 4),
        "concordancia_correta_x_nao": round(bin_iguais / n, 4) if n else None,
        "kappa": round((obs - esperado) / (1 - esperado), 4) if esperado < 1 else None,
        "matriz_humano_x_juiz": {
            h: {j: sum(1 for a, b in pares if a == h and b == j) for j in classes} for h in classes
        },
        "divergencias": sorted(i for i, rot in rotulos.items() if i in juiz and ROTULOS[rot] != juiz[i]),
    }


def ler_rotulos(caminho: Path) -> dict[str, str]:
    with caminho.open(encoding="utf-8", newline="") as f:
        return {r["id"]: r["rotulo"].strip().lower() for r in csv.DictReader(f) if r["rotulo"].strip()}


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("acao", choices=["planilha", "concordancia"])
    ap.add_argument("--nome", required=True)
    ap.add_argument("--raiz", type=Path, default=Path(".."))
    a = ap.parse_args()
    pasta = a.raiz / "data" / "avaliacao" / a.nome
    casos = ler_golden(a.raiz / "eval" / "golden.csv")
    respostas = [json.loads(x) for x in (pasta / "respostas.jsonl").read_text(encoding="utf-8").splitlines()]
    ids = amostrar(casos, respostas)
    if a.acao == "planilha":
        (pasta / "calibracao_planilha.md").write_text(planilha(casos, respostas, ids), encoding="utf-8")
        rotulos = a.raiz / "eval" / "calibracao_juiz.csv"
        if not rotulos.exists():  # nunca sobrescreve rótulos já dados
            with rotulos.open("w", encoding="utf-8", newline="") as f:
                w = csv.writer(f, lineterminator="\n")
                w.writerow(["posicao", "id", "rotulo", "rotulador"])
                w.writerows((n, i, "", "") for n, i in enumerate(ids, start=1))
        print(f"{len(ids)} itens em {pasta / 'calibracao_planilha.md'}")
        return
    notas = [json.loads(x) for x in (pasta / "juizo.jsonl").read_text(encoding="utf-8").splitlines()]
    rot = ler_rotulos(a.raiz / "eval" / "calibracao_juiz.csv")
    res = concordancia(rot, notas)
    print(json.dumps(res, ensure_ascii=False, indent=1))
    destino = a.raiz / "eval" / "resultados" / f"calibracao-{a.nome}.json"
    destino.write_text(json.dumps(res, ensure_ascii=False, indent=1), encoding="utf-8")


if __name__ == "__main__":
    main()
