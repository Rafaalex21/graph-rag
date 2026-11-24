"""F10.5: bateria final de precisão (`eval/f105-medida-bateria.md`, fixada antes de escrever as perguntas).

    uv run python -m indexer.f105 sortear      # sorteia as páginas (semente 105): eval/f105-sorteio.json
    uv run python -m indexer.f105 pagina 137   # o texto e as tabelas (Markdown) de uma página

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


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("comando", choices=["sortear", "pagina"])
    ap.add_argument("numeros", nargs="*", type=int)
    ap.add_argument("--raiz", type=Path, default=Path(".."))
    a = ap.parse_args()
    if a.comando == "sortear":
        r = sortear(a.raiz)
        destino = a.raiz / "eval" / "f105-sorteio.json"
        destino.write_text(json.dumps(r, ensure_ascii=False, indent=1) + "\n", encoding="utf-8")
        print(json.dumps({k: r[k] for k in ("candidatas", "usadas_excluidas", "universo")}), "->", destino)
    else:
        for n in a.numeros:
            print(pagina(a.raiz, n))


if __name__ == "__main__":
    main()
