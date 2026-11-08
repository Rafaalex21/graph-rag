# ADR-066 · Modo rápido (`consultar-rapido`): só a rodada 1, o tempo cai de 19,8 s para 11,6 s (p50) sem perder page recall, mas só 13 de 30 respostas saem completas

- **Estado:** aceita (08/11/2026)
- **Data:** 2026-11-08
- **Tarefa(s):** F7.13

## Contexto

O ciclo completo (ADR-060) pede uma segunda rodada em 62% das perguntas, e ela não melhorou o page recall em nenhuma; o custo é ~12 s (p50) e até 185 s. O RNF-2 (resposta completa em ≤ 20 s para pergunta simples) ficou estourado, e o `POST /api/chat` recusava `profile: "consultar-rapido"` com 400 (ADR-062).

## Decisão

- **`executarCiclo(..., { rapido: true })`** (`api/src/agente/ciclo.ts`): só a rodada 1. O crítico roda uma vez com `podeBuscarMais: false`, o que já existia; um `buscar_mais` vira `incompleta` com o `faltando` dele, que é o que o redator usa para dizer o que não achou. `suficiente`, `ausente` e `sem_consulta` não mudam. Sem a opção (ou `false`) o ciclo é o de antes.
- **`POST /api/chat`** aceita `profile: "consultar-rapido"` e passa `rapido: true` ao ciclo; um perfil que não existe continua 400 (`requisicao_invalida`). O código `perfil_nao_implementado` deixou de existir; `contracts/api.openapi.yaml` foi atualizado.
- **O perfil é de comportamento, não de modelo:** os dois usam o Qwen3.6-35B-A3B. O perfil `consultar-rapido` do `llama-swap.yaml` (gpt-oss-20b) **não** é usado: trocar de modelo custaria uma carga de dezenas de segundos e o gpt-oss nunca foi validado como roteador, crítico ou redator. O aceite da F7.13 pede só "usa só a rodada 1"; o nome do perfil na API coincide com o do `llama-swap` por herança da §11, e a divergência fica registrada aqui.
- **Testes** escritos antes do código (8 novos em `ciclo.test.ts` e `chat.test.ts`): crítico que pede `buscar_mais` não dispara rodada 2 (1 rodada, 1 crítico, 1 atualizador, o crítico recebe o aviso de que não há nova busca) e vira `incompleta` com o `faltando`; `suficiente` e `ausente` iguais; rota `nenhuma` sem crítico; LLM do crítico fora do ar vira `suficiente` anotada; `rapido: false` ou ausente mantém as duas rodadas; o uso de tokens soma uma só rodada; na API, `consultar-rapido` chega ao ciclo como `rapido: true` e `consultar`/padrão como `false`; perfil desconhecido é 400 sem rodar o ciclo. Total da suíte: 842 passam (74 pulados são os de integração).

## Medida

`npm run avaliar:rapido` (`api/src/avaliacao/cli-rapido.ts`; definições no cabeçalho, commitadas em `fcbb507` antes da execução). As **30 perguntas simples do golden** (T01–T15 textuais e N01–N15 numéricas), pipeline inteiro (atualizador → roteador → executor → crítico → redator), Neo4j e llama-swap reais, **cada pergunta nos dois perfis**, um logo depois do outro, com a **ordem alternada** entre perguntas e uma pergunta de aquecimento descartada. Tempo = pergunta inteira até o fim do texto do redator, sem rede nem SSE. Resultado em `eval/resultados/f713-modo-rapido.json`.

| | `consultar` (completo) | `consultar-rapido` |
|---|---|---|
| **Resposta completa em ≤ 20 s** (≤ 20 s **e** estado `suficiente`) | **14 de 30 (46,7%)** | **13 de 30 (43,3%)** |
| Só o tempo ≤ 20 s (qualquer estado) | 15 de 30 (50,0%) | **29 de 30 (96,7%)** |
| Tempo da pergunta inteira p50 / p95 / máx. | 19,8 s / 63,0 s / 115,1 s | **11,6 s** / 17,5 s / 46,7 s |
| Rodadas (1 / 2) | 13 / 17 | 30 / 0 |
| Estados `suficiente` / `incompleta` | 15 / 15 | 13 / 17 |
| **Page recall @1 / @3 / @6** | 0,5333 / 0,6667 / 0,7333 | 0,5333 / 0,6667 / 0,7333 |
| **Queda do page recall @3** | | **0,0000** (30 de 30 perguntas com o mesmo recall; nenhuma perdeu, nenhuma ganhou) |
| Página do gabarito citada pelo redator | 18 de 30 | 17 de 30 |
| Respostas que dizem "não consta" | 16 de 30 | 15 de 30 |
| Erro de infraestrutura | 0 | 0 |

## Como ler isso

- **O tempo resolve.** A diferença p50 é de ~8 s e a de p95 de ~45 s; 29 das 30 perguntas simples respondem em ≤ 20 s. A única que passou (T02, 46,7 s) é uma em que a primeira rodada já foi lenta; T03 levou 115 s no completo e 12,6 s no rápido.
- **O número de "resposta completa" quase não muda, e esse é o ponto principal.** Só 13 a 14 de 30 saem `suficiente` nos dois perfis: o modo rápido acelera as respostas, mas não as torna mais completas, e o ciclo completo também não as torna: a rodada extra reclassificou apenas 2 perguntas de `incompleta` para `suficiente`, e os dois perfis dão ~16 respostas "não consta" para perguntas que o documento responde. O gargalo continua sendo o recuperador/crítico (ADR-060, ADR-065), não o número de rodadas.
- **Recall idêntico em 30 de 30**: coerente com o ADR-060 (a rodada extra não achou páginas novas), mas aqui o recall é das evidências finais do ciclo, não do redator; não mede se a resposta ficou certa.
- **O modo rápido perde 1 resposta completa** (14 → 13): duas perguntas que o completo chegou a `suficiente` na segunda rodada ficaram `incompleta`; nenhuma foi no sentido contrário. Dentro do ruído de n = 30, mas é o único custo visível.

## Consequências e limites ditos

- **n = 30, uma só execução por perfil**; sem intervalo de confiança. Os tempos dependem desta máquina e dos modelos já carregados; o cache de prompt do servidor pode favorecer o segundo perfil de cada par (por isso a ordem alterna, mas não foi medido o efeito). As perguntas simples são as dos conjuntos que já serviram para decidir as versões do agente; o modo rápido em si não foi ajustado depois de ver o resultado.
- **Não medi o modo rápido pela API** (SSE, fila de duas perguntas, telemetria): o tempo é do pipeline no mesmo processo; a API soma poucos ms (ADR-062) e o primeiro evento continua saindo antes do ciclo. A telemetria não registra o perfil usado (o registro `chat` não tem esse campo); acrescentar exigiria nova versão do registro, e fica fora desta tarefa.
- **Perguntas não simples** (agregações, temáticas, multi-hop) não foram medidas no modo rápido; ali a segunda rodada pode pesar mais ou menos, e o `panorama` é o que levava os 185 s do ADR-060.
- O RNF-2 está atendido **no tempo** para perguntas simples no modo rápido (96,7%), mas **não** como "resposta completa" (43,3%): o aceite pede medir e registrar os dois números, e é isso que está aqui.

## Como reproduzir

```powershell
. .\infra\dev-env.ps1
powershell -File infra\neo4j.ps1 iniciar          # e infra\swap.ps1 em outro terminal
cd api
npx vitest run test/agente/ciclo.test.ts test/http/chat.test.ts   # sem banco nem LLM
npm run avaliar:rapido                            # 30 perguntas x 2 perfis, ~25 min
```

As saídas completas ficam em `data/avaliacao/f713-modo-rapido-detalhes.json`, fora do repositório (ADR-009).
