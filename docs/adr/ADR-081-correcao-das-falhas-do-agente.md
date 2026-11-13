# ADR-081 · Ciclo de correção das falhas do agente: o crítico e o redator liam evidência cortada

- **Estado:** aceita (13/11/2026); regra de `eval/f94-medida-correcao.md` aplicada como estava; cumprida só na terceira rodada
- **Data:** 2026-11-13
- **Tarefa(s):** F9.4

## Contexto

A F9.1 mediu o A6 (agente completo) nas 60 perguntas do golden e nas 24 do grupo novo. As categorias mais fracas eram agregação (correção 0,20) e numérica (0,50). A F9.4 pede "falhas das categorias mais fracas reduzidas à metade". A medida foi fixada **antes** de rodar (c5d0baa): **falha = 1 − correção** no A6, mesmas 60 e 24, mesmo Qwen3.6, mesmo juiz (Gemma 4 26B-A4B), mesmo índice; meta: falha de agregação ≤ 0,40 e de numérica ≤ 0,25, sem categoria perdendo 0,10, fora do escopo em 1,00, fidelidade ≥ 0,95 e o grupo novo sem cair mais de 0,05. A r1 e a r2 não cumpriram; cada rodada nova foi decidida por uma errata escrita e commitada antes de rodar (edde3dd, 08f69bc), olhando só as falhas das 60.

## Decisão

Mantêm-se no código as três rodadas de correção (`api/src/agente/`):

1. **r1: limites de texto** (`redator.ts`, `critico.ts`). O redator cortava cada evidência em 900 caracteres (9.000 no total) e o crítico em 350 (7.000): a linha da tabela ou a frase com o valor ficava depois do corte. Agora: redator 3.000 por evidência e 24.000 no total; crítico 1.200 e 14.000 (depois ampliados na r3).
2. **r2: busca de tabelas junto** (`agente.ts`, opção `tabelasJuntas`, ligada por padrão). Toda subpergunta roteada para alguma ferramenta recebe também `buscar_tabelas`, em paralelo e depois da ferramenta escolhida. Não vale para `panorama`, `entidade`, modos forçados nem para execuções com ferramentas restritas (os degraus A3ts a A5 ficam como estão).
3. **r3: o crítico e o redator passam a ler a evidência inteira e em linhas.** O **crítico** vê 8 evidências por subpergunta (eram 4), até 2.500 caracteres cada (eram 1.200) e 22.000 no total, com as quebras de linha da tabela mantidas (antes uma tabela larga virava uma linha só), e o tempo-limite foi a 60 s. O **redator** aceita 16 evidências (eram 10), mantém as quebras de linha das tabelas e ganhou a regra 6 do prompt (como ler uma tabela em Markdown: cruzar o rótulo da linha com o cabeçalho da coluna; "Observado" é o resultado do período; se o valor está na célula, responder com ele).

## Resultado (A6, uma execução por rodada; `eval/resultados/f94-correcao.md`)

| | F9.1 | r1 | r2 | r3 | Meta |
|---|---:|---:|---:|---:|---:|
| Falha de agregação (60) | 0,80 | 0,60 | 0,60 | **0,30** | ≤ 0,40 |
| Falha de numérica (60) | 0,50 | 0,37 | 0,27 | **0,10** | ≤ 0,25 |
| Maior queda de correção em outra categoria | — | 0,10 (multi-hop) | 0 | 0 | < 0,10 |
| Correção geral (60) | 0,59 | 0,69 | 0,72 | **0,87** | — |
| Correção geral (grupo novo, 24) | 0,46 | 0,58 | 0,67 | **0,77** | não cair |
| Fidelidade (60) | 0,97 | 0,99 | 0,98 | 0,97 | ≥ 0,95 |
| Fora do escopo (60 e 24) | 1,00 | 1,00 | 1,00 | 1,00 | 1,00 |
| Latência p50 / p95 (s) | 22,9 / 111,6 | 16,9 / 55,9 | 22,1 / 61,8 | 17,4 / 70,1 | informativo |
| Acerto numérico (60) | 0,48 | 0,62 | 0,67 | 0,86 | informativo |
| Respostas `incompleta` (de 60) | 28 | — | — | 5 | informativo |

- **r1: não cumprida** (agregação e numérica fora da meta; multi-hop −0,10). **r2: não cumprida** (agregação igual à r1; numérica a 0,02 da meta). **r3: cumprida em todos os itens.** As três ficam no relatório; nenhuma substitui a outra, e o aceite só cumpriu na terceira.
- **Por categoria na r3 (60 / 24):** factual 0,90 / 0,92; numérica 0,90 / 0,67; agregação 0,70 / 1,00; temática 0,90 / 0,50; multi-hop 0,80 / 0,50; fora do escopo 1,00 / 1,00. Sem erros do sistema e sem falhas do juiz em nenhuma das seis execuções.
- **De onde veio o ganho:** o crítico. Na F9.1 o ciclo terminava `incompleta` em 28 das 60 respostas: ele via evidências cortadas e achatadas, dizia "o valor não foi encontrado" e o redator, instruído para esse estado a escrever "Não encontrei nos trechos consultados", recusava mesmo com a tabela inteira na mão (N03, N07, N08, G06, G10). Na r3 são 5 das 60, e os casos com 2 rodadas caem de 32 para 10. Por isso a latência também melhora em relação à F9.1.
- **Diagnóstico por leitura** (nas 60, sem juiz; `f94-diag`, `f94-diag3`, `f94-diag4`, `f94-diag5`, fora da medida): um valor que estava no contexto do redator e mesmo assim saía como "não encontrei", e uma tabela que ficava na 15ª posição e era descartada pelo teto de 10 evidências.

## Alternativas consideradas

- **Encerrar na r2** com o resultado como saiu: a regra não permitia o aceite pós-hoc (numérica a 0,02 da meta); o dono preferiu uma r3.
- **Ensinar o redator a ler tabela só por prompt** (a regra 6): testada sozinha (`diag4`) não mudou nada; o efeito veio do crítico e das quebras de linha. A regra 6 ficou porque entrou junto na rodada medida, sem prova de que ajude.
- **Reranquear as evidências por relevância antes do corte em 16:** não feito; subir o teto bastou nas 60.

## Consequências e ressalvas

- **O resultado nas 60 é otimista:** é o conjunto em que as falhas foram lidas e os prompts, ajustados nas etapas anteriores. O grupo novo (24), que não foi lido pergunta a pergunta, subiu de 0,46 para 0,77, o que afasta a ideia de que o ganho é só sobreajuste, mas são 24 perguntas (uma vale 0,042) e as categorias dele têm de 3 a 6.
- **Quatro mudanças entraram juntas na r3** (crítico, redator, regra de leitura de tabela, teto de evidências): a medida não diz qual delas fez o quê. O que se sabe é que o crítico é a maior parte.
- **Uma execução por rodada;** a variância do Qwen a 0,2 e do juiz não foi medida (G06 e G10 acertaram na r1 e erraram na r2, e parte dessa oscilação pode ser variância, não efeito do código).
- **A escada da F9.1 precisa ser refeita antes de congelar a v1 (F9.5):** os degraus A3ts, A4 e A5 de `v1-ablacao.md` foram medidos com o redator anterior (corte de 900 caracteres, tabelas achatadas, 10 evidências); só o A6 foi refeito aqui, e o `tabelasJuntas` não entra nesses degraus por construção. A comparação A6 contra A5 da tabela atual mistura, portanto, o que a escada mostra com o que esta etapa consertou.
- **O que ainda falha nas 60** (12 com correção < 1): T08 (o texto está na evidência e o redator responde com outro órgão), G02, G07 e G08 (agregação sobre uma lista ou soma de linhas), e meias notas em T13, N03, N06, N08, P03, P09, M01 e M02. No grupo novo, 7 (Q01, Q10, Q11, Q16, Q17, Q19, Q21), sem diagnóstico.
- **Custo:** o crítico e o redator leem mais texto por chamada (o crítico até 22.000 caracteres, o redator até 24.000); medido, a latência não piorou em relação à F9.1 (p50 17,4 s e p95 70,1 s contra 22,9 e 111,6), porque o ciclo faz menos rodadas. O RNF-2 (resposta completa ≤ 20 s) segue sem ser cumprido no p95.
- **A falha do reranker (`-c 4096`) achada na F9.3** não é tratada aqui; segue como dívida aberta.
- **Golden e rótulos do juiz** são do Claude (ADR-027, ADR-030); o Gemma é juiz de respostas do Qwen.

## Evidência

`eval/f94-medida-correcao.md` (medida, duas erratas e o resultado de cada rodada, execuções contadas), `eval/resultados/f94-correcao.md` (gerado por `uv run python -m indexer.f94 --rodadas r1 r2 r3`), `eval/resultados/f94r1-a6.json`, `f94r1n-a6.json`, `f94r2-a6.json`, `f94r2n-a6.json`, `f94r3-a6.json`, `f94r3n-a6.json`; respostas e notas do juiz em `data/avaliacao/f94r*-a6/`, fora do git (ADR-009). Commits: medida c5d0baa, r1 1f568f8, errata 1 edde3dd, r2 23f538b, errata 2 08f69bc.

Reproduzir (Neo4j e llama-swap no ar; ~2 h 15 por rodada, quase tudo juiz): `.\infra\rodar-f94.ps1 -Rodada r3`.
