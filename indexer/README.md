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
