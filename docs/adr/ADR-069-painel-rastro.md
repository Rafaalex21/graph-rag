# ADR-069 · Painel Rastro: a linha do tempo da resposta feita só com os eventos do SSE

- **Estado:** aceita (09/11/2026)
- **Data:** 2026-11-09
- **Tarefa(s):** F8.3

## Contexto

A F8.3 mostra o caminho de cada resposta (pergunta reescrita, rota, ferramentas, Cypher, evidências, crítica) na aba Rastro. O aceite é "todos os eventos da §11.1 representados". O `detalhe` das `etapa` é livre no contrato (`type: object`); o que cada tipo leva está em `api/src/http/eventos.ts` e em `chat.ts`. Os testes agora são só E2E (ADR-068), escritos antes do código.

## Decisão

- **Sem nova rota nem nova chamada à API:** o `ChatService` já guarda, em cada resposta, os eventos que não são `token` (F8.2). `chat/rastro.ts` (função pura) transforma esses eventos em passos; `paginas/rastro/rastro.page.ts` mostra os da resposta mais recente, ao vivo (cada evento aparece quando chega).
- **Passos** (um por evento, na ordem de chegada): pergunta recebida (o `etapa` `reescrita` com `estado: inicio`), pergunta reescrita (rodada, nº de subperguntas, tempo, plano de reserva), rota (rota, ferramentas, plano de reserva), ferramenta iniciada, ferramenta terminada (evidências e tempo; se `erro`, "falhou" com o texto e a borda vermelha), Cypher (consulta dentro de `<details>`, linhas, tempo), crítica (buscar mais / suficiente / "o documento não tem esse dado", o que falta, perguntas novas), reparo (nº de frases reescritas), evidências (as que chegam juntas viram **um** passo, com tipo, nota, página e trecho), fim (tempo, tokens, rota, estado) e erro. O `etapa` com tipo ou `detalhe` desconhecido é ignorado; campo ausente ou de outro tipo vira "sem dado", sem quebrar a lista.
- **"O documento não tem" não é erro:** a crítica `ausente` e a ferramenta que devolve 0 evidências aparecem em destaque neutro e sem `role="alert"`; só o evento `erro` e a ferramenta que falhou ganham a borda vermelha, e o alerta continua só no chat.
- **Tudo é texto:** consulta Cypher, trecho de evidência, mensagens e nomes entram por interpolação do Angular; o `<script>` e o `<img onerror>` que o teste põe dentro deles aparecem como texto.
- **Página da evidência** é um botão ("Abrir a página N do documento") que leva a `/chat/fontes?pagina=N`, como o chip da resposta; sem página, "sem página" sem botão.
- **Acessibilidade:** `<ol>` com rótulo "Linha do tempo da resposta" e **sem** região viva (o andamento já é anunciado pelo `role="status"` do chat); números em pt-BR (`1.234 tokens`, `12,3 s`, nota `0,91`).
- A lista é da resposta mais recente; "Nova conversa" a esvazia; trocar de aba e voltar não a perde (o estado está no serviço).

## Alternativas consideradas

- **Mostrar o rastro de qualquer resposta clicando nela.** Fica para quando houver necessidade; o aceite pede o da pergunta atual.
- **Um passo por evidência na linha do tempo.** Com 9 ou mais evidências escondia a rota e a crítica; agrupadas, a linha do tempo fica com 9 a 22 passos.
- **Região viva (`aria-live`) na lista.** Leria 20 passos seguidos junto com o status do chat.

## Consequências

- O Rastro depende só do que o SSE manda; se o contrato ganhar um tipo de etapa, ele é ignorado até alguém o desenhar.
- A API só manda as evidências depois da última crítica (o `chat.ts` as envia ao fim do ciclo), então elas aparecem tarde na linha do tempo, não junto da ferramenta que as achou.
- A configuração de modo e perfil (F8.6) vai usar este painel para mostrar que a rota mudou.

## Evidência

**E2E** (`cd e2e; npm test`): 51 testes da interface (20 novos do Rastro) passam, e 102 de 102 numa repetição (`--repeat-each=2`), em ~41 s. Eles cobrem: os 18 passos do fluxo completo na ordem em que chegam (as duas rodadas, uma ferramenta que falha, Cypher, as 3 evidências com e sem página, crítica `buscar_mais` e depois `suficiente`, reparo e fim); ao vivo (passos antes do fim, fim só no fim); crítica `ausente` sem alerta; evento `erro`; HTTP 429 (sem passos); XSS em Cypher e trecho; Nova conversa e troca de abas; 375 px sem rolagem horizontal. Esse último achou um estouro real (o `<pre>` esticava a grade do passo), corrigido com `minmax(0, 1fr)`.

**Pilha real** (`npm run test:ao-vivo`, `eval/resultados/f83-rastro.json`): T15, N01 e G03 passaram. Passos vistos: T15 e N01 com 9, G03 com 22; a união cobre recebida, reescrita, rota, ferramenta iniciada e terminada, **Cypher** (visto em G03), crítica, evidências e fim. **Não foram vistos ao vivo o `reparo` e o `erro`** (não deu para provocá-los com perguntas do golden): esses dois só estão provados contra a API falsa, que segue o contrato.

**Build:** `ng lint` limpo e `ng build` de produção sem avisos (246,1 kB iniciais; a aba Rastro é um chunk de 9,6 kB). A aparência foi vista em uma captura a 1280 px no Edge; não houve revisão visual em outras larguras além do teste de rolagem.

Reproduzir: `cd e2e; npm ci; npm test` (interface); com Neo4j, llama-swap e a API no ar, `npm run test:ao-vivo -- rastro`.
