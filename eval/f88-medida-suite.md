# F8.8: medida da suíte E2E final (definição fixada ANTES de rodar)

Aceite da etapa: "`npx playwright test` verde e gera `playwright-report/`, `test-results/results.json` e traces; cobre chat com citação que abre a página certa, troca de modo que muda a rota no Rastro, resposta 'não consta' e erro da API; um teste `@smoke` roda contra a pilha local real".

A interface já tem 222 testes E2E, escritos etapa por etapa (F8.1 a F8.10, sempre antes do código). Esta etapa **não reescreve esses testes**: ela consolida, torna a suíte reproduzível e prova os quatro fluxos e o `@smoke` por critério mecânico. Nenhum teste unitário é escrito (ADR-068).

## O que muda

1. **`npx playwright test`, sem argumentos, roda só o projeto `interface`** (a API falsa e o `ng serve`; não precisa de Neo4j nem de modelos), que é o que passa a ser a suíte "verde". O projeto `ao-vivo` só roda se pedido (`--project=ao-vivo`), como já era para os testes de medida.
2. **Quatro fluxos exigidos pelo aceite recebem uma etiqueta** nos testes que já os cobrem (só se acrescenta `{ tag }` ao teste; o corpo não muda): `@fluxo-citacao` (a citação abre a página certa), `@fluxo-modo` (trocar o modo muda a rota no Rastro), `@fluxo-nao-consta` (resposta "não consta") e `@fluxo-erro` (erro da API).
3. **`@smoke` contra a pilha real:** `tests/ao-vivo/smoke.spec.ts`, rodado com `npx playwright test --project=ao-vivo --grep @smoke`: abre a tela inicial, confere "Tudo funcionando", faz uma pergunta real do golden (T15), espera a resposta com um selo de estado de resposta, abre o primeiro cartão de fonte e confere que o painel mostra a **página citada** com a página desenhada (canvas), e faz uma pergunta que o documento não responde (F01) e confere o selo "Não consta no documento". Esse projeto grava o trace de todo teste (`trace: "on"`).
4. **Resumo reproduzível:** `e2e/resumo-da-suite.ts` (`npm run resumo`) lê `test-results/results.json` e grava `eval/resultados/f88-suite.json` com: total, passaram, falharam, flaky, pulados, duração, contagem por projeto e por etiqueta de fluxo, e os arquivos de trace encontrados. Sai com erro se houver falha, flaky ou se alguma etiqueta de fluxo tiver zero teste passando. O resumo **não contém texto do documento** (ADR-009).

## Critérios (todos precisam valer)

- **C1.** `npx playwright test` (a partir de `e2e/`, sem argumentos) termina com **código 0**, com **todos os testes passando, 0 falhas e 0 flaky**, em duas execuções seguidas (`--repeat-each=2` na segunda).
- **C2.** Depois da execução existem `e2e/playwright-report/index.html` e `e2e/test-results/results.json` válido.
- **C3.** Cada etiqueta `@fluxo-citacao`, `@fluxo-modo`, `@fluxo-nao-consta` e `@fluxo-erro` tem **pelo menos 2 testes** passando no `results.json`.
- **C4.** `npx playwright test --project=ao-vivo --grep @smoke` contra Neo4j, llama-swap e a API reais termina com código 0, o teste `@smoke` aparece como passou no `results.json`, e o `trace.zip` dele existe.
- **C5.** O `eval/resultados/f88-suite.json` gerado por `npm run resumo` bate com o `results.json` (mesmos totais).
- **C6.** O CI continua verde com o comando que ele já roda (`npm test`, que é o projeto `interface`).

## Regra de aceite (fixada agora)

Cumprida só se **C1 a C6** valem. A regra não muda depois de rodar; se algum critério falhar, a F8.8 continua `[~]` e o resultado é registrado como saiu. Toda execução ao vivo é contada (o `@smoke` chama o modelo de verdade: as execuções ficam no relatório). Não há aceite pós-hoc de algo que falhou.

## Limites já sabidos

- A suíte `interface` usa a API falsa (contrato SSE, ADR-068): agente, grafo e guarda do Text2Cypher só são exercitados nos testes `ao-vivo`, e o `@smoke` é um caminho feliz mais um "não consta" e não substitui as medidas de aceite das etapas anteriores.
- O `@smoke` depende do modelo local, que tem variância; ele confere a presença de um selo de resposta e a página citada, não o conteúdo do texto.
- O trace de testes que passam só é gravado onde a configuração manda: sempre no projeto `ao-vivo`; no `interface`, `retain-on-failure` (para não gravar centenas de megabytes por execução), ou sempre, com `E2E_TRACE=on`.
- A poda dos testes unitários do indexador (Python) segue como decisão à parte, só com confirmação do dono.

## Errata 1 (10/11/2026, escrita ANTES de rodar o `@smoke` de novo; o texto acima fica como foi fixado)

O item 3 de "O que muda" diz que a pergunta F01 do golden volta com o selo "Não consta no documento". **Isso estava errado**: o F01 é a saudação "Olá, tudo bem?" (`sem_consulta`, sem selo; já registrado na F8.9, `eval/resultados/f89-assistente.json`), e F02 a F05 (fora do escopo) também saem como `sem_consulta` nas medidas anteriores (F7.5, F7.11). Nenhuma pergunta do golden foi medida com o selo "Não consta no documento" ao vivo. O erro foi meu, achado na 3ª tentativa do `@smoke` (a tela mostrou a saudação, sem selo), e não é falha do sistema.

Correção do passo 3 do `@smoke`: em vez de F01, a pergunta **F02** ("Qual foi o lucro líquido do Itaú Unibanco em 2025?", fora do documento, rota esperada `nenhuma`, já usada nas medidas F7.x) e a conferência passa a ser: a resposta termina sem erro, **sem nenhum selo de "encontrado"** (nem "Encontrado no documento" nem "Encontrei só em parte"), e o estado da conversa é "Resposta pronta.". O selo "Não consta no documento" continua provado pelos 3 testes `@fluxo-nao-consta` da suíte `interface` (API falsa) e, ao vivo, pelo pedido sem dado da F8.10 (D5); o `@smoke` não o exercita, e isso é um limite declarado. **Os critérios C1 a C6 não mudam.** As tentativas anteriores ficam contadas em "Execuções".

## Reprodução

```powershell
cd e2e
npm ci
npx playwright test                       # interface: verde, relatório e results.json
npm run resumo                            # grava eval/resultados/f88-suite.json
# com Neo4j, llama-swap e a API no ar:
npx playwright test --project=ao-vivo --grep @smoke
```

## Execuções (preenchido depois de rodar; toda execução é contada)

Todas as execuções desta etapa, na ordem em que aconteceram (o `results.json` é sobrescrito a cada execução; os resumos estão em `eval/resultados/f88-*.json`).

**Suíte `interface`** (`npx playwright test`, sem argumentos):

| # | Comando | Resultado | Duração |
|---|---|---|---|
| 1 | `npx playwright test` (config anterior à correção de `E2E_AO_VIVO`) | 222 de 222 passaram, 0 falha, 0 flaky | ~1 min |
| 2 | `npx playwright test --repeat-each=2` (mesma config) | 444 de 444, 0 falha, 0 flaky, `resumo` ok (o resumo foi sobrescrito pela execução 4) | 133 s |
| 3 | `npx playwright test` com a **configuração final** (depois de `E2E_AO_VIVO` e de acertar o smoke) | **222 de 222**, 0 falha, 0 flaky, saída 0 | 67 s |
| 4 | `npx playwright test --repeat-each=2` com a configuração final | **444 de 444**, 0 falha, 0 flaky, saída 0 | 128 s |

As execuções 1 e 2 valeram para o desenvolvimento; as de aceite são a 3 e a 4, com o código que foi commitado (a configuração mudou entre 2 e 3). `eval/resultados/f88-suite.json` resume a execução 3 e `f88-suite-repeticao.json` a execução 4 (que é a última do `results.json`: 444 esperados, 0 inesperados, 0 flaky, 0 pulados).

**`@smoke` ao vivo** (`npx playwright test --project=ao-vivo --grep @smoke`, Neo4j, llama-swap e API reais, `/api/saude` "ok" antes):

| # | Resultado | Causa |
|---|---|---|
| S1 | falhou em 0 ms: "Project ao-vivo not found in the worker process" | **bug da configuração:** os processos de trabalho recarregam a config com outro `argv`; corrigido passando a escolha por `E2E_AO_VIVO`. Nenhuma chamada ao modelo |
| S2 | falhou no passo 1 (~30 s) | **bug do meu teste:** a regex `^…$` do selo não casou, embora a tela mostrasse "Encontrado no documento"; usei `getByText(selo, { exact: true })` como os outros testes |
| S3 | falhou no passo 3 (~24 s), depois de passar os passos 1 e 2 | **medida errada:** o F01 é uma saudação, sem selo (errata 1, commit 96fc4fd, escrita antes da rodada seguinte) |
| S4 | **passou** (1 de 1, 11,4 s no teste, 18 s no total), saída 0 | `trace.zip` gravado (1 arquivo) |

Foram 4 execuções ao vivo do `@smoke`: 3 falhas por bugs meus (configuração, seletor, premissa da medida) e 1 aprovação; nenhuma falha foi do sistema. O corpo do teste mudou entre S3 e S4 por causa da errata; os critérios não.

## Resultado por critério

- **C1** cumprido: execuções 3 e 4 (222 e 444, 0 falhas, 0 flaky, saída 0).
- **C2** cumprido: `e2e/playwright-report/index.html` e `e2e/test-results/results.json` existem depois das execuções.
- **C3** cumprido: `@fluxo-citacao` 4, `@fluxo-modo` 3, `@fluxo-nao-consta` 3, `@fluxo-erro` 4 testes passando (execução 3; o dobro na 4).
- **C4** cumprido: S4 passou, `trace.zip` existe, `f88-smoke.json` ok com 1 `@smoke` passando e 1 trace.
- **C5** cumprido: `f88-suite.json` (222/222) e `f88-suite-repeticao.json` (444/444) saem do `resumo` e batem com o `results.json` de cada execução; conferido por script contra o `results.json` da execução 4 (444 esperados).
- **C6**: ver a linha abaixo (CI por sha).

**Limite novo:** o `@smoke` não exercita o selo "Não consta no documento" (ver errata 1); o fluxo "não consta" tem 3 testes na suíte `interface` (API falsa) e, ao vivo, o pedido sem dado da F8.10 (D5).
