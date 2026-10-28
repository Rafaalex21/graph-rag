# ADR-023 · Rerank dos Pais com o Qwen3-Reranker-0.6B

- **Estado:** aceita (28/10/2026)
- **Data:** 2026-10-28
- **Tarefa(s):** F2.6

## Contexto

O retriever (ADR-022) devolve até 24 Pais; o reranker os reordena e os 6 melhores seguem para o LLM (§5.1). O aceite da F2.6 é "24 Pais reranqueados em ≤ 2 s". O ADR-011 já tinha avisado que a margem era curta: 24 trechos de ~1.200 tokens levaram 1,85 a 2,17 s na GPU (e 4,1 a 4,5 s na CPU).

## Decisão

Módulo `indexer/src/indexer/reranker.py` (comandos `buscar` e `medir`):

1. **Chamada:** `POST /v1/rerank` do llama-swap, modelo `qwen3-rerank-0.6b` (GPU, perfil `consultar`/`consultar-rapido`), com a pergunta e os 24 textos; a nota (`relevance_score`, 0 a 1) volta por `index`. Empate mantém a ordem da recuperação.
2. **Texto enviado:** caminho da seção + corpo do Pai, **cortado em 6.000 caracteres** (~1.500 tokens do reranker). O corte vale só para a nota (o LLM recebe o Pai inteiro) e a quantidade de cortes vai no resultado. Ele existe porque o custo é proporcional aos tokens enviados: 24 Pais de ~1.600 tokens (~7.400 caracteres, o máximo da ADR-018) levaram **2,1 a 2,2 s**, acima do limite. Só Pais acima de ~1.300 tokens do Qwen3.6 são afetados.
3. **Pipeline do degrau 3 (sem reescrita):** `recuperar_e_reranquear` = k×4 Filhos → até 24 Pais → rerank → 6 Pais, com a latência por etapa e o tempo do rerank.
4. **Sem instrução de tarefa no par:** o endpoint recebe `query` e `documents` e o llama.cpp monta o formato do modelo; a nota ficou nítida (0,9999 contra 0,0003 e 0,00002 em três trechos de teste).

## Descobertas sobre o servidor

- O limite real de entrada do reranker é o **contexto de 4.096 tokens**, e não o `-ub 2048` do ADR-011: pares de 2.325, 2.827, 3.325 e 4.077 tokens foram aceitos. Com ~4 caracteres por token isso dá ~16 mil caracteres, mais que o dobro de qualquer Pai.
- A latência é praticamente linear nos tokens enviados (46 mil tokens ≈ 2,1 s): ~22 mil tokens/s.

## Alternativas consideradas

- **Reranquear na CPU:** 4,1 s para 24 trechos de 1.200 tokens (ADR-011); reprova.
- **Reranquear só 12 Pais:** cumpriria o tempo com folga, mas muda o desenho (24/6 da §5.1) sem necessidade, já que o corte por caracteres resolve.
- **Não cortar e confiar que os Pais são pequenos:** os dados reais permitem (máximo 12,9 mil tokens para os 24 maiores), mas o documento inteiro (F5.8) pode ter Pais maiores; o corte dá um teto garantido em vez de uma esperança.

## Consequências

- Na F2.9 (`ask`) e na F3 (A3), o rerank entra depois da recuperação com k = 24.
- Se a F3 mostrar que o corte prejudica a nota de Pais longos, o limite pode subir até ~16 mil caracteres, ao custo de passar de 2 s no pior caso; ou reranquear só os Filhos que casaram.

## Verificação do aceite da F2.6

Comando: `uv run python -m indexer.reranker medir` (20 perguntas de `eval/perguntas_latencia.txt`; saída em [`ADR-023-bruto/rerank_medicao.json`](ADR-023-bruto/rerank_medicao.json)).

| Cenário (24 Pais) | Tokens enviados (Qwen3.6) | Tempo do rerank | ≤ 2 s |
|---|---:|---|---|
| **Reais**: os 24 candidatos de cada uma das 20 perguntas | 8.218 em média | p50 **583 ms**, máx. **751 ms** | sim |
| **24 maiores Pais do banco** | 12.968 | 740 a 856 ms (5 rodadas) | sim |
| **Teto garantido**: 24 textos no limite de 6.000 caracteres | ~37 mil (estimado) | 1.814 a 1.844 ms (5 rodadas) | sim, com ~8% de folga |

Testes: 7 testes novos em `test_reranker.py`; 151 no indexador, ruff limpo.

**Sonda informativa** (trecho do meio de cada Pai como pergunta; o Pai de origem deve ser o 1º entre os 24 candidatos): os 116 Pais apareceram entre os candidatos; em 1º lugar, **112 antes e 112 depois do rerank**. O rerank não piorou nem melhorou esta sonda (é lexical, favorece o que a recuperação já acerta). Na consulta de exemplo sobre risco de mercado, o rerank promoveu para o 4º lugar o Pai da seção "Descrição dos 5 principais fatores de risco" (estava em 6º).

## Ressalvas

1. **A folga do teto é de ~8%** (1,84 s contra 2 s). Ela depende da GPU livre; com o desktop disputando a GPU ou outro modelo ativo, pode estourar no pior caso (que não ocorreu em dados reais, onde o máximo foi 0,86 s).
2. **O rerank só foi medido com a GPU ociosa** e o Qwen3.6 não carregado; no perfil `consultar` completo o tempo deve ser medido na F2.9/F3.
3. **A sonda não mede qualidade de ranqueamento**; o ganho do reranker (A3 contra A2) é da F3.
4. O ADR-011 afirma que o `-ub 2048` limita o par a 2.048 tokens; a medição mostrou que isso não é verdade para este modelo (o limite é o contexto); o ADR-011 recebeu um adendo.
5. O corte de 6.000 caracteres foi escolhido pelo tempo, não pela qualidade.

## Evidência

`indexer/src/indexer/reranker.py`, `indexer/tests/test_reranker.py`, `docs/adr/ADR-023-bruto/`.
