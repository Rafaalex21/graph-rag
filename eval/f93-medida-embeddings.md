# F9.3: bake-off de embeddings (definição fixada ANTES de rodar)

Aceite da etapa (ETAPAS.md): "ADR com recall de contexto e page recall@k de cada candidato". O índice de produção usa o **Qwen3-Embedding-0.6B** (1024 dims, ADR-020). A F9.3 compara três candidatos com o mesmo restante do sistema e registra qual embedding o projeto deve usar, com a evidência.

## Candidatos (baixados com o aval do Rafael em 12/11/2026; SHA-256 em `infra/models.lock.json`)

| Tag | Modelo | Arquivo | Dimensões | Formato do documento | Formato da consulta |
|---|---|---|---:|---|---|
| `qwen06` (incumbente) | Qwen3-Embedding-0.6B Q8_0 | 639 MB | 1024 | texto do Filho, sem instrução | `Instruct: <tarefa>\nQuery: <pergunta>` (a `TAREFA_PADRAO` do projeto, em inglês) |
| `qwen4b` | Qwen3-Embedding-4B Q8_0 | 4.280 MB | 2560 | idem | idem |
| `gemma2` | EmbeddingGemma 2 Q8_0 (texto; 768d) | 310 MB | 768 | `title: none \| text: <Filho>` | `task: search result \| query: <pergunta>` |
| `bgem3` | bge-m3 Q8_0 | 635 MB | 1024 | texto do Filho | a própria pergunta, sem instrução |

Os formatos são os que o cartão de cada modelo manda (Qwen3 e Gemma 2) ou a ausência de instrução (bge-m3); **nenhum foi ajustado olhando o golden**. O Filho já traz o caminho da seção no texto (ADR-018), por isso `title: none` no Gemma 2. Todos rodam no `llama-server` Vulkan b11932 do projeto (as três cargas foram conferidas antes de fixar esta medida: vetores normalizados e com as dimensões acima). O pooling vem do GGUF (Qwen3: `last`, fixado no perfil; bge-m3 e Gemma 2: o do arquivo).

## O que se mede

Os **mesmos 1.041 Filhos** do índice de produção (os limites dos Filhos foram cortados com o tokenizador do Qwen3-Embedding e **não** são refeitos por candidato; ver limites). Cada candidato grava os vetores numa propriedade e num índice vetorial próprios (`embedding_<tag>`, `child_vec_<tag>`); o `child_vec` de produção não é tocado. O full-text (`child_ft`), o reranker (Qwen3-Reranker-0.6B), o Pai e o juiz são os mesmos. Duas perguntas-grupo: as **60** de `eval/golden.csv` e as **24** de `eval/golden_novas.csv` (fora do ajuste).

Três degraus de **recuperação, sem LLM de resposta** (o que o LLM veria):

| Degrau | O que é |
|---|---|
| **r1** (= A1) | só o índice vetorial; 6 Filhos |
| **r2** (= A2) | híbrido vetor + full-text (RRF); 6 Filhos |
| **r3** (= A3) | o pipeline de produção: híbrido, 24 Filhos → até 24 Pais → rerank → 6 Pais |

Métricas:

- **Recall de contexto** (juiz Gemma 4 26B-A4B, perfil `avaliar`, só essa métrica): fração do gabarito que o contexto sustenta; julgado em **r1 e r3** (60 + 24 perguntas cada, por candidato). Nas perguntas de recusa não se aplica.
- **Page recall@1, @3, @6** (mecânico, sem juiz): em **r1, r2 e r3**.
- **Custo:** tamanho do arquivo, dimensões, MB dos vetores dos Filhos, vazão de embutir (200 Filhos na GPU, sem gravar) e **latência de embutir uma consulta na CPU** (como a produção faz; 60 consultas do golden depois de 3 de aquecimento; p50 e p95).

O **Qwen3-0.6B é refeito pelo mesmo harness** (usa o `child_vec` existente; nada é reembutido), para as mesmas condições, e é **validado contra a F9.1**: o page recall@6 dele em r1 e r3 nas 60 precisa ficar a até **±0,02** do A1 (0,58) e do A3 (0,63) de `eval/resultados/v1-ablacao.md` (mesmo índice, mesmo full-text, mesmo reranker; a diferença possível é o cache do reranker e o índice aproximado). Se não ficar, a medida **não vale** até a causa ser achada, e isso é escrito.

## Regra de decisão (fixada agora)

Cada candidato contra o `qwen06`, no **r3** (o pipeline de produção). Δ = candidato − `qwen06`; **|Δ| < 0,05 em recall de contexto é empate**.

- **Melhor:** Δ recall de contexto ≥ +0,05 **nas 60 e nas 24**, **e** Δ page recall@6 (60) ≥ −0,02.
- **Pior:** Δ recall de contexto ≤ −0,05 em qualquer um dos dois grupos.
- **Equivalente:** o resto.
- **Elegível:** latência p50 de uma consulta na CPU ≤ **1.000 ms** (a consulta de produção roda na CPU, com o reranker e o LLM na GPU).
- **Substitui o Qwen3-0.6B** só se **melhor e elegível**. Se mais de um cumpre, o de maior recall de contexto nas 60. **Empate ou melhor-mas-inelegível: o incumbente fica**: reembutir tudo e repetir a F9.1 custa horas e não se paga com empate.
- **Se um candidato substituir:** o ADR registra a escolha, mas **a troca em produção não é executada na F9.3** (exige reembutir os quatro índices vetoriais, Filhos, perguntas hipotéticas, entidades e comunidades, e repetir a F9.1); fica proposta como tarefa.

**Aceite da F9.3:** `eval/resultados/f93-embeddings.md` (gerado por `uv run python -m indexer.f93`, que aplica a regra) e o ADR-080 com recall de contexto e page recall@k de cada candidato, as regras aplicadas **como estão** (sem afinar depois de ver o resultado), a validação do harness cumprida, e todas as execuções contadas aqui. O aceite é o ADR com os números, qualquer que seja a escolha: manter o Qwen3-0.6B é um resultado válido.

## Limites já sabidos

- **Só os vetores dos Filhos são trocados.** Os limites dos Filhos continuam os do tokenizador do Qwen3-Embedding (≈ 320 tokens com 12% de sobreposição), o que **favorece o incumbente**; uma reindexação "completa" por candidato refaria também a segmentação com o tokenizador dele, e isso não é feito. Os vetores de perguntas hipotéticas (1.659), entidades (2.474) e comunidades (745) não são reembutidos: nenhuma métrica desta medida os consome (são usados pelas ferramentas `buscar_tabelas`, `entidade` e `panorama` do agente), então **o efeito do embedding nelas não é medido**. O custo de reembutir tudo é estimado pela vazão dos Filhos, não medido.
- **O corpus é pequeno:** 1.041 Filhos e 60 perguntas (24 no grupo novo, 1 pergunta = 0,042). Diferenças pequenas entre candidatos são ruído; por isso a margem de 0,05 e os dois grupos.
- **Uma execução por candidato** (a recuperação é determinística; o juiz tem variância que não é medida).
- **O incumbente leva vantagem de ajuste:** a `TAREFA_PADRAO` e o pipeline (k×4, RRF, 24 Pais) foram calibrados na F2/F3 com o Qwen3-0.6B, em parte olhando o golden. Os candidatos usam o formato do cartão, sem calibração.
- **Recall de contexto é juiz** (Gemma 4, rótulos do Claude, só a correção foi calibrada, ADR-030); o page recall é o contraponto mecânico, e a regra exige que ele não caia.
- **Golden do Claude** (ADR-027); o recall de contexto das perguntas de recusa não se aplica.
- **Latência na CPU:** depende do que o Windows estiver fazendo; é uma medida do dia, com 60 consultas.
- O pooling de bge-m3 e Gemma 2 vem do GGUF; a sanidade foi conferida só com três frases (sem golden). Se um deles tiver o pooling errado, a pior colocação dele seria um defeito de configuração, não do modelo; isso será dito se o resultado for estranho.

## Reprodução

```powershell
# serviços no ar: .\infra\neo4j.ps1 iniciar ; .\infra\swap.ps1   (swap em outra janela)
.\infra\rodar-f93.ps1                       # por candidato: embutir, medir, latência; depois o juiz; depois a tabela
cd indexer; uv run python -m indexer.f93    # só a tabela e a regra, sem LLM
```

## Execuções (toda execução é contada)

**Fora da medida:** o teste técnico de carga dos três candidatos no llama-swap (12/11, 3 frases sem relação com o golden: dimensões, norma e a ordem de semelhança de "lucro líquido" contra "receita de juros" e "gato"; os três carregaram). Nenhuma pergunta do golden foi rodada antes de fixar este documento.

**Da medida:** a preencher conforme as execuções acontecerem.
