# ADR-060 · Crítico com uma rodada extra: o teto de duas rodadas e as recusas passam, mas o crítico pede busca em 62% das respondíveis e a rodada extra não melhorou o page recall em nenhuma

- **Estado:** aceita (07/11/2026)
- **Data:** 2026-11-07
- **Tarefa(s):** F7.4

## Contexto

O aceite da F7.4 é: nenhuma conversa ultrapassa duas rodadas, e os casos "ausente" são respondidos como ausentes. A §7.1 da arquitetura descreve o crítico como um passo que devolve as perguntas que faltam; lista vazia encerra, no máximo uma rodada extra, e depois o agente responde com o que tem e diz o que faltou. O agente da F7.11 ([ADR-059](ADR-059-agente-em-ondas.md)) só recupera; faltava decidir se o que recuperou basta.

## Decisão

- **`api/src/agente/critico.ts`**, função `criticar(llm, entrada)`: lê a pergunta e, por subpergunta, as evidências (até 4 por subpergunta, 350 caracteres cada, 7.000 no total, com a página) e os erros das ferramentas. Devolve JSON `{decisao, perguntas, faltando}`:
  - `suficiente`: as evidências têm o que a pergunta pede;
  - `buscar_mais`: deveria estar no documento e não veio; vêm de 1 a 3 perguntas novas, que se entendem sozinhas e diferem das já feitas (repetidas, curtas demais ou iguais a uma já perguntada saem);
  - `ausente`: o documento não trata do assunto; o redator deve dizer que não consta e não se insiste na busca;
  - `incompleta` (nunca vem do LLM): ele quis buscar mais e não deu (última rodada, sem pergunta, sem pergunta nova), com o motivo em `fallback`.
  Se o LLM falha ou responde fora do esquema, a decisão é `suficiente` com o motivo (`llm_falhou` ou `resposta_invalida`), de propósito: pedir nova busca numa falha viraria laço. Só o cancelamento do chamador sobe. O texto das evidências é dado de um documento: vai entre tags que ele não consegue fechar e o sistema diz que é dado, não instrução.
- **`api/src/agente/ciclo.ts`**, função `executarCiclo(llm, executor, pergunta, opcoes)`: rodada 1 do agente → crítico → só se pedir `buscar_mais`, **uma** rodada extra com as perguntas do crítico (sem repetir o atualizador: opção `subperguntas` do agente) → última crítica, que já não pode pedir mais. `MAX_RODADAS = 2` por construção: não há laço. Estados finais: `suficiente`, `incompleta`, `ausente`, `sem_consulta` (rota `nenhuma`: saudação, fora do escopo ou pergunta vazia; o crítico nem roda). Junta as evidências das duas rodadas sem repetição, com a rodada de origem e as com página primeiro (opção `paginasPrimeiro`, ligada, como na F7.11), anota as falhas por rodada, soma o tempo do crítico em `etapas_ms.criticar` e emite o evento `critica` (e a rodada em todos os eventos) para o SSE da F7.6.

Medida: `npm run avaliar:ciclo` (`api/src/avaliacao/cli-ciclo.ts`), com as definições fixadas antes de rodar o golden (no cabeçalho do arquivo). O prompt foi escrito e verificado só com 16 perguntas de ajuste fora do golden (`eval/critico_ajuste.json`; os rótulos das respondíveis são palpite), sem nenhuma revisão depois da primeira rodada do ajuste.

## Resultado

Golden, 60 perguntas, Neo4j e llama-swap reais (`eval/resultados/f74-critico.json`):

| | |
|---|---|
| **Rodadas** | máximo 2; 26 perguntas com 1 rodada, 34 com 2 |
| **Ausente** | as 5 recusas (F01–F05) terminam em `sem_consulta` (5/5), nenhuma pediu rodada extra |
| Erro de infraestrutura | 0 em 60 |
| Respondíveis (55) | `suficiente` 27, `incompleta` 28; **`ausente` por engano: 0**; o crítico pediu busca em 34 (62%) |
| Page recall do ciclo (@1/@3/@6) | 0,4545 / 0,5515 / 0,6091 (agente da F7.11 v3: 0,4364 / 0,5697 / 0,6273) |
| Das 34 com rodada extra: recall antes → depois | 0,2941 / 0,4216 / 0,5000 → **o mesmo**, em @1, @3 e @6 |
| Tempo por pergunta (p50 / máx.) | 16,9 s / 185,3 s (o agente sozinho: 4,9 s / 50,2 s) |
| Tempo do crítico (p50 / máx.) | 7,6 s / 10,6 s |

Ajuste (16 perguntas fora do golden): as 6 ausentes de assuntos gerais e 3 de 4 ausentes próximas do documento são recusadas pelo **roteador** (rota `nenhuma`); uma (A10) chegou ao crítico e saiu `ausente`. Das 6 respondíveis, 3 saíram `suficiente` e 3 `incompleta`.

## Consequências

- **O aceite está atendido nos dois pontos, mas o segundo é, na prática, mérito do roteador.** As cinco recusas do golden chegam como rota `nenhuma` (o roteador reconhece "fora do escopo", mesmo quando a pergunta cita outra empresa, cotação ou preço-alvo) e o crítico nem roda. O caminho `ausente` do crítico só foi exercido em 1 pergunta do ajuste (A10), e as categorias de ausência do prompt foram escritas sabendo que o golden tem recusas desses tipos. Ou seja: está provado que a recusa funciona no sistema; não está provado que o crítico, sozinho, recusa bem.
- **O crítico é conservador demais para o que o recuperador entrega.** Ele pediu mais busca em 34 de 55 respondíveis (62%) e terminou `incompleta` em 28 (51%). Lendo as justificativas (`data/avaliacao/`, fora do repositório), a maioria é pertinente: a evidência é a descrição de uma tabela sem o número (N09, funcionários), o trecho é de outro órgão (T13, Conselho de Administração) ou o recuperador trouxe passagens vizinhas e não a certa (N10, participação na BB Seguridade). Em G03 ele ignorou uma linha do grafo (`total=1096`) por não trazer o rótulo. Ou seja, o crítico mede a fraqueza do recuperador, mais do que a corrige.
- **A rodada extra não ajudou.** Nas 34 perguntas em que rodou, o page recall em @1, @3 e @6 ficou idêntico ao da rodada 1 (as perguntas novas são paráfrases da original, e a busca devolve as mesmas passagens), e o custo foi de ~12 s (p50) por pergunta, com máximo de 185 s quando a segunda rodada reexecuta o `panorama` (P03, P05, P06). Isso estoura o RNF-2 (resposta completa ≤ 20 s para pergunta simples) assim que se somar o redator, e o RNF-3 (≤ 90 s para busca global) nas perguntas temáticas.
- **Estado `incompleta` é útil mesmo sem a rodada extra:** o redator da F7.5 pode usar `faltando` para dizer o que não achou, em vez de afirmar. O que não está medido é se `incompleta` corresponde a respostas de fato erradas ou faltantes (isso é da F7.5 e da F9).
- **Limites da medida:** o recall de antes e depois é nas 34 perguntas em que a rodada extra rodou, e 'antes' e 'depois' vêm da mesma execução; as 55 respondíveis já tinham servido para decidir as mudanças da F7.11, mas o prompt do crítico foi escrito sem elas. O ajuste tem 16 perguntas, rótulos de palpite e uma só ausente que chegou ao crítico.
- **Em aberto para a F7.5/F7.6:** a latência pede uma escolha de configuração entre o ciclo completo e um modo rápido que roda só a rodada 1 e usa o crítico apenas para dizer o que faltou (uma chamada de ~7 s, com `podeBuscarMais: false`). O modo rápido não foi implementado nem medido aqui; o ciclo completo é o que a tarefa pede.

## Como reproduzir

```powershell
.\infra\neo4j.ps1 iniciar
.\infra\swap.ps1                           # em outro terminal
cd api
npx vitest run test/agente/critico.test.ts test/agente/ciclo.test.ts   # sem banco nem LLM (dublês)
npm run avaliar:ciclo -- --ajuste          # 16 perguntas fora do golden, ~3 min
npm run avaliar:ciclo                      # as 60 do golden, ~20 min
```

Os relatórios versionados são `eval/resultados/f74-critico.json` (golden), `f74-critico-ajuste.json` e `f74-critico-ajuste-b.json` (ajuste; o segundo só com A07–A10). As saídas completas ficam em `data/avaliacao/<nome>-detalhes.json`, fora do repositório (ADR-009).
