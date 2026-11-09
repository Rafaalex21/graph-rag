# ADR-067 · Rotina diária da telemetria: relatório de ontem, remoção dos logs vencidos só depois do relatório, notas ligadas às perguntas e custo do registrador medido (0,035 ms)

- **Estado:** aceita (09/11/2026)
- **Data:** 2026-11-09
- **Tarefa(s):** F7.14

## Contexto

O ADR-063 deixou quatro dívidas: nada agendava o relatório, os logs cresciam sem limite, as notas do `/api/feedback` só eram contadas (sem ligação com a pergunta, apesar de o `mensagemId` já ser o `id` do registro) e o custo do registrador no tempo de resposta não tinha sido medido.

## Decisão

- **Rotina diária** (`api/src/telemetria/diaria.ts`, `rotacao.ts`; CLI `npm run telemetria:diaria`; script `infra/relatorio-diario.ps1`): gera `relatorio-<ontem>.md` e `.json` e remove os logs com **mais de N dias** (padrão 30: o de 30 dias fica, o de 31 sai). O script carrega o ambiente (`dev-env.ps1`), repassa `-Dias`, `-Simular`, `-Hoje`, `-Pasta`, `-Feedback`, `-Log`, acrescenta a saída a `data/logs/telemetria/diaria.log` e devolve o código de saída (0 certo, 1 erro de relatório ou remoção, 2 argumento inválido).
- **Apagar é a parte perigosa, então as regras são estreitas:**
  - só apaga arquivo cujo nome é `AAAA-MM-DD.jsonl` com data que existe; `feedback.jsonl`, relatórios, `.bak`, nomes com data impossível (`2026-13-45`) e pastas com nome de log ficam;
  - a idade vem do **nome**, em dias de calendário (virada de mês, ano e fevereiro bissexto testados), nunca de horas nem do `mtime`; log com data futura (relógio errado) não vence;
  - **nunca apaga o log de um dia sem o relatório dele**: se falta, gera antes; se não consegue gerar, o log fica (`mantidos_sem_relatorio`) e o erro é dito. Os relatórios, pequenos, não são apagados;
  - `N` inválido (0, negativo, fracionário, NaN) e `hoje` inválido param antes de tocar em qualquer arquivo; `-Simular` só diz o que faria; um arquivo que não dá para apagar não impede os outros e entra em `erros`;
  - sem log de ontem (API não usada, PC desligado) ou sem a pasta **não é erro**; a rodada é idempotente.
- **Notas ligadas** (`relatorio.ts`): cada nota do dia aparece com o registro da pergunta de mesmo `id` (estado, ferramentas, tempo, impressão digital e tamanho da pergunta; o texto só se o log o guardou) ou como "sem registro". A pergunta de ontem recebe a nota de hoje: o relatório lê também o log do dia anterior, só para ligar (não entra nas contagens). Duas notas para a mesma mensagem aparecem as duas; o comentário vem em uma linha, cortado em 200 caracteres, com `|` escapado para não quebrar a tabela. O JSON ganhou `feedback.notas`; o resumo de positivas e negativas continua igual.
- **Agendamento: não registrado.** Rodar sozinho todo dia exige uma tarefa no Agendador do Windows, que muda o sistema; só se faz com o seu aval. O script está pronto para isso e foi testado à mão.

## Resultado

**Testes** (escritos antes do código; 49 novos, 891 passam na API): idade (30 fica, 31 sai; N = 1; virada de ano e bissexto), nomes que parecem log e não são, N e `hoje` inválidos, log do futuro, relatório gerado antes de apagar e log mantido se não gera (um diretório no lugar do arquivo do relatório), sem log de ontem, pasta inexistente, idempotência, `-Simular`, falha ao apagar um arquivo, notas (ligada, sem registro, do dia anterior, duas para a mesma mensagem, pergunta com erro, comentário com `|`/quebra de linha/400 caracteres, texto da pergunta ausente por padrão, registro `http` com o mesmo id). Uma mutação feita à mão: trocar `>` por `>=` na idade derruba 3 testes. O script `.ps1` roda de verdade num teste (5 casos, só no Windows com o Node portátil; o CI Linux pula): remove só o vencido, `-Dias 90` mantém o de agosto, `-Simular` não muda nada, `-Dias 0` e data inválida saem com erro sem apagar.

**Na máquina, com os logs reais** (`-Simular`, sem apagar nada): relatório de 08/11 "sem log nesse dia"; com `-Dias 1` o log de 07/11 aparece como removível; código 0.

**Custo do registrador** (`npm run avaliar:telemetria`, definições fixadas antes de rodar no cabeçalho de `api/test/http/medir-telemetria.ts`, commit `b59f2a7`; `eval/resultados/f714-custo-telemetria.json`): três instâncias da API (sem, sem de novo como controle de ruído, com registrador real), 1.000 requisições medidas por condição e rota depois de 200 de aquecimento, ordem girando entre as 6 permutações, HTTP em 127.0.0.1, ciclo e redator falsos que respondem na hora:

| Rota | sem (p50 / p95) | com (p50 / p95) | diferença p50 / p95 / média | ruído (sem2 − sem) p50 |
|---|---|---|---|---|
| `POST /api/chat` (SSE inteiro) | 0,289 / 0,437 ms | 0,324 / 0,468 ms | **+0,035 / +0,031 / +0,038 ms** | −0,002 ms |
| `GET /api/saude` | 0,171 / 0,226 ms | 0,188 / 0,249 ms | **+0,017 / +0,023 / +0,020 ms** | −0,001 ms |

A fila de gravação esvaziou 21 ms depois da última requisição e as **2.400 linhas esperadas foram gravadas** (nenhuma perdida).

## Como ler isso

- A diferença é real (cerca de 17 vezes o ruído medido, de ±0,002 ms) e de **12% do tempo no dublê** do `/api/chat` e 10% no `/api/saude`, mas em termos absolutos é **35 e 17 microssegundos**: com o ciclo de verdade, a pergunta leva de 10 a 30 s (ADR-065, ADR-066), então o registrador pesa cerca de 0,0002% dela. Foi medido com o dublê de propósito, para que sobrasse só o que a API e o registrador gastam; **não** se mediu o custo em contenção com o LLM e o Neo4j ocupando a CPU.
- A gravação é assíncrona e fora do caminho da resposta; o custo medido é o de montar o registro, serializar e enfileirar (e o de disputar o laço de eventos com a gravação anterior).

## Consequências e limites ditos

- **Nada agenda sozinho ainda.** Sem a tarefa no Agendador, a rotina só roda quando alguém chama o script; os logs só deixam de crescer se for chamado.
- O relatório de ontem só liga notas dadas **hoje ou ontem** a perguntas de **ontem ou anteontem** (lê dois logs); uma nota dada três dias depois da pergunta aparece como "sem registro". Notas com comentário aparecem no relatório (em `data/`, fora do git); relatório com comentário não deve ser versionado.
- A idade conta o nome do arquivo, que é o dia **local** da API; trocar o fuso da máquina entre gravar e limpar pode deslocar um dia.
- Uma só máquina, uma instância da API; o script não trava contra duas rodadas ao mesmo tempo (a segunda regrava o mesmo relatório e tenta apagar o que a primeira já apagou, o que só gera um erro que o código de saída mostra).
- O medidor usa dublês: não prova nada sobre o custo com o pipeline real.

## Como reproduzir

```powershell
. .\infra\dev-env.ps1
cd api
npx vitest run test/telemetria                       # 97 testes (inclui o script .ps1, só no Windows)
npm run avaliar:telemetria                           # ~10 s, sem Neo4j nem llama-swap
cd ..
.\infra\relatorio-diario.ps1 -Simular                # o que faria hoje
.\infra\relatorio-diario.ps1 -Dias 30                # de verdade
```
