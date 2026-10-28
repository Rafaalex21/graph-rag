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

Pais e Filhos (F2.1, ADR-018); precisa do llama-swap no ar (`infra\swap.ps1`) para contar tokens por `/tokenize`:

```powershell
uv run python -m indexer.chunks ..\data\parsed\bb_fre_2026_recorte.normalizado.json ..\data\parsed\bb_fre_2026_recorte.secoes.json --saida ..\data\parsed
```

Carga no Neo4j (F2.2, ADR-019); precisa do Neo4j no ar (`infra
eo4j.ps1 iniciar`) e de `NEO4J_PASSWORD` no `.env`:

```powershell
uv run python -m indexer.grafo carregar ..\data\parsed\bb_fre_2026_recorte.chunks.json ..\data\parsed\bb_fre_2026_recorte.secoes.json --doc-id bb-fre-2026-v7 --titulo "Formulário de Referência 2026 (ano-base 2025), v7" --emissor "Banco do Brasil S.A." --ano 2025 --arquivo banco_do_brasil_formulario_referencia_2026.pdf --paginas 423 --paginas-indexadas 79
uv run python -m indexer.grafo sanidade --esperado ..\data\parsed\bb_fre_2026_recorte.chunks.json --secoes ..\data\parsed\bb_fre_2026_recorte.secoes.json
```

Embeddings e índice vetorial (F2.3, ADR-020); precisa do llama-swap e do Neo4j no ar:

```powershell
uv run python -m indexer.embeddings embutir
uv run python -m indexer.embeddings autoteste
```

Busca por vetor, texto ou híbrida (F2.4, ADR-021); precisa do llama-swap e do Neo4j no ar:

```powershell
uv run python -m indexer.busca criar-indice
uv run python -m indexer.busca buscar "sua pergunta" --modo hibrido-rrf --k 5
```

Retriever parent-document (F2.5, ADR-022); precisa do llama-swap e do Neo4j no ar:

```powershell
uv run python -m indexer.recuperador buscar "sua pergunta" --modo hibrido-rrf --k 6
uv run python -m indexer.recuperador medir --k 24
```

Rerank dos Pais (F2.6, ADR-023); precisa do llama-swap e do Neo4j no ar:

```powershell
uv run python -m indexer.reranker buscar "sua pergunta" --modo hibrido-rrf --k 24 --top 6
uv run python -m indexer.reranker medir
```

Tabelas: descrição e perguntas hipotéticas (F2.7, ADR-024). `gerar` usa o llama-swap no perfil `indexar`; `carregar` precisa do Neo4j e do perfil `vetorizar`:

```powershell
uv run python -m indexer.tabelas gerar ..\data\parsed\bb_fre_2026_recorte.docling.json ..\data\parsed\bb_fre_2026_recorte.normalizado.json ..\data\parsed\bb_fre_2026_recorte.secoes.json --doc-id bb-fre-2026-v7
uv run python -m indexer.tabelas carregar ..\data\parsed\bb_fre_2026_recorte.tabelas.json --doc-id bb-fre-2026-v7
uv run python -m indexer.tabelas autoteste
```

Reescritas opcionais da consulta (F2.8, ADR-025); precisam do LLM no llama-swap (perfil `consultar`):

```powershell
uv run python -m indexer.reranker buscar "sua pergunta" --stepback --hyde
uv run python -m indexer.recuperador comparar-reescritas
```

CLI `ask` (F2.9, ADR-026); precisa do llama-swap (perfil `consultar`) e do Neo4j no ar:

```powershell
uv run python -m indexer.ask "Qual foi o caixa líquido proveniente das atividades operacionais em 2025?"
uv run python -m indexer.ask avaliar
```

Métricas com o juiz local (F3.2, ADR-028); precisa do llama-swap (perfis `consultar` e `avaliar`, um de cada vez) e do Neo4j no ar. Retomável: repetir o comando com o mesmo `--nome` continua de onde parou. Os dados ficam em `data/avaliacao/<nome>/` (ignorado pelo git) e as notas em `eval/resultados/<nome>.json`:

```powershell
uv run python -m indexer.avaliar executar --nome f3-2-a3-60
uv run python -m indexer.avaliar executar --nome teste --limite 3
```

Métricas mecânicas (F3.3, ADR-029): page recall@k, acerto numérico (0,5%) e latência p50/p95 saem das respostas já gravadas e entram no mesmo relatório. Para refazê-lo sem LLM, sem llama-swap e sem Neo4j:

```powershell
uv run python -m indexer.avaliar relatorio --nome f3-2-a3-60
```

Calibração do juiz (F3.4, ADR-030), sem LLM: gera a planilha de 20 respostas para rotular (não sobrescreve rótulos) e calcula a concordância com `eval/calibracao_juiz.csv`:

```powershell
uv run python -m indexer.calibrar planilha --nome f3-2-a3-60
uv run python -m indexer.calibrar concordancia --nome f3-2-a3-60
```
