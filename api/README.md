# api

API e agente do GraphRAG local (Node 24, TypeScript 6.0, Fastify): o cliente LLM (F7.1), o agente (atualizador, roteador,
executor das 12 ferramentas, crítico e redator, F7.2 a F7.11) e a API HTTP com SSE (F7.6, `src/http/`, contrato em
[`contracts/api.openapi.yaml`](../contracts/api.openapi.yaml)). A telemetria (F7.7) é a próxima.

O TypeScript fica **fixado em 6.0.x**: o Angular 22 e o `typescript-eslint` ainda não aceitam a 7.x.

```powershell
. ..\infra\dev-env.ps1     # node e npm no PATH desta sessão
npm install
npm test                   # os testes de integração só rodam com o llama-swap no ar
npm run lint
npm run typecheck          # src e testes
npm run build
```

## API HTTP (`src/app.ts`, `src/http/`, F7.6, ADR-062)

`npm start` (depois do `build`) ou `npm run dev` sobe a API em `127.0.0.1:3000` (`API_PORT`), liga o Neo4j (`.env`) e o llama-swap
(`LLAMA_SWAP_URL`) e aquece o Neo4j e os três modelos em segundo plano (`API_AQUECER=0` desliga). Rotas, todas no formato de erro
`{codigo, mensagem}` do contrato:

| Rota | Faz |
|---|---|
| `POST /api/chat` | SSE: eventos `etapa`, `cypher`, `evidencia`, `token`, `fim` ou `erro`; o primeiro sai antes de qualquer chamada ao LLM; no máximo 2 perguntas ao mesmo tempo (a 3ª leva 429); o cliente que sai cancela o trabalho. Só `mode: auto` e `profile: consultar` |
| `GET /api/fonte/:id` | O Pai, Filho, tabela, fato, entidade ou comunidade que uma citação aponta, com página e seção |
| `GET /api/documento/pdf` | O PDF original, com `Range` (`DOCUMENTO_PDF` troca o arquivo) |
| `GET /api/grafo/vizinhanca?entidade=&profundidade=` | Nós e arestas de uma entidade (até 100 nós, profundidade 1 ou 2) |
| `GET /api/saude` | llama-swap (modelos e quais estão carregados), Neo4j e índices; sempre 200 |
| `POST /api/feedback` | Grava a nota em `data/logs/feedback.jsonl` (`FEEDBACK_JSONL` troca o arquivo) |

`criarApp(deps)` recebe o ciclo, o redator, o grafo e as sondas como dependências, para os testes usarem dublês. Os testes de
contrato (`test/http/`) leem o YAML e validam cada resposta e cada evento contra os esquemas dele; `npm run avaliar:api` mede a API
no ar (primeiro evento nas 60 perguntas, fluxo inteiro, rotas).

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
Nunca lança: ferramenta desconhecida, cliente LLM ausente e exceção viram `erro`.
Portadas: `fato_financeiro`, `serie_metrica`, `comparar_segmentos`, `riscos`, `eventos` e `pessoas_cargos`, com Cypher
fixo e somente leitura (`GrafoNeo4j`, sessão `READ`; credenciais do `.env` da raiz), e, a partir da F7.9 (ADR-057),
`buscar_trechos`, `buscar_tabelas`, `entidade` e `resposta_ja_dada`, que precisam do `llm` (`criarExecutor({ grafo, llm })`,
um `ClienteLlm`; sem ele devolvem `llm_nao_configurado`).

Desde a F7.10 (ADR-058) as 12 ferramentas do roteador têm execução: `panorama` (busca global *map-reduce* sobre os
relatórios de comunidade; leva de 20 a 56 s, com `progressoPanorama` repassando `selecao`, `mapa`, `sintese` e `fim`) e
`consultar_grafo` (Text2Cypher). Esta última executa texto escrito por um LLM, então passa pela guarda de
`ferramentas/guarda.ts` (texto, plano do `EXPLAIN`, sessão `READ` com 5 s e teto de 50 linhas) e só roda num acesso ao
grafo que saiba `explicar` e `executarLivre` (`GrafoNeo4j` sabe; senão `grafo_sem_cypher_livre`). O resultado é
hipótese: a guarda protege o banco, não a resposta. Os pontos do `panorama` não têm página.

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

Medida da F7.10 (Neo4j, llama-swap e `uv` no ar): `npm run avaliar:consultar` compara o prompt do Text2Cypher com o do
Python nas 23 perguntas de `eval/golden_agregacao.csv`, mede a execução certa nas 15 dos grupos `ajuste` e `teste` e o
tempo do `panorama` nas 10 perguntas temáticas (~9 minutos; `--somente prompt,cypher,panorama`). A guarda contra o grafo
real é `test/ferramentas/guarda.integracao.test.ts` (pulado sem o Neo4j); a lista das 26 entradas maliciosas está em
`test/ferramentas/guarda.casos.ts`.

Agente (F7.11, ADR-059): `executarAgente(llm, executor, pergunta, { historico, concorrencia, companhia, signal, progresso, complementar, paginasPrimeiro })` em `src/agente/agente.ts` liga o atualizador, o roteador (por ondas, até 2 subperguntas juntas) e o executor, e devolve `subperguntas[]` (rota, chamadas, execuções com tempo, evidências), `evidencias[]` plana e sem repetição, `etapas_ms`, `anotacoes` (falhas de ferramenta, exceções, caminhos seguros) e `uso`. Nada derruba a pergunta; só o `AbortSignal` do chamador sobe. `progresso` recebe os eventos `atualizacao`, `roteamento`, `execucao` e `fim`. `complementar` (ligada por padrão) acrescenta uma `buscar_trechos` a toda rota especializada e `paginasPrimeiro` (ligada) põe as evidências com página antes das sem página na lista plana; as duas são pós-hoc (ADR-059). Medida nas 60 perguntas do golden (Neo4j e llama-swap no ar, ~10 min): `npm run avaliar:agente` (`--v1`, `--complementar`, `--nome`, `--somente`, `--limite`); sai com código 1 se houver erro de infraestrutura ou o page recall for inferior ao do Python, o que acontece hoje.

Crítico (F7.4, ADR-060): `criticar(llm, { pergunta, subperguntas, jaPerguntadas, podeBuscarMais })` em `src/agente/critico.ts` decide `suficiente`, `buscar_mais` (1 a 3 perguntas novas), `ausente` ou `incompleta` e diz em `faltando` o que falta; falha do LLM vira `suficiente` com o motivo. `executarCiclo(llm, executor, pergunta, opcoes)` em `src/agente/ciclo.ts` roda o agente, o crítico e, só se ele pedir, uma rodada extra (`MAX_RODADAS = 2`), e devolve `estado` (`suficiente`, `incompleta`, `ausente`, `sem_consulta`), `faltando`, `rodadas[]`, as `evidencias` das duas rodadas (com a `rodada` de origem) e o evento `critica` no `progresso`. Medida: `npm run avaliar:ciclo` (as 60 do golden, ~20 min) e `-- --ajuste` (16 perguntas fora do golden).

Redator (F7.5, ADR-061): `redigir(llm, { pergunta, estado, faltando, evidencias, historico }, { signal, progresso })` em `src/agente/redator.ts` escreve a resposta em fluxo (eventos `token`, `reparo`, `fim`), com as evidências numeradas `[E1]…[E10]`; o modelo cita por `[E#]` e `textoComPaginas` traz as páginas. Devolve `verificacao` (`afirmacoes_numericas`, `sem_citacao`, `citacoes_invalidas`, `formato_nao_ptbr`, `numeros_sem_lastro`, `declaracoes_de_ausencia`), `reparos` (no máximo 1) e `modo` (`llm` ou `modelo_fixo`, sem LLM para `ausente` e sem evidência). Falha do LLM vira texto fixo ou o parcial marcado como cortado; só o cancelamento sobe. A régua (`src/agente/numeros.ts`) conta número pt-BR, escala escrita e "dois" a "dez". Medida: `npm run avaliar:redator` (`-- --ajuste` para as 16 de ajuste; `-- --reavaliar <nome>` refaz só a verificação sobre textos já gravados).

Erros (`LlmIndisponivelError`, `LlmTimeoutError`, `LlmAbortadoError`, `LlmHttpError`,
`LlmRespostaInvalidaError`) têm uma classe por causa. Só rede e 5xx ganham uma nova tentativa. A primeira
chamada de cada modelo inclui a carga dele (14 s o Qwen). Para rodar a integração:

```powershell
..\infra\swap.ps1          # em outro terminal; ou defina LLAMA_SWAP_URL
npx vitest run test/llm/integracao.test.ts
```
