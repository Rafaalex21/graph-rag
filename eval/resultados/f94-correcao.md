# Ciclo de correção (F9.4): o A6 da F9.1 contra o A6 refeito

Mesmo Qwen3.6, mesmo juiz (Gemma 4 26B-A4B), mesmo índice, mesmas perguntas; só muda o que cada rodada diz na medida. **Falha** de uma categoria = 1 − correção média (pontos perdidos por pergunta). Regra e limites em [`eval/f94-medida-correcao.md`](../f94-medida-correcao.md), fixados antes de rodar. Uma execução por rodada; **diferença menor que 0,05 vale como empate**.

## Rodada r1

### Correção e falha por categoria

| Categoria | Correção F9.1 (60) | Correção agora (60) | Falha F9.1 | Falha agora | Correção F9.1 (24) | Correção agora (24) |
|---|---:|---:|---:|---:|---:|---:|
| **Factual** | 0,70 | 0,83 | 0,30 | 0,17 | 0,42 | 0,92 |
| **Numérica** (fraca) | 0,50 | 0,63 | 0,50 | 0,37 | 0,33 | 0,33 |
| **Agregação** (fraca) | 0,20 | 0,40 | 0,80 | 0,60 | 0,67 | 0,67 |
| **Temática** | 0,75 | 0,80 | 0,25 | 0,20 | 0,17 | 0,17 |
| **Multi-hop** | 0,60 | 0,50 | 0,40 | 0,50 | 0,33 | 0,33 |
| **Fora do escopo** | 1,00 | 1,00 | 0,00 | 0,00 | 1,00 | 1,00 |
| **Geral** | 0,59 | 0,69 | 0,41 | 0,31 | 0,46 | 0,58 |

### Outras métricas (60 perguntas)

| | F9.1 | Agora |
|---|---:|---:|
| Fidelidade | 0,97 | 0,99 |
| Recall de contexto (o contexto agora é maior: não comparável 1 a 1) | 0,63 | 0,75 |
| Página citada | 0,60 | 0,67 |
| Acerto numérico | 0,48 | 0,62 |
| Latência p50 / p95 (s) | 22,9 / 111,6 | 16,9 / 55,9 |

### Aplicação da regra

| Item | Resultado | Vale |
|---|---|---|
| Falha de agregação ≤ metade da F9.1 (≤ 0,40) | 0,60 (era 0,80) | não |
| Falha de numérica ≤ metade da F9.1 (≤ 0,25) | 0,37 (era 0,50) | não |
| Nenhuma categoria perde ≥ 0,10 de correção nas 60 | quedas: Multi-hop 0,10 | não |
| Fora do escopo segue em 1,00 (60 e 24) | 1,00 / 1,00 | **sim** |
| Fidelidade ≥ 0,95 | 0,99 | **sim** |
| Grupo novo: correção geral não cai mais de 0,05 | 0,46 → 0,58 (0,13) | **sim** |
| Latência p50 / p95 dentro de 125% da F9.1 (informativo) | 16,9 / 55,9 s | sim |
| Erros do sistema (60; 24) / falhas do juiz (60; 24) | 0; 0 / 0; 0 | — |

**Aceite da rodada r1: NÃO cumprido.**

## Rodada r2

### Correção e falha por categoria

| Categoria | Correção F9.1 (60) | Correção agora (60) | Falha F9.1 | Falha agora | Correção F9.1 (24) | Correção agora (24) |
|---|---:|---:|---:|---:|---:|---:|
| **Factual** | 0,70 | 0,83 | 0,30 | 0,17 | 0,42 | 1,00 |
| **Numérica** (fraca) | 0,50 | 0,73 | 0,50 | 0,27 | 0,33 | 0,50 |
| **Agregação** (fraca) | 0,20 | 0,40 | 0,80 | 0,60 | 0,67 | 0,83 |
| **Temática** | 0,75 | 0,80 | 0,25 | 0,20 | 0,17 | 0,17 |
| **Multi-hop** | 0,60 | 0,60 | 0,40 | 0,40 | 0,33 | 0,33 |
| **Fora do escopo** | 1,00 | 1,00 | 0,00 | 0,00 | 1,00 | 1,00 |
| **Geral** | 0,59 | 0,72 | 0,41 | 0,28 | 0,46 | 0,67 |

### Outras métricas (60 perguntas)

| | F9.1 | Agora |
|---|---:|---:|
| Fidelidade | 0,97 | 0,98 |
| Recall de contexto (o contexto agora é maior: não comparável 1 a 1) | 0,63 | 0,88 |
| Página citada | 0,60 | 0,78 |
| Acerto numérico | 0,48 | 0,67 |
| Latência p50 / p95 (s) | 22,9 / 111,6 | 22,1 / 61,8 |

### Aplicação da regra

| Item | Resultado | Vale |
|---|---|---|
| Falha de agregação ≤ metade da F9.1 (≤ 0,40) | 0,60 (era 0,80) | não |
| Falha de numérica ≤ metade da F9.1 (≤ 0,25) | 0,27 (era 0,50) | não |
| Nenhuma categoria perde ≥ 0,10 de correção nas 60 | quedas: nenhuma queda | **sim** |
| Fora do escopo segue em 1,00 (60 e 24) | 1,00 / 1,00 | **sim** |
| Fidelidade ≥ 0,95 | 0,98 | **sim** |
| Grupo novo: correção geral não cai mais de 0,05 | 0,46 → 0,67 (0,21) | **sim** |
| Latência p50 / p95 dentro de 125% da F9.1 (informativo) | 22,1 / 61,8 s | sim |
| Erros do sistema (60; 24) / falhas do juiz (60; 24) | 0; 0 / 0; 0 | — |

**Aceite da rodada r2: NÃO cumprido.**

Regerar: `uv run python -m indexer.f94 --rodadas r1 r2` (a partir de `indexer/`, sem LLM).
