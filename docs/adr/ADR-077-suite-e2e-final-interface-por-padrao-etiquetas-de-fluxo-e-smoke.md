# ADR-077 · Suíte E2E final: `interface` por padrão, etiquetas de fluxo, trace por projeto e `@smoke` ao vivo

- **Estado:** aceita (10/11/2026); os critérios C1 a C6 de `eval/f88-medida-suite.md` valeram
- **Data:** 2026-11-10
- **Tarefa(s):** F8.8

## Contexto

A interface chegou à F8.8 com 222 testes E2E escritos etapa por etapa. Faltava transformá-los numa suíte final reproduzível: um comando que dá verde, os artefatos (relatório HTML, `results.json`, traces), a prova de que os quatro fluxos do aceite (citação que abre a página certa, troca de modo que muda a rota, "não consta", erro da API) estão cobertos, e um teste curto contra a pilha real. Não se escreve teste unitário (ADR-068) e os testes existentes não são reescritos.

## Decisão

- **`npx playwright test` sem argumentos roda só o projeto `interface`** (API falsa + `ng serve`, sem Neo4j nem modelos). O `ao-vivo` só entra com `--project=ao-vivo`. O filtro fica em `playwright.config.ts`; como os processos de trabalho do Playwright recarregam a configuração com outro `argv`, a escolha é passada a eles pela variável `E2E_AO_VIVO` (a primeira tentativa do `@smoke` falhou em 0 ms justamente por isso).
- **Etiquetas de fluxo** (`{ tag: "@fluxo-citacao" | "@fluxo-modo" | "@fluxo-nao-consta" | "@fluxo-erro" }`) acrescentadas a testes que já existiam; o corpo dos testes não mudou. `--grep @fluxo-erro` roda um fluxo.
- **Trace por projeto:** `retain-on-failure` no `interface` (guardar o de 222 testes custaria centenas de megabytes por execução; `E2E_TRACE=on` liga sempre) e `on` no `ao-vivo` (cada teste chama o modelo de verdade e vale ter o rastro).
- **`@smoke`** (`tests/ao-vivo/smoke.spec.ts`): tela inicial com "Tudo funcionando", pergunta T15 com selo de resposta, primeiro cartão de fonte abrindo a página citada com o PDF desenhado, e F01 voltando como "Não consta no documento". Confere selo e página, não o texto do modelo (variância).
- **Resumo reproduzível** (`e2e/resumo-da-suite.ts`, `npm run resumo` e `npm run resumo:smoke`): lê `test-results/results.json` e grava `eval/resultados/f88-*.json` com totais, por projeto, por etiqueta e contagem de traces; sem texto do documento (ADR-009). Sai com erro em falha, flaky ou etiqueta com menos de 2 testes passando.

## Alternativas consideradas

- **Um projeto `smoke` separado na configuração:** mais uma entrada para manter; `--project=ao-vivo --grep @smoke` já faz o mesmo.
- **Trace sempre no `interface`:** prova mais, mas pesa e deixa a execução lenta sem ganho quando tudo passa.
- **Etiquetar pelo título (`--grep` em texto):** frágil a renomeações; etiqueta é explícita e o resumo a lê do `results.json`.

## Consequências

- Cada execução do Playwright sobrescreve `test-results/`: o resumo precisa ser gerado antes da próxima execução.
- A suíte `interface` não exercita o agente, o grafo nem a guarda do Text2Cypher (API falsa); isso segue nas medidas `ao-vivo` de cada etapa.
- O `@smoke` depende do modelo local e chama-o de verdade (custo de ~minutos por execução).

## Evidência

Medida pré-registrada em `eval/f88-medida-suite.md` (com a errata 1 do passo 3 do `@smoke`) e resultados em `eval/resultados/f88-*.json`:

- **C1** `npx playwright test`: 222 de 222 e, com `--repeat-each=2`, 444 de 444; 0 falha, 0 flaky (67 s e 128 s).
- **C2/C3** relatório HTML e `results.json`; fluxos com 4, 3, 3 e 4 testes passando.
- **C4** `@smoke` ao vivo: 4 execuções, 3 falhas por defeito meu (configuração dos processos de trabalho, seletor do selo, F01 que é saudação) e a 4ª passou, com `trace.zip`.
- **C5** os resumos batem com o `results.json`. **C6** CI verde no commit 34bba39.

Limites: o `@smoke` não exercita o selo "Não consta no documento"; n = 1 teste `@smoke` e uma execução aprovada; a suíte `interface` usa a API falsa.

Reproduzir: `cd e2e; npx playwright test; npm run resumo`; e, com Neo4j, llama-swap e a API no ar, `npm run smoke; npm run resumo:smoke`.
