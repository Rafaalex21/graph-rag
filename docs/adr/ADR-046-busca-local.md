# ADR-046 · Busca local (ferramenta `entidade`)

- **Estado:** aceita (06/11/2026), com ressalvas sobre o tamanho e a origem do conjunto de aceite (ver "Limites")
- **Data:** 2026-11-06
- **Tarefa(s):** F6.1

## Contexto

A ferramenta `entidade(nome)` da §7.2 responde "quem é…" e "o que é a subsidiária…" a partir do grafo: parte de entidades parecidas com a pergunta e traz o que está ligado a elas. O aceite da F6.1 é recall de contexto ≥ 0,8 nas perguntas "quem é…" do golden set. O grafo é o do documento inteiro da F5.8 (2.474 entidades, 745 comunidades). Evidência: `eval/resultados/f61-quem.json`, `f61-entidades.json` e `f61-todas.json` (só números, sem trechos do documento, ADR-009).

## Decisão

`indexer/src/indexer/busca_local.py`, em cinco passos:

1. **Candidatas.** `entity_vec` (cosseno, 25) fundido por RRF com `entity_ft` (Lucene, analisador `brazilian`, sobre `name` e `aliasesText`), mas **só com o que a pergunta cita pelo nome ou apelido** (palavra inteira, sem caixa nem acento). Com a pergunta inteira como consulta o Lucene casava palavras soltas e enchia o topo de entidades genéricas.
2. **Reranker.** As candidatas são reordenadas pelo Qwen3-Reranker (o mesmo do `ask`, F2.6) sobre `nome: resumo`, e as 6 melhores seguem. Se o reranker falhar, a busca segue na ordem do RRF e o resultado diz `rerank: falhou`.
3. **Contexto de cada entidade**, nesta ordem de prioridade: resumo da entidade; Pais que a citam (`MENTIONED_IN`), ranqueados por RRF entre "quantas das entidades escolhidas citam o Pai" e "cosseno entre a pergunta e o melhor Filho do Pai"; relações resumidas (`SUMMARIZED_RELATIONSHIP`), as de maior força primeiro; relatórios das comunidades a que as entidades pertencem (`IN_COMMUNITY` e `PARENT_COMMUNITY`), a mais específica primeiro.
4. **Tetos**, porque o emissor liga-se a milhares de nós: 6 entidades, 6 Pais, 10 relações (a mesma relação entre duas entidades escolhidas entra uma vez), 2 comunidades e 6.000 tokens. O que o teto ou o orçamento corta é contado em `omitido`; a primeira entidade entra sempre.
5. **Saída** no contrato `evidence[]` da §7.2: `id`, `tipo` (`entidade`, `pai`, `relacao`, `comunidade`), `paginas`, `caminho`, `texto`, `score`. Só o Pai tem página do documento; entidade e relação mostram as (até 5) páginas dos Pais de onde vieram; o relatório de comunidade, que é síntese, não tem página (`""`, nada de página inventada).

O índice `entity_ft` é criado por `python -m indexer.busca_local criar-indice` (idempotente) e, daqui em diante, no fim da etapa `entidades-vec` de `infra/indexar-documento.ps1`.

## Resultado

Medição com o juiz local da F3.2 (recall de contexto), mais o recall mecânico (a regex de `evidencia` do golden contra o contexto entregue) e o *page recall*, tudo com a configuração acima:

| Conjunto | Perguntas | Recall de contexto (juiz) | Recall por regex | Page recall (Pais) |
|---|---|---|---|---|
| "Quem é…" do golden (T01, T08, T15), **aceite** | 3 | **1,00** | 1,00 | 1,00 |
| `golden_entidades.csv` (E01–E10), conjunto separado | 10 | **1,00** | 0,90 | 0,90 |
| Todas as 55 com gabarito (informativo) | 55 | não medido | 0,41 | 0,47 |

Latência com os modelos aquecidos: p50 de 0,3 s e máximo de 0,4 s (embedding da pergunta, os dois índices, o reranker e o contexto); uma consulta avulsa pelo CLI, sem reranker, logo depois de subir o llama-swap, levou 4,3 s.

**O que a medição mudou no desenho** (todas as variantes rodaram nas três perguntas do golden com o juiz; a primeira, antes de qualquer ajuste, deu 0,50):

| Variante | Recall (juiz) nas 3 "quem é…" | Regex nas 55 |
|---|---|---|
| 3 entidades, `entity_ft` com a pergunta inteira, ranking de Pais por contagem de citações | 0,50 | não medido |
| + empate de contagem tratado como empate (posição densa) | 0,33 | 0,41 |
| 6 ou 10 entidades | 0,67 | 0,45 |
| sem `entity_ft`, ou só com o nome citado | 0,67 | 0,40 a 0,45 |
| **+ reranker sobre as candidatas (3 ou 6 entidades)** | **1,00** | 0,37 (3) · 0,41 (6) |

- **Empate de contagem.** Com 400 Pais citados uma vez só, o desempate por id jogava o Pai mais parecido com a pergunta para o fim do ranking. A posição agora é densa (quem cita o mesmo número de vezes empata), e há um teste para isso.
- **T15 ("quem responde pelo conteúdo do formulário como Diretora Presidente?").** A resposta está no resumo de uma *pessoa* (rank 13 no `entity_vec`) que a pergunta não nomeia; as entidades de cargo ("Diretora Presidente", "Presidente"...) ficavam à frente. Só o reranker sobre `nome: resumo` a trouxe para o topo. É o único caso do conjunto que a variante sem reranker perdia.
- O reranker **baixou** o recall por regex nas 55 (0,45 → 0,41 com 6 entidades). Essas 55 incluem números de tabela, agregações e perguntas temáticas, que não são desta ferramenta; é o custo de o roteador (F7.3) escolhê-la mal, e não um critério.

## Consequências

- A F7.3 pode registrar `entidade(nome)` com este contrato. A F7.5 (redator) deve citar **as páginas dos itens `pai`**: a página de uma entidade ou de uma relação é onde ela foi citada, não prova de que o resumo está certo; o E03 mostra o risco: o juiz deu 1,00, mas o Pai da página certa não veio (regex 0 e *page recall* 0), então o fato só pode ter sido sustentado por outro item do contexto.
- A F6.2 (busca global) e as F6.3/F6.4 (templates e Text2Cypher) não dependem deste módulo.
- O `entity_ft` entrou no esquema do grafo; reexecutar a F5.8 passa a recriá-lo.

## Limites

- **O aceite tem n = 3 e foi ajustado olhando essas três perguntas.** As variantes acima foram escolhidas até as três passarem, então 1,00 é otimista. Para ter uma segunda leitura escrevi, depois do ajuste, 10 perguntas "quem é / o que é" (`eval/golden_entidades.csv`), com gabarito conferido contra o texto do PDF: o juiz deu 1,00 **também sem reranker**, ou seja, o conjunto é fácil (em quase todas a pergunta traz o nome da entidade) e não separa as configurações; a decisão pelo reranker repousa em um único caso (T15). Não escrevi perguntas difíceis do tipo cargo → pessoa além dessa.
- O juiz é local (Gemma, a mesma família do `ask`) e cada configuração foi medida uma vez; o mesmo contexto pode variar nota entre execuções (a T01 oscilou entre 0,33 e 1,00 quando o contexto mudou). Nenhuma pessoa conferiu as notas.
- A busca usa a pergunta inteira; o roteador pode passar só o nome da entidade, o que não foi medido.
- O efeito de cada camada (comunidades, relações) não foi isolado por ablação; elas entram pela especificação da §7.2.
- As consultas usam `db.index.*.queryNodes`, que o Neo4j 2026.10 marca como obsoletas (substituídas por `SEARCH`); o resto do projeto faz o mesmo, e a migração fica para depois.
