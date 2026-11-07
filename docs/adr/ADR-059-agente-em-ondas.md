# ADR-059 · Agente em ondas (atualizador → roteador → executor) em TypeScript: as 60 perguntas executam sem erro de infraestrutura, mas o page recall ficou abaixo do Python, com e sem complemento

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
- **Opção `complementar` (pós-hoc, desligada por padrão):** acrescenta uma chamada a `buscar_trechos` (com a subpergunta) a toda rota que não a tem e não é `resposta_ja_dada`, em paralelo, com as evidências dela **depois** das da ferramenta escolhida. Foi introduzida **depois** de ver o resultado da primeira rodada (abaixo).

A medida é `npm run avaliar:agente` (`api/src/avaliacao/cli-agente.ts`), com as definições fixadas antes da primeira rodada: "sem erro de ferramenta" = nenhuma exceção e nenhum erro de *infraestrutura* (`falha na ferramenta`, `llm_nao_configurado`, `ferramenta_desconhecida`, `ferramenta_nao_portada`, `grafo_sem_cypher_livre`, `falha_na_selecao`, `falha_no_esquema`); erro de *domínio* (a ferramenta rodou e disse que não achou) é contado à parte; page recall sobre a lista plana na ordem em que sai, nas mesmas 55 perguntas da F7.9, @1/@3/@6, "não inferior" = TypeScript ≥ Python nos três k (Python: 0,4727 / 0,5788 / 0,6273, `eval/resultados/f79-busca.json`).

## Resultado

| | 1ª rodada (`f711-agente-v1`, medida pré-registrada) | 2ª rodada (`f711-agente-v2`, `--complementar`, pós-hoc) |
|---|---|---|
| Sem exceção / sem erro de infraestrutura | 60/60 / 60/60 | 60/60 / 60/60 |
| Sem nenhum erro de ferramenta (estrito) | 57/60 | 57/60 |
| Erros de domínio | 3 × `fato_financeiro:metrica_desconhecida` (N03, N04, N13) | os mesmos 3 |
| Rota (aceita / estrita, informativa) | 54/60 / 33/60 | 54/60 / 33/60 (a rota do roteador não muda) |
| Tempo total p50 / máx. | 4,9 s / 51,7 s | 4,7 s / 47,4 s (P03, `panorama`) |
| **Page recall @1 / @3 / @6** (Python 0,4727 / 0,5788 / 0,6273) | **0,3273 / 0,4000 / 0,4091** | **0,3636 / 0,4727 / 0,5364** |
| Não inferior ao Python | **não** | **não** |
| Recall sobre todas as evidências (média de evidências) | 0,4182 (4,7) | 0,6909 (9,0) |

Com a opção, @1 melhora em 2 perguntas, @3 em 4 e @6 em 8 (piora uma em @6); nenhum k alcança o Python.

## Consequências

- **O critério de execução está atendido; o de page recall, não, nas duas rodadas.** A F7.11 não é marcada `[x]`.
- **Por que o recall fica abaixo (diagnóstico, não prova):** o baseline do Python é só `buscar_trechos`, e o agente manda 39 das 55 perguntas por ferramentas especializadas. As evidências do `panorama` não têm página (P03, P05, P06, P07, T02, T10), `consultar_grafo` só cita página se a consulta devolve a coluna `pagina` (T04 voltou sem evidência), `fato_financeiro` com métrica desconhecida volta vazio (N03, N13) e `buscar_tabelas`, `pessoas_cargos` e `riscos` devolvem páginas que podem diferir das do gabarito. Nas 16 perguntas só de `buscar_trechos`, o recall é 0,625 em todos os k nas duas rodadas. A métrica compara a ordem de uma lista que mistura fontes de tipos diferentes com a de uma busca única; o recall sobre todas as evidências (0,69 com complemento) mostra que as páginas do gabarito aparecem, só que depois do sexto item.
- **A 2ª rodada é pós-hoc.** A opção foi pensada depois de ver o resultado da 1ª, nas mesmas 55 perguntas, e a ordem (complemento depois da ferramenta escolhida) é uma escolha minha; ela não reprova nem aprova o aceite, só mostra quanto do déficit vem de evidência sem página. Nenhum parâmetro foi variado para chegar a um número: foram duas rodadas, as duas estão no repositório e a 1ª nunca foi substituída.
- **Decisão que fica com o dono do projeto:** (a) manter o aceite como está e melhorar o agente (por exemplo, o complemento por padrão e/ou colocar os trechos com página antes das evidências sem página), medindo outra vez, ou (b) redefinir a métrica para o que o redator da F7.5 realmente recebe (recall sobre todas as evidências, ou por tipo de rota), registrando a mudança como pós-hoc. Até lá o `complementar` fica desligado.
- Os tempos incluem o modelo já carregado; a primeira chamada ao Qwen após subir o llama-swap leva ~14 a 33 s a mais.
- O agente só recupera; crítica (F7.4) e redação (F7.5) vêm depois.

## Como reproduzir

```powershell
.\infra\neo4j.ps1 iniciar
.\infra\swap.ps1                           # em outro terminal
cd api
npx vitest run test/agente/agente.test.ts   # sem banco nem LLM (dublês)
npm run avaliar:agente -- --nome f711-agente-v1
npm run avaliar:agente -- --complementar --nome f711-agente-v2
```

A 1ª rodada foi feita antes de a opção existir (mesmo código, sem ela) e está versionada como `eval/resultados/f711-agente-v1.json`; o comando acima, sem `--complementar`, a reproduz. As saídas completas ficam em `data/avaliacao/<nome>-detalhes.json`, fora do repositório (ADR-009).
