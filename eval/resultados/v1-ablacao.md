# Escada de ablações v1: A0 a A6 no documento inteiro

Golden set de 60 perguntas (`eval/golden.csv`), **todas** (n = 60), no índice do documento inteiro (F5.8); juiz Gemma 4 26B-A4B ([ADR-028](../../docs/adr/ADR-028-metricas-com-juiz-local.md)), métricas mecânicas do [ADR-029](../../docs/adr/ADR-029-metricas-mecanicas.md). Definição, degraus e limites em [`eval/f91-medida-ablacao.md`](../f91-medida-ablacao.md). Uma execução por degrau; **diferença menor que 0,05 vale como empate** (3 perguntas).

## Resultado (60 perguntas)

| Degrau | Correção | Fidelidade | Recall de contexto | Page recall@1 / @6 | Página citada | Acerto numérico | Latência p50 / p95 (s) | Erros do sistema | Falhas do juiz |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| **A0** | 0,20 | n/a | n/a | 0,00 / 0,00 | 0,00 | 0,00 | 0,4 / 10,8 | 0 | 0 |
| **A1** | 0,54 | 1,00 | 0,56 | 0,43 / 0,58 | 0,44 | 0,24 | 2,3 / 7,1 | 0 | 0 |
| **A2** | 0,53 | 1,00 | 0,53 | 0,45 / 0,58 | 0,47 | 0,24 | 2,4 / 8,4 | 0 | 0 |
| **A3** | 0,54 | 1,00 | 0,58 | 0,47 / 0,63 | 0,47 | 0,24 | 5,0 / 10,5 | 0 | 0 |
| **A3ts** | 0,53 | 1,00 | 0,53 | 0,43 / 0,59 | 0,53 | 0,29 | 8,1 / 15,4 | 0 | 0 |
| **A4** | 0,54 | 1,00 | 0,55 | 0,49 / 0,61 | 0,55 | 0,38 | 8,2 / 18,2 | 0 | 0 |
| **A5** | 0,53 | 0,98 | 0,53 | 0,46 / 0,57 | 0,47 | 0,38 | 8,0 / 37,2 | 0 | 0 |
| **A6** | 0,59 | 0,97 | 0,63 | 0,44 / 0,61 | 0,60 | 0,48 | 22,9 / 111,6 | 0 | 0 |

- **A0**: LLM sem recuperação (de memória)
- **A1**: Vetor ingênuo: 6 Filhos
- **A2**: + full-text (híbrido RRF): 6 Filhos
- **A3**: + Pai e reranker (24 Pais → 6)
- **A3ts**: controle: só `buscar_trechos` pelo pipeline do agente em TypeScript e o redator
- **A4**: + templates de fatos e Text2Cypher (`consultar_grafo`)
- **A5**: + busca local (`entidade`) e global (`panorama`)
- **A6**: agente completo: 12 ferramentas e crítico (até 2 rodadas)

Correção: 1 correta, 0,5 parcial, 0 incorreta. Fidelidade e recall de contexto medem o contexto entregue ao LLM (no A0 não existem). Nos degraus do TypeScript o contexto é o que o redator viu. A latência de A0 a A3 é a do `ask` em Python; a de A3ts a A6 inclui atualizador, roteador, redator e, no A6, o crítico: comparar as duas famílias é indicativo.

## Só nas 54 do recorte (a comparação mais próxima do v0)

| Degrau | Correção | Fidelidade | Recall de contexto | Page recall@1 / @6 | Página citada | Acerto numérico | Latência p50 / p95 (s) | Erros do sistema | Falhas do juiz |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| **A0** | 0,20 | n/a | n/a | 0,00 / 0,00 | 0,00 | 0,00 | 0,4 / 11,2 | 0 | 0 |
| **A1** | 0,52 | 1,00 | 0,52 | 0,40 / 0,55 | 0,41 | 0,20 | 2,3 / 7,1 | 0 | 0 |
| **A2** | 0,50 | 1,00 | 0,50 | 0,42 / 0,54 | 0,45 | 0,20 | 2,3 / 8,8 | 0 | 0 |
| **A3** | 0,52 | 1,00 | 0,54 | 0,45 / 0,60 | 0,45 | 0,20 | 5,0 / 11,4 | 0 | 0 |
| **A3ts** | 0,51 | 1,00 | 0,49 | 0,40 / 0,56 | 0,49 | 0,25 | 8,1 / 16,0 | 0 | 0 |
| **A4** | 0,52 | 1,00 | 0,52 | 0,47 / 0,58 | 0,51 | 0,35 | 8,4 / 16,6 | 0 | 0 |
| **A5** | 0,52 | 0,98 | 0,51 | 0,46 / 0,56 | 0,45 | 0,35 | 8,2 / 39,7 | 0 | 0 |
| **A6** | 0,59 | 0,96 | 0,63 | 0,43 / 0,60 | 0,59 | 0,45 | 23,8 / 113,3 | 0 | 0 |

## Correção por categoria (60 perguntas)

| Degrau | Factual | Numérica | Agregação | Temática | Multi-hop | Fora do escopo |
|---|---:|---:|---:|---:|---:|---:|
| **A0** | 0,17 | 0,00 | 0,00 | 0,45 | 0,00 | 1,00 |
| **A1** | 0,90 | 0,33 | 0,00 | 0,90 | 0,00 | 1,00 |
| **A2** | 0,93 | 0,27 | 0,00 | 0,90 | 0,00 | 1,00 |
| **A3** | 0,90 | 0,27 | 0,00 | 0,90 | 0,20 | 1,00 |
| **A3ts** | 0,77 | 0,40 | 0,00 | 0,75 | 0,40 | 1,00 |
| **A4** | 0,73 | 0,47 | 0,00 | 0,75 | 0,40 | 1,00 |
| **A5** | 0,70 | 0,47 | 0,00 | 0,70 | 0,40 | 1,00 |
| **A6** | 0,70 | 0,50 | 0,20 | 0,75 | 0,60 | 1,00 |

## As 6 perguntas fora do recorte

| Degrau | Correção nas 6 de fora do recorte | Notas por pergunta |
|---|---:|---|
| **A0** | 0,17 | N15 0,0, T11 0,0, T12 0,0, T13 0,0, T14 1,0, T15 0,0 |
| **A1** | 0,75 | N15 1,0, T11 1,0, T12 0,0, T13 0,5, T14 1,0, T15 1,0 |
| **A2** | 0,83 | N15 1,0, T11 1,0, T12 0,0, T13 1,0, T14 1,0, T15 1,0 |
| **A3** | 0,75 | N15 1,0, T11 1,0, T12 0,0, T13 0,5, T14 1,0, T15 1,0 |
| **A3ts** | 0,75 | N15 1,0, T11 1,0, T12 0,0, T13 0,5, T14 1,0, T15 1,0 |
| **A4** | 0,75 | N15 1,0, T11 1,0, T12 0,0, T13 0,5, T14 1,0, T15 1,0 |
| **A5** | 0,58 | N15 1,0, T11 1,0, T12 0,0, T13 0,5, T14 0,0, T15 1,0 |
| **A6** | 0,58 | N15 1,0, T11 1,0, T12 0,0, T13 0,5, T14 0,0, T15 1,0 |

## Grupo novo (24 perguntas de `eval/golden_novas.csv`, fora do ajuste; só A3 e A6)

| Degrau | Correção | Fidelidade | Recall de contexto | Page recall@1 / @6 | Página citada | Acerto numérico | Latência p50 / p95 (s) | Erros do sistema | Falhas do juiz |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| **A3** | 0,48 | 1,00 | 0,50 | 0,60 / 0,76 | 0,48 | 0,30 | 4,4 / 9,4 | 0 | 0 |
| **A6** | 0,46 | 1,00 | 0,50 | 0,69 / 0,79 | 0,62 | 0,40 | 23,6 / 31,2 | 0 | 0 |

Regerar: `uv run python -m indexer.tabela --v1` (a partir de `indexer/`, sem LLM).
