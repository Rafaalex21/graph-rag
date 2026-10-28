"""I-1 · Parsing de PDF com o Docling (ARQUITETURA §5, tarefa F1.3).

O Docling só é importado dentro de `converter_pdf`: o restante do pacote e os testes
não dependem do grupo `parse`.

Uso (a partir de indexer/):
    uv run --group parse python -m indexer.parse ARQUIVO.pdf `
        --artefatos ../infra/bin/modelos-docling --saida ../data/parsed
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import time
from pathlib import Path


def cobertura_texto(doc: dict) -> dict:
    """Páginas do DoclingDocument (já em dict) que têm ao menos um item de texto não vazio.

    Conta `texts` e as células de `tables`, e devolve também as páginas sem nenhum texto.
    """
    paginas = sorted(int(k) for k in doc.get("pages", {}))
    por_pagina: dict[int, dict[str, int]] = {p: {"textos": 0, "tabelas": 0} for p in paginas}

    for item in doc.get("texts", []):
        if not (item.get("text") or "").strip():
            continue
        for prov in item.get("prov", []):
            por_pagina.setdefault(prov["page_no"], {"textos": 0, "tabelas": 0})["textos"] += 1

    for tabela in doc.get("tables", []):
        for prov in tabela.get("prov", []):
            por_pagina.setdefault(prov["page_no"], {"textos": 0, "tabelas": 0})["tabelas"] += 1

    com_texto = [p for p, v in por_pagina.items() if v["textos"] > 0 or v["tabelas"] > 0]
    sem_texto = [p for p in sorted(por_pagina) if p not in set(com_texto)]
    return {
        "paginas": len(por_pagina),
        "com_texto": len(com_texto),
        "sem_texto": sem_texto,
        "tabelas": sum(v["tabelas"] for v in por_pagina.values()),
        "itens_de_texto": sum(v["textos"] for v in por_pagina.values()),
    }


def sha256_arquivo(caminho: Path) -> str:
    h = hashlib.sha256()
    with open(caminho, "rb") as f:
        for bloco in iter(lambda: f.read(1 << 20), b""):
            h.update(bloco)
    return h.hexdigest()


def converter_pdf(pdf: Path, artefatos: Path, threads: int = 6) -> tuple[dict, dict]:
    """Converte o PDF e devolve (documento em dict, tempos).

    OCR desligado, TableFormer em modo accurate, CPU.
    """
    from docling.datamodel.accelerator_options import AcceleratorDevice, AcceleratorOptions
    from docling.datamodel.base_models import InputFormat
    from docling.datamodel.pipeline_options import PdfPipelineOptions, TableFormerMode
    from docling.document_converter import DocumentConverter, PdfFormatOption

    opcoes = PdfPipelineOptions(artifacts_path=str(artefatos), do_ocr=False, do_table_structure=True)
    opcoes.table_structure_options.mode = TableFormerMode.ACCURATE
    opcoes.accelerator_options = AcceleratorOptions(num_threads=threads, device=AcceleratorDevice.CPU)

    formato = PdfFormatOption(pipeline_options=opcoes)
    conversor = DocumentConverter(format_options={InputFormat.PDF: formato})

    t0 = time.perf_counter()
    conversor.initialize_pipeline(InputFormat.PDF)  # carrega os modelos
    t_carga = time.perf_counter() - t0

    t1 = time.perf_counter()
    resultado = conversor.convert(pdf)
    t_conversao = time.perf_counter() - t1

    doc = resultado.document.export_to_dict()
    tempos = {"segundos_carga_modelos": round(t_carga, 1), "segundos_conversao": round(t_conversao, 1)}
    return doc, tempos


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("pdf", type=Path)
    ap.add_argument("--artefatos", type=Path, required=True, help="pasta com os modelos do Docling (offline)")
    ap.add_argument("--saida", type=Path, required=True)
    ap.add_argument("--threads", type=int, default=6)
    a = ap.parse_args()

    # RNF-1: nenhuma chamada de rede na conversão
    os.environ["HF_HUB_OFFLINE"] = "1"
    os.environ["HF_HUB_DISABLE_TELEMETRY"] = "1"

    a.saida.mkdir(parents=True, exist_ok=True)
    doc, tempos = converter_pdf(a.pdf, a.artefatos, a.threads)
    cob = cobertura_texto(doc)

    from importlib.metadata import version

    nome = a.pdf.stem
    texto_json = json.dumps(doc, ensure_ascii=False)
    (a.saida / f"{nome}.docling.json").write_text(texto_json, encoding="utf-8")
    resumo = {
        "pdf": a.pdf.name,
        "pdf_sha256": sha256_arquivo(a.pdf),
        "docling": version("docling"),
        "configuracao": {
            "ocr": False,
            "tabelas": "TableFormer accurate",
            "dispositivo": "cpu",
            "threads": a.threads,
        },
        **tempos,
        "segundos_por_pagina": round(tempos["segundos_conversao"] / max(cob["paginas"], 1), 2),
        "cobertura": cob,
    }
    texto_resumo = json.dumps(resumo, ensure_ascii=False, indent=2)
    (a.saida / f"{nome}.tempo.json").write_text(texto_resumo, encoding="utf-8")
    print(json.dumps(resumo, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
