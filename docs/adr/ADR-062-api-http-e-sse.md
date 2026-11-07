# ADR-062 · API HTTP com SSE: contrato escrito antes das rotas, primeiro evento em 33 ms (máx. nas 60 perguntas), mas o primeiro conteúdo da resposta leva de 2,8 s a 21 s

- **Estado:** aceita (07/11/2026)
- **Data:** 2026-11-07
- **Tarefa(s):** F7.6

## Contexto

O aceite da F7.6 é: testes de contrato contra `contracts/api.openapi.yaml` e primeiro evento em até 1 s. O arquivo do contrato não existia (a §11 da arquitetura só tem tabelas), e a API só tinha o esqueleto de `GET /api/saude` da F0.8. O agente (F7.2 a F7.11) e o redator (F7.5) rodam em `api/src/agente/`; faltava expô-los por HTTP.

## Decisão

- **O contrato vem primeiro.** `contracts/api.openapi.yaml` (OpenAPI 3.1) descreve as seis rotas, o formato de erro `{codigo, mensagem}` e os seis eventos SSE (`x-eventos`). Os testes (`api/test/http/`) leem o YAML, compilam cada esquema com o `ajv` (2020-12) e validam cada resposta e cada evento contra ele; mudar uma rota sem mudar o contrato quebra o teste. Acrescentei `yaml` 2.9.1 e `ajv` 8.20.0 como dependências **de desenvolvimento** (o `ajv` já vinha pelo ESLint, agora está declarado).
- **`criarApp(deps)`** (`api/src/app.ts`) recebe o ciclo, o redator, o grafo e as sondas como dependências; sem uma delas a rota responde o erro certo (503, 404) em vez de a API não subir. `server.ts` liga o Neo4j real, o `ClienteLlm`, o executor e o agente, e aquece o Neo4j e os três modelos em segundo plano (`API_AQUECER=0` desliga). Todo erro sai no formato do contrato, com frase nossa; a mensagem do driver, do Fastify ou do disco nunca vai ao cliente.
- **`POST /api/chat`** (`src/http/chat.ts`, `eventos.ts`, `sse.ts`): valida o corpo com Zod (estrito), recusa `mode` diferente de `auto` e `profile` diferente de `consultar` com 400 (`modo_nao_implementado`, `perfil_nao_implementado`), recusa a 3ª pergunta simultânea com 429 (`ocupado`; 2 é o número de slots do llama-server). Depois larga a resposta do Fastify, manda o evento `etapa {reescrita, inicio}` **antes de qualquer chamada ao LLM**, e traduz o progresso do ciclo em `etapa` (reescrita, rota, ferramenta_inicio, ferramenta_fim, critica) e `cypher`; manda um `evidencia` por evidência do ciclo (trecho de até 400 caracteres, página `null` quando não há), repassa os `token` do redator, avisa o `reparo` e termina em **um** `fim` (texto com as páginas, citações com página, métricas somadas do ciclo e do redator) ou em um `erro`. O cliente que desconecta aborta o ciclo e o redator pelo `AbortSignal`, e a vaga volta ao terminar, com sucesso, erro ou cancelamento. Para isso o agente passou a expor a consulta Cypher de `consultar_grafo` (`Execucao.cypher`: texto e número de linhas).
- **Demais rotas** (`fonte.ts`, `pdf.ts`, `grafo.ts`, `saude.ts`, `feedback.ts`): `GET /api/fonte/:id` (uma consulta com uma ramificação por rótulo; o id é parâmetro), `GET /api/documento/pdf` (com `Range`, 206 e 416, que o pdf.js usa), `GET /api/grafo/vizinhanca` (resolve por id, nome ou apelido, escolhe a de mais ligações; 1 a 2 saltos; teto de 100 nós com `truncado`), `GET /api/saude` (sempre 200; sonda de 2 s por parte; `degradado` se o Neo4j ou o llama-swap faltarem; mostra quais modelos estão carregados pelo `/running` do llama-swap) e `POST /api/feedback` (uma linha JSON por registro em `data/logs/feedback.jsonl`).

## Resultado

**Testes** (escritos antes do código): 86 novos em `api/test/http/` (rotas e chat, validados contra o contrato) e 2 no agente; 861 testes passam na API com o Neo4j e o llama-swap no ar (787 sem eles, 74 de integração pulados). Entre os modos de falha cobertos: sonda do `/api/saude` que pendura, id e nome com injeção de Cypher, faixas `Range` malformadas e fora do arquivo, 100 nós exatos contra 101, aresta para nó não devolvido, primeiro evento com o ciclo preso, desconexão do cliente, 3ª pergunta com as duas vagas cheias, vaga devolvida depois de erro, falha interna sem vazar pilha ou caminho.

**Medida com a API, o Neo4j e o llama-swap reais** (`npm run avaliar:api`, `eval/resultados/f76-api.json`):

| | |
|---|---|
| **Primeiro evento, 60 perguntas do golden** | **máximo 33 ms**, mediana 1 ms (aceite: ≤ 1.000 ms); os 60 são `etapa` |
| Fluxo inteiro, 9 perguntas (T01, T05, N01, N06, G03, P02, M02, F01, F02) | 9 de 9 terminam em um único `fim`; **0 eventos fora do contrato** |
| Tempo até o 1º `token` (mín. / mediana / máx.) | 2,8 s / 9,7 s / 21,3 s |
| Tempo até o `fim` (mín. / máx.) | 3,4 s (F01) / 23,9 s (N06) |
| `GET /api/fonte/:id` | 31 de 31 achadas e válidas: Pai 25, fato 2, tabela, filho, comunidade e entidade 1 cada |
| `GET /api/grafo/vizinhanca` | Banco do Brasil: 100 nós, 252 arestas, `truncado` (a entidade tem 3.482 ligações), 40 ms; entidade inexistente: 404 |
| `GET /api/documento/pdf` | `Range: bytes=0-1023` → 206, `bytes 0-1023/8719214`, começa em `%PDF` |
| `GET /api/saude` | `ok`, 17 índices, os 3 modelos do `consultar` carregados depois do aquecimento |
| `POST /api/feedback` | 201 |

## Consequências

- **O "primeiro evento em 1 s" é cumprido pelo aviso imediato, não pelo conteúdo.** O que sai em 33 ms é a confirmação de que a pergunta foi aceita (`etapa`/`reescrita`/`inicio`); a primeira palavra da resposta (`token`) leva de 2,8 s (recusas) a 21 s, e o ciclo é quem demora (ADR-060 e ADR-061). O aceite está atendido como escrito, mas o RNF-2 (resposta completa em 20 s para pergunta simples) segue estourado nas perguntas que o crítico manda buscar mais, até haver o modo rápido (`profile: consultar-rapido`), que a API recusa por enquanto.
- **O primeiro `/api/saude` depois de subir disse `indisponivel` para o Neo4j** (a 1ª conexão do driver passou de 2 s, com os modelos carregando ao mesmo tempo). O aquecimento do Neo4j no `server.ts` existe por isso; depois dele o `/api/saude` respondeu `ok` em 10 ms. Não foi medido de novo com a API recém-subida.
- **A 1ª medida achou um defeito de resolução:** `GET /api/grafo/vizinhanca?entidade=Banco do Brasil` dava 404, porque o nome da entidade é "Banco do Brasil S.A." e a busca era por nome exato. A resolução passou a aceitar também os apelidos da entidade (`aliases`) e a escolher a de mais ligações; o resultado antigo fica em `f76-api-primeira.json`.
- **Limites ditos:** o contrato é meu e os testes foram escritos contra ele (consistência, não validação externa); só `mode: auto` e `profile: consultar`; sem CORS (o Angular da F8 deve usar o proxy do dev server); sem autenticação (a API escuta só em 127.0.0.1, RNF-1); `mensagemId` do feedback é escolhido pelo cliente (o `fim` não traz um id da mensagem); o `/api/fonte` só foi exercitado com os ids que as ferramentas devolvem, e a seção de um Filho vem do `path` da seção (o texto "de Referência 2026" no filho da p. 1 mostra que a seção nem sempre é um título útil); `maxPerguntas` é 2 fixo no código e na configuração, sem fila; o fluxo inteiro foi medido em 9 perguntas, não nas 60.

## Como reproduzir

```powershell
.\infra\neo4j.ps1 iniciar
.\infra\swap.ps1                          # em outro terminal
cd api
npx vitest run test/http                  # contrato e rotas, sem banco nem LLM (dublês)
npm run build; npm start                  # a API em 127.0.0.1:3000 (FEEDBACK_JSONL aponta o arquivo de notas)
npm run avaliar:api -- --extras <ids de tabela, filho, comunidade e entidade>   # em outro terminal, ~5 min
```

O relatório versionado é `eval/resultados/f76-api.json` (ids, contagens e tempos; sem texto do documento nem das respostas, ADR-009).
