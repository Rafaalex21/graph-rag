# ADR-043 · Relatórios de comunidade em JSON e `community_vec`

- **Estado:** aceita
- **Data:** 2026-11-04
- **Tarefa(s):** F5.6

## Contexto

A F5.5 deixou 159 comunidades (67 + 47 + 45, em 3 níveis; [ADR-042](./ADR-042-leiden-hierarquico.md)). A §5 I-9 pede, por comunidade, um relatório em JSON (título, resumo, impacto de 0 a 10, explicação do impacto e de 5 a 10 achados com referências), embutido em `community_vec`. O aceite da F5.6 é "100% com relatório válido; 10 revisados à mão". Evidência numérica: `ADR-043-bruto/resumo.json` (contagens e métricas; os relatórios são texto derivado do documento e ficam só no Neo4j, fora do git).

## Decisão

Módulo `indexer.relatorios` (`gerar`, `embutir`, `autoteste`, `verificar`).

- **Contexto do pedido:** os resumos das entidades (F5.4) e das relações entre elas, cada um com uma etiqueta (`[E1]`, `[R1]`), ranqueados pelo grau; limite de 20 mil caracteres, 70% para as entidades. Se passar, saem as relações de menor rank e, depois, as entidades de menor rank com as relações que ficaram sem ponta; a quantidade omitida é gravada na comunidade. No recorte nada foi omitido (maior prompt: 2.725 tokens).
- **Saída por gramática JSON** (`response_format`), com o esquema montado por comunidade; Qwen3.6, temperatura 0,1, sem *thinking*.
- **Validação** (`validar_relatorio`), porque a gramática não impõe tudo: título, resumo e explicação não vazios; nota numérica entre 0 e 10; número de achados entre `min(5, entidades)` e `min(10, 2 × entidades)`; todo achado com texto e com ao menos uma referência; toda referência existe no contexto; **nenhuma etiqueta (`E3`, `R5`) no texto**, que o leitor não consegue decifrar. Resposta recusada é pedida de novo uma vez, com o motivo no pedido; duas recusas seguidas são o erro `RelatorioInvalido` e o relatório não é gravado.
- **Faixa de achados:** a §5 I-9 pede de 5 a 10; para comunidades de 2 ou 3 entidades isso obriga a inventar ou repetir. O mínimo passa a `min(5, entidades)` e o máximo a `min(10, 2 × entidades)` (a ARQUITETURA foi corrigida).
- **Cache** por hash do pedido e dos ids das entidades, não por comunidade: as 159 comunidades têm 83 conteúdos distintos (a hierarquia repete boa parte delas entre níveis), e cada conteúdo gera um relatório só.
- **Grafo:** `__Community__.title|summary|rating|ratingExplanation|rank|report` (`report` é o JSON inteiro, com os achados e as referências em ids de entidade e pares `[de, para]`) e `omittedEntities|omittedRelationships`. `rank` = número de Pais que mencionam as entidades da comunidade.
- **Embedding** de título + resumo + achados (até 12 mil caracteres), pelo perfil `vetorizar`; índice `community_vec` (1024 dimensões, cosseno).

## Resultado

Comandos: `cd indexer; uv run python -m indexer.relatorios gerar | embutir | autoteste | verificar`.

| | Prompt `v1` | Prompt `v2` (final) |
|---|---|---|
| Relatórios válidos | 159 de 159 | **159 de 159**, todos na primeira tentativa |
| Chamadas ao LLM / tempo | 83 / ≈ 24 min | 83 / ≈ 23 min |
| Com etiqueta no texto (83 relatórios distintos) | 51 (61%) | **0** |
| Com linguagem de especulação (`sugere`, `possivelmente`, `pode indicar`...) | 13 (16%) | **0** |
| Achados por relatório (mín / mediana / máx) | 2 / 5 / 10 | 2 / 4 / 10 |
| Nota média | 6,96 | 7,03 |

- **Revisão à mão de 10 relatórios** (o maior, com 25 entidades, ao menor, com 2; espalhados entre os três níveis), cada um lido contra os resumos das entidades e das relações de origem. Com o `v1`: conteúdo fiel na maior parte, mas etiquetas vazando em 7 dos 10, especulação em 3 (incluindo "estrutura de deal sofisticada" para a aquisição de uma empresa, sem apoio no material), uma sigla inventada no título de um relatório e achados repetidos nas comunidades pequenas. Foi isso que levou ao `v2` (regras de escrita no prompt, recusa de etiqueta no texto, teto de achados por tamanho). Com o `v2`: **10 de 10 fiéis ao material, sem etiqueta, sem especulação e sem sigla inventada**; datas e nomes que não estavam nos resumos das entidades (uma data de aprovação, o nome de uma linha de crédito) foram rastreados até o resumo de uma relação.
- **Defeitos que sobram:** achados redundantes em 4 dos 10 (um por produto numa comunidade de produtos, um achado que repete o anterior) e arredondamentos leves em 3 ("supervisão direta", "efeito cascata"). Um relatório (Ministério da Fazenda) é fiel a uma entrada de extração errada, em que um cargo aparece como exercido pelo ministério: o erro é da F5.1/F5.3, não da F5.6, e entra no prompt `v4` da extração aberta.
- **Autoteste:** `community_vec` ONLINE, 159 embeddings, recall@1 = 1,0 (cada relatório re-embutido pelo backend da CPU acha a si mesmo; empate entre comunidades de texto idêntico conta como acerto); a busca pelo título com a instrução de consulta acha a comunidade (ou uma de texto idêntico) no top-3 em 98,7% (157 de 159).
- **Idempotência:** segunda rodada de `gerar` com 0 chamadas ao LLM, em 3 s, preservando os embeddings.
- **Sanidade (`verificar`):** 0 comunidades sem relatório, 0 sem embedding, 0 com nota fora de 0 a 10, 0 com contexto omitido.

## Consequências

- Quem muda um relatório precisa rodar `embutir` de novo; `gerar` não toca no vetor.
- A validação de fidelidade é por amostra (10 relatórios), não automática; o que é automático é a forma (referências existentes, sem etiqueta). A F5.8 revisa outra amostra no documento inteiro.
- 76 das 159 comunidades repetem o conteúdo de outra em nível diferente: a F6 deve tratar `report` idêntico em níveis diferentes como uma busca só, e a escolha do nível na `panorama` pesa mais pelo tamanho do que pelo nível (3 níveis, mediana de 3 entidades).
- No documento inteiro o contexto pode passar do limite; a quantidade omitida já é gravada (`omittedEntities`, `omittedRelationships`) e a F5.8 a lê. A alternativa do MS GraphRAG (substituir o contexto por relatórios das subcomunidades) fica para quando houver omissão.
