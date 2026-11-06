# ADR-047 · Busca global *map-reduce* (ferramenta `panorama`)

- **Estado:** aceita (06/11/2026), com ressalvas sobre a qualidade (ver "Limites")
- **Data:** 2026-11-06
- **Tarefa(s):** F6.2

## Contexto

A ferramenta `panorama(pergunta, nivel?)` da §7.2 responde perguntas temáticas ("quais os principais fatores de risco?") lendo os relatórios de comunidade da F5.6, não trechos. O aceite da F6.2 é **≤ 90 s no perfil `consultar`, com progresso por comunidade**; não há limiar de recall na tarefa, mas o recall de contexto foi medido para escolher os padrões. Evidência: `eval/resultados/f62-*.json` (só números, ADR-009). Medidas de velocidade do perfil `consultar` (qwen36-35b-a3b, `-np 2`): prefill ≈ 900 tok/s, geração ≈ 35 tok/s, ou seja, **o tempo é dominado pelos tokens gerados**.

## Decisão

`indexer/src/indexer/busca_global.py`:

1. **Seleção.** Embedding da pergunta → `community_vec` (k = 1000) filtrado por **nível** (padrão 1) e **`rating` ≥ 5**; ficam as 16 mais parecidas com a pergunta.
2. **Mapa.** Os relatórios (resumo + achados, até 4.500 caracteres cada) são agrupados em lotes de até 14.000 caracteres; cada lote vai ao Qwen3.6, que devolve, em JSON validado por gramática (a etiqueta da comunidade é um `enum`), até 6 pontos de ≤ 30 palavras com nota de 0 a 10 para a pergunta. 2 lotes em paralelo (os 2 slots), 2 tentativas por lote.
3. **Seleção de pontos.** Nota mínima 1, sem repetição (texto normalizado), ordem por nota e depois por similaridade, teto de 12 pontos e 5.000 tokens. O que o filtro corta é contado em `omitido`.
4. **Reduce** (opcional): o LLM escreve uma síntese de ≤ 150 palavras só com esses pontos. O redator da F7.5 pode ignorá-la e ler os pontos.
5. **Orçamento de tempo** de 45 s para o mapa: lote que ainda não começou depois disso é pulado (`omitido.comunidades_por_tempo`, `truncado_por_tempo`); o reduce roda com o que chegou. Falha de lote, do reduce ou do *callback* de progresso nunca derruba a busca; se todos os lotes falham, o resultado traz `erro`.
6. **Progresso.** `progresso(evento)` recebe `selecao`, um evento `mapa` por lote concluído (`comunidades_feitas` de `comunidades_total`, status `ok|falhou|tempo`, títulos), `sintese` e `fim`.
7. **Saída** no contrato `evidence[]`: `id` (`<comunidade>#<n>`), `tipo` `ponto`, `paginas` `""`, `caminho` (`Comunidade (nível N): título`), `texto`, `score` (a nota).

## Resultado

Juiz local (recall de contexto sobre os pontos entregues), 10 perguntas panorama (P01–P10), uma rodada de cada:

| Configuração | Recall (juiz) | Tempo p50 / máx |
|---|---|---|
| **nível 1, 12 pontos, com reduce (padrão)** | **0,495** | 39,2 s / **56,1 s** |
| nível 1, 24 pontos, sem reduce | 0,525 | 30,4 s / 54,0 s |
| nível 0, 24 pontos, sem reduce | 0,424 | 23,9 s / 54,3 s |
| nível 2, 24 pontos, sem reduce | 0,419 | 29,2 s / 61,6 s |

O aceite de tempo passa com folga (máximo 56 s com o reduce). O nível 1 foi o melhor; a diferença entre 12 e 24 pontos (0,495 × 0,525) está dentro do ruído de uma rodada com n = 10, por isso o teto ficou em 12 (menos tokens para o redator).

**O que a medição mudou:** a primeira execução real (24 comunidades, 8 pontos por lote, pontos de 40 palavras, reduce livre) levou **88,6 s** e ainda pulou 2 comunidades pelo orçamento de 60 s. Passar para 16 comunidades, 6 pontos de 30 palavras, reduce de ≤ 150 palavras e orçamento de 45 s levou a mesma pergunta a 53,7 s, sem corte.

Por pergunta (padrão): P05 (1,00) e P08 (1,00) bem; P10 0,75; P01 0,60; P02 e P07 0,50; P03 0,40; P06 0,20; P04 e P09 0,00.

## Consequências

- A F7.3 pode registrar `panorama(pergunta, nivel?)` com este contrato; o parâmetro `nivel` mapeia para `limites["nivel"]`.
- Os pontos **não têm página**: vêm de relatórios, que são sínteses. A F7.5 não consegue citar página para o `panorama`; se isso for exigido, o roteador deve combinar `panorama` com `buscar_trechos` ou a F7.5 deve aceitar a citação "Comunidade …".
- O reduce não é um ranking explícito: a P01 pede "cinco principais" e a síntese agrupou por natureza, sem ordenar por importância.

## Limites

- **Recall médio de 0,5 é baixo.** P04 e P09 (0,00) pedem números e percentuais (composição acionária, metas) que não estão nos relatórios de comunidade; P06 (0,20) pede o texto da política ASG, também mais fino que o relatório. Essas perguntas são de `fatos`/`trechos`, e o custo de o roteador escolher `panorama` por engano é uma resposta vazia. Não há ablação do reduce nem da nota mínima.
- Uma rodada por configuração, n = 10, juiz local (Gemma) que erra e oscila; nenhuma pessoa conferiu as notas. As variantes de nível usaram `--sem-reduce` e 24 pontos, então não são idênticas ao padrão.
- O tempo depende da velocidade medida (35 tok/s) e dos 2 slots; com um slot só, o mapa dura cerca do dobro e o orçamento de 45 s passa a pular lotes (o resultado diz).
- As consultas usam `db.index.vector.queryNodes`, obsoleta no Neo4j 2026.10 (mesma dívida da ADR-046).
