# ADR-065 · Medida do agente e do redator em perguntas novas: os dois aceites pós-hoc se sustentam pela regra fixada antes, mas a regra é fraca e a qualidade da resposta é baixa

- **Estado:** aceita (08/11/2026)
- **Data:** 2026-11-08
- **Tarefa(s):** F7.12

## Contexto

Os aceites do agente (F7.11, ADR-059) e do redator (F7.5, ADR-061) foram reescritos depois de ver os resultados no golden de 60 perguntas, e as versões v2/v3 do agente foram pensadas olhando as mesmas 55 perguntas. Esse conjunto, portanto, já não mede generalização. A F7.12 mede os dois em perguntas que nunca serviram para decidir nada.

## Decisão

- **24 perguntas novas** (`eval/golden_novas.csv`, mesmo formato do golden): 6 textuais, 6 numéricas, 3 agregações, 3 temáticas, 3 multi-hop e 3 fora do escopo, sobre fatos que o golden não cobre. Gabarito e páginas conferidos contra o PDF **antes** de qualquer execução (`validar_golden.py --novas`: 24 de 24, 0 erros).
- **Regras fixadas e commitadas antes de rodar** (commit `aaf0dda`, `eval/README.md`, seção "Grupo novo"): nenhuma mudança de prompt, régua, limiar ou pergunta depois de ver o resultado. O **agente** sustenta o aceite pós-hoc se cada page recall (@1, @3, @6) ficar **no máximo 0,10 abaixo** da referência da v3 no golden (0,4364 / 0,5697 / 0,6273; uma pergunta vale 0,048 em n = 21, então a tolerância é de duas perguntas). O **redator** sustenta o seu só se a parcela de afirmações numéricas citadas for **100%**. Informativos: acerto numérico, recusas, respostas cortadas, tempos.
- Os dois CLIs ganharam `--golden`. Com um golden diferente do padrão, o CLI do agente deixa de comparar com o baseline do Python (que só existe para as 55 perguntas do golden).

## Resultado

**Agente** (v3, `complementar` + `paginasPrimeiro`; 21 perguntas com página):

| | @1 | @3 | @6 |
|---|---|---|---|
| Golden (55), v3 | 0,4364 | 0,5697 | 0,6273 |
| **Perguntas novas (21)** | **0,6905** | **0,7619** | **0,7857** |
| Diferença | +0,25 | +0,19 | +0,16 |

**Pela regra fixada antes, o aceite pós-hoc da F7.11 se sustenta** (nenhum valor ficou abaixo da referência). Por categoria (@1): textuais 6 de 6; numéricas 4 de 6; agregações 2 de 3; temáticas 1 de 3; multi-hop 1,5 de 3 (0,5 em cada).

Execução: 24 de 24 sem exceção nem erro de infraestrutura; 1 erro de domínio (`fato_financeiro:metrica_desconhecida`, na Q08); tempo total p50 5,7 s, máx. 28,7 s (Q11, via `consultar_grafo`).

Falhas (recall 0): **Q10** (cartões) foi roteada para nenhuma ferramenta; **Q11** (pontos de atendimento) foi para `consultar_grafo` e voltou sem a página; **Q16** e **Q18** (temáticas) esperavam `panorama` e o roteador usou `buscar_trechos`. Q14 acertou só no @3 e Q19, Q20, Q21 acertaram uma das duas páginas no @1.

**Redator** (régua final de `numeros.ts`, 24 perguntas):

| | |
|---|---|
| **Afirmações numéricas citadas** | **17 de 17 = 100%** (critério: 100%); 14 respostas têm número |
| Frases sem citação / reparos / citação inventada / formato fora do pt-BR / cortadas | 0 / 0 / 0 / 0 / 0 |
| Estados | `suficiente` 6, `incompleta` 14, `sem_consulta` 4 |
| Recusas (Q22 a Q24) | 3 de 3 sem número e dizendo que não consta |
| Página citada contém a do gabarito (informativo) | 12 de 21 (golden: 31 de 55) |
| **Acerto numérico nas 10 perguntas de valor (informativo)** | **3 de 10** (golden: 7 de 21) |
| Números sem lastro na evidência citada (informativo) | 2, em Q14 e Q15 |
| **Perguntas respondíveis em que a resposta diz "não consta"/"não encontrei"** | **13 de 21** (Q04, Q05, Q06, Q09 a Q14, Q16, Q18, Q20, Q21) |
| Tempo: primeiro token do redator (p50 / máx.) | 2,3 s / 3,7 s |
| Tempo: redator inteiro (p50 / p95 / máx.) | 4,1 s / 6,8 s / 6,8 s |
| Tempo: pergunta inteira (p50 / p95 / máx.) | 23,6 s / 31,2 s / 48,5 s |

**Pela regra fixada antes, o aceite pós-hoc da F7.5 se sustenta** (100%).

## Como ler isso

- **O critério passou, mas é fraco.** A régua do redator mede se a frase com número tem citação válida; uma resposta que diz "não encontrei o percentual" não tem afirmação numérica e passa sem esforço. Aqui só 17 frases entraram na conta. A régua não diz se a resposta está certa: o acerto numérico foi **3 de 10**, e **13 das 21 perguntas respondíveis terminaram em "não consta"**, apesar de o fato estar no documento. Em proporção, é parecido com o golden (7 de 21 lá, 3 de 10 aqui): a qualidade da resposta final não generalizou melhor do que a citação.
- **O recall do agente subiu, mas não prova que o agente melhorou.** As perguntas novas parecem mais simples (um fato, uma página, vocabulário próximo ao do texto) que as do golden de 60, que inclui casos escolhidos por serem difíceis; não medi essa diferença de dificuldade. Com n = 21 e uma pergunta valendo 0,048, a diferença de +0,25 no @1 não separa "agente generaliza" de "conjunto mais fácil". O que a medida sustenta é só que **não há queda** frente ao golden.
- **Recuperar a página não basta.** No agente, Q04, Q05, Q06, Q09 e Q12 acertaram a página em todos os cortes; na execução do redator, o ciclo as deu por `incompleta` ("o percentual mínimo ... não foi encontrado nas evidências", na Q04) e o redator, corretamente com as evidências recebidas, disse que não encontrou. São duas execuções separadas (o agente do CLI de recall e o ciclo do CLI do redator), então não afirmo que a evidência era a mesma; o que fica visível é que o gargalo está entre a recuperação e o crítico/ciclo, não na citação. Não investiguei a causa.
- **Os temáticos continuam sendo o ponto fraco do roteamento:** Q16 e Q18 pedem uma lista de participações e o roteador escolheu `buscar_trechos` em vez de `panorama`.

## Consequências e limites ditos

- **n = 24 (21 com página, 10 de valor)**: uma pergunta move o @1 em 0,048 e o acerto numérico em 10 pontos percentuais. Não há intervalo de confiança, e a margem de 0,10 foi escolhida antes, de modo grosseiro de propósito.
- **Mesmo documento**, e perguntas escritas por quem conhecia o golden; não mede outro Formulário de Referência nem perguntas de usuários reais (a F9.x continua com isso).
- **Não determinismo:** a primeira execução do agente se perdeu por um defeito no CLI (`goldenPadrao` usado antes de declarado, `ReferenceError` ao montar o relatório, corrigido de lugar na mesma tarefa; nenhum resultado foi visto ou usado para decidir). Na segunda, o console mostrou uma diferença em relação à primeira (Q01: número de ferramentas e de evidências), sinal de que uma segunda rodada não repete exatamente a primeira. Os números acima são os da execução registrada; não repeti para escolher a melhor.
- **Nada foi ajustado** depois de ver o resultado. Os problemas acima (ciclo que dá `incompleta` com a página já na mão, roteamento temático, Q10 sem ferramenta) ficam como dívida, não como mudança desta tarefa.
- Saída completa por pergunta (inclui texto dos trechos e respostas) em `data/avaliacao/` (fora do git, ADR-009); no repositório só ids, números e decisões em `eval/resultados/f712-agente-novas.json` e `f712-redator-novas.json`.

## Como reproduzir

```powershell
. .\infra\dev-env.ps1
python eval\validar_golden.py --novas                     # 24 de 24 contra o PDF
powershell -File infra\neo4j.ps1 iniciar                   # e llama-swap no ar (infra\swap.ps1)
cd api
npm run avaliar:agente -- --golden eval/golden_novas.csv --nome f712-agente-novas
npm run avaliar:redator -- --golden eval/golden_novas.csv --nome f712-redator-novas
```
