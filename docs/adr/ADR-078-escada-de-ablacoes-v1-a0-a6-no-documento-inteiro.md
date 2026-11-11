# ADR-078 · Escada de ablações v1: A0 a A6 no documento inteiro

- **Estado:** aceita (11/11/2026); os cinco itens da regra de `eval/f91-medida-ablacao.md` valeram
- **Data:** 2026-11-11
- **Tarefa(s):** F9.1

## Contexto

A F3.5 mediu A0 a A3 só no recorte de 79 páginas (`v0.md`, 54 perguntas). Com o documento inteiro indexado (F5.8) e o agente pronto (F7), a F9.1 mede a escada inteira, A0 a A6, nas 60 perguntas do `eval/golden.csv`. A definição (degraus, controle, métricas, grupo novo, regra de aceite) foi fixada e commitada **antes** de rodar (commit 15321e4), e nada foi afinado depois.

## Decisão

- **Um degrau novo de controle, o A3ts:** só `buscar_trechos`, mas pelo pipeline do agente em TypeScript e com o redator da F7.5. A0 a A3 respondem com o prompt do `ask` (Python) e A4 a A6 com o redator do TypeScript; sem o controle, o salto A3 → A4 misturaria "ferramentas de grafo" com "outro pipeline".
- **`apenas` no roteador** (`OpcoesRoteador.apenas`, `OpcoesAgente.ferramentas`): restringe as ferramentas oferecidas, para montar A4 (templates de fatos e `consultar_grafo`) e A5 (+ `entidade` e `panorama`). Só a medida usa; a API não passa.
- **`npm run avaliar:ablacao`** (TypeScript) grava o `respostas.jsonl` no formato do harness do Python, e `indexer.avaliar` julga e calcula as métricas mecânicas sem mudança (degraus `a3ts`, `a4`, `a5`, `a6` só julgam). `indexer.tabela --v1` monta `eval/resultados/v1-ablacao.md`.
- **Grupo novo:** A3 e A6 também respondem as 24 perguntas de `golden_novas.csv` (F7.12), fora do ajuste, para ver quanto de A4 a A6 é sobreajuste ao golden de 60.

## Resultado (60 perguntas, uma execução por degrau; detalhes em `eval/resultados/v1-ablacao.md`)

| Degrau | Correção | Page recall@6 | Página citada | Acerto numérico | Latência p50 / p95 (s) |
|---|---:|---:|---:|---:|---:|
| A0 de memória | 0,20 | 0,00 | 0,00 | 0,00 | 0,4 / 10,8 |
| A1 vetor | 0,54 | 0,58 | 0,44 | 0,24 | 2,3 / 7,1 |
| A2 + full-text | 0,53 | 0,58 | 0,47 | 0,24 | 2,4 / 8,4 |
| A3 + Pai e reranker | 0,54 | 0,63 | 0,47 | 0,24 | 5,0 / 10,5 |
| A3ts (controle) | 0,53 | 0,59 | 0,53 | 0,29 | 8,1 / 15,4 |
| A4 + fatos e Text2Cypher | 0,54 | 0,61 | 0,55 | 0,38 | 8,2 / 18,2 |
| A5 + local e global | 0,53 | 0,57 | 0,47 | 0,38 | 8,0 / 37,2 |
| A6 agente completo e crítico | 0,59 | 0,61 | 0,60 | 0,48 | 22,9 / 111,6 |

Nenhum degrau teve erro do sistema nem falha do juiz.

## O que a escada mostra

- **O salto que vale é ter o documento: A0 → A1, 0,20 → 0,54.** Daí até o A5 a correção total fica entre 0,53 e 0,54: pela regra fixada (diferença menor que 0,05 = empate; uma pergunta vale 0,017), **A1, A2, A3, A3ts, A4 e A5 empatam**. O full-text (A2) e o Pai com reranker (A3) não mudam a correção total aqui, como já era o caso no v0; o Pai ajuda o page recall (0,58 → 0,63).
- **O A6 chega a 0,59, +0,05 sobre A3 e A4: exatamente o limite da regra (3 perguntas), não um ganho claro.** E **não se repete no grupo novo** (24 perguntas fora do ajuste): A3 0,48 e A6 0,46, empate (−0,02). Na página citada (0,48 → 0,62) e no acerto numérico (0,30 → 0,40) o A6 segue à frente também lá, mas a correção, não. A leitura segura é: o agente completo ajuda a achar e citar a página e a acertar números, e o ganho de correção total no golden de 60 é pequeno e pode ser sobreajuste.
- **O que os fatos estruturados e o Text2Cypher compram (A3ts → A4):** o **acerto numérico** (mecânico, regra de 0,5%) sobe de 0,29 para 0,38 (8 de 21 perguntas de valor, contra 6) e chega a 0,48 no A6 (10 de 21), contra 0,24 do A3 (5 de 21); a correção das numéricas vai de 0,27 (A3) a 0,50 (A6). A **agregação** continua em **0,00** até o A5 e só chega a 0,20 no A6 (2 de 10), apesar de o `consultar_grafo` ter sido chamado em 7 a 8 perguntas; a causa não foi investigada.
- **O pipeline do agente tem custo em perguntas de texto:** o controle A3ts (só `buscar_trechos`) já cai em relação ao A3 em factual (0,90 → 0,77) e temática (0,90 → 0,75), e em A4 a A6 isso fica (0,70 a 0,75). São 2 a 3 perguntas por categoria, no limite do ruído, mas a direção é a mesma nos quatro degraus. Em compensação o multi-hop sobe (0,20 no A3, 0,40 do A3ts ao A5, 0,60 no A6; 5 perguntas, 1 por passo). Como o total empata, os dois efeitos se compensam; não se sabe quanto vem do redator e quanto do atualizador, porque não se isolou.
- **A busca local e global (A4 → A5) não trouxe ganho medido:** correção igual (0,54 → 0,53), page recall@6 e página citada menores, p95 de 18 para 37 s. O `panorama` e a `entidade` foram chamados em 4 e 3 perguntas. As 6 perguntas fora do recorte caem de 0,75 (A4) para 0,58 (A5 e A6) por uma pergunta (T14, 1,0 → 0,0), o que é ruído de uma pergunta e não foi investigado.
- **Fidelidade quase 1,00 em todos** (A5 0,98, A6 0,97): o erro é de recuperação e de cobertura, não de afirmação sem lastro; a fidelidade não foi calibrada contra rótulos humanos.
- **Latência:** o A6 tem mediana de 22,9 s e p95 de 111,6 s (máximo 209 s), com 28 das 60 respostas marcadas `incompleta` pelo crítico. A comparação com A0 a A3 é indicativa (famílias diferentes, ver a medida). O RNF-2 segue em aberto.

## Alternativas consideradas

- **Rodar A4 a A6 no recorte de 79 páginas**, para comparar com o v0: não, porque o índice de produção é o do documento inteiro e a F9.1 existe para medi-lo. A comparação mais próxima do v0 está na tabela "Só nas 54 do recorte" (A3: 0,52 aqui contra 0,55 no v0, empate; o índice maior tem mais distratores).
- **Não ter controle:** o salto A3 → A4 seria ambíguo.

## Consequências e ressalvas

- **Ordem de grandeza, não decimais:** uma execução por degrau, 60 perguntas (24 no grupo novo), geração a 0,2; nada foi repetido, então a variância do Qwen e do juiz não está medida.
- **A4 a A6 são otimistas no golden de 60:** foram ajustados olhando essas perguntas. O grupo novo só tem A3 e A6, não A4 e A5.
- **O A6 mistura efeitos** (crítico, até 2 rodadas, e `buscar_tabelas`); o crítico sozinho foi medido na F7.4 e na F7.13, não aqui.
- **Golden e rótulos do juiz** são do Claude (ADR-027, ADR-030); só a correção foi calibrada; o N01 continua marcado incorreta pelo juiz embora seja correto por decisão do Rafael.
- **Fidelidade e recall de contexto no v1** valem para o contexto entregue ao LLM; nos degraus do TypeScript, o que o redator viu.
- A trilha de execuções (inclusive a pausa a pedido e uma tentativa descartada de cortar o juiz) está em `eval/f91-medida-ablacao.md`.

## Evidência

`eval/resultados/v1-ablacao.md` (gerado por `uv run python -m indexer.tabela --v1`) e os relatórios `v1-a0` … `v1-a6`, `v1-a3ts`, `v1n-a3`, `v1n-a6` em `eval/resultados/`; respostas e justificativas (que citam o documento) ficam em `data/avaliacao/`, fora do git (ADR-009). Medida em `eval/f91-medida-ablacao.md`.

Reproduzir (Neo4j e llama-swap no ar; ~10 h de GPU): a sequência da seção Reprodução de `eval/f91-medida-ablacao.md`.
