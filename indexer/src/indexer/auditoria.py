"""Auditoria de tabelas do Docling contra o PDF (ARQUITETURA §5 e §14, tarefa F1.6).

Duas verificações independentes do extrator de tabelas:

1. **Números**: compara os números das células de cada tabela com os números que o PDF tem na mesma região
   (texto lido pelo pdfium, não pelo Docling). Pega número faltando, sobrando, com sinal, parêntese,
   vírgula ou ponto errados.
2. **Imagem**: recorta a tabela da página renderizada, para conferir a olho linhas, colunas, cabeçalhos e
   escala ("R$ milhões", "%"), que a comparação de números não enxerga.

Uso (a partir de indexer/):
    uv run --group parse python -m indexer.auditoria ../data/parsed/ARQUIVO.docling.json \\
        --pdf ../data/raw/ARQUIVO_recorte.pdf --saida ../data/parsed/auditoria --n 15 --semente 20261028
"""

from __future__ import annotations

import argparse
import json
import random
import re
from collections import Counter
from pathlib import Path

# número em formato pt-BR: 914.535 · 8,5 · (6,3) · -1,2 · 12% · 2025
NUMERO = re.compile(r"\(?-?\d[\d\.]*(?:,\d+)?\)?%?")
MARGEM_PT = 3.0


def numeros_do_texto(texto: str) -> list[str]:
    """Números do texto, na forma como aparecem (parênteses, sinal e % ficam)."""
    return [m.group(0).strip(".") for m in NUMERO.finditer(texto or "")]


def comparar_numeros(textos_docling: list[str], texto_pdf: str) -> dict:
    """Diferença entre os números que o Docling pôs nas células e os que o PDF tem na região."""
    doc = Counter(n for t in textos_docling for n in numeros_do_texto(t))
    pdf = Counter(numeros_do_texto(texto_pdf))
    faltam = pdf - doc  # estão no PDF e não na tabela do Docling
    sobram = doc - pdf  # estão na tabela do Docling e não no PDF
    return {
        "numeros_docling": sum(doc.values()),
        "numeros_pdf": sum(pdf.values()),
        "faltam_no_docling": dict(faltam),
        "sobram_no_docling": dict(sobram),
        "identicos": not faltam and not sobram,
    }


def sortear(refs: list[str], n: int, semente: int) -> list[str]:
    """Amostra reprodutível: a lista é ordenada antes do sorteio."""
    return random.Random(semente).sample(sorted(refs, key=lambda r: int(r.rsplit("/", 1)[1])), n)


def bbox_da_tabela(tabela: dict) -> tuple[int, float, float, float, float]:
    """(página do recorte, esquerda, base, direita, topo) em pontos, origem embaixo à esquerda."""
    prov = tabela["prov"][0]
    b = prov["bbox"]
    return prov["page_no"], min(b["l"], b["r"]), min(b["t"], b["b"]), max(b["l"], b["r"]), max(b["t"], b["b"])


def auditar(
    docling_json: Path, pdf: Path, saida: Path, n: int, semente: int, mapa: Path | None = None
) -> list[dict]:
    import pypdfium2 as pdfium
    from docling_core.types.doc import DoclingDocument

    dados = json.loads(docling_json.read_text(encoding="utf-8"))
    doc = DoclingDocument.model_validate(dados)
    por_ref = {t["self_ref"]: t for t in dados["tables"]}
    populacao = [r for r, t in por_ref.items() if t.get("label") == "table"]
    amostra = sortear(populacao, n, semente)

    originais = {}
    if mapa:
        originais = {
            m["recorte"]: m["original_fisica"] for m in json.loads(mapa.read_text(encoding="utf-8"))["mapa"]
        }

    saida.mkdir(parents=True, exist_ok=True)
    pdf_doc = pdfium.PdfDocument(str(pdf))
    resultados = []
    for i, ref in enumerate(amostra, start=1):
        t = por_ref[ref]
        pagina, esq, base, dir_, topo = bbox_da_tabela(t)
        pagina_pdf = pdf_doc[pagina - 1]
        altura = pagina_pdf.get_height()
        texto_pdf = pagina_pdf.get_textpage().get_text_bounded(
            esq - MARGEM_PT, base - MARGEM_PT, dir_ + MARGEM_PT, topo + MARGEM_PT
        )
        celulas = [c.get("text") or "" for c in t["data"].get("table_cells", [])]
        comp = comparar_numeros(celulas, texto_pdf)

        escala = 2.0
        imagem = pagina_pdf.render(scale=escala).to_pil()
        caixa = (
            max(0, int((esq - 8) * escala)),
            max(0, int((altura - topo - 8) * escala)),
            min(imagem.width, int((dir_ + 8) * escala)),
            min(imagem.height, int((altura - base + 8) * escala)),
        )
        recorte = imagem.crop(caixa)
        if recorte.width > 1300:
            recorte = recorte.resize((1300, int(recorte.height * 1300 / recorte.width)))
        arquivo = saida / f"tab_{i:02d}_{ref.rsplit('/', 1)[1]}.png"
        recorte.save(arquivo)

        resultados.append(
            {
                "ordem": i,
                "ref": ref,
                "pagina_recorte": pagina,
                "pagina_original": originais.get(pagina),
                "linhas": t["data"].get("num_rows"),
                "colunas": t["data"].get("num_cols"),
                "celulas": len(celulas),
                "comparacao_numeros": comp,
                "markdown": ref and next(x for x in doc.tables if x.self_ref == ref).export_to_markdown(doc),
                "imagem": arquivo.name,
            }
        )
    return resultados


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("docling_json", type=Path)
    ap.add_argument("--pdf", type=Path, required=True, help="PDF do recorte (mesmas páginas do Docling)")
    ap.add_argument("--mapa", type=Path)
    ap.add_argument("--saida", type=Path, required=True)
    ap.add_argument("--n", type=int, default=15)
    ap.add_argument("--semente", type=int, default=20261028)
    a = ap.parse_args()

    resultados = auditar(a.docling_json, a.pdf, a.saida, a.n, a.semente, a.mapa)
    (a.saida / "auditoria_tabelas.json").write_text(
        json.dumps({"semente": a.semente, "n": a.n, "tabelas": resultados}, ensure_ascii=False, indent=1),
        encoding="utf-8",
    )
    iguais = sum(r["comparacao_numeros"]["identicos"] for r in resultados)
    print(f"{len(resultados)} tabelas; números idênticos ao PDF em {iguais}")
    for r in resultados:
        c = r["comparacao_numeros"]
        print(
            f"  {r['ordem']:2} {r['ref']:14} p.{r['pagina_original']:>3} {r['linhas']}x{r['colunas']:<2} "
            f"nº docling={c['numeros_docling']:3} pdf={c['numeros_pdf']:3} "
            f"faltam={sum(c['faltam_no_docling'].values())} sobram={sum(c['sobram_no_docling'].values())}"
        )


if __name__ == "__main__":
    main()
