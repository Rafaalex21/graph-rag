# ADR-059 · Agente em ondas (atualizador → roteador → executor) em TypeScript: as 60 perguntas executam sem erro de infraestrutura, mas o page recall ficou abaixo do Python em três rodadas (a terceira empata em @6 e fica 2 perguntas abaixo em @1)

- **Estado:** proposta (07/11/2026): o critério de page recall do aceite **não foi atendido**; a F7.11 fica `[~]`
- **Data:** 2026-11-07
- **Tarefa(s):** F7.11

## Contexto

As três peças do pipeline da §7.1 já existiam separadas: o atualizador ([ADR-053](ADR-053-atualizador-de-pergunta.md)), o roteador ([ADR-054](ADR-054-roteador-tool-calling.md)) e o executor com as 12 ferramentas em TypeScript ([ADR-056](ADR-056-templates-cypher-em-typescript.md), [057](ADR-057-buscas-em-typescript.md), [058](ADR-058-consultar-grafo-e-panorama-em-typescript.md)). Faltava a cola: um agente que recebe a pergunta e devolve, por subpergunta, a rota, as chamadas, o que cada ferramenta respondeu e as evidências. O aceite da F7.11 é: as 60 perguntas do golden executam ponta a ponta sem erro de ferramenta, com a rota e o tempo de cada etapa registrados, e o page recall não é inferior ao do Python.

## Decisão

`api/src/agente/agente.ts`, função `executarAgente(llm, executor, pergunta, opcoes)`:

- Atualizador → `rotearSubperguntas` por ondas (independentes até 2 juntas, o `-np 2` do Qwen; dependentes depois, com o resumo da resposta anterior, `resumirEvidencias`: 3 evidências com texto, cada uma cortada em 180 caracteres e o total em 600). As chamadas de uma subpergunta rodam em paralelo.
- Nada derruba a pergunta: ferramenta que devolve `erro` ou lança vira evidência vazia **anotada** (`erro_da_ferramenta`, `excecao`, `fallback_do_atualizador`, `fallback_do_roteador`, `chamada_descartada`, cada uma com subpergunta e ferramenta). Só o cancelamento do chamador (`LlmAbortadoError`) sobe. Pergunta vazia volta `erro: "pergunta_vazia"` sem chamar o LLM.
- Saída: `subperguntas[]` (rota, chamadas, execuções com tempo próprio, evidências marcadas com a subpergunta e a ferramenta) e `evidencias[]` plana, sem repetição (tipo + id), **na ordem das subperguntas e das chamadas** (não na de quem terminou antes); tempo por etapa (`atualizar`, `rotear`, `executar`, `total`), eventos de progresso (`atualizacao`, `roteamento`, `execucao`, `fim`) para o SSE da F7.6 e uso de tokens.
- **Opção `complementar` (pós-hoc, ligada por padrão desde a v3):** acrescenta uma chamada a `buscar_trechos` (com a subpergunta) a toda rota que não a tem e não é `resposta_ja_dada`, em paralelo, com as evidências dela **depois** das da ferramenta escolhida. Foi introduzida **depois** de ver o resultado da primeira rodada (abaixo).
- **Opção `paginasPrimeiro` (pós-hoc, ligada por padrão desde a v3):** na lista plana `evidencias`, as evidências com página vêm antes das sem página, em ordem estável dentro de cada grupo; as evidências de cada subpergunta não são reordenadas. Decidida depois de ver as rodadas 1 e 2, porque o redator só cita página.

A medida é `npm run avaliar:agente` (`api/src/avaliacao/cli-agente.ts`), com as definições fixadas antes da primeira rodada: "sem erro de ferramenta" = nenhuma exceção e nenhum erro de *infraestrutura* (`falha na ferramenta`, `llm_nao_configurado`, `ferramenta_desconhecida`, `ferramenta_nao_portada`, `grafo_sem_cypher_livre`, `falha_na_selecao`, `falha_no_esquema`); erro de *domínio* (a ferramenta rodou e disse que não achou) é contado à parte; page recall sobre a lista plana na ordem em que sai, nas mesmas 55 perguntas da F7.9, @1/@3/@6, "não inferior" = TypeScript ≥ Python nos três k (Python: 0,4727 / 0,5788 / 0,6273, `eval/resultados/f79-busca.json`).

## Resultado

| | v1 (`f711-agente-v1`, medida pré-registrada) | v2 (`--complementar`, pós-hoc) | v3 (padrão atual: complemento + páginas primeiro, pós-hoc) |
|---|---|---|---|
| Sem exceção / sem erro de infraestrutura | 60/60 / 60/60 | 60/60 / 60/60 | 60/60 / 60/60 |
| Sem nenhum erro de ferramenta (estrito) | 57/60 | 57/60 | 57/60 |
| Erros de domínio | 3 × `fato_financeiro:metrica_desconhecida` (N03, N04, N13) | os mesmos 3 | os mesmos 3 |
| Rota (aceita / estrita, informativa) | 54/60 / 33/60 | 54/60 / 33/60 (a rota do roteador não muda) | 54/60 / 33/60 |
| Tempo total p50 / máx. | 4,9 s / 51,7 s | 4,7 s / 47,4 s (P03, `panorama`) | 4,9 s / 50,2 s (P03) |
| **Page recall @1 / @3 / @6** (Python 0,4727 / 0,5788 / 0,6273) | **0,3273 / 0,4000 / 0,4091** | **0,3636 / 0,4727 / 0,5364** | **0,4364 / 0,5697 / 0,6273** |
| Não inferior ao Python | **não** | **não** | **não** (@6 igual; @1 e @3 abaixo) |
| Recall sobre todas as evidências (média de evidências) | 0,4182 (4,7) | 0,6909 (9,0) | 0,6909 (9,0) |

Da v2 para a v3, @1 melhora em 4 perguntas, @3 em 6 e @6 em 5, sem piora em nenhuma. Python: 0,4727 / 0,5788 / 0,6273. A v3 iguala o Python em @6 e fica 0,036 abaixo em @1 (2 perguntas em 55) e 0,009 em @3 (uma pergunta em 55, que vale 0,018, quase um empate). Como o critério é TypeScript ≥ Python nos três k, **continua não atendido**. A lista de evidências, o `recall` por pergunta e os tempos são os mesmos números da v2 em tudo que não é ordem (a v3 só reordena).

## Consequências

- **O critério de execução está atendido; o de page recall, não, nas três rodadas.** A F7.11 não é marcada `[x]`.
- **Por que o recall fica abaixo (diagnóstico, não prova):** o baseline do Python é só `buscar_trechos`, e o agente manda 39 das 55 perguntas por ferramentas especializadas. As evidências do `panorama` não têm página (P03, P05, P06, P07, T02, T10), `consultar_grafo` só cita página se a consulta devolve a coluna `pagina` (T04 voltou sem evidência), `fato_financeiro` com métrica desconhecida volta vazio (N03, N13) e `buscar_tabelas`, `pessoas_cargos` e `riscos` devolvem páginas que podem diferir das do gabarito. Nas 16 perguntas só de `buscar_trechos`, o recall é 0,625 em todos os k nas duas rodadas. A métrica compara a ordem de uma lista que mistura fontes de tipos diferentes com a de uma busca única; o recall sobre todas as evidências (0,69 com complemento) mostra que as páginas do gabarito aparecem, só que depois do sexto item.
- **A v2 e a v3 são pós-hoc.** As duas mudanças foram pensadas depois de ver os resultados anteriores, nas mesmas 55 perguntas; a ordem do complemento (depois da ferramenta escolhida) e "página primeiro" são escolhas minhas. Cada rodada mudou uma coisa só (v2: complemento; v3: ordem) e não houve variação de parâmetros: são três rodadas, as três estão no repositório e a v1 nunca foi substituída. A v3 é o melhor resultado de 55 perguntas já usadas para decidir as mudanças; não é medida independente, e chegar a ≥ Python em @6 depois de dois ajustes mostra o que o ajuste conseguiu, não o que se esperaria em perguntas novas.
- **Decisão que fica com o dono do projeto:** o dono pediu para melhorar o agente (v3). Falta pouco no critério literal (2 perguntas em @1, 1 em @3). Opções: (a) aceitar a v3 como "equivalente ao Python em @6 e a menos de uma pergunta e meia nos outros", o que muda o aceite e deve ser registrado como pós-hoc; (b) mais uma melhoria do agente, o que passa a ser ajustar sobre as mesmas 55 perguntas e pede um grupo novo de perguntas para valer como medida; (c) redefinir a métrica. Até haver decisão, a F7.11 fica `[~]`. Os padrões do agente são os da v3.
- Os tempos incluem o modelo já carregado; a primeira chamada ao Qwen após subir o llama-swap leva ~14 a 33 s a mais.
- O agente só recupera; crítica (F7.4) e redação (F7.5) vêm depois.

## Como reproduzir

```powershell
.\infra\neo4j.ps1 iniciar
.\infra\swap.ps1                           # em outro terminal
cd api
npx vitest run test/agente/agente.test.ts   # sem banco nem LLM (dublês)
npm run avaliar:agente -- --v1 --nome f711-agente-v1                    # sem complemento, ordem de origem
npm run avaliar:agente -- --complementar --nome f711-agente-v2          # só o complemento
npm run avaliar:agente -- --nome f711-agente-v3                         # padrão atual
```

A v1 foi feita antes de as opções existirem (mesmo código, sem elas) e está versionada como `eval/resultados/f711-agente-v1.json`; `--v1` a reproduz. As três rodadas estão em `eval/resultados/f711-agente-v1.json`, `-v2.json` e `-v3.json`. As saídas completas ficam em `data/avaliacao/<nome>-detalhes.json`, fora do repositório (ADR-009).
