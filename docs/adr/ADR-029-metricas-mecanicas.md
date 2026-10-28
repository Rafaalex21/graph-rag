# ADR-029 · Métricas mecânicas: page recall@k, acerto numérico e latência

- **Estado:** aceita (28/10/2026)
- **Data:** 2026-10-28
- **Tarefa(s):** F3.3

## Contexto

O aceite da F3.3 é um relatório único por execução em `eval/resultados/`. As três métricas do juiz (F3.2, [ADR-028](./ADR-028-metricas-com-juiz-local.md)) dizem se a resposta é boa, mas não onde o pipeline falha: a ARQUITETURA §13.2 pede também **page recall@k** (o gargalo apontado pelo estudo com FinanceBench), **acerto numérico** com tolerância de 0,5% e **latência p50/p95**. Essas três não precisam de LLM: saem do que a F3.2 já grava.

## Decisão

1. **Módulo `indexer/src/indexer/metricas.py`**, sem LLM, calculado a partir de `respostas.jsonl`. Isso permite refazer o relatório de uma execução antiga sem rodar nada (`python -m indexer.avaliar relatorio --nome N`).
2. **Relatório único:** `eval/resultados/<nome>.json` agora junta as métricas do juiz (`geral`, `so_no_recorte`, `por_categoria`) e as mecânicas (chave `mecanicas`, com os mesmos três cortes), mais a nota de cada pergunta em `por_pergunta`. A CLI `executar` o grava ao terminar; `relatorio` o refaz.
3. **Page recall@k.** Páginas do gabarito (`paginas`, físicas) cobertas pelos `k` primeiros trechos entregues ao LLM, na ordem do rerank, com k = 1, 3 e 6 (6 é o que o `ask` entrega). Reporta-se o *recall* (páginas cobertas / páginas do gabarito) e o *acerto* (alguma coberta). Um Pai de várias páginas ("p. 156-157") cobre todas elas. Não vale para fora do escopo (sem página). Reporta-se também a **página citada**: a resposta cita `[p. N]` com alguma página do gabarito.
4. **Acerto numérico.** Só nas 21 perguntas de gabarito `valor`. Extrai os números da resposta (formato pt-BR, sem as citações `[p. N]`) e aceita se algum estiver a até 0,5% do gabarito, em módulo. Número **sem escala escrita** vale na unidade do gabarito (`16.782` para "R$ milhões"); número **com escala** (`16,8 bilhões`, `85,2 mil`) é convertido antes de comparar, e escala errada reprova (`16.782 bilhões`). Recusa não tem número e conta como erro. Os numerais por extenso de dois a dez também valem (o gabarito tem contagens como "três sociedades").
5. **Latência.** p50 e p95 (interpolação linear, como `numpy.percentile`) do tempo de ponta a ponta do `ask` por pergunta, mais o máximo; perguntas em que o sistema falhou ficam de fora. O tempo do juiz não entra.
6. **Cruzamento regra × juiz.** O relatório traz `numerico_regra_x_juiz`: nas perguntas de valor, quantas vezes a regra e a correção do juiz concordam. É uma checagem barata que alimenta a F3.4.

## Verificação do aceite da F3.3

| Critério | Resultado |
|---|---|
| Relatório único por execução em `eval/resultados/` | `eval/resultados/f3-2-a3-60.json` (cópia em `ADR-029-bruto/`) refeito com `relatorio` sobre as 60 respostas reais; e `executar --limite 3` de ponta a ponta (Neo4j e llama-swap no ar) gravou um relatório com as métricas do juiz e as mecânicas no mesmo arquivo (relatório de teste descartado) |
| A regra numérica reconhece o gabarito | teste: o texto do `gabarito` de cada uma das 21 perguntas de valor passa na própria regra |
| Testes | `indexer/tests/test_metricas.py`: escalas, tolerância (+0,4% passa, +0,7% reprova), sinal, citação ignorada, recall por k, percentil, relatório único; suíte inteira verde |

### Resultado sobre a execução da F3.2 (A3, recorte de 79 páginas)

| Corte | Page recall@1 / @3 / @6 | Acerto de página @6 | Página citada | Acerto numérico | Latência p50 / p95 |
|---|---|---:|---:|---:|---|
| Geral (n = 55 com página) | 0,44 / 0,52 / 0,55 | 0,56 | 0,42 | 0,19 (n = 21) | 4,5 s / 9,9 s |
| Só `no_recorte` = sim (n = 49) | 0,49 / 0,58 / 0,62 | 0,63 | 0,47 | 0,20 (n = 20) | 4,6 s / 10,2 s |
| Factual textual | 0,67 / 0,67 / 0,67 | 0,67 | 0,67 | n/a | 6,1 s / 13,2 s |
| Numérica | 0,33 / 0,47 / 0,53 | 0,53 | 0,13 | 0,27 | 3,1 s / 4,9 s |
| Agregação e filtro | 0,10 / 0,10 / 0,10 | 0,10 | 0,00 | 0,00 | 2,8 s / 4,8 s |
| Temática/global | 0,70 / 0,83 / 0,90 | 0,90 | 0,90 | n/a | 7,5 s / 19,6 s |
| Multi-hop | 0,20 / 0,40 / 0,50 | 0,60 | 0,40 | n/a | 4,6 s / 7,8 s |

Leitura (o diagnóstico é da F3.5):

- **O recall de página sobe com k** (0,44 → 0,55 de @1 para @6): o rerank melhora a posição, mas metade das páginas do gabarito não está nem entre os 6 Pais. Nas numéricas a página certa chega ao LLM em 53% dos casos, mas a página citada é certa em só 13% e o acerto numérico é 27%: o número está em **tabelas**, que não entram nos Pais, e o modelo recusa.
- **A regra numérica concorda com o juiz em 20 de 21 perguntas** (3 certas nos dois, 17 erradas nos dois). A divergência é N01: a resposta diz "R$ 16,8 bilhões" para um gabarito de R$ 16.782 milhões; a regra aceita (arredondamento de 0,1%, dentro dos 0,5% da tarefa) e o juiz marcou incorreta por não trazer o valor exato. É um caso para a calibração da F3.4.
- **Latência:** p50 de 4,5 s e p95 de 9,9 s, com máximo de 26,7 s. Os maiores tempos são da primeira pergunta (carga fria dos modelos no llama-swap) e das temáticas, cuja resposta é longa. Medida com um modelo de cada vez no llama-swap, índice do recorte e Neo4j local.

## Consequências e ressalvas

- A lista da §13.2 também cita **tokens por resposta** e **acurácia de rota**; nenhuma está na F3.3 (a rota só existe com o roteador, F5/F6). Os tokens ficam para quando forem úteis na F3.5, porque o `ask` ainda não os devolve.
- O acerto numérico é uma regra sobre texto: pode aceitar um número certo no lugar errado da resposta (só há risco real em gabaritos pequenos, como contagens) e não entende "R$ 16,8 bi". O cruzamento com o juiz existe justamente para vigiar isso.
- A latência inclui a troca de modelo do llama-swap quando ela acontece; para comparar degraus na F3.5, as execuções devem partir do mesmo estado (modelos já carregados).
