# ADR-057 · Buscas em TypeScript (`buscar_trechos`, `buscar_tabelas`, `entidade`, `resposta_ja_dada`): mesma recuperação que o Python e mesmo page recall; notas do reranker só comparáveis com o servidor no mesmo estado

- **Estado:** aceita (06/11/2026)
- **Data:** 2026-11-06
- **Tarefa(s):** F7.9

## Contexto

A [ADR-055](ADR-055-execucao-das-ferramentas-em-typescript.md) manda portar as 12 ferramentas de recuperação para o `api/`, cada uma aceita por paridade contra o Python no grafo real. A F7.8 ([ADR-056](ADR-056-templates-cypher-em-typescript.md)) portou o executor e os seis templates Cypher. A F7.9 porta as quatro ferramentas de busca: `buscar_trechos` (o degrau 3 da F2.6: reescrita opcional, `child_vec` + `child_ft`, Pai, reranker), `buscar_tabelas`, `entidade` (a `busca_local` da F6.1) e `resposta_ja_dada`.

## Decisão

Em `api/src/ferramentas/`:

- **`busca.ts`**
  - `buscarTrechos(grafo, llm, pergunta, {stepback, hyde, candidatos, top})`: consulta (± *step-back*, ± HyDE) → 96 Filhos (`child_vec` com o prefixo `Instruct:` + `child_ft` com Lucene escapado, fundidos por RRF k = 60) → um candidato por Pai (24) → reranker sobre "caminho + corpo" cortado em 6000 caracteres (o corte vale só para a nota; a evidência leva o Pai inteiro) → 6 Pais. Empate de nota mantém a ordem da busca. Se o reranker falhar, os trechos seguem na ordem da busca com `aviso` (o Python levantaria erro). `omitido {pais, cortados_no_rerank}`, e o resultado leva `pais[{id, nota_rerank, posicao_antes}]`, `rerank` e `etapas_ms`.
  - `buscarTabelas`: embedding da pergunta, `question_vec` (perguntas hipotéticas, k = 20), agrupa por tabela pela melhor pergunta, devolve até 3 (descrição + escala + moeda + Markdown cortado em 10 000 caracteres, com aviso de corte).
  - `respostaJaDada({resposta})`: devolve a resposta anterior como evidência `conversa` (até 8000 caracteres); vazia vira `resposta_vazia`.
- **`entidade.ts`**: porte da `busca_local`: embedding do nome **sem** o prefixo de instrução, `entity_vec` (k = 25) + `entity_ft` filtrado por citação do nome inteiro (sem acento, sem caixa), RRF, rerank opcional sobre "nome: resumo", relações, Pais ranqueados (posições densas + RRF, desempate por id), comunidades e `montarEvidencias` com os tetos (6 entidades, 10 relações, 6 Pais, 2 comunidades, 6000 tokens, a primeira evidência sempre entra, `por_orcamento`).
- **`LlmDeBusca`** (interface mínima: `embeddingDeConsulta`, `embeddings`, `rerank`, `chatJson?`): o `ClienteLlm` da F7.1 a satisfaz e os testes põem um dublê. O executor ganhou a opção `llm` (sem ela, as quatro ferramentas devolvem `llm_nao_configurado`); só `panorama` e `consultar_grafo` seguem `ferramenta_nao_portada` (F7.10).
- **`grafo.ts`**: `paraNeo4j` passou a mandar como `FLOAT` os vetores com algum número não inteiro (uma lista com todos os valores inteiros por acaso iria como inteiros e o índice vetorial recusaria).
- O Python ganhou `reranker buscar --json` (só imprime o que já calculava), para a paridade ler a saída sem *parsing* de texto.

## Avaliação

`npm run avaliar:busca` (`api/src/avaliacao/cli-busca.ts`; relatório em `eval/resultados/f79-busca.json`, só ids, números e rótulos, sem texto do documento — [ADR-009](ADR-009-documento.md); as saídas completas ficam em `data/avaliacao/`). No grafo real, com o mesmo Neo4j e o mesmo llama-swap dos dois lados:

**`buscar_trechos` — 55 perguntas do golden com página** (as 60 menos as 5 de recusa):

| | Python | TypeScript |
|---|---|---|
| page recall@1 | 0,4727 | 0,4727 |
| page recall@3 | 0,5788 | 0,5788 |
| page recall@6 | 0,6273 | 0,6273 |

O page recall do TypeScript é **idêntico** ao do Python em cada uma das 55 perguntas (aceite: não inferior). Esse é o Python recalculado agora, no grafo inteiro; o 0,62 da F3.3 era da fatia de 79 páginas e não é comparável.

Paridade dos 6 Pais (ids, texto, caminho, posição antes do rerank, `cortados`, `candidatos`; nota com tolerância de 1e-3): **50 idênticos, 1 com ruído de ordem entre quase empatados, 4 diferentes**, 0 falhas. Em todas as 55 os mesmos Pais chegam ao reranker na mesma ordem; as 4 diferenças são do reranker:

- **T04**: um Pai de 783 caracteres recebe 0,8520 num lado e 0,8062 no outro (os dois valores aparecem nos dois lados, em momentos diferentes), a 0,046 de diferença;
- **T14**: empate exato (0,9958) entre o 6º e o 7º Pai, e cada lado ficou com um;
- **N11** (diferença máxima de 0,011) e **G01** (0,0019): notas um pouco diferentes sem mudar o resultado relevante.

**`entidade` — 12 nomes** (a diretora presidente, o Tesouro, a União, a Previ, os conselhos, o comitê, uma pessoa, o próprio banco e um nome inexistente): **12/12 idênticos** (entidades, evidências, `omitido`, `rerank`; nota com tolerância de 1e-3). **T15** (cargo → pessoa) resolvida pela `entidade`, tanto pela pergunta inteira quanto por "Diretora Presidente".

**`buscar_tabelas`** (sem referência em Python: a função não existia lá): a página do gabarito aparece nas 3 tabelas devolvidas em **7 de 9** perguntas do golden cuja rota esperada é essa (@1: 5 de 9). Erros: N07 e N08. É uma medida de recuperação, não de paridade.

**Latência do TypeScript** (`buscar_trechos`, com tudo carregado): mediana de 710 ms por pergunta.

**Testes** (escritos antes do código, com as formas de falha no cabeçalho de cada arquivo): 407 na API (84 novos), `typecheck`, `lint`, `build` e `ruff` sem erros.

## O que descobri sobre o reranker

A primeira rodada deu 31 de 55 "iguais ou ruído" e 24 "diferentes", todas só por nota (até 0,10). Não era erro do porte: o Python contra ele mesmo, em chamadas idênticas, já diferia (até 0,046 e, uma vez, trocando um Pai do corte). A causa mais provável é o cache de prefixo do `llama-server`: **a nota depende de o servidor ter visto a mesma consulta na chamada anterior** (a frio ou a quente). Ordenando as chamadas como TS (a frio), Python, TS (a quente) e comparando só os dois últimos, as 12 primeiras perguntas passaram de 4 dentro do critério para 11, e a rodada completa ficou em 50 iguais mais 1 com ruído de ordem. O efeito a frio medido na rodada final: a nota muda em 21 das 55 perguntas, até 0,10.

Isto vale para a F7.11 e para o produto: a mesma pergunta pode ganhar notas diferentes em duas execuções (ordem entre Pais quase empatados, e o 6º lugar quando há empate). Não é um defeito do porte.

## Limites

- **Isso não prova que as buscas acertam**, só que o TypeScript recupera o que o Python recuperava. O page recall (0,47 / 0,58 / 0,63) é o do sistema atual; a pergunta fora do escopo e a qualidade da resposta ficam para a F7.11 e a F7.5.
- **O protocolo de comparação foi ajustado depois de ver os resultados** (a ordem das chamadas e a tolerância nas entidades). A tolerância de 1e-3 foi fixada antes da rodada completa e não foi mexida; o ajuste de ordem veio do diagnóstico do cache. O critério que não se ajusta é o page recall, igual nos dois lados em 55 de 55.
- **As 4 perguntas "diferentes" ficam como estão**: nenhuma é erro de recuperação; T14 é um empate que qualquer um dos dois lados poderia resolver de outro jeito na próxima execução.
- **`buscar_tabelas` e `resposta_ja_dada` não têm referência em Python**; a primeira é medida só por página (7 de 9). A segunda tem testes com dublê.
- **Corte do texto:** o Python corta o texto do Pai por pontos de código e o JavaScript por unidades UTF-16; só difeririam em caracteres fora do plano básico. Não verifiquei se o documento tem algum; em todas as 55 perguntas a contagem de Pais cortados no reranker foi igual nos dois lados.
- **Queda do reranker:** o Python levanta erro; o TypeScript devolve os trechos na ordem da busca com um `aviso` (divergência deliberada, a F7.11 não deve parar por isso).
- **As quatro ferramentas dependem do llama-swap** (embedding e reranker); sem ele, `llm_nao_configurado` ou erro por causa.

## Como reproduzir

```
.\infra\neo4j.ps1 iniciar
.\infra\swap.ps1                  # em outro terminal
cd api
npm run avaliar:busca             # ~25 min; --somente trechos,entidades,tabelas, --limite N, --ruido N
npx vitest run test/ferramentas   # unitários e, com o Neo4j no ar, o contrato contra o grafo real
```
