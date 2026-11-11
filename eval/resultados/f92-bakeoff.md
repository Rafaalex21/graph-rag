# Bake-off de modelos locais (F9.2): agente e redator, e extração em amostra

Três LLMs no papel de **agente e redator** (atualizador, roteador, executor com Text2Cypher e panorama, crítico e redator, o A6 inteiro da F9.1) e na **extração aberta** de uma amostra de Pais. Mesmo código, mesmos prompts, mesmo juiz (Gemma 4 26B-A4B no perfil `avaliar`), mesmo índice. Definição, regras de decisão e limites em [`eval/f92-medida-bakeoff.md`](../f92-medida-bakeoff.md), fixados antes de rodar. Uma execução por LLM.

## Agente e redator: 60 perguntas do `eval/golden.csv`

| LLM | Correção | Fidelidade | Recall de contexto | Página citada | Acerto numérico | Latência p50 / p95 (s) | Erros do sistema | Falhas do juiz | VRAM pico (GB) |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| **Qwen3.6-35B-A3B (produção)** | 0,59 | 0,97 | 0,63 | 0,60 | 0,48 | 22,9 / 111,6 | 0 | 0 | 11,7 |
| **gpt-oss-20b (raciocínio low)** | 0,58 | 0,97 | 0,59 | 0,47 | 0,38 | 10,5 / 19,3 | 0 | 0 | 12,9 |
| **Gemma 4 26B-A4B (Vulkan, sem raciocínio)** | 0,53 | 0,97 | 0,54 | 0,47 | 0,29 | 12,3 / 43,4 | 0 | 0 | 14,8 |

## Agente e redator: 24 perguntas do grupo novo (`eval/golden_novas.csv`, fora do ajuste)

| LLM | Correção | Fidelidade | Recall de contexto | Página citada | Acerto numérico | Latência p50 / p95 (s) | Erros do sistema | Falhas do juiz | VRAM pico (GB) |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| **Qwen3.6-35B-A3B (produção)** | 0,46 | 1,00 | 0,50 | 0,62 | 0,40 | 23,6 / 31,2 | 0 | 0 | 11,7 |
| **gpt-oss-20b (raciocínio low)** | 0,42 | 0,96 | 0,45 | 0,43 | 0,20 | 14,5 / 20,3 | 0 | 0 | 12,9 |
| **Gemma 4 26B-A4B (Vulkan, sem raciocínio)** | 0,50 | 1,00 | 0,49 | 0,48 | 0,30 | 14,4 / 33,0 | 0 | 0 | 14,8 |

Correção: 1 correta, 0,5 parcial, 0 incorreta. **Diferença menor que 0,05 vale como empate** (3 perguntas nas 60, 1 nas 24). VRAM: pico da sonda de 8 perguntas (A6) com o reranker na GPU e o embedding na CPU, total do adaptador com o desktop incluído. O Qwen reaproveita as execuções da F9.1 (`v1-a6`, `v1n-a6`).

### Aplicação da regra do agente

| Desafiante | Δ correção (60) | Δ correção (24) | Qualidade | Mais rápido (p50 ≤ 0,7× e p95 ≤ Qwen) | Condições | Substitui o Qwen |
|---|---:|---:|---|---|---|---|
| gpt-oss-20b (raciocínio low) | -0,01 | -0,04 | equivalente | sim | falham: pagina_citada_nao_pior, acerto_numerico_nao_pior | não |
| Gemma 4 26B-A4B (Vulkan, sem raciocínio) | -0,06 | 0,04 | pior | sim | falham: pagina_citada_nao_pior, acerto_numerico_nao_pior | não |

**LLM do agente e do redator pela regra: Qwen3.6-35B-A3B (produção).**

## Extração aberta: amostra de Pais

| LLM | Pais | Válidas | Válidas na 1ª | Chamadas/Pai | Entidades/Pai | Relações/Pai | Sem lastro de nome | Nomes repetidos | Tokens de saída/Pai | Segundos/Pai |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| **Qwen3.6-35B-A3B (produção)** | 30 | 30 (100,0%) | 30 | 1,00 | 12,67 | 10,53 | 7,1% | 0 | 1389 | 59,1 |
| **gpt-oss-20b (raciocínio low)** | 30 | 30 (100,0%) | 26 | 1,20 | 11,17 | 8,97 | 8,4% | 1 | 1244 | 28,6 |
| **Gemma 4 26B-A4B (Vulkan, sem raciocínio)** | 30 | 30 (100,0%) | 30 | 1,00 | 11,27 | 6,90 | 5,6% | 0 | 1081 | 30,5 |

Medidas só mecânicas (validade do JSON no esquema, lastro do nome no texto do Pai, contagens, tempo): **não medem se as entidades e as relações estão certas nem completas**.

### Aplicação da regra da extração

| Desafiante | Condições | Candidato a substituir o Qwen |
|---|---|---|
| gpt-oss-20b (raciocínio low) | falham: entidades_90pct, relacoes_90pct | não |
| Gemma 4 26B-A4B (Vulkan, sem raciocínio) | falham: entidades_90pct, relacoes_90pct | não |

Regerar: `uv run python -m indexer.f92` (a partir de `indexer/`, sem LLM).
