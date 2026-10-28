# indexer

Indexador do GraphRAG local (Python 3.12, `uv`). Ainda é só o esqueleto da tarefa F0.8; os módulos de
`parse`, `normalize`, `segment`, `embed`, `extract`, `resolve`, `summarize`, `communities` e `load`
(ARQUITETURA §10) entram nas fases F1 a F5.

```powershell
. ..\infra\dev-env.ps1     # uv no PATH desta sessão
uv sync
uv run pytest
uv run ruff check .
```

Parsing de PDF (F1.3), com o grupo opcional `parse` (Docling, ADR-014):

```powershell
uv sync --group parse      # um `uv sync` puro remove o Docling
uv run --group parse python -m indexer.parse ..\data\raw\bb_fre_2026_recorte.pdf `
    --artefatos ..\infra\bin\modelos-docling --saida ..\data\parsed
```
