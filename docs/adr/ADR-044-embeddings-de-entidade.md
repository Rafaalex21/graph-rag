# ADR-044 · Embeddings dos resumos de entidade e `entity_vec`

- **Estado:** aceita
- **Data:** 2026-11-04
- **Tarefa(s):** F5.7

## Contexto

Depois da F5.4 toda `__Entity__` tem `summary`. A ferramenta `entidade(nome)` da F6 começa por uma busca vetorial no índice `entity_vec` (§6.3); o aceite da F5.7 é "índice ONLINE; busca entidade → si mesma com recall@1 ≥ 0,95". Evidência: `ADR-044-bruto/resumo.json` (contagens e taxas; sem nomes de entidades nem trechos do documento).

## Decisão

Módulo `indexer.entidades_vec` (`embutir`, `autoteste`, `verificar`), no mesmo desenho dos Filhos (F2.3, [ADR-020](./ADR-020-embeddings-e-child-vec.md)): documentos sem instrução, em lote, pelo perfil `vetorizar` (Qwen3-Embedding-0.6B na GPU); consultas com o prefixo `Instruct:`.

- **Texto embutido:** `nome (tipo em português). resumo` e, em outra linha, `Também chamada: apelido | apelido` (apelidos que a resolução da F4.5 juntou, sem repetir o nome, até 8, no máximo 4 mil caracteres). Entidades de tipos diferentes com o mesmo nome (o "Pix" produto e o "Pix" programa) geram textos diferentes.
- **Incremental:** o hash do texto fica em `__Entity__.embeddingHash`; `embutir` só refaz quem não tem vetor ou cujo texto mudou. A F5.8 e qualquer reexecução custam só o que mudou.
- **Índice:** `entity_vec` (1024 dimensões, cosseno), criado depois de embutir, com `db.awaitIndexes`.
- **Autoteste:** cada entidade é re-embutida pelo backend da CPU (outro processo, outro arredondamento) e buscada no índice; o esperado é ela mesma em 1º lugar, e empate com texto idêntico conta como acerto. Duas sondas informativas com a instrução de consulta: pelo nome e por cada apelido, com a entidade esperada entre as 3 primeiras.

## Resultado

Comandos: `cd indexer; uv run python -m indexer.entidades_vec embutir | autoteste | verificar`.

| | |
|---|---|
| Entidades embutidas | 433 em 4,3 s; a segunda rodada embutiu 0 em 0,02 s |
| Índice | `entity_vec` ONLINE, 100% populado, 1024 dimensões, cosseno |
| **recall@1 (entidade → si mesma)** | **1,0000** (433 de 433; aceite ≥ 0,95) |
| Sonda pelo nome, top-3 | 96,8% (419 de 433) |
| Sonda por apelido, top-3 | 97,4% (484 de 497 consultas) |
| Sanidade | 0 entidades sem embedding, 0 sem hash, 0 sem resumo |

**As 14 que falham na sonda pelo nome** são nomes genéricos ou curtos: 10 têm até duas palavras ("seguros", "varejo", "governo", "agricultura"...) e a consulta pelo nome puro cai em entidades de resumo mais específico; 1 tem o nome repetido em outro tipo. Isso diz que `entidade(nome)` não deve confiar só no vetor: o índice de texto `entity_ft` (nome e apelidos, §6.3) cobre o caso do nome exato, e a F6 combina os dois.

**Achado fora do critério:** 4 entidades `PERSON` da camada dirigida têm como nome um marcador de vazio (nome vazio, `N/A`, `Desconhecido`, `null`): o modelo preenche o campo obrigatório com um placeholder. Não têm relações, não estão em comunidades e têm de uma a duas menções cada; entram no índice e podem aparecer em buscas. Reimportar não as remove (a importação só acrescenta). A correção é recusar nomes assim no importador e apagar os 4 nós; **o apagamento aguarda autorização**.

## Consequências

- `entity_vec` fica pronto para a F6; a F5.8 só reexecuta `embutir`.
- Mudar um resumo (F5.4) ou um apelido (F4.5) muda o hash e o vetor é refeito na próxima execução.
- A sonda pelo nome é a medida mais próxima do uso real; o aceite (entidade → si mesma) é uma condição necessária, não suficiente. A F9 mede o `entidade(nome)` de ponta a ponta.
