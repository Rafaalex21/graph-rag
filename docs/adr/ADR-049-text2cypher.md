# ADR-049 · Text2Cypher com esquema (APOC), terminologia, *few-shot* e instruções de formato

- **Estado:** aceita (06/11/2026), com ressalvas sobre o conjunto de avaliação e sobre perguntas que o grafo não cobre (ver "Limites")
- **Data:** 2026-11-06
- **Tarefa(s):** F6.4

## Contexto

`consultar_grafo` é a rede de segurança da §7.2: agregações e filtros que nenhum template cobre. O aceite da F6.4 é **acurácia de execução ≥ 70% nas perguntas de agregação**. O LLM é o Qwen3.6-35B-A3B do perfil `consultar` (o especialista Gemma 3 4B é a F6.6, e os guarda-corpos completos são a F6.5).

Antes de escrever o código, procurei as perguntas de agregação do golden set (G01–G10) no grafo real. **Só G03 e G07 têm a resposta no grafo**: G01 e G02 dependem da tabela de participações (p. 205), que está só como markdown; G04 e G05 pedem cor/raça × região, que o grafo não tem; G06 e G10 pedem a maior e a menor remuneração individual (métricas existem, fatos não); G08 é da p. 113, sem fatos; G09 precisa do lucro de 2023 e 2024. Medir o Text2Cypher nessas dez perguntas mediria a extração, não a geração de Cypher.

## Decisão

### Conjunto de avaliação: `eval/golden_agregacao.csv`

15 perguntas de agregação **respondíveis pelo grafo** (AG01–AG15: AG01 = G03 e AG02 = G07 do golden; 13 novas), cada uma com o valor esperado conferido contra o texto do PDF, as páginas e um `cypher_gabarito` que o teste de contrato executa no grafo real e compara com o valor do gabarito. As 8 perguntas oficiais sem resposta no grafo ficam no mesmo arquivo com `grupo = fora` e o motivo, como **dívidas de extração**, fora da nota.

Para a medida não virar vazamento, as 15 se dividem em **`ajuste`** (5: AG04, AG06, AG10, AG13, AG15), as únicas usadas para iterar o prompt, e **`teste`** (10), medidas uma vez com o prompt congelado. O número do aceite é o do `teste`.

### Módulo `indexer/src/indexer/text2cypher.py`

Prompt de duas mensagens. O **sistema** é igual em toda pergunta (o cache de prefixo do llama.cpp o reaproveita) e tem as quatro seções do cap. 4:

1. **Esquema** pela APOC (`apoc.meta.nodeTypeProperties`, `apoc.meta.relTypeProperties`) e padrões de relação lidos do grafo, sem `embedding*`, textos longos nem metadados; rótulos de infraestrutura de recuperação (`Child`, `HypotheticalQuestion`, `__Entity__`) ficam de fora e as relações entre tipos de entidade (`RELATED_TO`, `MENTIONED_IN`...) viram uma linha com `Entidade`, o que reduziu o esquema de 23.672 para 4.364 caracteres. Sem a APOC, cai para `db.schema.*` e avisa. **Amostra de valores**: `OF_METRIC.qualifier`, `Period.id`, `unit`, `periodType`, `scale`, `Metric.kind`, `RiskFactor.category`; os 687 rótulos distintos de `FinancialFact.metric` (famílias repetitivas, como as 40 faixas de provisão, entram com 6 exemplos e a contagem do resto, até 16.000 caracteres); e até 5 recortes (`dimension`) por métrica.
2. **Terminologia** PT↔EN das 97 métricas, lida de `contracts/metricas.json` (nome do grafo, nome em português, até 6 sinônimos).
3. **11 exemplos *few-shot*** em `api/prompts/cypher-examples.json` (ver "Desvio" abaixo), cada um executado no grafo real pelo teste de contrato; nenhuma pergunta repete as dos dois golden sets (teste de vazamento).
4. **Instruções de formato**: "SOMENTE CYPHER, SEM BLOCOS DE CÓDIGO", somente leitura, alias em toda coluna, `f.page AS pagina` e `f.id AS id` para a resposta ser citável, `LIMIT` ao fim, e as regras do grafo (ano com `STARTS WITH '2025'`, porque o mesmo ano é `2025-FY` ou `2025-12-31`; filtrar pelo rótulo completo `f.metric`, não pelo `dimension` ambíguo; linhas de total fora de ranking; um só rótulo quando dois repetem o valor; diferença com um único `sum(CASE ...)`; "caiu" é anterior menos atual).

A **mensagem do usuário** leva os **12 rótulos de `f.metric` mais parecidos com a pergunta** (palavras em comum sem acento nem plural simples, as raras pesam mais) e, por último, a pergunta. É a ligação entre a pergunta e o vocabulário do grafo; o LLM escolhe, mas entre poucos.

Execução: sessão `READ`, tempo limite de 10 s no servidor (`neo4j.Query(timeout=)`; passar `timeout=` a `session.run` só criaria um parâmetro), teto de 50 linhas com `truncado`, texto do LLM reduzido à **primeira** consulta (sem cerca ```, sem prosa, `;` dentro de aspas respeitado). Falha do LLM, Cypher vazio, erro de execução e pergunta vazia voltam como `erro` (`falha_no_llm`, `sem_cypher`, `falha_na_execucao`, `pergunta_vazia`), nunca como exceção. `evidencias[]` no contrato das outras ferramentas (`tipo: "consulta"`), com a página só quando a consulta devolve a coluna `pagina`; resultado vazio é `aviso`, e resultado **sem nenhuma página** também (uma soma sobre conjunto vazio dá `0` sem fonte). LLM com temperatura 0, sem raciocínio, até 600 tokens (`chat_cypher`).

### Desvio da especificação

A §7.3 previa `api/prompts/cypher-examples.yaml`. O arquivo é **JSON** (`cypher-examples.json`): o projeto não depende de PyYAML e acrescentar a dependência só para ler uma lista de pares não se justifica. A §7.3 foi corrigida.

## Resultado

Neo4j 2026.10.1 e Qwen3.6-35B-A3B no perfil `consultar`; temperatura 0, uma rodada por conjunto (`eval/resultados/f64-*.json`; Cypher e linhas gerados ficam em `data/avaliacao/`, fora do repositório).

| Conjunto | Acertos | Acurácia |
|---|---|---|
| **`teste` (10, não vistas durante o ajuste) — o aceite** | **9 / 10** | **90%** |
| `ajuste` (5, usadas para iterar o prompt) | 4 / 5 | 80% |
| Geral (15, rodada única com o prompt final) | 13 / 15 | 86,7% |

Aceite (≥ 70%): **atendido**. Latência com o prefixo em cache: mediana 3,2 s e máximo 3,9 s por pergunta (quase tudo é geração; o banco leva 3 ms); a primeira chamada depois de trocar de perfil leva ~17 s porque processa o prefixo de ~38 mil caracteres.

Como o prompt chegou lá: seis rodadas só nas 5 perguntas de `ajuste`; o Cypher gerado para as de `teste` só foi lido depois do congelamento.

| Rodada | Mudança | `ajuste` |
|---|---|---|
| a | esquema APOC + terminologia + 8 exemplos | 0 / 5 (o modelo inventava valores de `dimension` e usava `Metric` onde o recorte está no rótulo) |
| b | + lista de rótulos de `f.metric` | 1 / 5 |
| c | exemplos reescritos para `f.metric` e `sum(CASE)`; regras de total e de sinal | 3 / 5 |
| d | + regra de total e de página | 2 / 5 |
| e | + candidatos de rótulo por pergunta, recortes por métrica, exemplo de ranking sem total | 4 / 5 |
| f | + regra de rótulos repetidos (sem efeito) | 4 / 5 — prompt congelado |

O erro do `teste` é AG02 (soma da remuneração anual de dois conselhos): o modelo escreveu um rótulo que não existe ("Valor anual de remuneração do Conselho de Administração") em vez de usar `Metric` + `dimension`, e a soma voltou 0. O erro do `ajuste` é AG04, em que o modelo soma duas vezes o mesmo valor guardado sob dois rótulos ("Empregados X" e "TOTAL DE EMPREGADOS - X").

## Alternativas consideradas

- **Medir nas 10 perguntas G01–G10**: só duas são respondíveis pelo grafo; o resultado seria 2 em 2 ou 0 em 10 dependendo da extração, e diria pouco sobre o Text2Cypher.
- **Esquema completo sem agrupar**: 23.672 caracteres só de relações entre entidades; cabia, mas empurrava os rótulos de fatos para fora do que o modelo atende.
- **Lista de rótulos sem candidatos por pergunta**: 1 de 5 no ajuste; o modelo não acha o rótulo certo entre 687.
- **Ligação por embedding** dos rótulos: não foi necessária; a sobreposição de palavras já resolveu os casos medidos. Fica como alternativa se o `teste` crescer e cair.
- **Raciocínio ligado** no Qwen: não testado; custa dezenas de segundos por pergunta e o aceite passou sem ele.

## Limites

- **n = 10 no `teste`**: um erro a mais ou a menos muda 10 pontos; o intervalo de confiança é largo (9/10 vai de ~60% a ~98%). As 15 perguntas são minhas, escritas depois de olhar o grafo, e os **exemplos *few-shot* também** (sobre assuntos diferentes das perguntas, com teste de vazamento, mas escritos por quem conhecia os rótulos). A medida diz que o Text2Cypher funciona **quando o grafo tem o dado e a pergunta cabe nos padrões vistos**, não que acerta qualquer agregação.
- **Perguntas sem dado no grafo viram números plausíveis e errados.** Rodei as 8 perguntas oficiais fora do grafo: **0 de 8 certas**; duas voltam vazias (G04, G10), uma dá erro de sintaxe (G09), G01 e G05 voltam `0` sem página (soma de nada), G08 voltou 3 (esperado 5) e G02 e G06 voltaram valores de outra métrica (G06: 64.040.172,76, p. 326, no lugar de 933.408,41). O `aviso` de "sem página" pega só os `0` com página nula. **A F6.5 e a F7.4 precisam tratar o resultado de `consultar_grafo` como hipótese**: exigir página, não aceitar agregação sobre conjunto vazio e preferir template quando existir.
- **Dívidas de extração que a medida expôs** (sem tarefa no ETAPAS): tabela de participações (p. 205) só como markdown; cor/raça × região; maior e menor remuneração individual (tabela 8.15); página 113; lucro de 2023 e 2024 do emissor.
- **O mesmo valor sob dois rótulos** ("Empregados X" e "TOTAL DE EMPREGADOS - X") dobra somas; a regra no prompt não bastou (AG04). O reparo é de dados (unificar na importação) ou de verificação (F6.5).
- **Guarda-corpos parciais**: esta etapa só garante sessão de leitura, tempo limite, teto de linhas e erros sem exceção. Cláusulas proibidas, `EXPLAIN`, `LIMIT` injetado e autocorreção são a F6.5; o especialista Gemma 3 4B é a F6.6.
- **Prompt de ~38 mil caracteres (~11 mil tokens)**: no perfil `consultar` o prefixo fica em cache entre perguntas, mas qualquer mudança no grafo (rótulos novos) o invalida; trocar de perfil custa ~17 s na primeira pergunta.
