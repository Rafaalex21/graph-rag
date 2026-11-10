# ADR-077 · Suíte E2E final: `interface` por padrão, etiquetas de fluxo, trace por projeto e `@smoke` ao vivo

- **Estado:** proposta (F8.8); passa a aceita só se os critérios C1 a C6 de `eval/f88-medida-suite.md` valerem
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

Ver `eval/f88-medida-suite.md` (seção Execuções) e `eval/resultados/f88-*.json`.

Reproduzir: `cd e2e; npx playwright test; npm run resumo`; e, com Neo4j, llama-swap e a API no ar, `npm run smoke; npm run resumo:smoke`.
