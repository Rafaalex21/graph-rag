# ADR-052 · Cliente LLM em TypeScript: SDK da OpenAI fixado, perfis por modelo, erros por causa e uma nova tentativa

- **Estado:** aceita (06/11/2026)
- **Data:** 2026-11-06
- **Tarefa(s):** F7.1

## Contexto

Toda a F7 (atualizador de pergunta, roteador, crítico, redator) fala com o llama-swap por um cliente só. O aceite da F7.1 é **testes de integração para chat, *tool call*, embeddings e rerank**. A API ainda era o esqueleto da F0.8 (Fastify, só `GET /api/saude`).

Medi o que o llama-swap faz hoje (Qwen3.6-35B-A3B, gpt-oss-20b, Qwen3-Embedding e Qwen3-Reranker, Vulkan) antes de decidir:

- O Qwen sem `enable_thinking: false` gasta o teto de tokens pensando; um JSON ou uma chamada de ferramenta chega vazia com `finish_reason: length`. O gpt-oss não tem `enable_thinking`: o raciocínio é `reasoning_effort` e o texto final vem separado em `reasoning_content`.
- `/v1/rerank` não existe no SDK da OpenAI; o formato (`query`, `documents` → `results[].index`, `relevance_score`) é o do indexador Python.
- O SDK, sem `encoding_format`, pede os vetores em base64; o servidor responde em *float*.
- O iterador de fluxo do SDK trata o cancelamento como **fim normal**: um fluxo cortado pelo usuário ou pelo silêncio do servidor parece completo.

## Decisão

`api/src/llm/` (`cliente.ts`, `perfis.ts`, `erros.ts`), sobre o pacote **`openai` 7.43.0** (fixado, sem `^`; é a mais nova com mais de duas semanas, a 7.53 saiu no mesmo dia e o SDK publica várias versões por semana; `npm audit` sem achados).

- **Perfis.** `principal` = `qwen36-35b-a3b` com `chat_template_kwargs: {enable_thinking: false}`, 120 s, 1.024 tokens, temperatura 0; `rapido` = `gpt-oss-20b` com `{reasoning_effort: "low"}`, 60 s. O perfil de carga (`consultar` ou `consultar-rapido`) é escolhido pelo llama-swap pelo modelo pedido; o cliente só diz o modelo. Embeddings de consulta usam `qwen3-embed-0.6b` (CPU) e o reranker `qwen3-rerank-0.6b`; o lote da indexação (`-lote`) é opção, não padrão.
- **Operações.** `chat`, `chatJson` (com `response_format` `json_object` ou, com `esquema`, `json_schema` estrito: a gramática do llama.cpp impede o modelo de sair da forma; aceita cerca ```json e um `validar`), `chamarFerramentas` (declara no formato da OpenAI, devolve `{id, nome, argumentos}` já lidos), `chatStream` (tokens, raciocínio à parte e `fim` com uso), `embeddings` / `embeddingDeConsulta` (prefixo `Instruct:` igual ao do indexador) e `rerank`, mais `modelos`.
- **Tempo-limite e cancelamento.** Cada chamada tem um `AbortSignal.timeout` próprio combinado (`AbortSignal.any`) com o `signal` do chamador; o fluxo tem tempo ocioso entre pedaços (60 s no principal) e total (10 min). Depois do laço do fluxo o cliente confere se o sinal disparou, por causa do iterador que engole o cancelamento.
- **Erros por causa**, todos `LlmErro`: `LlmIndisponivelError` (llama-swap desligado; a mensagem diz `infra\swap.ps1`), `LlmTimeoutError`, `LlmAbortadoError`, `LlmHttpError` (status e a mensagem do servidor, como "request exceeds the available context size") e `LlmRespostaInvalidaError` (JSON quebrado, ferramenta não declarada, vetor com dimensão ou norma erradas, índice do rerank faltando, repetido ou fora do intervalo; leva o texto bruto).
- **Tentativas.** Duas por chamada (uma nova tentativa, com espera): só para rede e 5xx/429. Nunca para tempo-limite (dobraria a espera), cancelamento e 4xx. No fluxo, a nova tentativa vale só até o primeiro pedaço. As tentativas são do cliente, não do SDK (`maxRetries: 0`), para o tempo-limite e o cancelamento valerem para a chamada inteira.
- **Conferência do que volta.** Vetores: 1.024 dimensões e norma 1 ± 1e-3 (o índice `child_vec` é cosseno), quantidade igual à de textos, ordem pelo `index`, lotes de 16 e lista vazia sem requisição. Rerank: uma nota por texto, na ordem de entrada. `chatJson` com resposta vazia e `finish_reason: length` explica que faltou orçamento de tokens, em vez de devolver `undefined`.

## Resultado

47 testes unitários contra um llama-swap de mentira (servidor HTTP de verdade em `127.0.0.1`: corpo, cabeçalhos, atraso, status e SSE) escritos antes do código, e 8 de integração contra o llama-swap real (pulados quando ele não responde, como no CI): 56 testes no total, `lint`, `typecheck` (agora também dos testes) e `build` limpos.

Medido no llama-swap real, pelo próprio cliente:

| Operação | Carga do modelo (1ª chamada) | Regime |
|---|---|---|
| Embedding de consulta (CPU) | 141 ms | **79 ms** (mediana de 7) |
| Rerank de 24 trechos de ~1.600 caracteres (GPU) | 60 ms | **513 ms** (mediana de 5) |
| Chat Qwen, ~60 tokens | **13,9 s** | **1,30 s** (mediana de 5) |
| Fluxo Qwen | — | 1º token em **253 ms**, 93 pedaços em 3,0 s |
| *Tool call* Qwen (`escolha: required`) | — | 1,1 a 2,3 s |
| Chat gpt-oss-20b | 8,9 s | 0,32 s; raciocínio (20 tokens) separado em `raciocinio`, texto `391` |

O Qwen escolheu a ferramenta certa nas três perguntas de teste (`fato_financeiro` para o lucro de 2025, `pessoas_cargos` para o presidente, `buscar_trechos` para "o que o relatório diz"), com os argumentos já em JSON (`{"metrica":"lucro líquido","periodo":"2025"}`). O gpt-oss também chamou `fato_financeiro` para o lucro. Isso não mede a acurácia de rota (F7.3); só mostra que o caminho funciona.

## Alternativas consideradas

- **`fetch` direto, sem SDK**: simples para cinco rotas, mas o SDK já dá o *parser* de SSE, os tipos de mensagem e de ferramenta e a serialização; o que falta (rerank) entra por `sdk.post`. A ARQUITETURA já previa o SDK.
- **Tentativas do SDK (`maxRetries`)**: não dá o mesmo tipo de erro nem respeita o tempo-limite da chamada inteira.
- **Zod no cliente**: fica para o roteador e o crítico (F7.3, F7.4), onde há esquemas de ferramenta a gerar; aqui `validar` aceita qualquer função (inclusive `schema.parse`).
- **Repetir também no tempo-limite**: dobraria a espera do usuário no pior caso; o agente decide se repete.

## Limites

- **A carga a frio é do llama-swap, não do cliente**: 13,9 s no primeiro uso do Qwen. O `timeoutMs` de 120 s a cobre; a F7.6 deve aquecer o modelo ao subir (e o `/api/saude` dizer se está carregado). A primeira pergunta real ainda paga o preenchimento do prompt de sistema sem cache (17 s no Text2Cypher, ADR-051).
- **`reasoning_effort: "low"` no gpt-oss** foi medido em uma pergunta; se o crítico ou o redator o usarem, a qualidade tem de ser medida na F7.4 e na F7.5.
- **Sem telemetria ainda**: o cliente devolve `uso` e `ms` por chamada, mas quem registra é a F7.7.
- **Não há *pool* nem limite de concorrência**: o Qwen roda com `-np 2` (duas requisições simultâneas); o agente da F7.3 que lançar ferramentas em paralelo deve respeitar isso.
- O SDK publica versões a cada poucos dias; a atualização é manual e pelo `package-lock.json`.
