# F9.1: medida da escada de ablações A0 a A6 no documento inteiro (definição fixada ANTES de rodar)

Aceite da etapa: "`eval/resultados/v1-ablacao.md` com a escada completa". A F3.5 mediu A0 a A3 só no recorte de 79 páginas (`v0.md`, 54 perguntas). Agora o documento inteiro está indexado (F5.8) e o agente existe (F7), então a escada inteira, A0 a A6, é medida **de novo, nas 60 perguntas do `eval/golden.csv` e no documento inteiro**. O `v0.md` não é tocado: A0 a A3 do v1 são execuções novas, no índice novo, e não comparáveis célula a célula com o v0 (outro índice, outras perguntas contadas).

## Os degraus (ARQUITETURA §13.3)

Mesmo LLM de resposta (Qwen3.6), mesmo juiz (Gemma 4 26B-A4B, raciocínio ligado, temperatura 0, ADR-028) e mesmas métricas (§13.2) em todos.

| Degrau | O que é | Quem responde |
|---|---|---|
| **A0** | LLM sem recuperação (de memória) | Python (`indexer.avaliar`, como no v0) |
| **A1** | vetor ingênuo, 6 Filhos | Python, como no v0 |
| **A2** | + full-text (híbrido RRF), 6 Filhos | Python, como no v0 |
| **A3** | + Pai e reranker (24 Pais → 6) | Python, como no v0 (sem reescrita; a A3r não é refeita) |
| **A3ts** (controle) | só `buscar_trechos` (o método do A3) pelo pipeline do agente em TypeScript: atualizador, roteador restrito a essa ferramenta, executor, **redator da F7.5** | TS, `npm run avaliar:ablacao -- --degrau a3ts` |
| **A4** | A3ts + os 6 templates de fatos (`fato_financeiro`, `serie_metrica`, `comparar_segmentos`, `riscos`, `eventos`, `pessoas_cargos`) + `consultar_grafo` (templates e Text2Cypher) | TS |
| **A5** | A4 + `entidade` (busca local) + `panorama` (busca global) | TS |
| **A6** | o agente completo: as 12 ferramentas (entra `buscar_tabelas`) e o ciclo com o crítico, até 2 rodadas | TS |

O **A3ts existe só para separar efeitos**: A0 a A3 usam o prompt de resposta do Python e A4 a A6 usam o redator do TypeScript (citação por evidência, verificação, reparo). Sem o controle, o salto A3 → A4 misturaria "ferramentas de grafo" com "outro pipeline e outro redator". A3 → A3ts é o efeito da troca de pipeline; A3ts → A4 é o dos fatos e do Text2Cypher.

Detalhes de A3ts a A5: uma rodada do agente, **sem crítico**; o estado entregue ao redator é `sem_consulta` (rota `nenhuma`), `suficiente` (há evidência) ou `ausente` (rota com ferramenta e nenhuma evidência). O complemento de trechos do agente (ADR-059, v3, o padrão) fica ligado em todos os degraus do TS. Em A4 e A5 o roteador só enxerga as ferramentas do degrau (`apenas` no roteador; o plano de reserva dele é `buscar_trechos`, que está em todos). A6 usa o `executarCiclo` e o `redigir` com as opções padrão, como a API.

O **contexto entregue ao juiz** nos degraus do TS é o que o redator viu (as evidências de `selecionar`: até 10, cortadas como ele as corta), e a **resposta julgada** é o texto com as páginas no lugar dos marcadores `[E#]`.

## Perguntas, métricas e como se lê

- **Conjunto principal:** as 60 do `golden.csv` (54 no recorte, 6 fora dele), uma execução por degrau (`v1-a0` … `v1-a6`, `v1-a3ts`), temperatura 0,2 na resposta. **A tabela principal vale para as 60.** Ao lado, as mesmas métricas só nas 54 do recorte (a comparação mais próxima do v0) e a correção das 6 de fora, separadas. Por categoria (6), como no v0.
- **Métricas:** correção (1, 0,5, 0), fidelidade e recall de contexto (juiz), page recall@1/3/6, página citada, acerto numérico (tolerância de 0,5%, regra mecânica), latência p50 e p95 de ponta a ponta, erros do sistema. **Tokens por resposta** (§13.2) seguem fora: o `ask` e o agente não os devolvem em todos os degraus.
- **Grupo novo (checagem de sobreajuste):** os prompts, os templates, o Text2Cypher e o roteador de A4 a A6 foram ajustados olhando as 60 perguntas do `golden.csv` (várias das aceitações anteriores foram escritas ou ajustadas sobre elas, e está registrado). Por isso A4 a A6 são **otimistas** nesse conjunto. Para medir isso, **A3 e A6 também respondem as 24 perguntas do `eval/golden_novas.csv`** (F7.12, escritas depois e fora do ajuste): `v1n-a3` e `v1n-a6`, tabela à parte. Só as duas pontas, por custo; A4 e A5 não rodam no grupo novo.
- **Ordem de grandeza:** com 60 perguntas, uma vale 0,017 de correção; com 24, 0,042. **Diferença menor que 0,05 entre degraus vale como empate** (3 perguntas) e é escrita assim. Uma execução por degrau, sem repetição: o Qwen a 0,2 e o juiz têm variância que não é medida aqui.

## Regra de aceite (fixada agora)

Cumprida só se tudo valer:

1. `eval/resultados/v1-ablacao.md` existe, **gerado por comando** (`uv run python -m indexer.tabela --v1`, a partir dos relatórios `eval/resultados/v1-*.json`), com as linhas A0, A1, A2, A3, A3ts, A4, A5 e A6 e as colunas da §13.2.
2. **Cada degrau respondeu as 60 perguntas.** Uma pergunta em que o sistema falha (exceção, resposta vazia por erro) fica registrada em `erros_do_sistema` e conta como incorreta; **não se refaz para melhorar a nota**. Rodada interrompida por queda de serviço é retomada (as respostas já gravadas ficam) e isso é escrito.
3. O juiz respondeu pelo menos **95% das chamadas** em cada degrau (as que falham são contadas e listadas).
4. **Nada é afinado entre as rodadas** (prompt, limiar, ferramenta, golden, juiz). Só se corrige defeito de infraestrutura que impeça a rodada, e o conserto é registrado com a rodada refeita contada.
5. O que a escada mostra é descrito como saiu, inclusive degrau que **não melhora** ou piora: o aceite é a escada completa e reproduzível, não um sentido de resultado.

Não há aceite pós-hoc de algo que falhou. Se algum item acima não valer, a F9.1 continua `[~]` e o resultado é registrado como saiu.

## Limites já sabidos

- **Golden escrito pelo Claude** (ADR-027) e **rótulos do juiz dados pelo Claude** (ADR-030); só a correção foi calibrada (95% de concordância em 20), a fidelidade e o recall de contexto não. O N01 ("R$ 16,8 bilhões") é correto por decisão do Rafael, mas o juiz o marca incorreta.
- **O A6 mistura efeitos:** além do crítico, entra `buscar_tabelas`. O efeito do crítico sozinho (modo rápido, só a rodada 1) foi medido em outras etapas (F7.4, F7.13), não aqui.
- A latência do A0 a A3 vem do `ask` em Python; a do A3ts a A6 inclui atualizador, roteador, redator e, no A6, o crítico. Não são a mesma coisa e a comparação direta de latência entre as duas famílias é indicativa.
- O A3r (reescrita) não é refeito: ficou desligado por padrão na F3.5.
- As perguntas fora do recorte (6) são poucas demais para uma conclusão por categoria.

## Reprodução

```powershell
# serviços no ar: .\infra\neo4j.ps1 iniciar ; .\infra\swap.ps1
cd indexer
uv run python -m indexer.avaliar executar --nome v1-a0 --degrau a0
uv run python -m indexer.avaliar executar --nome v1-a1 --degrau a1
uv run python -m indexer.avaliar executar --nome v1-a2 --degrau a2
uv run python -m indexer.avaliar executar --nome v1-a3 --degrau a3
cd ..\api
foreach ($d in "a3ts","a4","a5","a6") { npm run avaliar:ablacao -- --degrau $d --nome v1-$d }
cd ..\indexer
foreach ($d in "a3ts","a4","a5","a6") { uv run python -m indexer.avaliar executar --nome v1-$d --degrau $d }
# grupo novo
uv run python -m indexer.avaliar executar --nome v1n-a3 --degrau a3 --golden ../eval/golden_novas.csv
cd ..\api; npm run avaliar:ablacao -- --degrau a6 --nome v1n-a6 --golden eval/golden_novas.csv
cd ..\indexer; uv run python -m indexer.avaliar executar --nome v1n-a6 --degrau a6 --golden ../eval/golden_novas.csv
uv run python -m indexer.tabela --v1
```

## Execuções (preenchido depois de rodar; toda execução é contada)

Execução de desenvolvimento, **fora da medida** (feita antes de fixar este documento, só para ver que a CLI e o juiz leem o `respostas.jsonl` do TypeScript): `v1-fumaca-a4`, A4, T01 e T02 (2 perguntas, 1 chamada de geração e 1 de juiz cada); resultado descartado, relatório e respostas apagados. Nenhuma outra execução até a pré-medida ser commitada.
