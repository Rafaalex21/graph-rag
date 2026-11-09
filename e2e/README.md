# Testes E2E (Playwright)

Não há testes unitários neste repositório (ADR-068). Os testes são E2E: um navegador de verdade usa a interface e, quando precisa, o HTTP da API é chamado de fora, como um cliente faria.

| Projeto | O que roda | Precisa de | CI |
|---|---|---|---|
| `interface` | O navegador contra o `ng serve` (com o proxy `/api` real) e uma API falsa (`api-falsa/servidor.ts`) que fala o contrato SSE | Node | sim |
| `ao-vivo` | O navegador e o HTTP contra a pilha real: Neo4j, llama-swap e a API em `127.0.0.1:3000` | Neo4j, llama-swap, API no ar e os modelos | não |

## Rodar

Com o Node do projeto (`. .\infra\dev-env.ps1`), dentro de `e2e/`:

```bash
npm ci
npm test                  # projeto interface (sobe a API falsa e o ng serve sozinho)
npm run test:ao-vivo      # projeto ao-vivo (suba antes Neo4j, llama-swap e a API)
npm run relatorio         # abre o relatório HTML da última execução
```

Sem `CI`, o Playwright usa o **Edge** que já vem no Windows (nada a baixar). No CI usa o Chromium do Playwright (`npx playwright install --with-deps chromium`).

## Artefatos

`playwright-report/` (HTML), `test-results/results.json`, e em cada falha o `trace.zip` (`npx playwright show-trace <trace.zip>`) e a captura de tela. O vídeo está desligado de propósito: pede baixar o ffmpeg do Playwright.

O `ao-vivo/primeiro-token.spec.ts` grava ainda `eval/resultados/f82-primeiro-token.json` (só ids e tempos, ADR-009).

## O que cada arquivo prova

- `tests/interface/chat.spec.ts`: enviar (teclado, botão, limites), a resposta aos poucos pelo proxy, chips de citação e navegação para a aba Fontes, markdown, HTML hostil que não vira elemento, erros (429, 502 com HTML, evento `erro`, fluxo sem `fim`), Parar, histórico e nova conversa.
- `tests/interface/rastro.spec.ts`: o painel Rastro (F8.3): todos os eventos da §11.1 na linha do tempo, ao vivo, Cypher e evidências como texto, página que abre Fontes, "o documento não tem" sem alerta, erro, 429 e celular.
- `tests/interface/fontes.spec.ts`: o visualizador de fonte (F8.4): página citada com o trecho destacado (PDF de 12 páginas feito à mão pela API falsa, com `Range`), pixels no canvas, trecho fora da página, fonte 404/503, HTML hostil, navegação e seus limites, páginas inválidas, PDF fora do ar, só a mesma origem, chip e Rastro abrindo página e fonte, celular.
- `tests/interface/grafo.spec.ts`: o explorador do subgrafo (F8.5): subgrafo de uma resposta "quem é" (sementes, vizinhos, ligações, uma consulta por semente), expandir por clique e teclado sem mover o que já estava, explorar pelo nome, 100 vizinhos, HTML hostil, no máximo 6 sementes, estado entre abas, sem sobreposição, zoom e celular (a API falsa tem um grafo de 7 entidades).
- `tests/interface/shell.spec.ts`: rotas, 404, abas, título, marcos de acessibilidade, tema e largura de celular.
- `tests/ao-vivo/api.spec.ts`: validação do pedido (400), ausência de CORS, `/api/saude`, uma pergunta real em SSE com o primeiro evento em ≤ 1 s, e o 429 da terceira pergunta simultânea.
- `tests/ao-vivo/rastro.spec.ts`: o Rastro de T15, N01 e G03 contra a pilha real; grava `eval/resultados/f83-rastro.json` (ids e tipos de passo).
- `tests/ao-vivo/fontes.spec.ts`: o aceite da F8.4 (`eval/f84-medida-citacoes.md`): 10 citações sorteadas abrem na página certa no PDF real (grava `eval/resultados/f84-citacoes.json`) e o chip de uma resposta real (T15). Precisa de `data/avaliacao/f75-redator-detalhes.json` e `f712-redator-novas-detalhes.json`.
- `tests/ao-vivo/grafo.spec.ts`: o aceite da F8.5 (`eval/f85-medida-subgrafo.md`): T01, E04 e E07 ("Quem é…") pela interface, tempo até o subgrafo desenhado, repetições pelo campo "Explorar" e uma expansão (grava `eval/resultados/f85-subgrafo.json`).
- `tests/ao-vivo/primeiro-token.spec.ts`: o aceite da F8.2 (`eval/f82-medida-primeiro-token.md`).

## Limites

- A API falsa só imita o contrato; o agente, o grafo e a guarda do Text2Cypher só são exercitados no projeto `ao-vivo`, e por perguntas, não por consultas Cypher diretas.
- Um corte seco de conexão (RST) no meio do SSE não passa pelo proxy do `ng serve`: a tela fica em "Gerando a resposta…" até o usuário apertar Parar. O fluxo que acaba sem `fim` é testado.
- O indexador (Python) não tem teste próprio: ele é exercitado só pelo que a API devolve do grafo que ele montou.
