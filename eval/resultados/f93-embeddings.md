# Bake-off de embeddings (F9.3): Qwen3-Embedding-0.6B contra três candidatos

Mesmos Filhos, mesmo full-text, mesmo reranker, mesmo juiz (Gemma 4 26B-A4B), mesmas perguntas; só mudam o índice vetorial dos Filhos e o formato da consulta e do documento que cada modelo pede. **A1** = só vetor (6 Filhos); **A2** = híbrido RRF (6 Filhos); **A3** = o pipeline de produção (24 Pais → rerank → 6 Pais). Recall de contexto = fração do gabarito que o contexto recuperado sustenta (juiz); sem LLM de resposta. Definição, regras e limites em [`eval/f93-medida-embeddings.md`](../f93-medida-embeddings.md), fixados antes de rodar. Uma execução por candidato; **diferença menor que 0,05 em recall de contexto vale como empate**.

## Recuperação

### 60 perguntas do `eval/golden.csv`

| Candidato | Recall de contexto A1 | Recall de contexto A3 | Page recall@1 / @3 / @6 (A1) | Page recall@1 / @3 / @6 (A2) | Page recall@1 / @3 / @6 (A3) |
|---|---:|---:|---|---|---|
| **Qwen3-Embedding-0.6B (produção)** | 0,56 | 0,58 | 0,41 / 0,52 / 0,58 | 0,45 / 0,53 / 0,57 | 0,47 / 0,58 / 0,63 |
| **Qwen3-Embedding-4B** | 0,58 | 0,57 | 0,40 / 0,54 / 0,61 | 0,42 / 0,56 / 0,58 | 0,45 / 0,56 / 0,61 |
| **EmbeddingGemma 2** | 0,56 | 0,56 | 0,45 / 0,50 / 0,60 | 0,47 / 0,53 / 0,59 | 0,45 / 0,56 / 0,61 |
| **bge-m3** | 0,55 | 0,58 | 0,43 / 0,54 / 0,57 | 0,46 / 0,56 / 0,58 | 0,47 / 0,58 / 0,63 |

### 24 perguntas do grupo novo (`eval/golden_novas.csv`, fora do ajuste)

| Candidato | Recall de contexto A1 | Recall de contexto A3 | Page recall@1 / @3 / @6 (A1) | Page recall@1 / @3 / @6 (A2) | Page recall@1 / @3 / @6 (A3) |
|---|---:|---:|---|---|---|
| **Qwen3-Embedding-0.6B (produção)** | 0,45 | 0,50 | 0,52 / 0,67 / 0,69 | 0,52 / 0,64 / 0,76 | 0,60 / 0,74 / 0,76 |
| **Qwen3-Embedding-4B** | 0,50 | 0,50 | 0,48 / 0,52 / 0,62 | 0,43 / 0,62 / 0,76 | 0,60 / 0,74 / 0,76 |
| **EmbeddingGemma 2** | 0,44 | 0,50 | 0,45 / 0,55 / 0,60 | 0,50 / 0,60 / 0,71 | 0,60 / 0,74 / 0,76 |
| **bge-m3** | 0,50 | 0,50 | 0,43 / 0,60 / 0,76 | 0,48 / 0,67 / 0,76 | 0,60 / 0,69 / 0,76 |

### Validação do harness (o incumbente refeito reproduz a F9.1)

| Degrau | Page recall@6 aqui | Page recall@6 na F9.1 | Diferença | Dentro de ±0,02 |
|---|---:|---:|---:|---|
| r1 | 0,5848 | 0,5848 | 0,0000 | sim |
| r3 | 0,6273 | 0,6273 | 0,0000 | sim |

## Custo

| Candidato | Arquivo (MB) | Dimensões | Vetores dos Filhos (MB) | Embutir Filhos (por s, GPU) | Consulta na CPU p50 / p95 (ms) |
|---|---:|---:|---:|---:|---:|
| **Qwen3-Embedding-0.6B (produção)** | 639 | 1024 | 4.3 | 105,5 | 73,4 / 76,7 |
| **Qwen3-Embedding-4B** | 4280 | 2560 | 10.7 | 23,4 | 288,9 / 323,0 |
| **EmbeddingGemma 2** | 310 | 768 | 3.2 | 163,0 | 47,8 / 53,8 |
| **bge-m3** | 635 | 1024 | 4.3 | 128,1 | 56,2 / 76,9 |

## Aplicação da regra

| Candidato | Δ recall de contexto A3 (60) | Δ recall de contexto A3 (24) | Δ page recall@6 A3 (60) | Qualidade | Consulta CPU p50 (ms) | Substitui o Qwen3-0.6B |
|---|---:|---:|---:|---|---:|---|
| Qwen3-Embedding-4B | -0,01 | 0,00 | -0,02 | equivalente | 288,9 | não |
| EmbeddingGemma 2 | -0,02 | 0,00 | -0,02 | equivalente | 47,8 | não |
| bge-m3 | -0,00 | 0,00 | 0,00 | equivalente | 56,2 | não |

**Embedding pela regra: Qwen3-Embedding-0.6B (produção).**

Regerar: `uv run python -m indexer.f93` (a partir de `indexer/`, sem LLM).
