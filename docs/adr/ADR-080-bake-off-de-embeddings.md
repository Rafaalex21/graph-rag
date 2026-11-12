# ADR-080 · Bake-off de embeddings: o Qwen3-Embedding-0.6B fica

- **Estado:** aceita (12/11/2026); regras de `eval/f93-medida-embeddings.md` aplicadas como estavam
- **Data:** 2026-11-12
- **Tarefa(s):** F9.3

## Contexto

O índice de produção usa o Qwen3-Embedding-0.6B (1024 dims, ADR-020). A F9.3 compara três candidatos, baixados com o aval do Rafael: **Qwen3-Embedding-4B** (2560 dims), **EmbeddingGemma 2** (768 dims, lançado em 06/10/2026) e **bge-m3** (1024 dims). Cada um embute os mesmos 1.041 Filhos num índice vetorial próprio; o restante do sistema (full-text, reranker, Pai, juiz) é o mesmo, e as 60 perguntas do golden e as 24 do grupo novo são as mesmas. A definição e a regra de decisão foram commitadas **antes** de rodar (56a4909); uma errata sobre erro de infraestrutura foi commitada antes de refazer qualquer chamada (ff16130).

## Decisão

**O Qwen3-Embedding-0.6B continua como embedding do projeto.** Nenhum candidato ficou "melhor" (≥ +0,05 em recall de contexto nos dois grupos): os três ficam **equivalentes** pela regra e, em empate, o incumbente fica. Nada muda em produção.

## Resultado (uma execução por candidato; detalhes em `eval/resultados/f93-embeddings.md`)

Recall de contexto (juiz Gemma 4 26B-A4B) e page recall@6 (mecânico), sem LLM de resposta. A1 = só vetor, 6 Filhos; A3 = o pipeline de produção (híbrido, 24 Pais, rerank, 6 Pais).

| Candidato | Recall de contexto A1 / A3 (60) | Page recall@6 A1 / A3 (60) | Recall de contexto A1 / A3 (24 novas) | Page recall@6 A1 / A3 (24 novas) |
|---|---|---|---|---|
| Qwen3-Embedding-0.6B (produção) | 0,56 / 0,58 | 0,58 / 0,63 | 0,45 / 0,50 | 0,69 / 0,76 |
| Qwen3-Embedding-4B | 0,58 / 0,57 | 0,61 / 0,61 | 0,50 / 0,50 | 0,62 / 0,76 |
| EmbeddingGemma 2 | 0,56 / 0,56 | 0,60 / 0,61 | 0,44 / 0,50 | 0,60 / 0,76 |
| bge-m3 | 0,55 / 0,58 | 0,57 / 0,63 | 0,50 / 0,50 | 0,76 / 0,76 |

Page recall@1 e @3 e o degrau A2 (híbrido, só mecânico) estão na tabela completa.

| Candidato | Arquivo (MB) | Dimensões | Vetores dos Filhos (MB) | Embutir Filhos (por s, GPU) | Consulta na CPU p50 / p95 (ms) |
|---|---:|---:|---:|---:|---:|
| Qwen3-Embedding-0.6B | 639 | 1024 | 4,3 | 105,5 | 73 / 77 |
| Qwen3-Embedding-4B | 4.280 | 2560 | 10,7 | 23,4 | 289 / 323 |
| EmbeddingGemma 2 | 310 | 768 | 3,2 | 163,0 | 48 / 54 |
| bge-m3 | 635 | 1024 | 4,3 | 128,1 | 56 / 77 |

- **A regra:** Δ recall de contexto no A3 contra o incumbente: 4B −0,01 (60) e 0,00 (24); Gemma 2 −0,02 e 0,00; bge-m3 −0,00 e 0,00; Δ page recall@6 (60): −0,02, −0,02 e 0,00. Todos elegíveis pela latência (≤ 1.000 ms na CPU), nenhum "melhor".
- **O que mais se vê:** no pipeline de produção (A3) os quatro **quase se igualam**: o page recall@6 sem as 3 perguntas com erro é 0,625 nos quatro, porque a busca híbrida (que traz o mesmo full-text) e o reranker fixo absorvem a diferença entre embeddings. Só no vetor sozinho (A1) há alguma diferença, dentro do ruído (±0,03 em 60 perguntas).
- **O modelo maior não compra nada:** o Qwen3-4B é 7× maior, 4× mais lento na consulta, 4,5× mais lento para embutir e 2,5× maior em vetores, sem ganho medido.
- **Os mais leves empatam com o incumbente:** o EmbeddingGemma 2 (310 MB, 768 dims, 48 ms na consulta) e o bge-m3 ficam equivalentes. Seria uma troca possível por custo (menos memória e vetores menores), mas **empate não paga** a troca: seria preciso reembutir os quatro índices e repetir a F9.1 para o ganho de uns milissegundos e alguns MB. Fica registrado como alternativa, sem tarefa.

## Alternativas consideradas

- **Trocar para o EmbeddingGemma 2 pelo custo:** equivalente em qualidade e mais leve; não feito, pelo motivo acima. Se um dia o espaço no índice ou a latência virarem problema, ele é o candidato.
- **Reindexação completa por candidato (nova segmentação com o tokenizador dele e os quatro índices vetoriais):** não feita; ver ressalvas.

## Consequências e ressalvas

- **Só os vetores dos Filhos foram trocados.** Os limites dos Filhos continuam os do tokenizador do Qwen3-Embedding (≈ 320 tokens), o que favorece o incumbente. Os vetores de perguntas hipotéticas (1.659), entidades (2.474) e comunidades (745) **não** foram reembutidos: nenhuma métrica daqui os consome, então o efeito do embedding nas ferramentas `buscar_tabelas`, `entidade` e `panorama` **não foi medido**. O custo de reembutir tudo é pequeno (as 5.900 unidades levariam minutos, pela vazão dos Filhos); a parte cara de uma troca seria repetir a F9.1.
- **O incumbente leva vantagem de ajuste:** a `TAREFA_PADRAO` e o pipeline foram calibrados com o Qwen3-0.6B (F2/F3), em parte olhando o golden; os candidatos usaram o formato do cartão, sem calibração. Um resultado "melhor" teria sido mais forte do que o "equivalente" que saiu.
- **Corpus pequeno:** 1.041 Filhos e 60 perguntas (24 no grupo novo; uma pergunta vale 0,042). Diferenças de 0,02 a 0,03 são ruído. Uma execução por candidato; a variância do juiz não foi medida.
- **Erro do reranker (errata 1):** 3 de 240 chamadas do A3 nas 60 perguntas deram `500 "Context size has been exceeded"` no `/v1/rerank` (a M05 no 0,6B, a T10 no 4B, a P02 no Gemma 2; o bge-m3 não teve nenhuma). Foram refeitas uma vez e falharam de novo: o reranker de produção (`-c 4096`) estoura quando os 24 Pais somam ~70 mil caracteres. **Isso é um defeito do pipeline de produção, não do bake-off:** ~1,3% das chamadas podem cair nele, e o A3 da F9.1 não o mostrou nessas perguntas. **Fica como dívida aberta, sem tarefa ainda** (candidata à F9.4: limitar os Pais por pedido ou o tamanho do texto enviado ao reranker). A comparação foi conferida por sensibilidade (sem as 3 perguntas, ou contando-as 0): a maior diferença para o incumbente é 0,02, e a regra não muda.
- **O recall de contexto nessas 3 ficou nulo, não 0** (o harness grava nota nula quando o sistema falha), diferente do que a errata escrevia; está dito na medida e coberto pela sensibilidade.
- **Latência na CPU** é medida do dia (60 consultas). O pooling do bge-m3 e do Gemma 2 vem do GGUF e foi conferido só com 3 frases; os resultados deles não mostram sinal de configuração errada.
- **Golden e rótulos do juiz** são do Claude (ADR-027, ADR-030).

## Evidência

`eval/resultados/f93-embeddings.md` (gerado por `uv run python -m indexer.f93`, que também aplica a regra), `f93-embeddings-antes-da-errata.md`, os relatórios `f93-<tag>-r1/r2/r3.json` e `f93n-<tag>-r1/r2/r3.json`, `f93-embutir-<tag>.json` e `f93-latencia-<tag>.json` em `eval/resultados/`; respostas, notas do juiz e erros originais ficam em `data/avaliacao/`, fora do git (ADR-009). SHA-256 dos modelos em `infra/models.lock.json`. Medida, errata, execuções e análise de sensibilidade em `eval/f93-medida-embeddings.md`.

Reproduzir (Neo4j e llama-swap no ar; ~5,5 h, quase todas de juiz): `.\infra\rodar-f93.ps1`.
