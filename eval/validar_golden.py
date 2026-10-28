"""Valida eval/golden.csv (F3.1): estrutura, distribuição da §13.1 e, linha a linha, o gabarito contra o PDF.

Cada linha tem `evidencia` (regex, ou várias separadas por " && ") que tem de casar com o texto das páginas
físicas citadas em `paginas`, lido do PDF original com o pypdfium2; `ausencia` (regex) não pode casar em
NENHUMA página (perguntas sem resposta no documento). `no_recorte` tem de bater com o mapa do recorte.

Uso (o PDF fica fora do git, em data/raw/; o pypdfium2 vem de uma execução efêmera):
    uv run --no-project --with pypdfium2 python -I eval/validar_golden.py [--json saida.json]
"""

from __future__ import annotations

import argparse
import csv
import json
import re
import sys
from collections import Counter
from pathlib import Path

RAIZ = Path(__file__).resolve().parents[1]
CSV = RAIZ / "eval" / "golden.csv"
PDF = RAIZ / "data" / "raw" / "banco_do_brasil_formulario_referencia_2026.pdf"
MAPA = RAIZ / "data" / "raw" / "bb_fre_2026_recorte_mapa.json"  # local, fora do git
RECORTE = RAIZ / "eval" / "recorte_paginas.json"  # as mesmas páginas, versionado

DISTRIBUICAO = {
    "factual_textual": 15,
    "numerica": 15,
    "agregacao_filtro": 10,
    "tematica_global": 10,
    "multi_hop": 5,
    "fora_do_escopo": 5,
}
ROTAS = {
    "buscar_trechos", "entidade", "fato_financeiro", "buscar_tabelas", "consultar_grafo",
    "panorama", "varias", "nenhuma", "resposta_ja_dada",
}  # fmt: skip
TIPOS = {"texto", "valor", "lista", "recusa"}
CAMPOS = [
    "id", "categoria", "pergunta", "gabarito", "tipo_gabarito", "valor", "unidade", "paginas",
    "rota_esperada", "no_recorte", "pontos_chave", "evidencia", "ausencia", "cypher_gabarito", "observacao",
]  # fmt: skip
PAGINAS_DO_PDF = 423


def normaliza(texto: str) -> str:
    return re.sub(r"\s+", " ", texto.replace("­", "").replace("￾", ""))


def paginas_do_recorte(caminho: Path = RECORTE, mapa: Path = MAPA) -> set[int]:
    """Páginas físicas do recorte, do JSON versionado; se o mapa local existir, confere que são as mesmas."""
    dados = json.loads(caminho.read_text(encoding="utf-8"))
    paginas = {p for a, b in dados["faixas"] for p in range(a, b + 1)}
    if len(paginas) != dados["total"]:
        raise ValueError(f"{len(paginas)} páginas nas faixas, mas total = {dados['total']}")
    if mapa.exists():
        do_mapa = {m["original_fisica"] for m in json.loads(mapa.read_text(encoding="utf-8"))["mapa"]}
        if do_mapa != paginas:
            raise ValueError("eval/recorte_paginas.json difere do mapa local do recorte")
    return paginas


def ler_pdf(caminho: Path) -> dict[int, str]:
    import pypdfium2 as pdfium

    pdf = pdfium.PdfDocument(str(caminho))
    return {i + 1: normaliza(pdf[i].get_textpage().get_text_range()) for i in range(len(pdf))}


def ler_csv(caminho: Path) -> list[dict]:
    with caminho.open(encoding="utf-8", newline="") as f:
        return list(csv.DictReader(f))


def paginas_da_linha(linha: dict) -> list[int]:
    return [int(p) for p in linha["paginas"].split("|") if p]


def validar_estrutura(linhas: list[dict], paginas_recorte: set[int]) -> list[str]:
    erros: list[str] = []
    if linhas and list(linhas[0].keys()) != CAMPOS:
        erros.append(f"colunas diferentes do esperado: {list(linhas[0].keys())}")
    ids = [x["id"] for x in linhas]
    if len(ids) != len(set(ids)):
        erros.append("ids repetidos")
    contagem = Counter(x["categoria"] for x in linhas)
    if dict(contagem) != DISTRIBUICAO:
        erros.append(f"distribuição {dict(contagem)} ≠ §13.1 {DISTRIBUICAO}")
    if len(linhas) != 60:
        erros.append(f"{len(linhas)} linhas, esperadas 60")
    for x in linhas:
        i = x["id"]
        for c in ("pergunta", "gabarito", "tipo_gabarito", "rota_esperada", "no_recorte"):
            if not x[c].strip():
                erros.append(f"{i}: coluna {c} vazia")
        if x["rota_esperada"] not in ROTAS:
            erros.append(f"{i}: rota {x['rota_esperada']!r} desconhecida")
        if x["tipo_gabarito"] not in TIPOS:
            erros.append(f"{i}: tipo {x['tipo_gabarito']!r} desconhecido")
        pags = paginas_da_linha(x)
        if any(not (1 <= p <= PAGINAS_DO_PDF) for p in pags):
            erros.append(f"{i}: página fora de 1 a {PAGINAS_DO_PDF}")
        if x["categoria"] == "fora_do_escopo":
            if pags or x["tipo_gabarito"] != "recusa":
                erros.append(f"{i}: fora do escopo não leva página e o tipo é 'recusa'")
            if x["id"] != "F01" and not x["ausencia"]:
                erros.append(f"{i}: sem regex de ausência")
        else:
            if not pags:
                erros.append(f"{i}: sem página de evidência")
            if not x["evidencia"]:
                erros.append(f"{i}: sem regex de evidência")
        if x["tipo_gabarito"] == "valor":
            try:
                float(x["valor"])
            except ValueError:
                erros.append(f"{i}: valor numérico inválido {x['valor']!r}")
            if not x["unidade"]:
                erros.append(f"{i}: valor sem unidade")
        if (
            x["tipo_gabarito"] == "lista"
            and "|" not in x["pontos_chave"]
            and x["categoria"] != "agregacao_filtro"
        ):
            erros.append(f"{i}: lista sem pontos-chave")
        esperado = "sim" if all(p in paginas_recorte for p in pags) else "nao"
        if x["categoria"] == "fora_do_escopo":
            esperado = "sim"
        if x["no_recorte"] != esperado:
            erros.append(f"{i}: no_recorte={x['no_recorte']} mas as páginas pedem {esperado}")
    return erros


def validar_contra_o_pdf(linhas: list[dict], texto: dict[int, str]) -> tuple[list[str], list[dict]]:
    erros: list[str] = []
    detalhe: list[dict] = []
    todo = " ".join(texto.values())
    for x in linhas:
        i = x["id"]
        pags = paginas_da_linha(x)
        base = " ".join(texto[p] for p in pags)
        ok_evidencia = True
        falhas = []
        for regex in [r for r in x["evidencia"].split(" && ") if r]:
            if not re.search(regex, base, re.IGNORECASE):
                ok_evidencia = False
                falhas.append(regex)
        ok_ausencia = True
        if x["ausencia"] and re.search(x["ausencia"], todo, re.IGNORECASE):
            ok_ausencia = False
            falhas.append(f"AUSÊNCIA violada: {x['ausencia']}")
        if not (ok_evidencia and ok_ausencia):
            erros.append(f"{i}: {falhas}")
        detalhe.append({"id": i, "evidencia_ok": ok_evidencia, "ausencia_ok": ok_ausencia})
    return erros, detalhe


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--csv", type=Path, default=CSV)
    ap.add_argument("--pdf", type=Path, default=PDF)
    ap.add_argument("--json", type=Path, help="grava o resultado por linha")
    a = ap.parse_args()

    linhas = ler_csv(a.csv)
    recorte = paginas_do_recorte()
    erros = validar_estrutura(linhas, recorte)
    detalhe: list[dict] = []
    if a.pdf.exists():
        e2, detalhe = validar_contra_o_pdf(linhas, ler_pdf(a.pdf))
        erros += e2
    else:
        erros.append(f"PDF não encontrado em {a.pdf}: gabarito não conferido")
    resumo = {
        "linhas": len(linhas),
        "por_categoria": dict(Counter(x["categoria"] for x in linhas)),
        "no_recorte": dict(Counter(x["no_recorte"] for x in linhas)),
        "rotas": dict(Counter(x["rota_esperada"] for x in linhas)),
        "conferidas_no_pdf": sum(1 for d in detalhe if d["evidencia_ok"] and d["ausencia_ok"]),
        "erros": erros,
    }
    print(json.dumps(resumo, ensure_ascii=False, indent=2))
    if a.json:
        a.json.write_text(
            json.dumps({**resumo, "detalhe": detalhe}, ensure_ascii=False, indent=1), encoding="utf-8"
        )
    return 1 if erros else 0


if __name__ == "__main__":
    sys.exit(main())
