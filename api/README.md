# api

API e agente do GraphRAG local (Node 24, TypeScript 6.0, Fastify). Hoje: a rota `GET /api/saude` (esqueleto
da F0.8) e o cliente LLM (F7.1). O agente, as ferramentas e o SSE (ARQUITETURA §7 e §11) entram nas próximas
tarefas da F7.

O TypeScript fica **fixado em 6.0.x**: o Angular 22 e o `typescript-eslint` ainda não aceitam a 7.x.

```powershell
. ..\infra\dev-env.ps1     # node e npm no PATH desta sessão
npm install
npm test                   # os testes de integração só rodam com o llama-swap no ar
npm run lint
npm run typecheck          # src e testes
npm run build
```

## Cliente LLM (`src/llm`, F7.1, ADR-052)

`ClienteLlm` fala com o llama-swap pelo SDK da OpenAI (`openai` 7.43.0, fixado). O modelo vem do perfil
(`principal` = Qwen3.6-35B-A3B sem raciocínio; `rapido` = gpt-oss-20b); o llama-swap escolhe o perfil de carga
pelo modelo pedido.

```ts
import { ClienteLlm } from "./llm/index.ts";

const llm = new ClienteLlm({ baseUrl: "http://127.0.0.1:8080" });
await llm.chat([{ role: "user", content: "Olá" }]);                       // texto, uso, ms
await llm.chatJson(mensagens, { esquema, validar });                      // JSON forçado por gramática
await llm.chamarFerramentas(mensagens, ferramentas, { escolha: "required" }); // [{ id, nome, argumentos }]
for await (const e of llm.chatStream(mensagens)) { /* token | raciocinio | fim */ }
await llm.embeddingDeConsulta("Qual foi o lucro?");                       // 1024 dimensões, norma 1
await llm.rerank("pergunta", textos);                                     // uma nota por texto
```

Erros (`LlmIndisponivelError`, `LlmTimeoutError`, `LlmAbortadoError`, `LlmHttpError`,
`LlmRespostaInvalidaError`) têm uma classe por causa. Só rede e 5xx ganham uma nova tentativa. A primeira
chamada de cada modelo inclui a carga dele (14 s o Qwen). Para rodar a integração:

```powershell
..\infra\swap.ps1          # em outro terminal; ou defina LLAMA_SWAP_URL
npx vitest run test/llm/integracao.test.ts
```
