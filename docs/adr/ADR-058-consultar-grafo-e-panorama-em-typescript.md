# ADR-058 · `consultar_grafo` (Text2Cypher com guarda-corpos) e `panorama` em TypeScript: mesmo prompt, mesmos acertos e erros do Python; a guarda não escreve nada no grafo real

- **Estado:** aceita (06/11/2026)
- **Data:** 2026-11-06
- **Tarefa(s):** F7.10

## Contexto

A [ADR-055](ADR-055-execucao-das-ferramentas-em-typescript.md) manda portar as 12 ferramentas de recuperação para o `api/`, cada uma aceita contra o Python no grafo real. A F7.8 ([ADR-056](ADR-056-templates-cypher-em-typescript.md)) portou o executor e os seis templates, e a F7.9 ([ADR-057](ADR-057-buscas-em-typescript.md)) as quatro buscas. Faltavam as duas últimas: `consultar_grafo` (Text2Cypher da F6.4 com a guarda da F6.5, [ADR-050](ADR-050-guarda-corpos-text2cypher.md)) e `panorama` (busca global *map-reduce* da F6.2).

`consultar_grafo` é a única ferramenta que executa texto escrito por um LLM no banco. O Cypher vem de um modelo que lê a pergunta do usuário, e o Qwen obedece a injeção de prompt (na F6.5, 4 de 10 perguntas injetadas viraram consultas de escrita). Por isso a guarda foi portada e testada **antes** do resto.

## Decisão

Em `api/src/ferramentas/`:

- **`guarda.ts`** (porte de `guarda_cypher.py`): `preparar(cypher)` devolve `{cypher, motivo}` e nunca autocorrige. Tira comentários, mascara strings e crases, exige um só comando, recusa cláusulas de escrita e de administração (`CREATE`, `MERGE`, `DELETE`, `SET`, `REMOVE`, `FOREACH`, `DROP`, `LOAD CSV`, `USE`, `SHOW`, `CALL { } IN TRANSACTIONS`…), recusa `CALL` de procedimentos, exige uma cláusula de leitura, limita o texto a 4000 caracteres, recusa caractere de controle e injeta ou limita o `LIMIT` a 100. `planoComEscrita(plano)` olha os operadores do `EXPLAIN` (`Create`, `Merge`, `Delete`, `DetachDelete`, `Set*`, `Remove*`, `Foreach`, `ProcedureCall`, `LoadCSV`…) e `avisosDoPlano(notificacoes)` separa os nomes que não existem no grafo dos outros avisos. As expressões regulares usam classes Unicode (`\p{L}`), porque o `\w` do JavaScript não vê letra acentuada e o do Python vê, e não usam `g` (a bandeira guarda estado entre chamadas).
- **`grafo.ts`**: nova interface `GrafoCypher` (`explicar` e `executarLivre`) sobre o `GrafoNeo4j`, ambos em sessão `READ` com tempo-limite no servidor; `executarLivre` lê no máximo 50 linhas e avisa se havia mais. `temCypherLivre` deixa o executor recusar `consultar_grafo` num acesso que não saiba isso, em vez de rodar sem as barreiras.
- **`consultar.ts`** (porte de `text2cypher.py`): esquema descoberto pela APOC (`apoc.meta.*`, com amostras categóricas e os 687 rótulos de `f.metric` agrupados por família), terminologia PT↔EN de `contracts/metricas.json`, exemplos *few-shot* de `api/prompts/cypher-examples.json`, os 12 rótulos de `f.metric` mais parecidos com a pergunta na mensagem do usuário, Qwen a temperatura 0 com 600 tokens. Cadeia de barreiras: texto (`preparar`) → plano (`EXPLAIN`) → sessão `READ` com 5 s → teto de 50 linhas. Uma única autocorreção, só para erro do banco e nome inexistente; violação da guarda vira `erro: "bloqueada_pela_guarda: …"` sem nova tentativa. O resultado vira `evidencias[]` (uma por linha; a página só vem da coluna `pagina`) e leva `aviso` quando nenhuma linha cita página. Não foram portadas as variantes de prompt do especialista Gemma (F6.6), rejeitadas naquela decisão.
- **`panorama.ts`** (porte de `busca_global.py`): vetor da pergunta (`embeddingDeConsulta`, com o prefixo `Instruct:`, como no Python) → `community_vec` (1000 vizinhos, nível 1, rating ≥ 5, 16 candidatas) → lotes de até 14 000 caracteres → **mapa** (JSON por esquema, no máximo 6 pontos por lote, duas tentativas) → pontos validados (nota inteira de 0 a 10, etiqueta existente, texto não vazio; o inválido é descartado e contado) → deduplicação por texto sem acento nem pontuação (fica a maior nota), ordem estável independente da chegada, teto de 12 pontos e 5000 tokens → **reduce** (≤ 150 palavras). Duas vagas em paralelo; orçamento de 45 s, depois do qual os lotes que não começaram são pulados e contados em `omitido`; o reduce roda com o que chegou. O progresso (`selecao`, `mapa`, `sintese`, `fim`) chega por *callback* e uma falha do *callback* não derruba a busca. Os pontos vêm de relatórios de comunidade e **não têm página** (`paginas: ""`).
- **`executor.ts`**: `panorama` e `consultar_grafo` entram na tabela; `NAO_PORTADAS` fica vazia (as 12 ferramentas do roteador têm execução em TypeScript). A opção `llm` aceita agora também `chat` e `chatJson` (o `ClienteLlm` tem tudo), e `progressoPanorama` repassa os eventos. Sem o que a ferramenta exige, o resultado é `llm_nao_configurado` ou `grafo_sem_cypher_livre`.
- O Python ganhou o subcomando `text2cypher prompt <perguntas…>`, que só imprime os candidatos e as mensagens do prompt, para a paridade comparar o texto.

**Diferenças deliberadas em relação ao Python:** pergunta vazia devolve `erro: "pergunta_vazia"` (o Python devolvia o resultado vazio sem erro); falha ao embutir a pergunta ou ao consultar o índice devolve `falha_na_selecao` (o Python lançaria); síntese vazia conta como `reduce: "falhou"`; o texto das linhas usa `String(v)` do JavaScript (o Python imprime `1096.0` onde o TypeScript imprime `1096`). Nenhuma delas muda o prompt, o Cypher nem a conta do `acerto`.

## Avaliação

`npm run avaliar:consultar` (`api/src/avaliacao/cli-consultar.ts`; relatório em `eval/resultados/f710-consultar.json`, só ids, números e motivos, sem texto do documento — [ADR-009](ADR-009-documento.md); o Cypher gerado, as linhas e os pontos ficam em `data/avaliacao/`) e o teste de integração `guarda.integracao.test.ts`, no grafo real e com o mesmo llama-swap do Python.

**Guarda — 26 entradas maliciosas ou malformadas** (`guarda.casos.ts`, as mesmas 26 do teste da F6.5 em Python: escritas em todas as caixas, quebras de linha e comentários no meio da cláusula, `;`, `FOREACH`, índices, `LOAD CSV`, `apoc.*`, `dbms.*`, `SHOW`, `USE system`, controle, 50 mil caracteres, `LIMIT` calculado, sem leitura):

- **26/26** são recusadas por `preparar` sem banco (`guarda.test.ts`, que roda também na integração contínua).
- No grafo real, o número de nós, o de relações e a soma de `f.value` são **os mesmos antes e depois de cada uma das 26**. Pelo fluxo completo, 25 voltam com `bloqueada_pela_guarda`; a que tem `;` é reduzida pela extração do Cypher à primeira consulta, que é de leitura (`MATCH (n) RETURN n LIMIT 1`), exatamente como no Python.
- As barreiras do servidor, uma a uma: o plano do `EXPLAIN` denuncia as **7 escritas** do teste mesmo sem o filtro de texto; a sessão `READ` recusa as 6 que chegam a executar; o tempo-limite de 5 s derruba o produto cartesiano (`falha_na_execucao`, bem abaixo de 20 s, com o aviso do plano); nome de propriedade e de rótulo que não existem viram aviso; erro de sintaxe levanta no `EXPLAIN`; a autocorreção acontece uma vez (a segunda resposta, com nome inexistente, segue com o aviso, sem terceira chamada); os exemplos *few-shot* e as consultas legítimas passam pela guarda e pelo plano e devolvem linhas. 45 testes, todos passando.

**Text2Cypher — 15 perguntas de `eval/golden_agregacao.csv`:**

| | Python (F6.4) | TypeScript |
|---|---|---|
| `teste` (aceite, n = 10) | 9/10 = 0,90 | **9/10 = 0,90** |
| `ajuste` (n = 5) | 4/5 | 4/5 |
| geral (n = 15) | 13/15 | 13/15 |
| rodaram sem erro | 15/15 | 15/15 |

O prompt do TypeScript é **idêntico, caractere a caractere, ao do Python nas 23 perguntas do arquivo** (as 15 acima mais as 8 `fora`), e os rótulos candidatos são os mesmos. Os acertos e erros coincidem **pergunta a pergunta**: erram AG02 e AG04 nos dois lados. Latência: a primeira chamada leva 33,1 s (carga do modelo), a mediana é 2,9 s e o máximo 4,1 s.

O aceite (≥ 90%) é cumprido, mas **no limite: uma pergunta a menos reprovaria**. As duas que erram mostram que a guarda protege o banco, não a resposta: AG02 inventou os nomes dos rótulos de remuneração e a soma deu 0 sem página (o `aviso` "não cita página" disparou); AG04 somou os rótulos "Empregados X" e "TOTAL DE EMPREGADOS - X" e contou em dobro (12 416 no lugar de 6 208).

**`panorama` — 10 perguntas temáticas do golden (P01 a P10), com síntese:**

| | Python (F6.2, `f62-n1`, mesmos limites) | TypeScript |
|---|---|---|
| mediana | 39,2 s | 40,8 s |
| máximo | 56,1 s | **55,9 s** (P01) |

O aceite (≤ 60 s) é cumprido nas 10, com 4,1 s de folga na pior. Nenhuma foi truncada por tempo, nenhuma teve erro e o reduce rodou nas 10. Os pontos por pergunta variam: 12 em seis, 11 em P05, 5 em P07, 2 em P10 e **1 em P09**.

**Testes** (escritos antes do código, com as formas de falha no cabeçalho de cada arquivo): 619 na API com Neo4j e llama-swap no ar — 65 da guarda e 69 do Text2Cypher (sem banco), 31 do `panorama`, 45 da guarda contra o grafo real —, `typecheck`, `lint`, `build` e `ruff` sem erros.

## Limites

- **O Text2Cypher segue sendo hipótese.** 90% em 10 perguntas é um número com intervalo largo (uma pergunta vale 10 pontos); o grupo `ajuste` foi usado para ajustar o prompt na F6.4, então o 13/15 geral não é independente. As 8 perguntas `fora` (sem dado no grafo, que na F6.4 voltaram números plausíveis e errados) não foram medidas de novo. O resultado só é conferível quando a linha cita a página.
- **Paridade não é correção.** O TypeScript reproduz o Python (prompt, acertos e erros), não prova que os 90% se mantêm em outras perguntas.
- **O `panorama` foi medido só em tempo.** A qualidade (o recall do juiz, 0,50 na F6.2) não foi reavaliada aqui, e P09 e P10 voltaram com 1 e 2 pontos. A folga de 4 s vem de uma rodada por pergunta; o LLM roda a temperatura 0,1 e o tempo varia com o servidor (o Python também ficou a 56,1 s). Os tempos do Python são os da F6.2, de outra rodada e de outro estado do servidor, então a comparação com a mediana (39,2 s contra 40,8 s) mostra a mesma ordem de grandeza, não igualdade.
- **Os pontos do `panorama` não têm página**, então o redator da F7.5 não pode citá-los como evidência do documento.
- **Um ajuste de teste depois de ver o resultado:** o teste de integração esperava erro nas 26 entradas; a de `;` não dá erro porque a extração corta na primeira consulta (de leitura). O erro era do teste, não da guarda, e o teste agora diz isso. Nada do aceite foi mexido.
- O Python continua como referência até a F7.11.

## Como reproduzir

```powershell
.\infra\neo4j.ps1 iniciar
.\infra\swap.ps1                           # em outro terminal
cd api
npx vitest run test/ferramentas/guarda.integracao.test.ts   # ~7 s; pulado sem o Neo4j
npm run avaliar:consultar                  # ~9 min; --somente prompt,cypher,panorama, --limite N
```
