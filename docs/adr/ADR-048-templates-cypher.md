# ADR-048 · Templates Cypher (`fato_financeiro`, `serie_metrica`, `comparar_segmentos`, `riscos`, `eventos`, `pessoas_cargos`)

- **Estado:** aceita (06/11/2026), com ressalvas sobre o que o grafo real contém (ver "Limites")
- **Data:** 2026-11-06
- **Tarefa(s):** F6.3

## Contexto

As ferramentas estruturadas da §7.2 respondem com consultas Cypher fixas, sem LLM: o roteador passa texto livre ("lucro líquido", "4T25", "diretora presidente") e o grafo responde com valores e páginas. O aceite da F6.3 é **testes de contrato contra o grafo real**. O grafo é o da F5.8 (1.243 fatos, 97 métricas, 50 períodos, 352 riscos, 241 eventos, 172 pessoas). Antes de escrever o código, olhei o que o grafo tem de fato, e isso mudou o desenho em cinco pontos.

## O que o grafo real tem (e a especificação não previa)

| Achado | Consequência no desenho |
|---|---|
| Não há `HAS_SEGMENT`; os 152 `Segment` são entidades da extração aberta ("varejo", "Tesouraria") sem fatos. O recorte de um fato está em `OF_METRIC.dimension` (Rurais, Imobiliário, Pessoas Físicas...). | `comparar_segmentos` compara a **`dimension`** de uma métrica num período. |
| O mesmo valor aparece em escalas diferentes ("R$ 16,8 bilhões" p. 22 e "R$ 16.782 milhões" p. 80 e 93); 108 grupos (métrica × período × entidade × recorte) têm mais de um fato. | Consolidação: dois valores são o mesmo fato se a diferença cabe em **meia unidade da escala maior** (16,8 bi cobre 16,75 a 16,85 bi); fica a escala mais fina e as páginas se unem. O que não cabe fica separado, com `conflito`. |
| Há fatos de 2026 que são projeção (remuneração prevista). | Sem período, vale o mais recente **até o ano-base** do documento (`Document.fiscalYear`). |
| Um percentual de crescimento pode estar sob uma métrica monetária (ADR-037). | A unidade do fato tem de combinar com o tipo da métrica (`monetary`→`currency`, `percent`/`ratio`→`percent`, `count`→`count`). |
| 192 dos 352 riscos não têm categoria; só 16 dos 241 eventos têm data; alguns cargos foram gravados como **nome de pessoa** ("Diretoria Executiva", "A Presidente do BB"); a presidente ("Tarciana…") só aparece como `Diretora Presidente` no **resumo** da pessoa, os títulos dela são "Membro da Diretoria Executiva…". | Riscos sem categoria viram `sem_categoria`; `eventos(ano=)` conta os sem data em `omitido.sem_data` e avisa; `pessoas_cargos` marca `nome_parece_cargo` e aceita o resumo como fonte secundária (`fonte: "resumo"`). |

## Decisão

`indexer/src/indexer/templates_cypher.py`: seis funções, `ferramenta(driver, ...) -> dict`.

- **Consultas fixas, somente leitura, com `LIMIT`** (`CONSULTAS`: emissor, entidades dos fatos, fatos, riscos, eventos, pessoas). O texto do usuário só entra como parâmetro; um teste confere que nenhuma consulta escreve ou deixa de ter `LIMIT` e que um texto com aspas e `DETACH DELETE` não chega à consulta. A sessão é de leitura (`RoutingControl.READ`).
- **Resolução antes da consulta**: a métrica pelo catálogo da F4.6 (`contracts/metricas.json`), aceitando o termo exato ou o mais longo contido no texto quando o resto é só enchimento ("o lucro líquido do exercício de 2025"); "lucro bruto" **não** vira "lucro líquido", devolve `metrica_desconhecida` com sugestões. Período: "2025", "FY2025", "4T25", "4º trimestre de 2025", "Q4 2025", "31/12/2025", "31 de dezembro de 2025" → `2025-FY`, `2025-Q4`, `2025-12-31`; o inválido é `periodo_invalido`. Entidade: sem texto, o emissor; senão o nome exato (sem caixa nem acento) ou o único que contém todas as palavras; ambígua ("BB") ou desconhecida é `entidade_desconhecida` com sugestões, nunca cai no emissor em silêncio.
- **`fato_financeiro(metrica, entidade?, periodo?, qualificador?, dimensao?)`**: o total (sem recorte) por padrão; `dimensao` pede um recorte. Valores em pt-BR com escala e moeda explícitas ("R$ 16.782 milhões", "23,9%", "85,2 mil").
- **`serie_metrica(metrica, entidade?, dimensao?, tipo_periodo="fiscal_year")`**: um ponto por período, em ordem cronológica; **não preenche lacunas** (`periodos_ausentes`), só calcula `variacao_pct` entre períodos vizinhos da mesma unidade e sem divergência; períodos com valores diferentes mostram o mais sustentado e as `alternativas`.
- **`comparar_segmentos(metrica, segmentos?, periodo?, entidade?)`**: recortes de uma métrica, do maior ao menor; os pedidos que não existem vêm em `nao_encontrados`; sem lista, os 15 maiores e `omitido.segmentos`.
- **`riscos(tema?, categoria?)`**, **`eventos(tema?, ano?)`**, **`pessoas_cargos(cargo?, nome?, orgao?)`**: o tema casa por palavras com flexão de gênero e plural ("diretora presidente" casa "Diretor Presidente"); o cargo é comparado **um título por vez** (senão "Diretor Executivo; Vice-presidente" casaria "diretor presidente"); sem nenhum filtro, `pessoas_cargos` devolve `filtro_obrigatorio` em vez de listar todo mundo.
- **Contrato comum**: `evidencias[]` (`id`, `tipo`, `paginas`, `caminho`, `texto`, `score`), `aviso`, `erro`, `sugestoes`, `omitido`, `latencia_ms`. Falha do grafo vira `erro`, nunca exceção. Sem resultado, lista vazia e `aviso`.

## Resultado

Contra o grafo real (Neo4j no ar, `uv run pytest tests/test_templates_grafo.py`): **12 testes de contrato passam**, cada um com o valor esperado vindo do golden set, não do código.

| Verificação no grafo real | Resultado |
|---|---|
| N01 lucro líquido do exercício de 2025 | um fato, R$ 16.782 milhões, páginas 80 e 93 (golden: 16.782, p. 93) |
| N02 receita líquida de juros de 2025 | um fato, R$ 101.011 milhões, p. 93 (golden: 101.011, p. 93) |
| `fato_financeiro` sem período | `2025-FY`, `periodo_assumido: true`; a projeção de 2026 não é escolhida |
| T15 "diretora presidente" por `pessoas_cargos` | acha a pessoa do gabarito, `fonte: "resumo"`, com página |
| Série da carteira de crédito | 2023, 2024 e 2025 em ordem, com divergência marcada |
| Série do lucro líquido | **um ponto só (2025)**: o grafo não tem 2023 e 2024 do emissor; a série não inventa |
| `EXPLAIN` das 6 consultas, nenhuma escreve no grafo | contagem de nós e relações igual antes e depois |

Latência com o driver aquecido: 10 a 100 ms por chamada (a primeira chamada, que abre a conexão, levou 2,2 s). Os 90 testes com grafo falso cobrem as 20 formas de falhar listadas no topo de `tests/test_templates_cypher.py`; a suíte inteira ficou em 701 testes.

## Limites

- **O grafo é a fonte, então a resposta é tão completa quanto ele.** Dos 1.243 fatos, 144 não têm métrica canônica (cobertura de 88,4%, dívida da F5.8), e várias métricas misturam subtotais sob "sem recorte": `fato_financeiro("carteira de crédito", 2025)` devolve dois valores (R$ 1.229.907 milhões nas p. 83 e 84 e R$ 175.442 milhões na p. 94) com `conflito: true`; "quantidade de empregados" devolve três totais diferentes. O template não escolhe: mostra os dois e avisa. G09 ("em quais anos o lucro caiu") **não** é respondida por `serie_metrica`, porque o grafo só tem o lucro de 2025 do emissor; ela depende das tabelas (`buscar_tabelas`) ou do Text2Cypher (F6.4).
- **`comparar_segmentos` herda o mapeamento da F4.6**: o recorte "Rurais" da carteira vem de linhas cujo rótulo é "Financiamentos Rurais"; recortes com o mesmo nome em tabelas diferentes viram um só quando o valor coincide e `conflito` quando não.
- **`pessoas_cargos` depende de uma extração com defeitos**: nomes que são cargos (marcados, mas não corrigidos), a mesma pessoa em vários nós e títulos de `HOLDS_POSITION` que não dizem "Presidente" para a presidente. O resumo da pessoa cobre o caso da T15, mas é uma leitura de LLM, não um fato estruturado.
- **Riscos e eventos têm pouca estrutura**: 55% dos riscos sem categoria e 93% dos eventos sem data. O filtro por ano descarta o que não tem data (e conta); a categoria só filtra o que a extração classificou.
- **Só o grafo de um documento**: `Document.fiscalYear` define o "ano-base"; com mais de um documento no mesmo banco, a regra precisa de um filtro por `documentId`.
- **Sem medida de acurácia do roteamento**: os templates não decidem quando são chamados (F7.3). As consultas usam as propriedades `f.value`, `f.scale`, `r.dimension`..., que viram contrato do esquema; a lista de rótulos do grafo está na §6.2.
