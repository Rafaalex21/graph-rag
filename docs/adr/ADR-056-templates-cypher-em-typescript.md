# ADR-056 · Executor de ferramentas em TypeScript e os seis templates Cypher portados, com paridade de 54/54 contra o Python no grafo real

- **Estado:** aceita (06/11/2026)
- **Data:** 2026-11-06
- **Tarefa(s):** F7.8

## Contexto

A [ADR-055](ADR-055-execucao-das-ferramentas-em-typescript.md) decidiu portar as 12 ferramentas de recuperação para o `api/`, cada uma aceita por **paridade contra o Python no grafo real**. A F7.8 é a primeira: o executor (que recebe o `{nome, argumentos}` do roteador da F7.3), o contrato `evidencias[]`, a conexão `neo4j-driver` somente leitura e os seis templates Cypher da F6.3 ([ADR-048](ADR-048-templates-cypher.md)): `fato_financeiro`, `serie_metrica`, `comparar_segmentos`, `riscos`, `eventos` e `pessoas_cargos`.

O risco do porte não está nas consultas (copiadas) e sim em tudo o que o Python faz em volta delas: resolver "lucro líquido" e "4T25" para o que o grafo guarda, escolher o fato mais sustentado quando o documento diverge, ordenar, arredondar, contar o que ficou de fora. Foi isso que os testes e a paridade cobriram.

## Decisão

Em `api/src/ferramentas/`:

- **`grafo.ts`** — `GrafoLeitura` (uma consulta fixa com parâmetros; os testes põem um dublê) e `GrafoNeo4j`, sobre `neo4j-driver` 6.3.0, com `executeQuery(..., { routing: READ })`. Dois cuidados que o driver exige: inteiros chegam como `Integer` (`paraJs` os converte e recusa os fora do intervalo seguro) e número inteiro de JS vai como FLOAT, o que faz `LIMIT $n` falhar (`paraNeo4j`). Credenciais do `.env` da raiz, com as variáveis `NEO4J_*` do ambiente vencendo.
- **`contrato.ts`** — `Envelope` (`ferramenta`, `parametros`, `evidencias[]`, `aviso`, `erro`, `sugestoes`, `omitido`, `latencia_ms`) e `Evidencia` (`id`, `tipo`, `paginas` como `p. 6-7`, `caminho`, `texto`, `score`). As chaves ficam em *snake_case* como no Python, para a paridade comparar JSON com JSON.
- **`resolucao.ts`, `texto.ts`, `catalogo.ts`** — métrica (nome, alias, `contracts/metricas.json`), entidade do grupo, período (`2025`, `4T25`, `2025-Q4`, com validação de data), formatação de valor em reais, consolidação de fatos equivalentes (mesmo valor em escalas diferentes viram um; valores diferentes viram `conflito`) e a normalização de texto.
- **`templates.ts`** — as seis ferramentas e o dicionário `CONSULTAS` (Cypher fixo, só leitura, sempre com `LIMIT`; o texto do usuário entra apenas como parâmetro).
- **`executor.ts`** — `criarExecutor({grafo, catalogo?, extras?})` → `executar(chamada)` / `executarTodas(chamadas)`. **Nunca lança**: ferramenta desconhecida vira `ferramenta_desconhecida`, as seis ainda não portadas (`buscar_trechos`, `buscar_tabelas`, `entidade`, `panorama`, `consultar_grafo`, `resposta_ja_dada`) viram `ferramenta_nao_portada`, exceção vira `falha na ferramenta`. `extras` registra as ferramentas das F7.9 e F7.10 sem mexer nas outras. Os argumentos vêm de um LLM e são convertidos aqui: `riscos(categoria: "mercado")` vira `market`, categoria desconhecida vira `tema` em vez de sumir ou dar erro, ano em texto vira número, segmento único vira lista, e cada ferramenta recebe só os argumentos dela. Um teste confere que as ferramentas conhecidas pelo executor são exatamente as 12 do `CATALOGO` do roteador.

## Avaliação

**Paridade** (`npm run avaliar:paridade`, `eval/paridade_templates.json`): 54 chamadas dos seis templates (17 de fato, 8 de série, 5 de comparação, 9 de riscos, 7 de eventos, 8 de pessoas), cada uma rodada no Python (`uv run python -m indexer.templates_cypher`) e no TypeScript contra o mesmo Neo4j, com o JSON comparado campo a campo, ignorando só `latencia_ms`. 34 delas trazem evidências e 9 são erros esperados (métrica, entidade, período, tipo de período, categoria e ano inválidos; filtro ausente). **54/54 idênticas**, 0 diferenças só de ordem, 0 falhas. O resultado, sem nenhum texto do documento ([ADR-009](ADR-009-documento.md)), está em `eval/resultados/f78-paridade.json`; as duas saídas completas ficam em `data/avaliacao/` (fora do repositório).

**Contrato contra o grafo real** (`api/test/ferramentas/templates.integracao.test.ts`, porte de `test_templates_grafo.py`; pulado sem o Neo4j): os valores esperados vêm do golden set e não do código. N01 (lucro líquido de 2025) bate com o golden em valor × 10⁶ e página, N02 (receita líquida de juros) também, `pessoas_cargos` acha a diretora presidente (T15) pelo resumo, o cargo gravado como nome sai marcado, `EXPLAIN` roda para toda consulta e nenhum template escreve no grafo (contagem de nós e relações igual antes e depois). 13 testes, mais um do executor rodando uma chamada do roteador no grafo real.

**Testes** (escritos antes do código, com as formas de falha no cabeçalho de cada arquivo): 323 passam na API (169 novos: 147 unitários das ferramentas, 13 de contrato no grafo real e 9 do comparador de paridade), `typecheck` e `lint` sem erros.

## Uma divergência deliberada

Num erro de validação (`categoria_invalida` em `riscos`, `ano_invalido` em `eventos`) o Python sai antes de criar a lista do resultado e **não traz a chave** `riscos`/`eventos`; o TypeScript a devolve **vazia**, para quem consome não precisar testar a chave. Primeira rodada da paridade: 52/54, e as duas diferenças eram só essa. O comparador a trata por regra explícita (`semListasVaziasExtras`: só tira do lado TypeScript uma chave ausente no Python **e** com valor `[]`; lista com conteúdo, `null` ou lista vazia que o Python também tem continuam contando), e o relatório lista os casos em que ela agiu (`com_lista_vazia_extra_no_ts`: 2).

## Limites

- **Paridade com o Python não é correção.** As ressalvas da F6.3 continuam (o grafo só tem o lucro de 2025 do emissor; recorte em `dimension`; ano-base 2025). O porte reproduz inclusive o que o Python tem de estranho: a ordem de eventos por data compara o texto da data (prefixo menor primeiro), e `pontos[-limite:]` na série.
- **54 chamadas escritas por mim**, sem grupo de teste separado: a paridade confere igualdade com o Python, que é um oráculo fixo, então não há ajuste a esconder; mas ela só cobre o que as 54 exercitam. Combinações que não estão ali (qualificadores como `variacao_percentual`, que o CLI do Python não expõe; `limite` fora do padrão) são cobertas só pelos testes com grafo falso.
- **Arredondamento:** `Number(x.toFixed(n))` em vez do arredondamento do Python; só difere em empates exatos na última casa, que nenhum caso encontrou.
- **Ordem do que o banco não ordena** (`collect(DISTINCT ...)`): o comparador separa diferença de ordem de diferença de conteúdo (`so_ordem`) e não encontrou nenhuma, mas o Neo4j não garante essa ordem; as páginas são ordenadas nos dois lados antes de sair.
- **`.env`:** o TypeScript tira as aspas que cercam o valor; o `ler_env` do Python as mantém. Sem efeito nas credenciais atuais (sem aspas).
- **Latência não é comparável aqui:** a mediana de 2,1 s do Python inclui abrir a conexão em cada processo; a do TypeScript (8,6 ms) é com a conexão já aberta. A medida de tempo de resposta fica para a F7.11.
- **Seis ferramentas ainda sem execução em TypeScript:** F7.9 (`buscar_trechos`, `buscar_tabelas`, `entidade`, `resposta_ja_dada`) e F7.10 (`consultar_grafo`, `panorama`).

## Como reproduzir

```
.\infra\neo4j.ps1 iniciar
cd api
npm run avaliar:paridade        # 54 chamadas, Python x TypeScript, sai com código 1 se houver diferença
npx vitest run test/ferramentas # unitários e, com o Neo4j no ar, o contrato contra o grafo real
```
