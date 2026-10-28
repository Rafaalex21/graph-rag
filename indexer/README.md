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

Normalização (F1.4, ADR-015), sem precisar do grupo `parse`:

```powershell
uv run python -m indexer.normalize ..\data\parsed\bb_fre_2026_recorte.docling.json `
    --mapa ..\data\raw\bb_fre_2026_recorte_mapa.json --saida ..\data\parsed
```

Árvore de seções e comparação com o sumário do PDF (F1.5, ADR-016):

```powershell
uv run --group parse python -m indexer.sections ..\data\parsed\bb_fre_2026_recorte.normalizado.json `
    --pdf-original ..\data\raw\banco_do_brasil_formulario_referencia_2026.pdf `
    --mapa ..\data\raw\bb_fre_2026_recorte_mapa.json --saida ..\data\parsed
```

Auditoria de tabelas contra o PDF (F1.6, `docs/auditoria-tabelas.md`):

```powershell
uv run --group parse python -m indexer.auditoria ..\data\parsed\bb_fre_2026_recorte.docling.json `
    --pdf ..\data\raw\bb_fre_2026_recorte.pdf --mapa ..\data\raw\bb_fre_2026_recorte_mapa.json `
    --saida ..\data\parsed\auditoria --n 15 --semente 20261028
```

Normalizador numérico (F1.7, ADR-017); resume as células das tabelas de um `DoclingDocument`:

```powershell
uv run python -m indexer.numeros ..\data\parsed\bb_fre_2026_recorte.docling.json
```
