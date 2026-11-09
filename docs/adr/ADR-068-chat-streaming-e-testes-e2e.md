# ADR-068 · Chat com streaming SSE na tela, e a troca dos testes unitários por testes E2E (o primeiro token leva 8,5 a 82,5 s, não 5 s; aceite reescrito pós-hoc)

- **Estado:** aceita (09/11/2026). O aceite original da F8.2 (≤ 5 s até o primeiro token) **não foi cumprido**; o dono do projeto o reescreveu pós-hoc e a tarefa ficou `[x]`
- **Data:** 2026-11-09
- **Tarefa(s):** F8.2

## Contexto

A F8.2 liga o chat da interface à API (`POST /api/chat`, SSE, ADR-062). Um `EventSource` só faz GET, então o corpo do `fetch` é lido à mão. A resposta vem de um modelo que leu um documento: é entrada não confiável e não pode virar HTML.

No meio da tarefa o dono do projeto decidiu abandonar os testes unitários ("só criam peso no diretório e nunca pegam nenhum erro que os testes E2E pegariam") e passar a testar só por E2E.

## Decisão

**Chat** (`web/src/app/chat/`, `paginas/chat/chat.page.ts`):
- `sse.ts` lê o fluxo (`\n`, `\r`, `\r\n` partido entre pedaços, UTF-8 em fluxo, comentários, quadro incompleto no fim descartado) e se cancela sozinho quando o `AbortSignal` dispara, para a leitura parada acordar.
- `chat-api.ts` valida cada evento, mapeia toda falha para `ErroDaApi` com mensagem nossa em português (HTML de proxy, JSON fora do contrato, rede fora, fluxo sem `fim`) e deixa o cancelamento sair como `AbortError`.
- `chat.service.ts` guarda as mensagens em sinais, tem a trava de uma pergunta por vez **síncrona** (antes do primeiro evento), manda os últimos 4 itens do histórico (só turnos completos, cada texto cortado em 8.000), mede o primeiro evento, o primeiro token e o fim no cliente e guarda os eventos do Rastro para a F8.3.
- `markdown.ts`: o `marked` escapa o HTML cru, troca cabeçalho por parágrafo em negrito e tira imagem e link; o DOMPurify com lista fechada de elementos e só o atributo `start` devolve um fragmento; os marcadores `[p. 6]`, `[p. 6-7]`, `[p. 6, 9, 12]`, `[sem página]` e `[E1]` viram chips por nós de texto, fora de `code`/`pre`. Nada usa `innerHTML`.
- Enter envia, Shift+Enter quebra a linha, Enter durante a composição (IME) não envia; `role="log"` com `aria-live="off"` e um `role="status"` à parte ("Gerando a resposta…", "Resposta pronta.") para os tokens não serem lidos um a um; contador só a partir de 3.500 caracteres.
- `web/proxy.conf.json` leva `/api` do `ng serve` para `127.0.0.1:3000` (a API não tem CORS).

**Testes: só E2E** (`e2e/`, Playwright 1.64.1; a política está no `README.md` da raiz e em `e2e/README.md`):
- 83 arquivos de teste unitário removidos (43 de pytest no indexador, 33 de vitest na API, 7 do Angular), mais `vitest`, `jsdom` e `pytest` das dependências e o `pytest`, o `npm test` e o `ng test` do CI. Continuam no histórico (commit `685ced9` é o último com eles).
- Projeto `interface`: o navegador contra o `ng serve` e uma API falsa que fala o contrato (31 testes; roda no CI, job `e2e`).
- Projeto `ao-vivo`: o navegador e o HTTP contra a pilha real (12 testes; não roda no CI).

## Alternativas consideradas

- **Manter os unitários só nos parsers (SSE, markdown).** Era o caso em que a skill de E2E ainda os aceita, mas o dono pediu a remoção de todos.
- **Mockar a API com `page.route`.** Não prova o streaming pelo proxy; a API falsa em HTTP de verdade prova (o teste "os tokens aparecem em pedaços" passa pelo proxy do `ng serve`).
- **Playwright com Chromium baixado.** Pesa ~150 MB; localmente usa-se o Edge do Windows, e só o CI baixa o Chromium.

## Consequências

- O que se perde: cobertura direta e rápida de lógica interna da API (agente, ferramentas, guarda do Text2Cypher, telemetria) e de todo o indexador. Hoje esses trechos só são exercitados por perguntas no projeto `ao-vivo` e pelas medidas (`npm run avaliar:*`), que não são testes de regressão automáticos. Se uma regressão aparecer ali, o E2E só a pega se ela mudar o que a tela ou o HTTP mostram.
- O CI deixa de rodar `pytest`, `npm test` e `ng test`; ganha o job `e2e`. O `ruff`, o `eslint`, o `tsc` e o `ng build` continuam.
- O `uv remove --dev pytest` tirou do ambiente local o Docling e o torch (um `uv sync` puro faz isso, como já se sabia). Para reindexar um documento: `uv sync --group parse` (baixa de novo).
- Um corte seco (RST) da conexão no meio do SSE não passa pelo proxy do `ng serve`: a tela fica em "Gerando a resposta…" até o usuário apertar Parar. Não há tempo limite de silêncio no cliente.

## Evidência

**Interface** (`cd e2e; npm test`): 31 de 31 testes passam, e 62 de 62 numa repetição (`--repeat-each=2`), em ~21 s. Uma mutação feita à mão (tirar o `abort()` do `cancelar()`) derruba o teste do Parar. Uma execução inicial achou uma diferença real entre o que eu supunha e o proxy (o corte seco acima), e o teste passou a usar um fluxo que acaba sem `fim`.

**API ao vivo** (`npm run test:ao-vivo -- api`): 400 com corpo `Erro` para 7 pedidos inválidos, sem cabeçalho CORS, `/api/saude` ok, primeiro evento ≤ 1 s e fluxo terminando em um único `fim`, e a terceira pergunta simultânea recebe 429.

**Aceite da F8.2 (≤ 5 s até o primeiro token)** — definição em `eval/f82-medida-primeiro-token.md`, fixada e commitada (`685ced9`) antes de rodar; medida no Edge, `ng serve` com proxy, API real, perfil `consultar`, uma conversa nova por pergunta, uma execução (`eval/resultados/f82-primeiro-token.json`):

| Pergunta | Sinal de vida | Primeiro token | Fim | Rodadas do ciclo |
|---|---|---|---|---|
| T01 | 3 ms | 8.498 ms | 9.440 ms | 1 |
| T02 | 4 ms | 53.405 ms | 54.798 ms | 2 |
| T03 | 2 ms | 82.516 ms | 87.131 ms | 2 |
| T04 | 4 ms | 57.311 ms | 61.630 ms | 2 |
| T05 | 4 ms | 43.988 ms | 47.845 ms | 2 |

**0 de 5 dentro de 5 s** (mediana 53,4 s, máximo 82,5 s). A tela mostra sinal de vida em até 4 ms e, depois do primeiro token, a resposta termina em 0,9 a 4,6 s, em 30 a 152 estados intermediários (o streaming funciona de ponta a ponta pelo proxy). O atraso está antes do primeiro token: o redator só escreve depois do ciclo de busca, e o ciclo fez duas rodadas em 4 das 5 perguntas (telemetria). Esses tempos são bem piores que os 19,8 s de mediana da F7.13; não investiguei a diferença (a pilha acabara de subir, a máquina estava com o navegador e o `ng serve` rodando junto). A primeira execução do teste estourou só o tempo total do teste (240 s, erro meu na configuração), foi descartada e refeita com o limite corrigido; a regra de aceite e o limite de 5 s não mudaram.

Reproduzir: subir Neo4j (`infra\neo4j.ps1 iniciar`), llama-swap (`infra\swap.ps1`) e a API (`cd api; npm run build; npm start`), e `cd e2e; npm run test:ao-vivo`.

**Aceite reescrito (pós-hoc, decisão do dono em 09/11/2026).** Novo texto: "a tela mostra sinal de vida em ≤ 1 s e o texto aparece em pedaços, com a resposta terminando em ≤ 5 s depois do primeiro token, em 5 perguntas simples do golden". Sobre as mesmas medidas acima: sinal de vida 5 de 5 (máx. 4 ms), pedaços 5 de 5 (30 a 152 estados distintos), fim em ≤ 5 s depois do primeiro token 5 de 5 (0,9 a 4,6 s). Os limites novos foram escolhidos depois de ver esses números, nas mesmas perguntas: o resultado original (0 de 5) fica como medido, e o RNF-2 (1º token ≤ 5 s) segue não cumprido, agora como dívida do pipeline (redator que escreva antes de a busca acabar, ou menos rodadas do crítico). O teste `tests/ao-vivo/primeiro-token.spec.ts` passou a checar o critério novo e continua gravando o resultado original (`dentroDoLimite`) no JSON; não foi rodado de novo depois dessa troca (o JSON versionado é o da medida original).
