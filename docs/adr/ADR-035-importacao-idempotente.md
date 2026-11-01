# ADR-035 · Importação idempotente da extração dirigida

- **Estado:** aceita (01/11/2026)
- **Data:** 2026-11-01
- **Tarefa(s):** F4.4

## Contexto

O aceite da F4.4 é: importar duas vezes não altera nenhuma contagem. A §5 I-5 (guarda 3) pedia IDs determinísticos "hash de documento + página + métrica + período + entidade", e o livro alerta que `randomUUID()` não é idempotente. A entrada são os 807 fatos aceitos pelo lastro ([ADR-034](./ADR-034-lastro-numerico.md)) e as 6 listas de entidades da extração ([ADR-033](./ADR-033-extracao-por-pai-e-por-tabela.md)).

## Medição que corrigiu a ARQUITETURA

A chave da §5 funde fatos diferentes. Medido nos 807 aceitos do recorte (conta feita por um script avulso sobre `data/parsed/bb_fre_2026_recorte.fatos.json`; a chave adotada é a de `id_do_fato` em `importar.py`, que também dá 803 ids):

| Chave | Ids distintos | Colisões | Fatos perdidos |
|---|---|---|---|
| página + métrica + período + entidade (§5) | 761 | 29 | 46 (5,7%) |
| unidade + métrica + período + entidade + segmento | 790 | 14 | 17 |
| … + valor | 799 | 8 | 8 |
| … + evidência (**adotada**, mais o documento) | **803** | 4 | 4 |

Em 21 grupos da chave da §5 os valores diferem: a mesma página traz o valor num parágrafo (em R$ bilhões) e na tabela (em R$ milhões), ou o valor e a variação em %, ou a despesa com sinal e em módulo. Fundi-los deixaria um deles com o valor do outro. As 4 colisões que sobram têm métrica, período, entidade, valor e evidência idênticos na mesma unidade (o modelo extraiu a mesma célula duas vezes); fundi-las é o comportamento certo.

O Rafael aprovou a correção da chave antes da implementação (01/11/2026). A §5 I-5 guarda 3 foi corrigida.

## Decisão

**`indexer/src/indexer/importar.py`** (`python -m indexer.importar executar|verificar`): sem LLM, com o Neo4j no ar. Todo nó é gravado com `MERGE` pelo id e `SET n += props`; toda relação com `MERGE`. O mesmo comando rodado de novo reescreve os mesmos valores.

| Nó | Id | Origem |
|---|---|---|
| `FinancialFact` | `fact:` + hash(documento, unidade de origem, métrica, período, entidade, segmento, valor, evidência), textos normalizados | só os `aceito` do lastro |
| `__Entity__` + `Organization`, `Person`, `Segment`, `RiskFactor`, `Event`, `Instrument` | `ent:<tipo>:` + hash(tipo, nome normalizado, campo extra do tipo) | listas da extração; organização também nasce do `entity` dos fatos, do cargo, do segmento, do risco, do evento e do instrumento |
| `Period` | o próprio período (`2025-FY`) | início e fim calculados (exercício = ano civil) |

Normalização do nome: minúsculas, sem acento, só letras e dígitos. "Banco do Brasil S.A." e "BANCO DO BRASIL S A" são o mesmo nó, com as duas grafias em `aliases` e `aliasesText`; o campo extra do hash é a categoria (risco), o tipo (instrumento), a organização (segmento) e documento, unidade e tipo (evento). Escala e unidade **ficam fora** da chave do fato, para que corrigir a escala dos 48 fatos da p. 157 atualize o nó em vez de duplicá-lo.

Relações: `REPORTED_IN` (fato → Pai ou Tabela, uma por fato), `ABOUT` (fato → organização; não para entidades genéricas como "Total"), `FOR_PERIOD`, `MENTIONED_IN` (entidade → unidade onde foi citada), `DESCRIBED_IN` (risco → unidade), `HOLDS_POSITION {title}`, `HAS_SEGMENT`, `AFFECTS`, `INVOLVES`, `ISSUED_BY`. `Metric` e `OF_METRIC` ficam para a F4.6.

**Unidade não declarada (decisão do ADR-034).** Um fato em moeda, escala 1, valor inteiro, numa unidade cujo texto não traz nenhuma escala, ganha `unitDeclared = false`. O valor e a escala não são alterados.

## Verificação do aceite da F4.4

Evidência: `docs/adr/ADR-035-bruto/verificacao.json` (contagens e impressão digital, sem texto do documento). Comando, a partir de `indexer/` com o Neo4j no ar: `uv run python -m indexer.importar verificar ../data/parsed/bb_fre_2026_recorte --doc-id bb-fre-2026-v7`.

O comando importa, conta, importa de novo, conta e compara contagens **e** uma impressão digital (hash de todos os nós e relações do que o importador escreve, com propriedades).

| | 1ª importação | 2ª importação |
|---|---|---|
| `FinancialFact` | 803 | 803 |
| `__Entity__` | 106 (67 organizações, 13 pessoas, 12 segmentos, 9 riscos, 5 instrumentos, 0 eventos) | 106 |
| `Period` | 20 | 20 |
| `REPORTED_IN` / `ABOUT` / `FOR_PERIOD` | 803 / 796 / 803 | 803 / 796 / 803 |
| `MENTIONED_IN` / `DESCRIBED_IN` | 225 / 9 | 225 / 9 |
| `HOLDS_POSITION` / `ISSUED_BY` | 15 / 5 | 15 / 5 |
| Impressão digital | `3525a443fd76d33e` | `3525a443fd76d33e` |

Todas as contagens iguais e a mesma impressão digital. O comando rodou duas vezes, em processos diferentes (quatro importações no total), e as contagens do segundo processo são as do primeiro; a impressão digital foi registrada só no segundo. A sanidade ficou em 0 (fatos sem origem, sem período, com mais de uma origem; entidades sem origem ou sem tipo; fatos sem documento). Também deram 0 os fatos cuja unidade de origem não está numa seção e os fatos cuja página cai fora das páginas da unidade. Os 803 fatos são os 807 menos os 4 idênticos fundidos.

`unitDeclared = false` em **53 fatos**: 36 na p. 157, 12 na p. 158 (os 48 do ADR-034), 1 na p. 352 e 4 na p. 405. Os 5 últimos seguem a mesma regra e não foram conferidos no PDF.

## Consequências e ressalvas

- **O que muda quando a extração muda.** O id inclui o valor e a evidência. Reextrair com outro modelo, ou corrigir um valor, gera um nó novo e deixa o antigo no grafo (fato obsoleto). Remover o antigo é apagar dados e precisa de autorização; a F4.4 só adiciona. Reimportar a **mesma** extração nunca duplica.
- **Entidades só unidas por nome normalizado.** "BB", "Banco do Brasil" e "Banco do Brasil S.A." são três nós até a F4.5. Pessoas: 13 nós para 15 menções. Segmento com e sem a organização citada são nós diferentes.
- **`ABOUT` vai sempre para `Organization`.** O `entity` do fato mistura empresas e órgãos ("Diretoria Executiva", "Conselho Fiscal", "Conselho de Administração": 60 fatos); eles viram `Organization`. A F4.5 decide se são organizações, segmentos ou outra coisa. Entidades genéricas ("Total") não ganham `ABOUT` (7 fatos).
- **O mesmo número em duas unidades vira dois fatos.** O lucro líquido do parágrafo (R$ 16,8 bilhões) e o da tabela (R$ 16.782 milhões) são fatos distintos, ligados a unidades distintas. A importação não os une; quem soma ou compara fatos precisa saber disso (F4.6 e a camada de consulta).
- **Entidades de domínio não passaram por lastro.** Só os fatos têm guarda numérica; organizações, pessoas e riscos entram como o modelo as devolveu. A F4.5 audita fusões; a qualidade das 106 entidades não foi auditada.
- **Zero eventos** (herdado da F4.2): `Event` está pronto no importador e testado com dados inventados, mas não foi exercitado com dado real.
- **`unitDeclared` é uma regra, não um fato.** Ela marca o que o texto não declara; não prova que o número está em R$ mil nem em reais. Responder "reais" sobre esses 53 fatos continua errado.
- **Grafo atual.** O Neo4j do projeto agora tem os fatos e as entidades do recorte (esta importação). Não houve apagamento: só `MERGE`.
- **Páginas do fato.** `page` e `pageEnd` do fato são as da unidade de origem, não da célula; para um fato de tabela que atravessa páginas, a primeira página vale para o intervalo inteiro.
