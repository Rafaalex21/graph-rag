# ADR-073 · Selo de saúde no topo e feedback por resposta

- **Estado:** aceita (09/11/2026)
- **Data:** 2026-11-09
- **Tarefa(s):** F8.7

## Contexto

A API já tinha `GET /api/saude` e `POST /api/feedback` (F7.6), mas a interface não os usava: quem quisesse saber se o Neo4j ou o llama-swap estavam no ar, ou registrar se uma resposta foi útil, precisava do terminal (`curl`). O aceite da F8.7 é "5 perguntas do golden set feitas pela interface sem tocar no terminal". A medida foi escrita antes de rodar (`eval/f87-medida-interface.md`, commit `6df6409`) e os testes são só E2E (ADR-068), escritos antes do código.

## Decisão

- **Selo de saúde** (`web/src/app/saude/`), um botão "Sistema: …" no cabeçalho de todas as páginas. Estados: `verificando…` (só na primeira consulta), `no ar` (llama-swap e Neo4j `ok` e todos os índices `ONLINE`), `degradado` (a API respondeu, mas alguma dessas partes não está bem, inclusive "não configurado") e `fora do ar` (a API não respondeu, deu HTTP de erro, HTML de proxy ou um corpo que não é o contrato). O corpo é conferido campo a campo; o que vem da API só entra na tela como texto.
- **Quando consulta:** ao abrir, a cada 30 s (`setInterval`) e por "Verificar de novo". No máximo uma consulta em curso (cliques repetidos reaproveitam a que está no ar) e 10 s de espera máxima, depois dos quais o selo vira "fora do ar" e a de 30 s seguinte tenta de novo. O estado anterior fica na tela durante as consultas seguintes (o selo não pisca "verificando…").
- **Painel** (abre pelo selo; Escape fecha e devolve o foco): llama-swap, Neo4j (com ms), índices ("3 de 3 no ar" e quais não estão, pelo nome e estado), modelos na memória ("1 de 3"; o primeiro uso de um modelo frio leva ~14 s) e, quando algo caiu, a dica de como subir (`infra\swap.ps1`, `infra\neo4j.ps1 iniciar`, `cd api; node dist/server.js`). O texto do estado é uma região viva educada (anuncia a mudança, não cada consulta). **O selo só informa: não bloqueia o chat.**
- **Feedback** (`ChatService.avaliar/comentar`, `chat/feedback-api.ts`): toda resposta pronta (com `mensagemId` do `fim`) tem o grupo "Avaliar a resposta" com "Resposta útil" (nota 1) e "Resposta não útil" (nota -1), `aria-pressed`, "Nota registrada." e, depois da nota, o comentário opcional (até 1.000 caracteres) com "Enviar comentário". O clique envia na hora; clicar na nota já marcada, ou durante um envio, não manda outro pedido; trocar a nota começa um registro novo (sem o comentário de antes). Falha (rede, 500, 502 com HTML): alerta com a mensagem da API ou "Não foi possível registrar a nota agora.", a nota não é marcada e dá para tentar de novo; o texto do comentário digitado não se perde.
- **Registro:** o arquivo continua de linhas (`data/logs/feedback.jsonl`, ou `FEEDBACK_JSONL`); o comentário é uma segunda linha com a mesma nota, e **a última linha de cada `mensagemId` vale**. A API não mudou.

## Alternativas consideradas

- **Consultar a saúde só ao abrir:** o selo ficaria desatualizado quando o Neo4j caísse no meio do uso; 30 s custa uma consulta barata (cerca de 200 ms com índices).
- **Bloquear o chat quando "fora do ar":** a API pode estar bem e só a sonda ter falhado; deixar tentar dá o erro real do chat.
- **Enviar nota e comentário juntos, num só botão:** exigiria duas etapas para uma nota rápida; a nota vale sozinha e o comentário é um complemento.
- **Atualizar uma linha do arquivo em vez de acrescentar:** o arquivo é um registro de eventos (`appendFile`, sem reescrita), simples e sem perda se o processo cair no meio.

## Consequências

- O selo mede a pilha vista pela API, não a interface: se o `ng serve`/servidor estático cair, nada da página carrega para mostrar "fora do ar".
- A nota é por clique e não é deduplicada no servidor: trocar de ideia deixa várias linhas para o mesmo `mensagemId`; quem lê o arquivo deve pegar a última de cada id.
- Subir a pilha (Neo4j, llama-swap, API) continua sendo feito por scripts `infra\`; a interface mostra se estão no ar e como subi-los, mas não os inicia. É o limite do "sem tocar no terminal".
- Na medida, a nota foi **mecânica** (👍 se há citação de página, 👎 se não): G03 respondeu "não consta" mas citou uma página e recebeu 👍; F01 é uma saudação, que não tem citação por natureza, e recebeu 👎. A nota do teste não é avaliação de qualidade.

## Evidência

**E2E da interface** (`cd e2e; npm test`): 158 testes passam (35 novos: 14 de feedback e 21 do selo de saúde), e 316 de 316 numa repetição (`--repeat-each=2`). O selo cobre: em todas as páginas, "verificando…" até a resposta, painel (abre, fecha, Escape e foco), Neo4j fora, llama-swap fora, índice `POPULATING`, "não configurado", conexão recusada, 502 com HTML, corpo fora do contrato, "Verificar de novo" (e cliques repetidos = uma consulta), repetição a cada 30 s e o tempo máximo de 10 s (com o relógio do Playwright), o chat que continua funcionando com o selo "fora do ar", HTML hostil em nomes de modelo e índice, 375 e 320 px sem rolagem horizontal. O feedback cobre: botões só em resposta pronta, nota 1 e -1 com o `mensagemId`, trocar de ideia, nota repetida, duas respostas independentes, teclado, duplo clique, comentário (vazio, texto, HTML como texto), falha com nova tentativa, rede caída, 502 com HTML, falha só do comentário e 375 px. Teste de sanidade: tirar do selo a checagem dos índices faz o teste "índice que não está ONLINE" falhar. `ng lint` limpo e `ng build` sem avisos (255,2 kB iniciais; chunk do chat 95,6 kB).

**Pilha real** (`FEEDBACK_JSONL=… npm run test:ao-vivo -- interface`, `eval/resultados/f87-interface.json`, ids e números): T15, N01, G03, P01 e F01 pela interface. O selo estava "Sistema: no ar" antes da primeira pergunta e depois da última. **As 5 passaram pelos cinco passos fixados antes de rodar** (resposta pronta com texto, nota por botão, "Nota registrada.", todas as respostas do `POST /api/feedback` com 201) e **o arquivo de feedback tem as 5 notas certas** (6 linhas: F01 tem a nota e o comentário). Tempos: T15 14,7 s, N01 8,5 s, G03 49,0 s, P01 27,4 s, F01 3,9 s. Citações: 2, 2, 1, 10 e 0 (notas 1, 1, 1, 1 e -1). O aceite se cumpre pela regra fixada (5 de 5 e o selo "no ar").

**Limites:** n = 5 perguntas, 1 execução por pergunta; os serviços foram iniciados antes, pelos scripts `infra\`; a medida prova o fluxo de ponta a ponta, não que as respostas estão certas; "pilha fora do ar" só foi exercitada com a API falsa.

Reproduzir: `cd e2e; npm ci; npm test` (interface); com Neo4j, llama-swap e a API no ar (`FEEDBACK_JSONL=<arquivo>` ao subir a API e ao rodar o teste), `npm run test:ao-vivo -- interface`.
