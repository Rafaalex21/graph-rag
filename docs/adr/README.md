# Decisões de arquitetura (ADRs)

Uma decisão por arquivo: `ADR-NNN-assunto.md`. As nove decisões iniciais estão resumidas na tabela da §15 de [`../ARQUITETURA.md`](../ARQUITETURA.md); cada uma ganha seu arquivo aqui quando a fase que a confirma (ou refuta) for concluída.

| ADR | Assunto | Onde se fecha |
|---|---|---|
| [001](ADR-001-backend.md) | Backend de inferência (Vulkan × HIP) | F0.4 — aceita, revisada na F0.5 |
| [010](ADR-010-offload-moe.md) | Offload de experts do Qwen3.6 (`-lm none`, `--n-cpu-moe`) | F0.5 — aceita, com as medições |
| [011](ADR-011-perfis-swap.md) | Perfis do `llama-swap` (motor `matrix`) e orçamento de VRAM | F0.6 — aceita |
| [012](ADR-012-neo4j-nativo.md) | Neo4j nativo no Windows, sem Docker nem WSL2 | F0.7 — aceita |
| [013](ADR-013-ferramentas-dev.md) | Ferramentas de desenvolvimento portáteis e TypeScript 6.0 fixado | F0.8 — aceita |
| [009](ADR-009-documento.md) | Documento escolhido | F1.1: aceita (Banco do Brasil, FRE 2026 v7) |
| [014](ADR-014-parsing-docling.md) | Docling: versão, modelos e configuração do parsing | F1.3 — aceita |
| [015](ADR-015-normalizacao.md) | Normalização do DoclingDocument (repetidas, figuras decorativas, notas) | F1.4 — aceita, com dois adendos |
| [016](ADR-016-secoes.md) | Árvore de seções pela numeração do documento | F1.5 — aceita |
| [017](ADR-017-numeros.md) | Normalizador numérico | F1.7 — aceita |
| [018](ADR-018-pais-e-filhos.md) | Segmentação em Pais e Filhos | F2.1 — aceita |
| [019](ADR-019-camada-lexica-neo4j.md) | Camada léxica no Neo4j: constraints e carga | F2.2 — aceita |
| [020](ADR-020-embeddings-e-child-vec.md) | Embeddings dos Filhos e índice `child_vec` | F2.3 — aceita |
| [021](ADR-021-busca-hibrida.md) | Full-text `child_ft` e busca híbrida (máximo × RRF) | F2.4 — aceita |
| [022](ADR-022-retriever-parent-document.md) | Retriever parent-document (k×4 Filhos → Pais únicos) | F2.5 — aceita |
| [023](ADR-023-rerank-dos-pais.md) | Rerank dos Pais com o Qwen3-Reranker-0.6B | F2.6 — aceita |
| [024](ADR-024-tabelas-e-perguntas-hipoteticas.md) | Tabelas: descrição, perguntas hipotéticas e `question_vec` | F2.7 — aceita |
| [025](ADR-025-reescritas-da-consulta.md) | Reescritas opcionais da consulta: step-back e HyDE | F2.8 — aceita |
| [026](ADR-026-cli-ask.md) | CLI `ask`: resposta só com o contexto e citação `[p. N]` | F2.9 — aceita |
| [027](ADR-027-golden-set.md) | Golden set de 60 perguntas, conferido contra o PDF | F3.1 — aceita |
| [028](ADR-028-metricas-com-juiz-local.md) | Métricas com o juiz local (recall de contexto, fidelidade, correção) e orçamento de raciocínio | F3.2 — aceita |

Modelo em [`ADR-000-modelo.md`](ADR-000-modelo.md).
