# ADR-042 · Leiden hierárquico sem o emissor

- **Estado:** aceita
- **Data:** 2026-11-04
- **Tarefa(s):** F5.5

## Contexto

A §5 I-9 pede comunidades por Leiden hierárquico no GDS, com peso = força da relação e o emissor fora da projeção, para que as comunidades se formem em torno de temas e não colapsem no supernó. Depois da F5.4 o grafo tem 433 entidades e 481 `SUMMARIZED_RELATIONSHIP`; 190 delas tocam o emissor. Evidência: `ADR-042-bruto/resumo.json` (contagens, tamanhos e modularidades; sem nomes nem trechos do documento).

## Decisão

Módulo `indexer.comunidades` (`executar` e `verificar`).

- **Projeção:** `__Entity__` ligadas por `SUMMARIZED_RELATIONSHIP`, sem `:Issuer`, não direcionada; o par que existe nos dois sentidos vale o maior peso. Entram só as entidades com ao menos uma aresta depois de tirado o emissor. **Medido:** 138 das 432 entidades restantes (32%) ficam sem aresta (só ligavam ao emissor ou a nada); como comunidade seriam 138 unitárias, e o relatório da F5.6 de uma entidade só repete o resumo dela. Elas ficam sem `IN_COMMUNITY`. A projeção tem 294 nós e 291 arestas.
- **Leiden:** `gds.leiden` com `relationshipWeightProperty = weight`, `includeIntermediateCommunities`, `maxLevels 10`, `gamma 1`, `theta 0,01`, `tolerance 1e-4`, `randomSeed 42` e `concurrency 1`; a semente e uma só *thread* tornam a partição reprodutível.
- **Grafo:** `(:__Community__ {id, level, size})`; `(:__Entity__)-[:IN_COMMUNITY]->` a comunidade do nível 0 (o mais fino); `(:__Community__)-[:PARENT_COMMUNITY]->` a do nível seguinte. O id é `com:<nível>:<hash dos membros>`, calculado do conteúdo, não do número do GDS; a F5.6 pode guardar relatórios em cache por id. Os níveis precisam se aninhar; se não, `hierarquia` levanta erro em vez de escolher um pai.
- As comunidades são derivadas: cada execução apaga e refaz.
- **Registro da modularidade:** a do GDS (`modularities`) e a recalculada em Python sobre as mesmas arestas (`modularidade`, testada à mão em casos conhecidos).

## Resultado

Comando: `cd indexer; uv run python -m indexer.comunidades executar`.

| Nível | Comunidades | Tamanho (mín / mediana / máx) | Modularidade GDS | Recalculada |
|---|---|---|---|---|
| 0 (mais fino) | 67 | 2 / 3 / 17 | 0,8250 | 0,8250 |
| 1 | 47 | 2 / 3 / 25 | 0,8869 | 0,8869 |
| 2 (topo) | 45 | 2 / 3 / 25 | 0,8894 | 0,8894 |

- 3 níveis executados; nenhuma comunidade unitária; as duas modularidades coincidem em todos os níveis.
- Reprodutível: duas execuções seguidas geram as mesmas 159 comunidades, com os mesmos ids.
- Sanidade (`verificar`): 0 entidades do emissor em comunidade, 0 entidades em mais de uma comunidade no nível 0, 0 comunidades fora do topo sem pai, 0 com mais de um pai, 0 vazias, 0 com `size` diferente do número de membros.

## Consequências

- **A modularidade alta (≈ 0,89) vem em boa parte da fragmentação do grafo**, não só de comunidades bem separadas: a projeção tem 36 componentes conexos (o maior com 124 nós, o segundo com 51, 11 pares isolados), porque o recorte cobre 19% das páginas. A hierarquia é rasa (3 níveis, o topo tem 45 comunidades de mediana 3), longe de um panorama; no documento inteiro (F5.8) o grafo se conecta e os números mudam.
- A F5.6 gera um relatório por comunidade (159 no recorte). Se os 159 forem caros ou ralos, a escolha é cortar por tamanho mínimo ou nível, decisão a tomar com a medição dos relatórios em mãos; mexer em `gamma` para comunidades maiores só vale com o documento inteiro.
- As 138 entidades sem comunidade continuam acessíveis pela busca local (`entity_vec` e vizinhança); só não entram na busca global. Contagem a refazer na F5.8.
- O emissor não pertence a nenhuma comunidade; a busca global precisa de uma ferramenta de panorama que o trate à parte (F6).
