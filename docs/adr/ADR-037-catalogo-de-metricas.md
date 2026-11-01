# ADR-037 · Catálogo de métricas canônicas e mapeamento PT↔EN

- **Estado:** aceita (01/11/2026): 800 dos 803 fatos do grafo ligados a uma métrica (99,6%); auditoria completa dos rótulos acha cerca de 2% dos fatos sob métrica errada
- **Data:** 2026-11-01
- **Tarefa(s):** F4.6

## Contexto

O aceite da F4.6 é: ≥ 95% dos fatos ligados a uma métrica canônica. A F4.4 importou 803 fatos ([ADR-035](./ADR-035-importacao-idempotente.md)) cujo campo `metric` é o rótulo como a extração o escreveu: 400 rótulos distintos nos 807 fatos aceitos pelo lastro, de "Lucro líquido" a "Quantidade de empregados - Não binário - Sudeste". Sem um nome canônico, `fato_financeiro("receita líquida")` (ARQUITETURA §7.2) não acha nada que se escreva diferente, e o Text2Cypher (§7.3) não tem o que ligar a "faturamento" ou "lucro".

## Decisão

**O catálogo é um arquivo de contrato:** `contracts/metricas.json` (97 métricas), lido pelo indexador agora e pelo API na F6, sem cópia no prompt. Cada métrica tem `id`, `name` (nome canônico em inglês, a chave única do nó `Metric`), `name_pt`, `kind` (`monetary`, `percent`, `ratio`, `count`, `price`), `definition`, `aliases` e, opcionalmente, `componentes`. `python -m indexer.catalogo validar` confere campos, tipos e que nenhum termo aponte para duas métricas; `termo <texto>` faz o mapeamento terminológico ("faturamento", "receita" e "revenue" dão `net_revenue`; "lucro", `net_income`).

**Sinônimo não é componente.** `aliases` são sinônimos: o termo é o total da métrica. `componentes` são termos que designam uma parte ("depósitos a prazo", "LCA + LCI", "obrigações por repasses") e resolvem para a métrica **com o próprio termo como dimensão**. A primeira versão tinha os componentes como aliases e o mapeamento passava um componente por total (ver abaixo).

**Recorte não é métrica.** O vínculo `FinancialFact -[OF_METRIC {qualifier, dimension}]-> Metric` guarda o que o rótulo acrescenta ao conceito: `dimension` é o recorte (região, faixa de prazo, componente, segmento de cliente) e `qualifier` é `nenhum`, `variacao_percentual`, `variacao_absoluta` ou `percentual_do_total`. Assim "Financiamentos Rurais" e "Total da Carteira de Crédito" são `credit_portfolio`, o segundo com `dimension` nula, e os 112 rótulos de empregados cabem em `employee_headcount` sem 112 métricas. **`dimension` nula quer dizer "o termo do catálogo, o total".** O rótulo original continua em `FinancialFact.metric`.

**Mapeamento** (`python -m indexer.catalogo mapear`), nesta ordem:

1. rótulo igual a um alias (nome, nome em português ou alias, sem caixa nem acento): resolve sem LLM, `dimension` nula;
2. rótulo igual a um componente: resolve sem LLM, `dimension` = o rótulo;
3. os demais vão ao Qwen3.6 (`temperature` 0, JSON por gramática com a métrica restrita ao catálogo mais `nenhuma`). O pedido leva o rótulo, a seção do documento, os outros rótulos da mesma tabela ou trecho, as unidades, as páginas e duas evidências. Cache por hash do pedido em `data/parsed/metricas_cache/`.

Depois do LLM, duas regras deterministas: sem recorte declarado e sem qualificador, o próprio rótulo vira a `dimension` (ele não é um termo do catálogo, então não pode passar por o total); e `percentual_do_total` sobre uma métrica que já é percentual vira `nenhum`. O resultado vai para `data/parsed/<prefixo>.metricas.json` (fora do git), que o importador lê sozinho.

**Importação.** `Metric` é um nó por entrada do catálogo (`id` = `metric:<id>`, `name`, `namePt`, `kind`, `definition`, `aliases`), criado por `MERGE` junto com os fatos. O `MERGE` só acrescenta, então o importador agora remove os `OF_METRIC` que o plano não tem mais (relações que ele mesmo criou; nenhum fato, nó ou texto é tocado). Isso foi achado por uma verificação nova de sanidade, `fatos_com_mais_de_uma_metrica`: depois de revisar o mapeamento, 4 fatos ficaram com o vínculo velho e o novo.

**`Metric` não recebe `__Entity__`** (a §6.1 mandava). O catálogo é fechado, tem chave própria e entraria na resolução da F4.5 e nas contagens de entidades sem ser uma entidade extraída. A ARQUITETURA foi corrigida para adiar o rótulo até a F5.

## Medição

Três rodadas do mapeamento, na ordem em que foram feitas:

| Versão | Contexto dado ao LLM | Fatos ligados |
|---|---|---|
| v1 | rótulo, unidades, páginas, 2 evidências | 695 de 807 (86,1%): **abaixo do aceite** |
| v2 | v1 + seção do documento + regras de qualificador e de risco de mercado | 757 de 807 (93,8%): abaixo |
| v3 | v2 + rótulos vizinhos da mesma tabela + a métrica `authorized_capital` | 804 de 807 (99,6%) |

**A v2 e a v3 foram desenhadas depois de ver as falhas da anterior**, e o catálogo foi escrito depois de ler os 400 rótulos do recorte. Os números são de um ajuste feito no mesmo conjunto em que se mede; isso enviesa o resultado para cima. A v1 é a medição sem ajuste. Os 39 fatos de três segmentos de cliente de uma tabela de projeção ("Pessoas Físicas", "Empresas", "Agronegócios") só se resolveram quando o LLM viu os rótulos vizinhos ("Carteira de Crédito").

**Cobertura não é precisão.** Para não reportar só o 99,6%, auditei o mapeamento de duas formas (evidência em `docs/adr/ADR-037-bruto/resumo.json`, só contagens):

- **Amostra de 40 fatos** (semente 46): métrica certa em 39, uma errada (um passivo mapeado para um ativo de liquidez). Em 8 das 40 linhas a `dimension` veio com o texto literal "nenhuma" (o modelo a escreveu no campo em vez de deixá-lo nulo); isso foi corrigido na normalização. Em 3 linhas o `qualifier` ficou `nenhum` sendo guidance em % (ver ressalvas).
- **Leitura completa dos 399 rótulos mapeados**, agrupados por métrica: 11 rótulos com a métrica errada, que somam **17 fatos (2,1%)**. Entre eles "Variação % Obrigações por Empréstimos/Repasses" como valor de um empréstimo específico e "Recursos de Instituições Financeiras" como aplicação interfinanceira. Pela leitura, a precisão é de cerca de 97%.

A leitura também achou o defeito de desenho que mudou o catálogo: aliases que eram componentes (28 deles) faziam "Depósitos a Prazo" valer como o total de depósitos e deixavam `dimension` nula num componente, o que quebra "nula = total". Tirá-los dos aliases piorou 4 rótulos que o alias acertava por acaso; o campo `componentes` os recuperou (7 rótulos mudaram para o lado certo).

## Verificação (F4.6)

Comandos, a partir de `indexer/`, com Neo4j no ar (`mapear` precisa do llama-swap no perfil `indexar`):

```
uv run python -m indexer.catalogo validar
uv run python -m indexer.catalogo mapear ../data/parsed/bb_fre_2026_recorte
uv run python -m indexer.importar verificar ../data/parsed/bb_fre_2026_recorte --doc-id bb-fre-2026-v7
uv run python -m indexer.catalogo medir ../data/parsed/bb_fre_2026_recorte --doc-id bb-fre-2026-v7
```

| | Resultado |
|---|---|
| Catálogo | 97 métricas, 221 aliases, 26 componentes (13 métricas), sem termo repetido |
| Rótulos | 400: 102 por termo ou componente, 298 pelo LLM; 399 ligados, 1 sem métrica ("Passivo Total % em relação ao passivo total", uma tautologia de 100%) |
| Grafo | 803 fatos, **800 com `OF_METRIC` (99,63%)**, 97 nós `Metric`, 94 entidades (não mudaram) |
| Idempotência | duas importações: mesmas contagens e mesma impressão digital (`c93d991bc855dfc8`) |
| Sanidade | todas as verificações em 0, inclusive `fatos_com_mais_de_uma_metrica` |
| Recortes | 288 rótulos com `dimension`, 44 com `qualifier` diferente de `nenhum` |

## Consequências e ressalvas

- **A cobertura medida é otimista.** O catálogo foi escrito olhando o recorte de 79 páginas; no documento inteiro haverá rótulos de capítulos que ele não viu. A medição que vale é a da extração completa (F5.8): rodar `mapear` e `medir` de novo e ler os rótulos novos.
- **A auditoria é minha, não de uma pessoa.** A leitura dos 399 rótulos e a amostra foram feitas por mim, que também escrevi o catálogo. Os 11 rótulos errados são os que eu reconheci; pode haver mais.
- **`qualifier` de guidance em %.** As tabelas de projeção ("Carteira de Crédito (%)", "Despesas Administrativas (%)" com faixa e valor observado) são crescimentos em %, e os fatos saíram com `qualifier = nenhum`. Quem consultar o valor "sem qualificador" de `credit_portfolio` pode receber um percentual de crescimento junto com os saldos. A `unit` do fato (`percent`) separa uns dos outros; um filtro por `kind` da métrica e `unit` pertence ao `fato_financeiro` (F6).
- **`dimension` guarda só parte do recorte** quando o rótulo tem duas dimensões ("Não binário - Sudeste" ficou "Sudeste"). O rótulo inteiro está em `FinancialFact.metric`; as dimensões separadas não foram modeladas.
- **`dimension` não nula nem sempre é um recorte de verdade:** por causa da regra do rótulo-como-dimensão, rótulos específicos que não são termos do catálogo (por exemplo "Lucro Líquido do Exercício Atribuível às Partic. de Acionistas Não Controladores") levam o próprio rótulo como `dimension`. É conservador (nunca trata um componente como total) e verboso.
- **Períodos ("4T25" → `2025-Q4`) ficam fora**, apesar de aparecerem junto no mapeamento terminológico da §7.3: a F6 trata deles.
- **Rótulos de um mesmo conceito com unidades diferentes** (R$ e %) continuam sob a mesma métrica. A `kind` do catálogo diz o tipo esperado, mas o importador não confere o `unit` do fato contra ela.
- **Desfazer:** o mapeamento está em `data/parsed/<prefixo>.metricas.json`. Sem esse arquivo o importador não cria nem remove vínculos de métrica (a remoção só ocorre quando há métricas no plano). Para limpar o grafo seria preciso apagar os `OF_METRIC` e os nós `Metric` à mão, o que exige a sua autorização.
