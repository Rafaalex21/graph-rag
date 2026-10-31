# ADR-031 · Linha de base v0: a escada de ablações A0 a A3r

- **Estado:** aceita (31/10/2026)
- **Data:** 2026-10-31
- **Tarefa(s):** F3.5

## Contexto

O aceite da F3.5 é `eval/resultados/v0.md` com as quatro linhas da escada (A0 a A3) e as métricas da §13.2, medidas com o juiz da F3.2/F3.4 e as métricas mecânicas da F3.3. Sem essa tabela não há o que comparar quando o grafo, as tabelas e o roteador entrarem (F4 em diante).

## Decisão

1. **`indexer/src/indexer/degraus.py`**: cada degrau é um `Sistema` do harness de `indexer.avaliar`, com o mesmo LLM de resposta (Qwen3.6, temperatura 0,2) e o mesmo prompt de A1 em diante.
   - **A0**: o LLM sem recuperação, de memória (pode dizer que não sabe);
   - **A1**: vetor ingênuo, os 6 Filhos mais próximos, sem Pai e sem reranker;
   - **A2**: o mesmo com busca híbrida (vetor + full-text, RRF);
   - **A3**: o pipeline do `ask` (híbrida, k×4 Filhos, até 24 Pais, rerank, 6 Pais);
   - **A3r** (extra, F2.8): A3 com step-back e HyDE antes da busca.
2. **6 trechos em todos os degraus com contexto**, para que a diferença venha do método de recuperação e não da quantidade de texto. O Filho do A1/A2 não leva o título da seção (o Pai é que a traz).
3. **`avaliar executar --degrau`** roda cada degrau no mesmo harness (retomável); no A0 só a correção é julgada (sem contexto, fidelidade e recall não existem). A3 reaproveita a execução `f3-2-a3-60` da F3.2, regerada com as métricas mecânicas.
4. **`indexer/src/indexer/tabela.py`** (sem LLM) monta `eval/resultados/v0.md` a partir dos relatórios: tabela principal e correção por categoria, sempre **só nas 54 perguntas com `no_recorte` = sim**.

## Verificação do aceite da F3.5

Evidência: `eval/resultados/v0.md` e os cinco relatórios `v0-a0`, `v0-a1`, `v0-a2`, `f3-2-a3-60`, `v0-a3r` (cópia das notas em `ADR-031-bruto/`). Comando: `uv run python -m indexer.avaliar executar --nome v0-<degrau> --degrau <degrau>` e depois `uv run python -m indexer.tabela`. Nenhuma execução teve erro do sistema nem falha do juiz.

| Degrau | Correção | Fidelidade | Recall de contexto | Page recall@6 | Acerto numérico | Latência p50 / p95 (s) |
|---|---:|---:|---:|---:|---:|---:|
| A0 de memória | 0,22 | n/a | n/a | 0,00 | 0,00 | 0,5 / 12,2 |
| A1 vetor, 6 Filhos | 0,50 | 1,00 | 0,51 | 0,55 | 0,20 | 2,3 / 7,2 |
| A2 + full-text | 0,51 | 1,00 | 0,52 | 0,55 | 0,20 | 2,3 / 6,7 |
| A3 + Pai e reranker | 0,55 | 1,00 | 0,55 | 0,62 | 0,20 | 4,6 / 10,2 |
| A3r + reescrita | 0,55 | 1,00 | 0,55 | 0,62 | 0,20 | 12,2 / 18,3 |

## O que a tabela mostra

- **O maior salto é ter o documento (A0 → A1): 0,22 → 0,50.** O 0,22 do A0 vem em boa parte das 5 perguntas fora do escopo (recusar é a resposta certa; elas valem 0,09 dos 0,22); sem elas o A0 acerta quase nada (factual 0,23, numérica 0,00). 20 perguntas melhoram de A0 para A3 e nenhuma piora.
- **Híbrida (A2) quase não muda a correção** (+0,01; 2 perguntas melhoram, 1 piora), só o page recall@1 (0,46 → 0,50) e a página certa mais cedo. Os mesmos 6 Filhos chegam ao LLM na maioria dos casos.
- **Pai e reranker (A3) é o segundo ganho: +0,04 de correção, page recall@6 0,55 → 0,62 e multi-hop 0,10 → 0,40** (M03 e M04, de 5 perguntas), ao custo de dobrar a latência (p50 2,3 → 4,6 s).
- **A reescrita (A3r) não ajuda**: nenhuma pergunta muda de nota e todas as métricas empatam, com a latência subindo para 12,2 s no p50. Em 32 das 60 perguntas o contexto muda, mas não o bastante para acertar mais. Pelo critério da §13.3 (ganho que justifique o custo), fica **desligada por padrão** como já estava no `ask`.
- **Fidelidade 1,00 em todos**: o LLM não afirma nada fora do contexto; o erro é de recuperação e de cobertura, não de alucinação. **Zero citações inválidas** em todas as 300 respostas.
- **Os três limites que o grafo e as tabelas devem atacar** (F4/F5): agregação 0,00 em todos os degraus; numérica 0,20 em A1 a A3r (o valor está em tabelas, que o `ask` ainda não lê); multi-hop 0,40 no melhor caso. Recusas: 46 de 60 no A0, 34 no A1, 33 no A2, 31 no A3 e no A3r.

## Consequências e ressalvas

- **Ordem de grandeza, não decimais:** com 54 perguntas, uma pergunta vale 0,019 de correção; A1, A2 e A3 diferem por 2 a 4 perguntas. Só o salto A0 → A1 e o ganho do multi-hop em A3 estão claramente acima do ruído.
- **O A0 mede memória do modelo, não ausência de conhecimento do tema:** é um piso, não o "LLM puro" em condições de ensino; o prompt do A0 manda não inventar e por isso recusa bastante.
- **A latência do A3 vem da F3.2** e inclui uma partida a frio do modelo; as demais tiveram aquecimento. A diferença A2 → A3 está, portanto, ligeiramente inflada.
- **Limites herdados:** os rótulos da calibração (ADR-030) foram dados pelo Claude; a fidelidade não foi calibrada; o golden set foi escrito pelo Claude (ADR-027); a classe `parcial` quase não aparece (1 a 4 por degrau); **política de arredondamento do N01 decidida pelo Rafael em 31/10/2026: o arredondamento vale** ("R$ 16,8 bilhões" para R$ 16.782 milhões é correto). O juiz ainda marca esse caso como `incorreta` (exige o valor exato), então as notas de correção desta tabela estão **subestimadas em até 1 pergunta de 54 (0,02) por degrau**; a regra numérica da F3.3 já aceita o arredondamento. Ajustar o prompt do juiz e rejulgar fica como decisão separada.
- **Tokens por resposta**, da §13.2, seguem fora (o `ask` não os devolve); a avaliação sobre o documento inteiro vem na F9.1.
- **Repetir:** a rodada completa leva cerca de 3 h na GPU (A2 47 min e A3r 80 min com o juiz; o A1 foi retomado depois de uma queda) e é retomável.
