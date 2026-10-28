# ADR-020 · Embeddings dos Filhos e índice `child_vec`

- **Estado:** aceita (28/10/2026)
- **Data:** 2026-10-28
- **Tarefa(s):** F2.3

## Contexto

A F2.3 embute os Filhos (ADR-018) e cria o índice vetorial `child_vec` (ARQUITETURA §5 I-4 e §6.3): 1024 dimensões, cosseno. O aceite pede o índice `ONLINE` e um autoteste trecho → si mesmo com recall@1 ≥ 0,98.

## Decisão

Módulo `indexer/src/indexer/embeddings.py` (comandos `embutir` e `autoteste`).

1. **Documentos sem instrução, consultas com instrução.** Os Filhos são embutidos como estão (texto com o prefixo do caminho da seção); o formato de consulta `Instruct: <tarefa>\nQuery: <pergunta>` fica em `formatar_consulta`, com a tarefa em inglês, como o modelo recomenda, e será usado pelo retriever (F2.5).
2. **Em lote pela GPU.** `POST /v1/embeddings` do llama-swap no modelo `qwen3-embed-0.6b-lote` (perfil `vetorizar`), 16 textos por requisição. Cada vetor é conferido: 1024 dimensões e norma 1 (tolerância 1e-3); fora disso a carga para.
3. **Gravação retomável:** só os Filhos sem `embedding` são enviados (`WHERE c.embedding IS NULL`); o vetor vai por `db.create.setNodeVectorProperty`, e o nó recebe `embeddingModel` e `embeddingDims`. Trocar de modelo exige apagar os vetores e recriar o índice (§5 I-4); por isso a dimensão e a similaridade entraram também no `infra/models.lock.json`.
4. **Índice:** `child_vec`, `CREATE VECTOR INDEX … IF NOT EXISTS`, 1024 dims, `cosine`, seguido de `db.awaitIndexes`.
5. **Autoteste em dois backends.** Cada Filho é re-embutido pelo modelo da **CPU** (`qwen3-embed-0.6b`, uma consulta por vez, texto do documento sem instrução) e buscado no índice, montado com vetores da **GPU**; o esperado é o próprio Filho em 1º lugar. Assim o teste cobre também a consistência GPU × CPU e a acurácia do índice aproximado, e não só "o vetor é igual a si mesmo". Uma **sonda** informativa usa, como consulta, ~40 palavras do meio do Filho com instrução de consulta.

## Alternativas consideradas

- **Autoteste com o vetor já gravado:** trivial (o vetor do nó é o seu vizinho mais próximo por construção) e não pegaria divergência de backend.
- **Embutir pela CPU:** o lote de 166 Filhos leva ~2,4 s na GPU; a CPU serve para consultas isoladas.
- **Prefixar instrução nos documentos:** o modelo foi treinado com instrução só nas consultas.

## Consequências

- A F2.4 cria o `child_ft` sobre o mesmo `text` e a busca híbrida; a F2.5 usa `child_vec` com `formatar_consulta` e k×4.
- O modelo de lote e o da CPU precisam produzir vetores compatíveis (o autoteste confirma que são).
- Embutir o documento inteiro (F5.8) leva a ordem de minutos, não horas: ~68 Filhos/s no recorte.

## Verificação do aceite da F2.3

| Critério | Resultado |
|---|---|
| Índice `ONLINE` | `child_vec`: tipo `VECTOR`, estado **ONLINE**, 100% populado, 1024 dims, similaridade COSINE (`SHOW INDEXES` pelo driver e pelo `cypher-shell`) |
| Todos os Filhos embutidos | 166 de 166 com vetor; `embeddingModel` = `qwen3-embed-0.6b-lote`, `embeddingDims` = 1024; 2,44 s no lote (68 Filhos/s); vetores com norma 1 |
| Autoteste recall@1 ≥ 0,98 | **1,00 (166 de 166)**, vetor da CPU contra índice da GPU, nenhuma falha |
| Sonda (informativa) | trecho do meio + instrução de consulta: recall@1 **0,892**, recall@5 **0,982** |
| Testes | 7 testes novos em `test_embeddings.py`; 128 no indexador, ruff limpo |

Comandos: `uv run python -m indexer.embeddings embutir` e `… autoteste`. Saídas brutas em [`ADR-020-bruto/`](ADR-020-bruto/) (`embutir.txt`, `autoteste.txt`).

## Ressalvas

1. O autoteste é fácil por natureza (o texto da consulta é o do documento); ele garante consistência e índice funcionando, não qualidade de busca. A medida de busca real vem na F3 (recall de página no golden set). A sonda do trecho do meio é um primeiro sinal: 89% no top-1 e 98% no top-5 num corpus de só 166 Filhos, onde a dificuldade é baixa; não extrapolar para as 423 páginas.
2. O Neo4j emite um aviso de "propriedade `embedding` inexistente" na primeira consulta de pendentes (o banco ainda não tinha a propriedade); é inofensivo.
3. Os vetores só existem no banco (`infra/neo4j/data`, fora do git); recriá-los exige o llama-swap e o modelo local.
4. A tarefa padrão da instrução de consulta (`TAREFA_PADRAO`) é um ponto de calibração; a F2.5/F3 podem ajustá-la.

## Evidência

`indexer/src/indexer/embeddings.py`, `indexer/tests/test_embeddings.py`, `docs/adr/ADR-020-bruto/`.
