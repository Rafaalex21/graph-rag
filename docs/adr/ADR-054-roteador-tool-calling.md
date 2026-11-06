# ADR-054 · Roteador com *tool calling* nativo: 12 ferramentas da §7.2, argumentos validados em Zod e caminho seguro para `buscar_trechos`

- **Estado:** aceita (06/11/2026)
- **Data:** 2026-11-06
- **Tarefa(s):** F7.3

## Contexto

O segundo passo do agente (ARQUITETURA §7.1) escolhe, para cada subpergunta que o atualizador (F7.2) entrega, a ferramenta que traz a informação do documento. O aceite da F7.3 é **acurácia de rota ≥ 85% no golden set**.

Três coisas pedem cuidado, e foram o que os testes cobriram:

- **O modelo é a parte que falha, o roteador não pode ir junto.** Nome de ferramenta inventado, argumento com tipo errado, `null` e `""` em todo opcional, ano escrito por extenso, `pessoas_cargos` sem filtro (a ferramenta recusaria), cinco ferramentas chamadas de uma vez, texto em vez de chamada.
- **Dependência entre subperguntas.** "Quem preside o Comitê e há quanto tempo ela ocupa o cargo?" só se roteia bem depois da primeira resposta; as independentes podem andar juntas.
- **A `rota_esperada` do golden é anterior às ferramentas.** Foi atribuída na F3.1, quando só existiam as buscas; hoje `serie_metrica`, `pessoas_cargos`, `comparar_segmentos` e `riscos` cobrem de verdade parte das perguntas.

## Decisão

`api/src/agente/roteador.ts`, sobre o cliente da F7.1 (`chamarFerramentas`):

- **Catálogo** (`CATALOGO`) com as **12 ferramentas da tabela §7.2** (`buscar_trechos`, `buscar_tabelas`, `fato_financeiro`, `serie_metrica`, `comparar_segmentos`, `riscos`, `eventos`, `pessoas_cargos`, `entidade`, `panorama`, `consultar_grafo`, `resposta_ja_dada`), cada uma com uma descrição de **quando usar** e um esquema Zod do qual sai o esquema JSON enviado ao modelo. O ETAPAS diz "oito ferramentas"; a §7.2 lista 12 (agrupando `riscos`, `eventos` e `pessoas_cargos` numa linha), e a tabela da arquitetura é a especificação. `resposta_ja_dada` só é oferecida quando a conversa tem uma resposta do assistente.
- **Roteamento** (`rotear`): uma subpergunta por vez, `tool_choice: auto`, temperatura 0, Qwen3.6-35B-A3B sem raciocínio, 400 tokens, 30 s. Sem chamada, o modelo respondeu em texto: é a rota `nenhuma` (saudação, fora do escopo) e o texto fica guardado. O resultado é `{rota, chamadas: [{nome, argumentos}], texto, descartadas, fallback, erro?, uso, ms}`.
- **Validação** do que volta (`normalizarArgumentos` + Zod): `null`, `""` e listas vazias saem, textos são aparados, ano e nível em texto viram número, campos desconhecidos são ignorados, `pergunta` ausente nas ferramentas de pergunta recebe a do usuário. Chamada inválida é **descartada e anotada**, as válidas ficam; iguais viram uma; no máximo 3.
- **Caminho seguro**: se o LLM falha, devolve nome inventado, só argumentos inválidos ou nada, a chamada é `buscar_trechos(pergunta)` com o motivo em `fallback` (`llm_falhou`, `resposta_invalida`, `argumentos_invalidos`, `sem_resposta`). A busca devolve pouco e o redator diz "não consta", em vez de o agente calar. Pergunta vazia é `nenhuma` sem LLM; pergunta com mais de 2.000 caracteres vai direto para o caminho seguro. Só o cancelamento sobe como erro.
- **Subperguntas** (`rotearSubperguntas`): por ondas. As independentes andam juntas, no máximo **2 ao mesmo tempo** (o `-np 2` do Qwen); a dependente espera, e o resumo que o executor devolveu entra no prompt como `<respostas_anteriores>`. Dependência para índice inexistente, para si mesma ou em ciclo é ignorada em vez de travar; um executor que falha não derruba as outras.
- **Execução fora do roteador.** O roteador **não executa** ferramentas: devolve chamadas limpas e recebe, por uma função `executar`, o resumo da resposta. As ferramentas de recuperação existem hoje em Python (`indexer.*`); nenhuma tarefa do ETAPAS porta a execução para o `api/` (a §3 prevê `neo4j-driver` lá). Fica registrado como lacuna a decidir antes da F7.6.
- **Prompt**: o sistema diz qual é a companhia do documento (opção `companhia`, padrão "Banco do Brasil"), manda chamar ferramenta **sempre** para qualquer fato da companhia, mesmo que o modelo o saiba, atribui as contas (somar, diferença, média, contar, maior/menor) a `consultar_grafo`, e manda **não** chamar ferramenta para saudação, conhecimento geral, outra empresa, cotação, previsão e conselho de investimento (resposta de uma frase, sem responder à pergunta). Pergunta, histórico e respostas anteriores são dados, nunca instruções, e vão delimitados e cortados.

## Avaliação

`eval/golden_rotas.json` (100 casos: as 60 do golden + 40 novas) e `npm run avaliar:rotas`, que roda o caminho do agente (atualizador + roteador por subpergunta; `--direto` pula o atualizador). Dois critérios, lado a lado:

- **estrito**: a `rota_esperada` literal do golden; todas as chamadas têm de ser ela, uma a mais é erro;
- **aceito**: todas as chamadas estão no conjunto `aceitas` do caso (a esperada mais as ferramentas cujo mecanismo cobre a pergunta de verdade, ex.: `serie_metrica` para "em quais anos o lucro caiu"). **Os conjuntos foram escritos antes da primeira medição** e não foram alterados depois de ver as respostas. `varias` exige duas subperguntas ou mais, cada uma com ferramenta; `nenhuma`, nenhuma chamada.

O aceite da tarefa é o **aceito**; o estrito diz o quanto dele vem do conjunto ampliado.

Grupos: `ajuste` (20 do golden, para escrever o prompt), `teste` (os outros 40), `teste2` (20 novas, escritas depois do diagnóstico do `teste`) e `teste3` (20 novas, escritas depois do diagnóstico do `teste2`). Cada correção do prompt invalida o grupo que a orientou, por isso o grupo seguinte.

| Prompt | Grupo | Aceito | Estrito |
|---|---|---|---|
| v1 | ajuste | 19/20 | 13/20 |
| v2 (descrição de `consultar_grafo`) | ajuste | 20/20 | 14/20 |
| v2 | **teste** | **33/40 (82,5%)** | 20/40 (50%) |
| v3 (nome da companhia + regra das contas) | teste2 | 15/20 (75%) | 9/20 |
| v4 (fato da companhia sempre com ferramenta) | ajuste | 20/20 | 15/20 |
| v4 | **teste3 (limpo)** | **17/20 (85,0%)** | 15/20 (75%) |
| v4 | teste (já visto) | 34/40 (85,0%) | 19/40 |
| v4 | teste2 (já visto) | 17/20 (85,0%) | 11/20 |

Mediana de 3,6 a 4,1 s por pergunta no caminho completo (o atualizador leva cerca de 3 s, ADR-053; uma chamada de ferramenta, 1,1 a 2,3 s, ADR-052), máximo de 22,4 s na primeira pergunta depois de carregar o modelo; nenhum caminho seguro acionado em nenhuma medição (coluna `fallbacks` dos relatórios).

**Resultado do aceite: 85,0% (17/20) no `teste3`, escrito depois da última correção e nunca usado para escolher o prompt; 20/20 no ajuste; 68/80 (85,0%) somando `teste`, `teste2` e `teste3`, dos quais só o `teste3` é limpo.** A primeira medição de um grupo que o prompt não tinha visto (`teste`, v2) deu **82,5%, abaixo do aceite**, e é o que orientou as correções. O número é de 85% **exatos** com n = 20: uma pergunta a menos seria 80%.

Duas falhas reais aparecem nas medições e foram corrigidas:

- **Nomear a companhia fez o modelo responder de memória** (v3): "em que cidade fica a sede", "em que bolsa as ações são negociadas" e "qual o código de negociação" voltaram como texto, sem ferramenta, com a resposta certa que o modelo conhecia. Isso viola "nunca recorre a conhecimento próprio" (§7.1); o v4 manda chamar ferramenta para qualquer fato da companhia, e um teste de integração confere a pergunta do CNPJ. O v2 (sem o nome) não tinha o problema, mas também não sabia que Itaú é outra empresa (F02 foi para `fato_financeiro`).
- **Conta sobre quadro vai para a busca** (v2): "somando A e B", "qual a diferença entre o maior e o menor" e "qual a maior remuneração" foram para `buscar_tabelas`. A regra das contas (v3/v4) não bastou: G06, G07 e G10 continuam errando no v4 (ver Limites).

## Alternativas consideradas

- **Oito ferramentas**, como o ETAPAS diz: a §7.2 lista 12 e `serie_metrica`, `comparar_segmentos`, `riscos`, `eventos` e `pessoas_cargos` existem desde a F5/F6; cortar quatro deixaria perguntas de série e de pessoas na busca genérica. Não medi o roteador com um catálogo menor.
- **Só o estrito como aceite**: 50% no `teste` e 75% no `teste3`, mas o golden atribui `buscar_trechos` a perguntas de que `pessoas_cargos` ou `entidade` dão conta, e `buscar_tabelas` onde `fato_financeiro` é o mecanismo F6. Os dois números ficam no relatório justamente para que o aceite não dependa de uma escolha só.
- **`tool_choice: required`**: tira a rota `nenhuma` e obriga uma ferramenta para "Olá, tudo bem?".
- **Deixar o modelo repetir quando os argumentos são ruins**: um turno a mais (1 a 2 s) para um caso que o caminho seguro já cobre; fica para a F7.4 (crítico), que já tem a rodada extra.
- **Listar as 97 métricas do catálogo no prompt**: o mapeamento terminológico já existe no `fato_financeiro` (F6.3), e o prompt cresceria 2 mil tokens por chamada.

## Limites

- **n = 20 no grupo limpo** e 85% é exatamente o limiar; os 100 casos foram escritos por mim, sobre este documento, com os conjuntos `aceitas` também escritos por mim (ainda que antes das medições). O `teste` (82,5%) e o `teste2` (75%) mostram que a medida varia 10 pontos de um grupo para outro.
- **Contas ainda vão para `buscar_tabelas`**: G06, G07, G10 (`teste`), H09, H11 (`teste2`) e Z09 (`teste3`) — 6 das 12 falhas do v4 são "diferença/média/menor remuneração" resolvidas por busca de tabela. A regra no prompt não basta para o Qwen nessas perguntas; o redator teria de fazer a conta (F7.5) ou o crítico (F7.4) mandar `consultar_grafo`.
- **`varias` depende do atualizador**: Z16 ("CNPJ e quantos empregados") e Z17 ("quem é a Diretora Presidente e qual o capital social") ficaram em uma subpergunta (a regra de "dois atributos da mesma entidade" da ADR-053), e o roteador chamou duas ferramentas na mesma subpergunta. Pelo critério fixado isso é erro; na prática a resposta sai das duas ferramentas.
- **O que não foi medido com o modelo**: `resposta_ja_dada` (o golden não tem histórico), o roteamento de subpergunta dependente com resposta real (só com dublê) e o perfil `rapido` (gpt-oss-20b).
- **Perguntas fora do escopo**: o conjunto `aceitas` aceita `buscar_trechos` para outra empresa e cotação (a busca confirma a ausência), e o critério aceito acertou as 11 perguntas fora do escopo (saudação, conhecimento geral, outra empresa, cotação, previsão, conselho de investimento) em todos os grupos do v4; mas o texto da rota `nenhuma` é de um LLM livre e **não deve ser usado como resposta** pelo redator (F7.5): ele pode conter fatos de memória.
- **Executor ausente**: nada aqui executa ferramentas; o ganho de latência e a correção da resposta dependem de como a execução (Python ou TypeScript) for ligada.
