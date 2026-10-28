# ADR-019 · Camada léxica no Neo4j: constraints e carga

- **Estado:** aceita (28/10/2026)
- **Data:** 2026-10-28
- **Tarefa(s):** F2.2

## Contexto

A F2.2 aplica as *constraints* da ARQUITETURA §6.3 e carrega Document, Section, Parent e Child no Neo4j nativo (ADR-012), a partir dos Pais e Filhos da F2.1 (ADR-018) e da árvore de seções (ADR-016). O aceite pede as consultas de sanidade da §6.4 sem órfãos.

## Decisão

Módulo `indexer/src/indexer/grafo.py` (comandos `carregar` e `sanidade`), com o driver oficial `neo4j` **6.4.1** (confirmado na fonte: PyPI, publicado em 15/10/2026, não retirado, Python ≥ 3.10; única dependência nova de execução além do `pytz`), fixado em `indexer/pyproject.toml` e `uv.lock`.

1. **Constraints:** as 10 de unicidade da §6.3 (Document, Section, Parent, Child, Table, FinancialFact, Metric, Period, `__Entity__`, `__Community__`), todas com `IF NOT EXISTS`. Um teste compara o texto do código com o da §6.3 da ARQUITETURA, para que os dois não divirjam. Os índices vetorial e full-text ficam para a F2.3 e a F2.4.
2. **Carga idempotente:** `UNWIND` em lotes de 500 com `MERGE` por `id` e `SET n += r`; nós primeiro, relações depois. Relações: `HAS_SECTION` (Document → seção de nível 1), `HAS_SUBSECTION`, `HAS_PARENT`, `HAS_CHILD` e `NEXT` (Pais encadeados na ordem de leitura do documento, atravessando seções).
3. **IDs:** Pai e Filho usam os hashes da F2.1; a Seção usa `<documento>:s<n>` (a árvore é determinística). Document: `bb-fre-2026-v7`.
4. **Propriedades** (a §6.2 foi ajustada): Child ganhou `pageStart`/`pageEnd` no lugar de `page` (o Filho pode cruzar a página), `tokens` e `ordinal`; `text` do Filho já leva o prefixo do caminho. Section ganhou `number` e `order`; Parent, `ordinal`; Document, `pagesIndexed`.
5. **Sanidade** (`sanidade`, 9 consultas que devem dar 0): a da §6.4 (Filhos órfãos) e mais Pais sem Filho, Pais sem Seção, Pais em mais de uma Seção, Filhos em mais de um Pai, Seções fora do Documento, Pai fora das páginas da Seção, Filho fora das páginas do Pai e `NEXT` mal formado; mais as contagens, comparadas com o `.chunks.json`.
6. A senha vem do `.env` (nunca impressa); o texto dos Pais fica no banco local (`infra/neo4j/data`, fora do git).

## Alternativas consideradas

- **`CREATE` em vez de `MERGE`:** não seria reentrante; a F4.4 exige importação idempotente e a mesma disciplina vale desde já.
- **Cypher por linha (um `execute_query` por nó):** milhares de idas e voltas; o `UNWIND` em lotes carrega o recorte em segundos.
- **`neo4j-admin import` (carga em massa offline):** pede o banco parado e não é reentrante.
- **Teste de integração contra o banco real no pytest:** descartado; o Neo4j da comunidade só tem um banco de dados de usuário, e um teste que escreve e apaga nele poderia atingir dados reais. A verificação com o banco fica como comando de sanidade (e o CI roda os testes com um driver falso).

## Consequências

- A F2.3 acrescenta `embedding` e `child_vec` sobre os mesmos nós `Child`.
- Recarregar o mesmo documento é seguro. **Mudar a segmentação deixa nós antigos** (os ids são hashes do texto): antes de reindexar com outros parâmetros, ou de trocar o recorte pelo documento inteiro na F5.8, é preciso esvaziar o banco, o que só será feito com a sua autorização.
- Os Pais do recorte foram hasheados com o identificador `bb_fre_2026_recorte`; a indexação do documento inteiro gera ids novos.

## Verificação do aceite da F2.2

| Critério | Resultado |
|---|---|
| *Constraints* da §6.3 | **10 de 10** presentes (`SHOW CONSTRAINTS`, tipo `NODE_PROPERTY_UNIQUENESS`); um `CREATE (:Parent {id: <existente>})` foi recusado com `22N79` (unicidade) e a contagem de Pais continuou 116 |
| Carga | 1 Document, 170 Section, 116 Parent, 166 Child; relações: 17 `HAS_SECTION`, 153 `HAS_SUBSECTION`, 116 `HAS_PARENT`, 166 `HAS_CHILD`, 115 `NEXT`; contagens idênticas ao `.chunks.json` e à árvore |
| Idempotência | segunda carga: todas as contagens iguais (`carga1.txt` × `carga2.txt`) |
| Sanidade §6.4 (e extras) sem órfãos | **9 consultas, todas 0**: Filhos órfãos, Pais sem Filho, Pais sem Seção, Pai em mais de uma Seção, Filho em mais de um Pai, Seção fora do Documento, Pai fora das páginas da Seção, Filho fora das páginas do Pai, `NEXT` mal formado |
| Testes | 8 testes novos em `test_grafo.py`; 121 no indexador, ruff limpo |

Comandos e saídas brutas em [`ADR-019-bruto/`](ADR-019-bruto/) (`carga1.txt`, `carga2.txt`, `sanidade.json`): `uv run python -m indexer.grafo carregar … ` e `uv run python -m indexer.grafo sanidade --esperado … --secoes …`.

## Ressalvas

1. A primeira consulta de contagem de *constraints* devolveu 0 por um erro meu (filtrei por `UNIQUENESS`, mas o tipo é `NODE_PROPERTY_UNIQUENESS`); percebi porque a contagem contradizia as 10 aplicadas, corrigi a consulta e a conferência agora exige 10.
2. As consultas de sanidade verificam estrutura (órfãos, duplicidade, páginas), não o conteúdo dos nós; o conteúdo foi verificado na F2.1.
3. O `NEXT` liga Pais consecutivos mesmo de seções diferentes; quem usar a vizinhança para expandir contexto (F2.5 em diante) deve decidir se respeita a fronteira de seção.

## Evidência

`indexer/src/indexer/grafo.py`, `indexer/tests/test_grafo.py`, `docs/adr/ADR-019-bruto/`.
