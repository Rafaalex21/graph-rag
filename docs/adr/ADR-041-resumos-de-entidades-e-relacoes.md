# ADR-041 · Resumos de entidades e relações, com ranking e teto para o supernó

- **Estado:** aceita
- **Data:** 2026-11-04
- **Tarefa(s):** F5.4

## Contexto

Depois da F5.3 cada entidade guarda uma lista de descrições (uma por Pai, da extração aberta) e, quando veio da dirigida, uma descrição em texto; cada `RELATED_TO` guarda a lista de descrições do par. A §5 I-8 pede um resumo único para o que tem mais de um texto, sem estourar o contexto do modelo (slot de ≈ 16 mil tokens no `llama-swap`) e tratando o emissor como supernó: 70 descrições e 190 vizinhos no recorte. Evidência numérica: `ADR-041-bruto/resumo.json` (contagens e tempos; os resumos em si são texto derivado do documento e ficam só no Neo4j, fora do git).

## Decisão

Módulo `indexer.resumos` (`executar` e `verificar`), idempotente, sobre o grafo já importado.

- **Quando chama o LLM:** só com mais de um texto. Um texto só vira o próprio resumo (`summarySource = 'descricao'`); sem nenhum, uma frase com o nome e o tipo (`'nome'`). Com o LLM, `'llm'`.
- **Ranking:** as descrições da entidade entram em rodízio entre as seções do documento (uma de cada seção por vez, na ordem das seções); a diversidade vem antes da quantidade. A origem de cada descrição é a lista paralela `descriptionParents`, que o importador passou a gravar (primeiro Pai, o de menor id, onde o texto apareceu).
- **Níveis:** lotes de até 30 textos e de até 24 mil caracteres por pedido (≈ 8 mil tokens, metade do slot); cada texto é cortado em 2 mil. Mais de um lote: os resumos parciais viram os textos do nível seguinte, até sobrar um. O emissor (70 textos) gastou 3 lotes + 1 final = **2 níveis, 4 chamadas**.
- **Teto:** 300 descrições por entidade, depois do ranking; o excedente é descartado e contado. No recorte ninguém chegou perto (0 descartadas); o teste sintético com 5 mil textos termina em menos de 60 chamadas.
- **Saída:** `__Entity__.summary`, `summarySource`, `summaryDescriptions`; o rótulo `:Issuer` no nó cujo nome ou alias normalizado é o `Document.issuer`; e, para **todo** `RELATED_TO`, `(:__Entity__)-[:SUMMARIZED_RELATIONSHIP {summary, weight = strength, rank = grau(a) + grau(b)}]->(:__Entity__)`. A `SUMMARIZED_RELATIONSHIP` é derivada: cada execução a apaga e refaz.
- **Prompt:** `v2`, saída `{summary}` por gramática JSON, temperatura 0,1, sem *thinking*, pede ≤ 550 caracteres e frase completa; a gramática trava em 700. Cache por hash (versão do prompt, modelo, sistema e pedido) em `data/parsed/resumos_cache/`.

## Resultado

| | |
|---|---|
| Entidades | 433: 89 resumidas pelo LLM, 332 com o próprio texto, 12 só com o nome |
| Relações | 481: 31 resumidas pelo LLM, 450 com o próprio texto |
| LLM | 123 chamadas, ≈ 3,7 min; a segunda rodada saiu do cache em 3 s com 0 chamadas |
| Maior prompt | **817 tokens** (`usage.prompt_tokens` do servidor), contra o slot de ≈ 16 mil |
| Emissor | `:Issuer` em 1 nó; 70 descrições em 2 níveis |
| Sanidade | `summary IS NULL`: 0 entidades; 0 `RELATED_TO` sem resumo; 0 resumo sem relação |

**Achado:** com o prompt `v1` (limite de 700 só na gramática) o resumo do emissor foi cortado no meio da frase; os outros 88 ficaram abaixo de 560 caracteres. O prompt `v2` pede menos, e `aparar` volta ao fim da última frase completa quando o texto bate no limite (também ao ler o cache). Nenhum resumo termina sem pontuação.

## Consequências

- A F5.5 projeta `__Entity__` + `SUMMARIZED_RELATIONSHIP` (peso = `weight`) sem o nó `:Issuer`; a F5.7 embute `summary`.
- 332 dos 433 resumos são a descrição original, não texto novo do modelo; o aceite da F5.4 trata de contexto e níveis, não de qualidade, que a F5.6 e a F5.8 conferem nos relatórios de comunidade.
- O resumo do emissor mistura as descrições de 70 Pais; é esperado, e é por isso que ele sai da projeção do Leiden.
- No documento inteiro (F5.8) o emissor passa de 70 para algumas centenas de descrições: o teto de 300 entra em ação e `descartadas_pelo_teto` deve ser lido na hora.
