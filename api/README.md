# api

API e agente do GraphRAG local (Node 24, TypeScript 6.0, Fastify). Hoje: a rota `GET /api/saude` (esqueleto
da F0.8), o cliente LLM (F7.1), o atualizador de pergunta (F7.2), o roteador (F7.3) e o executor com os seis templates
Cypher (F7.8). As demais ferramentas, o agente completo e o SSE (ARQUITETURA §7 e §11) entram nas próximas tarefas da F7.

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

## Atualizador de pergunta (`src/agente`, F7.2, ADR-053)

`atualizarPergunta(llm, pergunta, historico)` devolve a pergunta autônoma e as subperguntas com `dependeDe`
(índices das que precisam responder antes). Soma, lista, série e atributos da mesma entidade ficam numa
pergunta só. Se o LLM falha, a pergunta segue inteira (`fallback`). Medir com o llama-swap no ar:

```powershell
npm run avaliar:decomposicao -- --nome f72-teste --grupo teste   # ajuste | teste | teste2
```

## Roteador (`src/agente/roteador.ts`, F7.3, ADR-054)

`rotear(llm, pergunta)` escolhe, por *tool calling*, entre as 12 ferramentas da §7.2 (`CATALOGO`, com esquema Zod) e devolve
`{rota, chamadas: [{nome, argumentos}], texto, descartadas, fallback}`. Argumentos ruins são descartados; sem nada
aproveitável, a chamada é `buscar_trechos` (`fallback`). `rotearSubperguntas(llm, subperguntas, { executar })` roteia
as saídas do atualizador por ondas (até 2 ao mesmo tempo). O roteador não executa as ferramentas. Medir:

```powershell
npm run avaliar:rotas -- --nome f73-teste3 --grupo teste3   # ajuste | teste | teste2 | teste3; --direto pula o atualizador
```

## Executor e templates Cypher (`src/ferramentas`, F7.8, ADR-056)

`criarExecutor({ grafo })` recebe o `{nome, argumentos}` do roteador e devolve o resultado da ferramenta no contrato
`evidencias[]` (`id`, `tipo`, `paginas`, `caminho`, `texto`, `score`, mais `aviso`, `erro`, `sugestoes`, `omitido`).
Nunca lança: ferramenta desconhecida, ainda não portada (`panorama` e `consultar_grafo`, F7.10) e exceção viram `erro`.
Portadas: `fato_financeiro`, `serie_metrica`, `comparar_segmentos`, `riscos`, `eventos` e `pessoas_cargos`, com Cypher
fixo e somente leitura (`GrafoNeo4j`, sessão `READ`; credenciais do `.env` da raiz), e, a partir da F7.9 (ADR-057),
`buscar_trechos`, `buscar_tabelas`, `entidade` e `resposta_ja_dada`, que precisam do `llm` (`criarExecutor({ grafo, llm })`,
um `ClienteLlm`; sem ele devolvem `llm_nao_configurado`).

```ts
import { GrafoNeo4j, criarExecutor } from "./ferramentas/index.ts";

const grafo = GrafoNeo4j.conectar();
const executor = criarExecutor({ grafo });
const r = await executor.executar({ nome: "fato_financeiro", argumentos: { metrica: "lucro líquido", periodo: "2025" } });
await grafo.fechar();
```

Paridade com o Python no grafo real (Neo4j no ar e `uv` no PATH): `npm run avaliar:paridade` roda as 54 chamadas de
`eval/paridade_templates.json` nos dois lados e sai com código 1 se algo diferir. O contrato contra o grafo real
(`test/ferramentas/templates.integracao.test.ts`) é pulado sem o Neo4j.

Paridade das buscas (F7.9; Neo4j, llama-swap e `uv` no ar): `npm run avaliar:busca` compara `buscar_trechos` nas 55
perguntas do golden com página e `entidade` em 12 nomes com o Python, mede o page recall dos dois lados e a página de
`buscar_tabelas`. Leva ~25 minutos. A nota do reranker muda conforme o servidor já tenha visto a consulta, então a
comparação é TS (a frio) → Python → TS (a quente) com tolerância de 1e-3 (ver o ADR-057).

Erros (`LlmIndisponivelError`, `LlmTimeoutError`, `LlmAbortadoError`, `LlmHttpError`,
`LlmRespostaInvalidaError`) têm uma classe por causa. Só rede e 5xx ganham uma nova tentativa. A primeira
chamada de cada modelo inclui a carga dele (14 s o Qwen). Para rodar a integração:

```powershell
..\infra\swap.ps1          # em outro terminal; ou defina LLAMA_SWAP_URL
npx vitest run test/llm/integracao.test.ts
```
