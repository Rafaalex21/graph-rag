"""Gera `contracts/extraction.schema.json` a partir dos modelos Pydantic.

Uso (a partir de indexer/):
    uv run python -m indexer.schemas            # escreve o arquivo
    uv run python -m indexer.schemas --conferir # falha se o arquivo versionado estiver desatualizado
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

from indexer.schemas import VERSAO, ExtracaoDirigida

ARQUIVO = Path("contracts") / "extraction.schema.json"


def gerar() -> str:
    """JSON Schema do contêiner, com versão e id; é o que vai em `response_format` (F4.2)."""
    schema = ExtracaoDirigida.model_json_schema()
    cabecalho = {
        "$schema": "https://json-schema.org/draft/2020-12/schema",
        "$id": "https://graphrag.local/contracts/extraction.schema.json",
        "version": VERSAO,
    }
    return json.dumps({**cabecalho, **schema}, ensure_ascii=False, indent=2) + "\n"


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--raiz", type=Path, default=Path(".."))
    ap.add_argument("--conferir", action="store_true")
    a = ap.parse_args()
    destino = a.raiz / ARQUIVO
    texto = gerar()
    if a.conferir:
        atual = destino.read_text(encoding="utf-8").replace("\r\n", "\n") if destino.exists() else ""
        if atual != texto:
            sys.exit(f"{destino} está desatualizado: rode `python -m indexer.schemas`")
        print(f"{destino} em dia (versão {VERSAO})")
        return
    destino.parent.mkdir(parents=True, exist_ok=True)
    destino.write_text(texto, encoding="utf-8", newline="\n")
    print(f"escrito {destino} (versão {VERSAO})")


if __name__ == "__main__":
    main()
