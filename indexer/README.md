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

Escada de ablações (F3.5, ADR-031): `--degrau` troca o sistema avaliado (`a0` de memória, `a1` vetor, `a2` híbrida, `a3` pipeline do `ask`, `a3r` com step-back e HyDE) e `indexer.tabela` junta os relatórios em `eval/resultados/v0.md`, sem LLM. A rodada completa leva cerca de 3 h na GPU:

```powershell
uv run python -m indexer.avaliar executar --nome v0-a1 --degrau a1
uv run python -m indexer.avaliar executar --nome v0-a3r --degrau a3r
uv run python -m indexer.tabela
```

Esquemas da extração (F4.1, ADR-032), sem LLM: gera `contracts/extraction.schema.json` a partir dos modelos Pydantic de `indexer.schemas`; `--conferir` falha se o arquivo estiver desatualizado:

```powershell
uv run python -m indexer.schemas
uv run python -m indexer.schemas --conferir
```

Extração dirigida a esquema (F4.2, ADR-033); precisa do llama-swap no perfil `indexar` (Qwen3.6) e é retomável (cache por hash em `data/parsed/extracao_cache/`; repetir o comando não refaz o que já está válido). Grava `data/parsed/<prefixo>.extracao.json` (fora do git):

```powershell
uv run python -m indexer.extrair executar ../data/parsed/bb_fre_2026_recorte
uv run python -m indexer.extrair executar ../data/parsed/bb_fre_2026_recorte --limite 5
uv run python -m indexer.extrair resumo ../data/parsed/bb_fre_2026_recorte
```

Lastro numérico dos fatos (F4.3, ADR-034); não usa LLM nem serviço. Confere cada fato contra o texto enviado e grava `data/parsed/<prefixo>.fatos.json` (fora do git), com o motivo de cada rejeição; `--amostra K --semente N` sorteia K fatos aceitos para auditar em `data/parsed/auditoria/` (fora do git):

```powershell
uv run python -m indexer.lastro ../data/parsed/bb_fre_2026_recorte
uv run python -m indexer.lastro ../data/parsed/bb_fre_2026_recorte --amostra 30 --semente 4
```

Importação dos fatos aceitos e das entidades no Neo4j, com `MERGE` e IDs determinísticos (F4.4, ADR-035); não usa LLM, mas precisa do Neo4j no ar (`infra\neo4j.ps1 iniciar`). `executar` importa e conta; `verificar` importa duas vezes e compara contagens e impressão digital (só adiciona nós, nunca apaga):

```powershell
uv run python -m indexer.importar executar ../data/parsed/bb_fre_2026_recorte --doc-id bb-fre-2026-v7
uv run python -m indexer.importar verificar ../data/parsed/bb_fre_2026_recorte --doc-id bb-fre-2026-v7
```

Catálogo de métricas canônicas (F4.6, ADR-037); `validar` e `termo` não usam serviço. `mapear` liga os rótulos das métricas dos fatos ao catálogo `contracts/metricas.json` (termo exato sem LLM, o resto pelo Qwen3.6 no perfil `indexar`; retomável, cache em `data/parsed/metricas_cache/`) e grava `data/parsed/<prefixo>.metricas.json` (fora do git), que o importador lê sozinho para criar os nós `Metric` e o `OF_METRIC`. `medir` conta os fatos ligados no Neo4j:

```powershell
uv run python -m indexer.catalogo validar
uv run python -m indexer.catalogo termo faturamento
uv run python -m indexer.catalogo mapear ../data/parsed/bb_fre_2026_recorte
uv run python -m indexer.importar executar ../data/parsed/bb_fre_2026_recorte --doc-id bb-fre-2026-v7
uv run python -m indexer.catalogo medir ../data/parsed/bb_fre_2026_recorte --doc-id bb-fre-2026-v7
```

Extração aberta (F5.1, ADR-038), a camada MS GraphRAG: entidades de 11 tipos fixos e relações com força de 1 a 10 por Pai, com o esquema em `contracts/open_extraction.schema.json` (gerado por `python -m indexer.schemas`). Precisa só do llama-swap no perfil `indexar`; `--amostra N` sorteia N Pais de pelo menos 300 tokens (`--semente`), a saída vai para `data/parsed/<prefixo>.aberta.json` (fora do git) e o cache para `data/parsed/aberta_cache/`. `resumo` conta a saída sem LLM:

```powershell
uv run python -m indexer.extracao_aberta executar ../data/parsed/bb_fre_2026_recorte --amostra 5 --semente 1
uv run python -m indexer.extracao_aberta resumo ../data/parsed/bb_fre_2026_recorte --amostra 5 --semente 1
```

*Gleaning* (F5.2, ADR-039): `--gleaning 1` faz uma rodada extra por Pai e a saída traz `ganho_do_gleaning`; o padrão é 0, porque a rodada extra acrescentou 60% de entidades mas só metade estava certa. `--minimo`, `--excluir` e `--saida` refazem a amostra de 20 Pais sem tocar na da F5.1:

```powershell
uv run python -m indexer.extracao_aberta executar ../data/parsed/bb_fre_2026_recorte --amostra 20 --minimo 100 --semente 2 --gleaning 1 --saida aberta_f52 --excluir a7babf0139ab7d1e 923805392cfd8e61 997b78e7a9370bfc 259a2ade6cd81a7a 454107c2f98f2838
```

Resolução de entidades (F4.5, ADR-036); precisa do Neo4j e do llama-swap (perfis `vetorizar` e `indexar`). `planejar` reconstrói o grafo sem fusões, gera candidatos, pergunta ao LLM e grava `data/parsed/<prefixo>.resolucao.json` (fora do git; cache em `data/parsed/resolucao_cache/`). `aplicar` funde com `apoc.refactor.mergeNodes` (sem LLM) e confere que reimportar não muda nada. O importador lê o plano sozinho, então reimportar não recria os nós fundidos:

```powershell
uv run python -m indexer.resolver planejar ../data/parsed/bb_fre_2026_recorte --doc-id bb-fre-2026-v7
uv run python -m indexer.resolver aplicar ../data/parsed/bb_fre_2026_recorte --doc-id bb-fre-2026-v7
```

Extração aberta do recorte inteiro e convergência com a dirigida (F5.3, ADR-040). O importador carrega `<prefixo>.aberta.json` quando ele existe (entidades `Product`, `FinancialMetric`, `Regulation`, `Policy`, `Location` e as demais com o id da dirigida, mais `RELATED_TO`), então a ordem é: extrair, copiar a saída para `.aberta.json`, `planejar`, `aplicar`. A resolução ganhou o fechamento dos grupos, a fusão parcial de conflitos e as razões de candidato novas (contração, nome igual entre tipos, nota entre parênteses):

```powershell
uv run python -m indexer.extracao_aberta executar ../data/parsed/bb_fre_2026_recorte --saida aberta_f53
Copy-Item ../data/parsed/bb_fre_2026_recorte.aberta_f53.json ../data/parsed/bb_fre_2026_recorte.aberta.json
uv run python -m indexer.resolver planejar ../data/parsed/bb_fre_2026_recorte --doc-id bb-fre-2026-v7
uv run python -m indexer.resolver aplicar ../data/parsed/bb_fre_2026_recorte --doc-id bb-fre-2026-v7
```

## Resumos de entidades e relações (F5.4, ADR-041)

Depois de `aplicar`, `indexer.resumos` resume as descrições de cada entidade e de cada `RELATED_TO` (só chama o LLM com mais de um texto; o emissor sai em dois níveis), grava `summary` e `summarySource` nas entidades, o rótulo `:Issuer` e a `SUMMARIZED_RELATIONSHIP` com `weight` e `rank`. Precisa do Neo4j e do `llama-swap`; é idempotente (cache por hash em `data/parsed/resumos_cache/`, 0 chamadas na segunda rodada):

```powershell
uv run python -m indexer.resumos executar ../data/parsed/bb_fre_2026_recorte
uv run python -m indexer.resumos verificar ../data/parsed/bb_fre_2026_recorte
```

## Comunidades (F5.5, ADR-042)

Leiden hierárquico no GDS sobre `SUMMARIZED_RELATIONSHIP`, sem o emissor e sem as entidades sem aresta; grava `(:__Community__ {id, level, size})`, `IN_COMMUNITY` (nível 0) e `PARENT_COMMUNITY`, e imprime a modularidade (GDS e recalculada) e a contagem por nível. Precisa do Neo4j com o GDS; reexecutar apaga e refaz as comunidades com os mesmos ids:

```powershell
uv run python -m indexer.comunidades executar
uv run python -m indexer.comunidades verificar
```

## Relatórios de comunidade (F5.6, ADR-043)

O Qwen3.6 escreve um relatório JSON por comunidade (título, resumo, nota de 0 a 10, achados com referências às entidades e relações); a validação recusa referência inexistente, etiqueta no texto e nota fora da faixa. `gerar` usa o perfil `indexar` e é idempotente (cache por hash em `data/parsed/relatorios_cache/`); `embutir` usa o `vetorizar` e cria o índice `community_vec`; depois de mudar um relatório, rode `embutir` de novo:

```powershell
uv run python -m indexer.relatorios gerar
uv run python -m indexer.relatorios embutir
uv run python -m indexer.relatorios autoteste
uv run python -m indexer.relatorios verificar
```

## Documento inteiro (F5.8, ADR-045)

O mesmo pipeline nas 423 páginas, sem o mapa do recorte (`--mapa` é opcional em `normalize` e `sections`; a página física é a do PDF). Os quatro primeiros passos são comandos próprios; o resto é o orquestrador `infra\indexar-documento.ps1`, que grava as etapas em `data\logs\f58_etapas.log` (leia por varredura, nunca com `tail -F`), o estado em `f58_estado.txt`, repete cada etapa até 3 vezes e é retomável. `-Esvaziar` apaga o grafo antes da carga (faça `neo4j-admin database dump` antes, com o Neo4j parado depois de um desligamento limpo):

```powershell
uv run --group parse python -m indexer.parse ..\data\raw\banco_do_brasil_formulario_referencia_2026.pdf --artefatos ..\infra\bin\modelos-docling --saida ..\data\parsed
uv run python -m indexer.normalize ..\data\parsed\banco_do_brasil_formulario_referencia_2026.docling.json --saida ..\data\parsed
uv run --group parse python -m indexer.sections ..\data\parsed\banco_do_brasil_formulario_referencia_2026.normalizado.json --pdf-original ..\data\raw\banco_do_brasil_formulario_referencia_2026.pdf --saida ..\data\parsed
uv run python -m indexer.chunks ..\data\parsed\banco_do_brasil_formulario_referencia_2026.normalizado.json ..\data\parsed\banco_do_brasil_formulario_referencia_2026.secoes.json --saida ..\data\parsed
cd ..; .\infra\indexar-documento.ps1 -Esvaziar      # ou -De <etapa> para retomar
```

Cuidado: `resolver planejar` **desfaz as fusões** no Neo4j; depois dele rode `resolver aplicar` e as etapas seguintes (resumos, comunidades, relatórios, vetores de entidade), que vêm do cache.

## Embeddings de entidade (F5.7, ADR-044)

`indexer.entidades_vec` embute `nome (tipo). resumo` + apelidos de cada `__Entity__` no perfil `vetorizar` e cria o índice `entity_vec`; o hash do texto em `embeddingHash` faz a reexecução embutir só o que mudou. O autoteste re-embute pela CPU e exige a entidade em 1º lugar:

```powershell
uv run python -m indexer.entidades_vec embutir
uv run python -m indexer.entidades_vec autoteste
uv run python -m indexer.entidades_vec verificar
```
