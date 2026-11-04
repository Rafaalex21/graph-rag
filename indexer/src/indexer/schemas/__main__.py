"""Gera os JSON Schemas de `contracts/` a partir dos modelos Pydantic: a extração dirigida
(`extraction.schema.json`, F4.1) e a aberta (`open_extraction.schema.json`, F5.1).

Uso (a partir de indexer/):
    uv run python -m indexer.schemas            # escreve os arquivos
    uv run python -m indexer.schemas --conferir # falha se algum arquivo versionado estiver desatualizado
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

from indexer.schemas import VERSAO, VERSAO_ABERTA, ExtracaoAberta, ExtracaoDirigida

ARQUIVO = Path("contracts") / "extraction.schema.json"
ARQUIVO_ABERTA = Path("contracts") / "open_extraction.schema.json"


def _gerar(modelo, arquivo: Path, versao: str) -> str:
    schema = modelo.model_json_schema()
    cabecalho = {
        "$schema": "https://json-schema.org/draft/2020-12/schema",
        "$id": f"https://graphrag.local/{arquivo.as_posix()}",
        "version": versao,
    }
    return json.dumps({**cabecalho, **schema}, ensure_ascii=False, indent=2) + "\n"


def gerar() -> str:
    """JSON Schema do contêiner, com versão e id; é o que vai em `response_format` (F4.2)."""
    return _gerar(ExtracaoDirigida, ARQUIVO, VERSAO)


def gerar_aberta() -> str:
    """JSON Schema da extração aberta (F5.1/F5.2)."""
    return _gerar(ExtracaoAberta, ARQUIVO_ABERTA, VERSAO_ABERTA)


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--raiz", type=Path, default=Path(".."))
    ap.add_argument("--conferir", action="store_true")
    a = ap.parse_args()
    alvos = [(ARQUIVO, gerar(), VERSAO), (ARQUIVO_ABERTA, gerar_aberta(), VERSAO_ABERTA)]
    for arquivo, texto, versao in alvos:
        destino = a.raiz / arquivo
        if a.conferir:
            atual = destino.read_text(encoding="utf-8").replace("\r\n", "\n") if destino.exists() else ""
            if atual != texto:
                sys.exit(f"{destino} está desatualizado: rode `python -m indexer.schemas`")
            print(f"{destino} em dia (versão {versao})")
            continue
        destino.parent.mkdir(parents=True, exist_ok=True)
        destino.write_text(texto, encoding="utf-8", newline="\n")
        print(f"escrito {destino} (versão {versao})")


if __name__ == "__main__":
    main()
