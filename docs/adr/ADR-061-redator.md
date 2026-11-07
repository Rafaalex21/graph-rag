# ADR-061 · Redator: toda frase com número cita uma evidência que existe, mas a 1ª medida deu 93,75% (45 de 48), abaixo dos 100% do aceite; os 3 casos eram defeitos da régua e a reavaliação pós-hoc dá 100%

- **Estado:** proposta (07/11/2026): o aceite de 100% só vale com a régua corrigida depois de medir, e quem decide se isso basta é o dono do projeto
- **Data:** 2026-11-07
- **Tarefa(s):** F7.5

## Contexto

O aceite da F7.5 é "100% das afirmações numéricas citadas no golden set". A §7.1 da arquitetura descreve o redator como o passo que responde em português, cita por `id` (a API converte em página), formata números em pt-BR com escala explícita e diz que a informação não consta quando for o caso, sem recorrer a conhecimento próprio. O ciclo da F7.4 ([ADR-060](ADR-060-critico.md)) entrega as evidências, o estado (`suficiente`, `incompleta`, `ausente`, `sem_consulta`) e `faltando`.

## Decisão

- **`api/src/agente/redator.ts`**, função `redigir(llm, entrada, { signal, progresso })`:
  - as evidências vão ao modelo numeradas `[E1]…[E10]` com a página; o modelo cita por `[E#]` e **não escreve página**: o sistema troca o marcador pela página da evidência (`textoComPaginas`, `citacoes`). Marcador que não existe sai do texto e fica registrado;
  - as respostas **sem o LLM**: `ausente` ("Essa informação não consta no Formulário de Referência." + o que o crítico disse), e `suficiente`/`incompleta` sem nenhuma evidência ("Não encontrei no documento informações…"). O texto da rota `nenhuma` do roteador nunca vira resposta (ADR-054);
  - `sem_consulta` chama o LLM **sem** evidências, com a ordem de só cumprimentar ou dizer que o assunto está fora do documento;
  - `incompleta` manda dizer "Não encontrei nos trechos consultados…", não "não consta no documento": a busca pode ter falhado e o crítico o diz (achado no ajuste, abaixo);
  - a resposta sai em fluxo (primeiro token ao chamador na hora) e é **verificada**: toda frase com número precisa de ao menos um `[E#]` que existe; se alguma não tem, **um** reparo (nunca mais) com a lista das frases, dos identificadores inexistentes e dos números fora do pt-BR. O que sobrar fica em `verificacao.sem_citacao` e no texto, nunca é apagado em silêncio. Números que a evidência citada não traz ficam em `numeros_sem_lastro` (registro, não erro: somar e converter são legítimos);
  - nunca derruba a pergunta: se o LLM cai, há texto fixo de falha ou o parcial marcado como cortado; só o cancelamento do chamador sobe;
  - temperatura 0,2 e 700 tokens (como o redator do Python), e não os 0,7 da tabela de amostragem da §8: a fidelidade ao número pesa mais que a variação.
- **`api/src/agente/numeros.ts`**: a régua. Número pt-BR (`1.234,56`), escala escrita (mil, milhão, bilhão, trilhão) e os números por extenso de dois a dez; ficam de fora ano solto, parte de data, numeração de lista, o número do marcador, "um/uma" e os por extenso acima de dez (limite dito). `dividirAfirmacoes` separa por linha e por frase, sem quebrar em `1.234`, `S.A.`, `p. 12`, `Val.`, `Ltda.` ou antes de minúscula, e leva o marcador depois do ponto para a frase do número. `acertoNumerico` porta o do Python (0,5%, escala escrita contra a unidade do gabarito).

Medida: `npm run avaliar:redator` (`api/src/avaliacao/cli-redator.ts`), o ciclo inteiro (atualizador, roteador, executor, crítico) mais o redator nas 60 perguntas, com as definições fixadas no cabeçalho antes de rodar o golden. O prompt foi escrito e verificado só com as 16 perguntas de ajuste fora do golden (`eval/critico_ajuste.json`).

## Resultado

**Medida original** (golden, 60 perguntas, Neo4j e llama-swap reais, `eval/resultados/f75-redator.json`):

| | |
|---|---|
| **Afirmações numéricas citadas** | **45 de 48 = 93,75%** (aceite: 100%); 34 respostas têm número |
| Frases sem citação que sobraram | 3, em N09 (1) e G01 (2) |
| Respostas que precisaram do reparo | 4 (T05, N09, G01, P01); antes do reparo havia 5 frases sem citação e 0 identificadores inventados |
| Formato fora do pt-BR / citação inventada / respostas cortadas | 0 / 0 / 0 |
| Erro de infraestrutura | 0 em 60 |
| Estados | `suficiente` 28, `incompleta` 27, `sem_consulta` 5 |
| Recusas F01–F05 | 5 de 5 sem número; 4 dizem que está fora do documento; a F01 é saudação e foi respondida cordialmente |
| Página citada contém a do gabarito (informativo) | 31 de 55 |
| Acerto numérico nas 21 perguntas de valor (informativo) | 7 de 21; as 7 que o crítico deu por `suficiente` com valor: 6 acertos; as 14 `incompleta`: 1 acerto |
| Números sem lastro na evidência citada (informativo) | 4, em N09, G02 e P06 |
| Tempo: primeiro token do redator (p50 / máx.) | 2,4 s / 3,7 s |
| Tempo: redator inteiro (p50 / p95 / máx.) | 4,6 s / 14,5 s / 20,5 s |
| Tempo: pergunta inteira (p50 / p95 / máx.) | 22,2 s / 120,9 s / 197,7 s |

**Os 3 casos que reprovaram eram defeitos da régua, não do modelo.**
- G01: a frase "...e BB Gestão de Recursos - Distribuidora de Títulos e Val. Mobiliários S.A. [E8]" foi cortada em "Val." e a primeira metade, sem o marcador, apareceu como sem citação. Defeito do divisor (siglas `Val.`, `Ltda.`, `Cia.` não estavam na lista) e provocou um reparo desnecessário.
- G01 e N09: a frase "Não encontrei nos trechos consultados a lista ... com 100% de participação" e "Não encontrei … o total de 85,2 mil funcionários" repetem um número da pergunta ou de uma frase já citada. O reparo cobrava citação de uma frase que não afirma nada.

Correções (feitas **depois** de ver a medida, nos testes antes do código): as siglas no divisor, e a regra "frase que abre declarando ausência e só repete número da pergunta ou de outra frase citada não é afirmação" (`declaracaoDeAusencia`; um número novo na mesma frase continua exigindo citação, com teste). **Reavaliação pós-hoc** dos mesmos 60 textos finais com a régua corrigida (`npm run avaliar:redator -- --reavaliar f75-redator`, `eval/resultados/f75-redator-reavaliado.json`): **46 afirmações, 0 sem citação = 100%**, 2 declarações de ausência fora da conta (N09, G01). O resultado original, com 93,75%, fica no repositório.

Ajuste (16 perguntas fora do golden, `f75-redator-ajuste*.json`): a 1ª passada mostrou que, em `incompleta`, o modelo escrevia "Essa informação não consta no documento" para o que o crítico dizia ser falha de busca (R01 e R05, o dado está na página 405 e o número de agências existe). O prompt passou a mandar "Não encontrei nos trechos consultados"; as três (R01, R02, R05) saíram corretas na repetição. A repetição das 16 com o código final está em `f75-redator-ajuste-c.json`.

## Consequências

- **O aceite de 100% só está atendido pós-hoc.** A régua mudou depois de ver o resultado, no mesmo golden; o certo é dizer "93,75% na medida original, 100% com a régua corrigida sobre os mesmos textos", e não se recomenda confiar nos 100% como medida independente. Não foi rodado grupo novo de perguntas com a régua final, só as 16 do ajuste (poucas com número).
- **"Citada" não é "correta".** A régua mede se a frase tem citação válida; o lastro (`numeros_sem_lastro`: 4) e o acerto numérico olham outro lado, e nenhum substitui ler as respostas. O lastro só vê números da frase na evidência citada; ele apontou G02 (`66,39` e `76,4`, citados como percentuais "listados"), N09 e P06 (`dois`); não investiguei se são falsos positivos (evidência cortada em 900 caracteres, outra grafia) ou números sem base.
- **O gargalo da resposta é o ciclo, não o redator.** O redator tem primeiro token em 2,4 s (p50) e termina em 4,6 s; a pergunta inteira tem p50 de 22,2 s e máximo de 197,7 s, quase todo do ciclo (crítico e rodada extra, ADR-060; o `panorama` reexecutado nas P03, P05 e P06). Isso fica fora do RNF-2 (20 s) para perguntas simples; o modo rápido do ADR-060 (rodada 1 e crítico só para dizer o que falta) continua em aberto e é a decisão de produto para a F7.6.
- **A qualidade da resposta é a do recuperador.** 27 das 55 respondíveis terminam `incompleta` e o redator, corretamente, diz que não encontrou; 26 das 55 respostas dizem "não encontrei/não consta" (pela expressão regular da medida; algumas trazem parte da resposta). Não li as 60 respostas uma a uma para procurar afirmação sem base; só as de número e o lastro foram checados por regra. Das 21 perguntas de valor, só 7 foram respondidas certo. Isso não é defeito do redator: com `suficiente` o valor saiu certo 6 vezes em 7. O número de `incompleta` é o do ADR-060 (o crítico é conservador e o recuperador fraco).
- **Lacunas da régua, ditas:** por extenso só de dois a dez, "um/uma" fora; o ano solto não conta (um ano errado passa); frase sem número não exige citação (afirmação textual sem fonte não é medida aqui).
- **`sem_consulta` ainda é o LLM sem evidências.** No ajuste, A01 (previsão financeira de outra companhia) recebeu "não tenho acesso a informações financeiras futuras… meu último treinamento", sem fato nem número, mas fora do tom pedido. No golden as 5 saíram dentro do pedido.
- **Perguntas dependentes de histórico** (a F7.6 passa `historico`) estão no código e nos testes, não nesta medida.

## Como reproduzir

```powershell
.\infra\neo4j.ps1 iniciar
.\infra\swap.ps1                                   # em outro terminal
cd api
npx vitest run test/agente/numeros.test.ts test/agente/redator.test.ts   # sem banco nem LLM
npm run avaliar:redator -- --ajuste                # 16 perguntas fora do golden
npm run avaliar:redator                            # as 60 do golden, ~50 min
npm run avaliar:redator -- --reavaliar f75-redator # só a verificação, sobre os textos já gravados (precisa de data/avaliacao/)
```

Os relatórios versionados (`eval/resultados/f75-redator.json`, `f75-redator-reavaliado.json`, `f75-redator-ajuste.json`, `f75-redator-ajuste-b.json`, `f75-redator-ajuste-c.json`) têm ids, contagens e tempos; os textos das respostas ficam em `data/avaliacao/<nome>-detalhes.json`, fora do repositório (ADR-009).
