"""F10.5: bateria final de precisão (`eval/f105-medida-bateria.md`, fixada antes de escrever as perguntas).

    uv run python -m indexer.f105 sortear      # sorteia as páginas (semente 105): eval/f105-sorteio.json
    uv run python -m indexer.f105 pagina 137   # o texto e as tabelas (Markdown) de uma página
    uv run python -m indexer.f105 pular 1 257 --motivo "..."  # regra da medida: a atribuição 1 troca a
                                               # página 257 pela próxima da reserva; a 257 vai para o fim
    uv run python -m indexer.f105 relatorio    # eval/resultados/f105-bateria.md a partir de f105-a3 e f105-a6

O leitor de páginas não mostra a `descricao` nem as `perguntas` que o LLM gerou para cada tabela na
indexação: elas entram no índice e dariam vantagem ao sistema se inspirassem as perguntas da bateria.
"""

from __future__ import annotations

import argparse
import csv
import json
import random
from collections import Counter
from pathlib import Path

SEMENTE = 105
COTAS = {
    "factual_textual": 38,
    "numerica": 38,
    "agregacao_filtro": 25,
    "tematica_global": 25,
    "multi_hop": 12,
    "fora_do_escopo": 12,
}
MIN_CARACTERES = 400
CONJUNTOS_EXISTENTES = ["golden", "golden_novas", "golden_agregacao", "golden_entidades"]
BASE = "banco_do_brasil_formulario_referencia_2026"


def _caminhos(raiz: Path) -> tuple[Path, Path]:
    parsed = raiz / "data" / "parsed"
    return parsed / f"{BASE}.normalizado.json", parsed / f"{BASE}.tabelas.json"


def _lista(valor: object) -> list[int]:
    if isinstance(valor, list):
        return [int(v) for v in valor]
    if isinstance(valor, str) and valor.startswith("["):
        return [int(v) for v in json.loads(valor)]
    return []


def _paginas_usadas(raiz: Path) -> set[int]:
    usadas: set[int] = set()
    for nome in CONJUNTOS_EXISTENTES:
        with (raiz / "eval" / f"{nome}.csv").open(encoding="utf-8-sig", newline="") as f:
            for linha in csv.DictReader(f):
                for p in (linha.get("paginas") or "").split("|"):
                    if p.strip().isdigit():
                        usadas.add(int(p))
    return usadas


def universo(raiz: Path) -> tuple[list[int], dict[str, int]]:
    normalizado, tabelas = _caminhos(raiz)
    elementos = json.loads(normalizado.read_text(encoding="utf-8"))["elementos"]
    caracteres: Counter[int] = Counter()
    for e in elementos:
        if e["tipo"] == "table":
            continue
        for p in _lista(e.get("paginas_originais")):
            caracteres[p] += len(e.get("texto") or "")
    com_tabela = {p for t in json.loads(tabelas.read_text(encoding="utf-8")) for p in _lista(t["paginas"])}
    candidatas = [p for p in range(1, 424) if caracteres[p] >= MIN_CARACTERES or p in com_tabela]
    usadas = _paginas_usadas(raiz)
    final = [p for p in candidatas if p not in usadas]
    excluidas = len(usadas & set(candidatas))
    return final, {"candidatas": len(candidatas), "usadas_excluidas": excluidas, "universo": len(final)}


def sortear(raiz: Path) -> dict:
    paginas, contagem = universo(raiz)
    rnd = random.Random(SEMENTE)
    fila = paginas[:]
    rnd.shuffle(fila)
    categorias = [c for c, n in COTAS.items() if c != "fora_do_escopo" for _ in range(n)]
    rnd.shuffle(categorias)
    atribuicoes = []
    i = 0
    for n, categoria in enumerate(categorias, start=1):
        k = 2 if categoria == "multi_hop" else 1
        atribuicoes.append({"n": n, "categoria": categoria, "paginas": fila[i : i + k]})
        i += k
    return {
        "semente": SEMENTE,
        "cotas": COTAS,
        "regra_minima": f">= {MIN_CARACTERES} caracteres de texto ou ao menos uma tabela",
        "conjuntos_excluidos": CONJUNTOS_EXISTENTES,
        **contagem,
        "atribuicoes": atribuicoes,
        "reserva": fila[i:],
        "pulos": [],
    }


def pular(raiz: Path, n: int, pagina_pulada: int, motivo: str) -> dict:
    destino = raiz / "eval" / "f105-sorteio.json"
    r = json.loads(destino.read_text(encoding="utf-8"))
    a = next(x for x in r["atribuicoes"] if x["n"] == n)
    if pagina_pulada not in a["paginas"]:
        raise SystemExit(f"A atribuição {n} não tem a página {pagina_pulada}: {a['paginas']}")
    nova = r["reserva"].pop(0)
    a["paginas"][a["paginas"].index(pagina_pulada)] = nova
    r["reserva"].append(pagina_pulada)
    pulo = {"n": n, "categoria": a["categoria"], "pulada": pagina_pulada, "nova": nova, "motivo": motivo}
    r["pulos"].append(pulo)
    destino.write_text(json.dumps(r, ensure_ascii=False, indent=1) + "\n", encoding="utf-8")
    return r["pulos"][-1]


def pagina(raiz: Path, numero: int) -> str:
    normalizado, tabelas = _caminhos(raiz)
    saida = [f"=== página {numero} ==="]
    for e in json.loads(normalizado.read_text(encoding="utf-8"))["elementos"]:
        if e["tipo"] != "table" and numero in _lista(e.get("paginas_originais")) and e.get("texto"):
            prefixo = "## " if e["tipo"] == "section_header" else ("- " if e["tipo"] == "list_item" else "")
            saida.append(prefixo + e["texto"])
    for t in json.loads(tabelas.read_text(encoding="utf-8")):
        if numero in _lista(t["paginas"]):
            saida.append(f"\n[tabela {t['id']} · páginas {_lista(t['paginas'])}]\n{t['markdown']}")
    return "\n".join(saida)


REAMOSTRAGENS = 10_000
LIMITE_INFRA = 0.05
METRICAS_IC = (
    ("correcao", "correção"),
    ("pagina_citada", "página citada"),
    ("acerto_numerico", "acerto numérico"),
)
ROTULOS = {
    "factual_textual": "factual",
    "numerica": "numérica",
    "agregacao_filtro": "agregação",
    "tematica_global": "temática",
    "multi_hop": "multi-hop",
    "fora_do_escopo": "fora do escopo",
}


def _valor(metrica: str, nota: object) -> float | None:
    """Nota por pergunta como número; `None` quando a métrica não se aplica à pergunta."""
    if nota is None:
        return None
    if isinstance(nota, bool):
        return 1.0 if nota else 0.0
    return float(nota)


def _media(v: list[float]) -> float | None:
    return sum(v) / len(v) if v else None


def _ic(amostra: list[float], rng: random.Random) -> tuple[float, float] | None:
    """IC de 95% por bootstrap percentil: reamostra as perguntas com reposição."""
    if not amostra:
        return None
    n = len(amostra)
    medias = sorted(sum(rng.choices(amostra, k=n)) / n for _ in range(REAMOSTRAGENS))
    return medias[int(0.025 * REAMOSTRAGENS)], medias[int(0.975 * REAMOSTRAGENS) - 1]


def _carregar_degrau(raiz: Path, nome: str, ids: list[str]) -> dict:
    """Notas por pergunta de um degrau, com a correção das perguntas que falharam contada como zero."""
    resumo = json.loads((raiz / "eval" / "resultados" / f"{nome}.json").read_text(encoding="utf-8"))
    pasta = raiz / "data" / "avaliacao" / nome
    respostas = [json.loads(x) for x in (pasta / "respostas.jsonl").read_text(encoding="utf-8").splitlines()]
    juizo = [json.loads(x) for x in (pasta / "juizo.jsonl").read_text(encoding="utf-8").splitlines()]
    erro_sistema = {r["id"] for r in respostas if r.get("erro")}
    falha_juiz = {j["id"] for j in juizo if j.get("falha_do_juiz") and j.get("metrica") == "correcao"}
    faltando = [i for i in ids if i not in resumo["por_pergunta"]]
    por = {}
    for i in ids:
        p = resumo["por_pergunta"].get(i, {})
        notas = {m: _valor(m, p.get(m)) for m, _ in METRICAS_IC}
        if i in erro_sistema or i in falha_juiz or i in faltando or notas["correcao"] is None:
            notas["correcao"] = 0.0
        por[i] = notas
    return {
        "nome": nome,
        "por": por,
        "infra": sorted(erro_sistema | falha_juiz | set(faltando)),
        "latencia": resumo["mecanicas"]["geral"]["latencia_s"],
    }


def _linha_v1(raiz: Path, nome: str) -> dict | None:
    caminho = raiz / "eval" / "resultados" / f"{nome}.json"
    if not caminho.exists():
        return None
    r = json.loads(caminho.read_text(encoding="utf-8"))
    mec = r["mecanicas"]["geral"]
    return {
        "correcao": r["geral"]["correcao"]["media"],
        "pagina_citada": mec["pagina_citada"]["media"],
        "acerto_numerico": mec["acerto_numerico"]["media"],
        "n": r["perguntas"],
    }


def _fmt(x: float | None, casas: int = 2) -> str:
    return "—" if x is None else f"{x:.{casas}f}".replace(".", ",")


def relatorio(raiz: Path, a3: str = "f105-a3", a6: str = "f105-a6") -> str:
    """Monta `eval/resultados/f105-bateria.md` a partir das execuções já julgadas, sem LLM."""
    import hashlib

    golden = raiz / "eval" / "golden_f105.csv"
    sha = hashlib.sha256(golden.read_bytes()).hexdigest()
    with golden.open(encoding="utf-8", newline="") as f:
        casos = list(csv.DictReader(f))
    ids = [c["id"] for c in casos]
    cat = {c["id"]: c["categoria"] for c in casos}
    degraus = {"A3": _carregar_degrau(raiz, a3, ids), "A6": _carregar_degrau(raiz, a6, ids)}
    rng = random.Random(SEMENTE)
    s = [
        "# F10.5: bateria final de precisão",
        "",
        "Gerado por `uv run python -m indexer.f105 relatorio`, sem LLM. "
        f"Medida: `eval/f105-medida-bateria.md`. Golden: `eval/golden_f105.csv`, {len(casos)} perguntas, "
        f"sha256 `{sha}`.",
        "",
    ]
    invalida = []
    for rot, d in degraus.items():
        if len(d["infra"]) > LIMITE_INFRA * len(ids):
            invalida.append(rot)
    if invalida:
        s += [
            f"**RODADA INVÁLIDA** em {', '.join(invalida)}: mais de 5% das perguntas com erro do sistema ou "
            "falha do juiz. Pela regra da medida, a rodada é refeita e contada.",
            "",
        ]
    s += [
        "## Resultado geral (IC de 95% por bootstrap, 10.000 reamostragens, semente 105)",
        "",
        "| Degrau | Métrica | n | Média | IC 95% |",
        "|---|---|---|---|---|",
    ]
    for rot, d in degraus.items():
        for m, nome in METRICAS_IC:
            v = [x[m] for x in d["por"].values() if x[m] is not None]
            ic = _ic(v, rng)
            faixa = "—" if ic is None else f"{_fmt(ic[0])} a {_fmt(ic[1])}"
            s.append(f"| {rot} | {nome} | {len(v)} | {_fmt(_media(v))} | {faixa} |")
    s += [
        "",
        "## Diferença A6 − A3 (bootstrap pareado: as mesmas perguntas nos dois degraus)",
        "",
        "| Métrica | n | Diferença | IC 95% |",
        "|---|---|---|---|",
    ]
    for m, nome in METRICAS_IC:
        pares = [
            degraus["A6"]["por"][i][m] - degraus["A3"]["por"][i][m]
            for i in ids
            if degraus["A6"]["por"][i][m] is not None and degraus["A3"]["por"][i][m] is not None
        ]
        ic = _ic(pares, rng)
        faixa = "—" if ic is None else f"{_fmt(ic[0])} a {_fmt(ic[1])}"
        s.append(f"| {nome} | {len(pares)} | {_fmt(_media(pares))} | {faixa} |")
    s += [
        "",
        "## Correção por categoria (só a média; com 12 a 38 perguntas o intervalo é largo)",
        "",
        "| Categoria | n | A3 | A6 |",
        "|---|---|---|---|",
    ]
    for k in COTAS:
        sel = [i for i in ids if cat[i] == k]
        a, b = (_media([degraus[r]["por"][i]["correcao"] for i in sel]) for r in ("A3", "A6"))
        s.append(f"| {ROTULOS[k]} | {len(sel)} | {_fmt(a)} | {_fmt(b)} |")
    s += [
        "",
        "## Latência (segundos, desta máquina)",
        "",
        "| Degrau | p50 | p95 | máximo |",
        "|---|---|---|---|",
    ]
    for rot, d in degraus.items():
        lat = d["latencia"]
        s.append(f"| {rot} | {_fmt(lat['p50'], 1)} | {_fmt(lat['p95'], 1)} | {_fmt(lat['maximo'], 1)} |")
    s += [
        "",
        "## Ao lado da v1 (conjuntos separados, sem misturar)",
        "",
        "| Conjunto | Degrau | n | Correção | Página citada | Acerto numérico |",
        "|---|---|---|---|---|---|",
    ]
    for conjunto, nomes in (
        ("as 60 (golden)", ("v1-a3", "v1-a6")),
        ("as 24 (golden_novas)", ("v1n-a3", "v1n-a6")),
    ):
        for rot, nome in zip(("A3", "A6"), nomes, strict=True):
            r = _linha_v1(raiz, nome)
            if r:
                s.append(
                    f"| {conjunto} | {rot} | {r['n']} | {_fmt(r['correcao'])} | {_fmt(r['pagina_citada'])} "
                    f"| {_fmt(r['acerto_numerico'])} |"
                )
    for rot, d in degraus.items():
        geral = {m: _media([x[m] for x in d["por"].values() if x[m] is not None]) for m, _ in METRICAS_IC}
        s.append(
            f"| as 150 (F10.5) | {rot} | {len(ids)} | {_fmt(geral['correcao'])} | "
            f"{_fmt(geral['pagina_citada'])} | {_fmt(geral['acerto_numerico'])} |"
        )
    s += ["", "## Perguntas com erro do sistema ou falha do juiz (contam como zero na correção)", ""]
    for rot, d in degraus.items():
        s.append(f"- {rot} ({d['nome']}): {', '.join(d['infra']) if d['infra'] else 'nenhuma'}")
    sorteio = json.loads((raiz / "eval" / "f105-sorteio.json").read_text(encoding="utf-8"))
    pulos = Counter(p["categoria"] for p in sorteio.get("pulos", []))
    s += [
        "",
        "## Ressalvas",
        "",
        f"- Páginas puladas pela regra da medida: {sum(pulos.values())} "
        f"({', '.join(f'{ROTULOS.get(k, k)} {v}' for k, v in pulos.most_common())}). "
        "A maioria eram currículos de administradores sem quantidade; por isso as numéricas tendem "
        "a cair em páginas de tabelas e transações, e a amostra delas não representa o documento inteiro.",
        "- Uma execução por degrau: o IC mede a incerteza da amostra de perguntas, não a variância do modelo "
        "nem a do juiz.",
        "- O juiz é o mesmo Qwen local da v1, sem calibração humana nesta bateria.",
        "- Mesma máquina e mesmo índice da v1; a latência vale para esta máquina.",
    ]
    destino = raiz / "eval" / "resultados" / "f105-bateria.md"
    destino.write_text("\n".join(s) + "\n", encoding="utf-8")
    return str(destino)


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("comando", choices=["sortear", "pagina", "pular", "relatorio"])
    ap.add_argument("numeros", nargs="*", type=int)
    ap.add_argument("--motivo", default="")
    ap.add_argument("--a3", default="f105-a3", help="relatorio: nome da execução do degrau A3")
    ap.add_argument("--a6", default="f105-a6", help="relatorio: nome da execução do degrau A6")
    ap.add_argument("--raiz", type=Path, default=Path(".."))
    a = ap.parse_args()
    if a.comando == "relatorio":
        print(relatorio(a.raiz, a.a3, a.a6))
        return
    if a.comando == "sortear":
        r = sortear(a.raiz)
        destino = a.raiz / "eval" / "f105-sorteio.json"
        destino.write_text(json.dumps(r, ensure_ascii=False, indent=1) + "\n", encoding="utf-8")
        print(json.dumps({k: r[k] for k in ("candidatas", "usadas_excluidas", "universo")}), "->", destino)
    elif a.comando == "pular":
        print(json.dumps(pular(a.raiz, a.numeros[0], a.numeros[1], a.motivo), ensure_ascii=False))
    else:
        for n in a.numeros:
            print(pagina(a.raiz, n))


if __name__ == "__main__":
    main()
