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
- `tests/interface/configuracoes.spec.ts`: as Configurações (F8.6): modo (6) e perfil (2) com padrão e descrição, salvar e recarregar, `localStorage` inválido ou bloqueado, teclado, 375 px, corpo do pedido só com o que difere do padrão, legenda do chat, e a rota do Rastro (`data-ferramentas`, "Modo forçado") mudando com cada modo; perfil rápido com uma rodada.
- `tests/interface/saude.spec.ts`: o selo de saúde (F8.7): estados no ar, degradado e fora do ar a partir de `/api/saude` (Neo4j, llama-swap, índice e corpo fora do contrato), painel, consulta a cada 30 s com o relógio do Playwright e tempo máximo de 10 s, chat que segue funcionando, HTML hostil e 375/320 px.
- `tests/interface/feedback.spec.ts`: o feedback por resposta (F8.7): botões só em resposta pronta, nota 1/-1 com o `mensagemId`, trocar de ideia, comentário opcional, falhas (500, rede, 502 com HTML) com nova tentativa e 375 px.
- `tests/interface/assistente.spec.ts`: a tela do usuário final (F8.9, `/assistente`, a inicial): selo de estado (encontrado, em parte, não consta, erro e a saudação sem selo), cartões de fonte que abrem o painel na página certa, "Como cheguei a esta resposta", nota e comentário, "Como buscar" e Completa/Rápida (a mesma escolha de Configurações), conversas recentes guardadas no navegador (restaurar, apagar, mesmo `conversationId`), estado do sistema, tema, link para o modo técnico, menu e folha da fonte no celular e o encaixe das peças na tela. Page Object: `paginas/assistente.ts`.
- `tests/interface/artefatos.spec.ts`: o material gerado pelo assistente (F8.10): gráfico com texto alternativo, tabela com a página de cada valor (abre o visualizador), downloads de `.svg`, `.xlsx`, `.docx` e `.pptx`, "não consta" sem material, aviso de pontos removidos, HTML e endereços hostis, imagem que não carrega, conversa restaurada e celular. A API falsa serve também `GET /api/arquivos/:id`.
- `tests/interface/shell.spec.ts`: rotas (a raiz leva a `/assistente`; `/chat` a `/chat/rastro`), 404, abas, título, marcos de acessibilidade, tema e largura de celular.
- `tests/ao-vivo/api.spec.ts`: validação do pedido (400), ausência de CORS, `/api/saude`, uma pergunta real em SSE com o primeiro evento em ≤ 1 s, e o 429 da terceira pergunta simultânea.
- `tests/ao-vivo/rastro.spec.ts`: o Rastro de T15, N01 e G03 contra a pilha real; grava `eval/resultados/f83-rastro.json` (ids e tipos de passo).
- `tests/ao-vivo/fontes.spec.ts`: o aceite da F8.4 (`eval/f84-medida-citacoes.md`): 10 citações sorteadas abrem na página certa no PDF real (grava `eval/resultados/f84-citacoes.json`) e o chip de uma resposta real (T15). Precisa de `data/avaliacao/f75-redator-detalhes.json` e `f712-redator-novas-detalhes.json`.
- `tests/ao-vivo/grafo.spec.ts`: o aceite da F8.5 (`eval/f85-medida-subgrafo.md`): T01, E04 e E07 ("Quem é…") pela interface, tempo até o subgrafo desenhado, repetições pelo campo "Explorar" e uma expansão (grava `eval/resultados/f85-subgrafo.json`).
- `tests/ao-vivo/modo.spec.ts`: o aceite da F8.6 (`eval/f86-medida-modo.md`): T15, N01 e G03 em `auto` e nos 5 modos pela tela Configurações, rota lida do Rastro, `mode` do corpo e uma execução do perfil rápido (grava `eval/resultados/f86-modo.json`, ids, rotas e tempos).
- `tests/ao-vivo/assistente.spec.ts`: o aceite da F8.9 (`eval/f89-medida-assistente.md`): T15, N01, G03, P01 e F01 só pela tela `/assistente`, com o selo esperado lido do `fim` do `POST /api/chat`, o primeiro cartão de fonte abrindo a página certa do PDF, o passo a passo, a nota (201) e o link do modo técnico (grava `eval/resultados/f89-assistente.json`, ids e números; a captura de tela a 1280 px fica em `data/avaliacao/`, fora do git).
- `tests/ao-vivo/arquivos.spec.ts`: o aceite da F8.10 (`eval/f810-medida-geracao.md`): cinco pedidos (gráfico, tabela e planilha, Word, apresentação e um sem dado no documento) só pela tela `/assistente`; confere rótulos, valores e páginas contra o gabarito, o evento `artefato` contra o contrato, baixa cada arquivo pelo link e o relê (exceljs, zip e XML); grava `eval/resultados/f810-geracao.json`.
- `tests/ao-vivo/interface.spec.ts`: o aceite da F8.7 (`eval/f87-medida-interface.md`): T15, N01, G03, P01 e F01 pela interface, com o selo "no ar" e uma nota por resposta lida do arquivo de feedback (`FEEDBACK_JSONL`; grava `eval/resultados/f87-interface.json`, ids e números).
- `tests/ao-vivo/primeiro-token.spec.ts`: o aceite da F8.2 (`eval/f82-medida-primeiro-token.md`).

## Limites

- A API falsa só imita o contrato; o agente, o grafo e a guarda do Text2Cypher só são exercitados no projeto `ao-vivo`, e por perguntas, não por consultas Cypher diretas.
- Um corte seco de conexão (RST) no meio do SSE não passa pelo proxy do `ng serve`: a tela fica em "Gerando a resposta…" até o usuário apertar Parar. O fluxo que acaba sem `fim` é testado.
- O indexador (Python) não tem teste próprio: ele é exercitado só pelo que a API devolve do grafo que ele montou.
