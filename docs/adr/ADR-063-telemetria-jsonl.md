# ADR-063 · Telemetria em JSONL: um registro por requisição, sem o texto da pergunta nem da resposta, e um relatório diário gerado dos logs

- **Estado:** aceita (07/11/2026)
- **Data:** 2026-11-07
- **Tarefa(s):** F7.7

## Contexto

O aceite da F7.7 é: relatório diário gerado a partir dos logs. A API (ADR-062) não guardava nada além do `feedback.jsonl`; não havia como saber quantas perguntas terminaram em erro, que ferramentas o agente mais chama, quanto tempo cada etapa leva ou quantos tokens o dia custou. O ADR-062 também deixava um buraco: o `mensagemId` do feedback era escolhido pelo cliente, sem ligação com nada do servidor.

## Decisão

- **Uma linha JSON por requisição**, em `data/logs/telemetria/AAAA-MM-DD.jsonl` (o dia é o **local**, não o UTC; o `ts` de cada linha é UTC). Dois tipos, validados por Zod (`src/telemetria/tipos.ts`, `v: 1`):
  - `chat` (uma por `POST /api/chat`): `resultado` (`fim`, `erro`, `cancelada` ou `recusada`), `codigo`, `estado` do ciclo, rodadas, **ferramentas** (nome, chamadas, erros, evidências e tempo somado, da mais chamada à menos), evidências, anotações por tipo, **tokens** (ciclo + redator), modo do redator (`llm` ou `modelo_fixo`, reparos, cortada, fallback) e a **latência** total, do primeiro evento, do primeiro token e de cada etapa (atualizador, roteador, ferramentas, crítico, redator);
  - `http` (as demais rotas): método, **padrão da rota** (`/api/fonte/:id`, `/api/grafo/vizinhanca`), status e tempo. Rota que não existe vira `desconhecida`; se fosse a URL pedida, cada URL inventada seria uma linha do relatório. A requisição que o Fastify recusa antes do handler do chat (JSON quebrado) entra como `http` em `/api/chat`.
- **Privacidade (RNF-1, ADR-009).** O log fica na máquina e **não guarda o texto da pergunta, da resposta nem das evidências**, nem a mensagem do erro real (pode trazer trecho do documento): só o tamanho da pergunta e uma impressão digital (sha256 do texto em minúsculas e sem espaços sobrando, 16 hex), que serve para contar perguntas repetidas. `TELEMETRIA_TEXTO=1` liga o texto da pergunta (só ele). O `id` e a query das rotas comuns também não vão.
- **O `id` do registro é o `mensagemId`.** O evento `fim` ganhou `mensagemId` (obrigatório no `contracts/api.openapi.yaml`), um UUID gerado pelo servidor; é o que o cliente manda em `POST /api/feedback`. Isso fecha o buraco do ADR-062.
- **Nunca atrasa nem derruba a resposta** (`src/telemetria/registro.ts`): `registrar` põe a linha numa fila de promessas **em série** (duas gravações ao mesmo tempo no mesmo arquivo poderiam se misturar) e volta na hora; falha de gravação (disco cheio, pasta que não dá para criar) vai para `registrarErro("telemetria", e)` e a fila segue; um registrador que **lança** dentro do handler é capturado. `aguardar()` esvazia a fila no desligamento da API (`SIGINT`/`SIGTERM`).
- **Um registro por requisição.** O `/api/chat` grava no `finally` do handler (o resultado vai de `cancelada`, o valor inicial, para `fim` ou `erro`) e as recusas (400, 429, 503) gravam `recusada` com o código; um `WeakSet` impede que o gancho `onResponse` das demais rotas grave um segundo registro para a mesma requisição.
- **O relatório** (`src/telemetria/relatorio.ts`, funções puras; CLI `npm run relatorio:telemetria -- --dia AAAA-MM-DD`) lê o `.jsonl` do dia, **descarta e conta** a linha que não confere com o esquema (JSON quebrado, versão ou tipo desconhecido, campo faltando) em vez de virar `NaN`, e grava `relatorio-AAAA-MM-DD.md` e `.json` ao lado do log. Traz: perguntas por resultado, estado e código; tokens das respondidas; p50, p95 e máximo do tempo de cada etapa (percentil por *nearest-rank*; só das que terminaram em `fim`); por ferramenta, perguntas, chamadas, erros, taxa de erro e ms por chamada; redator (reparos, cortadas, texto fixo, fallbacks); demais rotas por padrão, com status e tempo; e as notas (positivas e negativas) do `feedback.jsonl` com `ts` naquele dia. Sem log do dia, o CLI sai com código 1.

## Resultado

**Testes** (escritos antes do código): 48 novos (861 → 909 na API com o Neo4j e o llama-swap no ar). Modos de falha cobertos: fila serial com gravação lenta (ordem preservada), pasta que não pode ser criada (não lança, avisa, a próxima linha ainda grava), virada de dia local, registrador que lança, um (e só um) registro por requisição em `fim`, `erro`, `cancelada` e `recusada` (400, 429), segredo da pergunta, da resposta, da evidência e do erro ausente do JSON, `mensagemId` igual ao `id`, rota pelo padrão sem o id nem a query, URL inventada como `desconhecida`; no relatório, log vazio, linha quebrada, CRLF, linha vazia, versão e tipo desconhecidos, percentil de lista vazia, de um elemento e de 100, ferramentas ordenadas, `null` como "—", nunca `NaN`/`undefined`/`null` no Markdown, saída determinística.

**Medida com a API, o Neo4j e o llama-swap reais** (nove perguntas completas do `avaliar:api` + 3 recusas, 2 cancelamentos, 1 JSON quebrado e as demais rotas; relatório em `eval/resultados/f77-relatorio-2026-11-07.json` e `.md`):

| | |
|---|---|
| Registros do dia | 14 de `chat` (9 `fim`, 3 `recusada`, 2 `cancelada`) e 39 de `http` |
| Registros por requisição | 1 para cada uma das 53 requisições; a 3ª pergunta simultânea → `recusada`/`ocupado`; o JSON quebrado → `http` em `/api/chat` 400 |
| Telemetria × cliente de medição, nas 9 respondidas | estado igual em 9 de 9; tempo até o `fim` e até o 1º `token` diferem em **1 a 3 ms** (36 ms e 34 ms na 1ª, que pegou o modelo recém-aquecido) |
| Tempo da pergunta inteira (n = 9) | p50 16,2 s, p95 44,3 s |
| Tokens das 9 | 85.763 de entrada, 2.933 de saída |
| Ferramentas | `buscar_trechos` 16 chamadas, 0 erros; `fato_financeiro` 3 chamadas, 1 erro; `consultar_grafo` 2 chamadas, ~3,6 s a mediana por chamada |
| Notas | 2 positivas (a do `avaliar:api` e a que mandei ligada ao `mensagemId` de uma pergunta do log) |

## Consequências

- **Aceite atendido como escrito:** o relatório do dia é gerado só a partir dos logs reais e confere com o que o cliente viu. "Diário" é por dia: **nada o agenda**, rode o CLI (ou um agendador do Windows) uma vez por dia.
- **A soma das etapas pode passar do tempo da pergunta** (4 das 9: p. ex. 28,7 s de etapas para 24,8 s de relógio), porque o roteador e as ferramentas somam as subperguntas, que rodam ao mesmo tempo (`etapas_ms` do agente). Para tempo de relógio use "pergunta inteira"; o relatório diz isso embaixo da tabela. Não separei o tempo de relógio de cada etapa.
- **A impressão digital não anonimiza:** perguntas curtas e conhecidas (as do golden) podem ser reconhecidas por quem tiver o dicionário. Ela evita guardar o texto, não é um segredo. Com `TELEMETRIA_TEXTO=1` o texto da pergunta fica em claro no log; o padrão é desligado.
- **Limites ditos:** o relatório conta as notas do dia mas **não as liga à pergunta** (o `mensagemId` permite, ainda não é feito); não há rotação nem limpeza dos logs (um arquivo por dia, crescem sem limite); uma só instância da API grava (sem trava entre processos); o custo do registrador no tempo de resposta **não foi medido** (a gravação é assíncrona e fora do caminho da resposta, mas não comparei com e sem); `cancelada` registra o instante em que o handler terminou depois do aborto, que pode ser depois da desconexão do cliente; o relatório lê um dia por vez e o `ms` de ferramentas é da média por chamada em cada pergunta, não de cada chamada. Os 53 registros são de uma sessão de teste, não de uso; os percentis de n = 9 mostram o formato do relatório, não a latência típica.

## Como reproduzir

```powershell
cd api
npx vitest run test/telemetria test/http          # registro, relatório e ligação nas rotas, com dublês
npm run build; npm start                          # grava em data/logs/telemetria/AAAA-MM-DD.jsonl (TELEMETRIA_DIR muda a pasta)
npm run avaliar:api -- --pular --nome f77-fluxo   # 9 perguntas completas (apaga-se o f77-fluxo.json; não é versionado)
npm run relatorio:telemetria -- --dia 2026-11-07 --feedback <arquivo de notas>
```

O relatório versionado (`eval/resultados/f77-relatorio-2026-11-07.json` e `.md`) tem só contagens, nomes de ferramentas e tempos; o log bruto fica em `data/` (fora do git).
