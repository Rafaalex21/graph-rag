# ADR-022 · Retriever parent-document

- **Estado:** aceita (28/10/2026)
- **Data:** 2026-10-28
- **Tarefa(s):** F2.5

## Contexto

A ARQUITETURA §7 e o cap. 3 do livro pedem recuperar pelo Filho (pequeno, preciso para o embedding) e entregar o Pai (contexto maior) ao reranker e ao LLM. A F2.5 implementa: k×4 Filhos → deduplicação por Pai → top-k, sem Pai repetido e com ≤ 300 ms sem rerank.

## Decisão

Módulo `indexer/src/indexer/recuperador.py` (comandos `buscar` e `medir`), em cima de `indexer.busca` (ADR-021):

1. **Entrada:** a pergunta, o modo (`vetor`, `texto`, `hibrido-max`, `hibrido-rrf`, o mesmo `--modo` da F2.4), `k` e `alfa`. Padrão `k = 6` (Pais para o LLM); o pipeline completo usará `k = 24` para o reranker (§5.1).
2. **Candidatos:** `k × 4` Filhos de cada índice, fundidos pelo modo, cortados em `k × 4`.
3. **Deduplicação:** os Filhos viram Pais únicos; o escore e a posição de um Pai são os do seu melhor Filho; os demais Filhos do mesmo Pai são listados no resultado (`filhos`). Corta-se em `k` Pais.
4. **Saída:** por Pai, `id`, `score`, `pageStart`/`pageEnd`, `secaoId`, `caminho` da seção, `tokens`, `text` e os `filhos` que o trouxeram; mais `filhos_considerados` e a latência em ms por etapa (embedding da consulta, busca nos índices, leitura dos Pais).
5. **Pode devolver menos de `k` Pais** quando vários Filhos caem no mesmo Pai (no `texto`, com k = 24, a média foi 23,1).
6. Refatoração em `busca.py`: a escolha da fusão virou `fundir(modo, …)`, usada por `buscar` e pelo retriever.

## Alternativas consideradas

- **Pegar o Pai de cada Filho antes de deduplicar na consulta Cypher:** mais viagens ao banco e mistura a ordenação com a leitura; aqui a lista fundida é cortada em memória e os dados dos Pais saem de uma consulta só.
- **Preencher até `k` Pais quando houver colisão:** mudaria o k×4 do desenho; o chamador pode pedir `fator` maior.
- **Expandir a vizinhança com `NEXT`:** adiado; é uma otimização a medir na F3 (ADR-019, ressalva 3).

## Consequências

- A F2.6 reranqueia os 24 Pais deste retriever; a F2.9 (`ask`) usa os 6 melhores.
- A latência medida é dominada pelo embedding da consulta na CPU (~76 ms); os índices e a leitura dos Pais somam ~15 ms.

## Verificação do aceite da F2.5

Comando: `uv run python -m indexer.recuperador medir --k 6` e `--k 24` (20 perguntas de [`eval/perguntas_latencia.txt`](../../eval/perguntas_latencia.txt), 3 repetições, após aquecer; 480 consultas no total). Saídas em [`ADR-022-bruto/`](ADR-022-bruto/).

| Critério | Resultado |
|---|---|
| Nenhum Pai duplicado | **0 duplicatas em 480 consultas** (4 modos × 2 valores de k × 60); o teste unitário também cobre o caso de dois Filhos por Pai |
| ≤ 300 ms sem rerank | **máximo 123 ms** em todas as consultas; p50 de 88 a 96 ms nos modos com vetor e 10 ms no `texto`; p95 de 98 a 109 ms |
| Etapas (média, ms) | embedding da consulta 74–79; busca nos índices 8–12; leitura dos Pais 4–9 |
| Testes | 5 testes novos em `test_recuperador.py`; 144 no indexador, ruff limpo |

| k | Modo | p50 (ms) | p95 (ms) | máx. (ms) | Pais/consulta |
|---:|---|---:|---:|---:|---:|
| 6 | vetor | 95,7 | 108,7 | 123,0 | 6 |
| 6 | texto | 9,6 | 12,2 | 45,1 | 6 |
| 6 | híbrido-máx. | 87,7 | 100,9 | 104,5 | 6 |
| 6 | híbrido-RRF | 90,8 | 98,4 | 120,3 | 6 |
| 24 | vetor | 90,2 | 101,7 | 106,8 | 24 |
| 24 | texto | 9,6 | 11,5 | 22,5 | 23,1 |
| 24 | híbrido-máx. | 95,8 | 103,3 | 117,9 | 24 |
| 24 | híbrido-RRF | 93,3 | 109,2 | 112,8 | 24 |

## Ressalvas

1. **Corpus pequeno:** 166 Filhos e 116 Pais. Com as 423 páginas os índices levam mais tempo; o embedding da consulta (a maior parte) não muda. Refazer a medição na F5.8.
2. **Medido com o modelo de embedding sozinho em memória.** No perfil `consultar` o Qwen3.6 fica residente; a recuperação ocorre antes da geração, então a contenção de CPU deve ser pequena, mas não foi medida (F2.9/F3).
3. **A primeira consulta depois de trocar de perfil custa segundos** (5,6 s, com o llama-swap carregando o modelo de embedding). A interface precisa aquecer o modelo ao iniciar; a medição acima é pós-aquecimento.
4. **As 20 perguntas são de fumaça**, sem gabarito: servem para latência e duplicatas, não para qualidade. A qualidade da recuperação é da F3.
5. Na consulta de exemplo (risco de mercado) os Pais vieram das seções e páginas esperadas (155–158); isso é uma checagem a olho, não métrica.

## Evidência

`indexer/src/indexer/recuperador.py`, `indexer/tests/test_recuperador.py`, `eval/perguntas_latencia.txt`, `docs/adr/ADR-022-bruto/`.
