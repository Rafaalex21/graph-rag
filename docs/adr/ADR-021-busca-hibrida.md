# ADR-021 · Full-text `child_ft` e busca híbrida (máximo × RRF)

- **Estado:** aceita (28/10/2026)
- **Data:** 2026-10-28
- **Tarefa(s):** F2.4

## Contexto

A ARQUITETURA §2 (degrau 2) pede busca vetorial e híbrida com full-text, com duas fusões: normalização pelo máximo (cap. 2 do livro) e RRF como variante. O ganho do híbrido é uma hipótese a medir, não um fato: num estudo citado na §2, com FinanceBench, a fusão híbrida não superou a busca densa. A F2.4 só precisa deixar os três modos selecionáveis por flag; a medição vem na F3.

## Decisão

Módulo `indexer/src/indexer/busca.py`, com a flag `--modo` (e a função `buscar(..., modo=...)`):

| Modo | O que faz |
|---|---|
| `vetor` | `child_vec` (cosseno), pergunta com o prefixo `Instruct: …` (ADR-020) |
| `texto` | `child_ft` (Lucene) |
| `hibrido-max` | cada lista dividida pelo seu maior escore, combinada por `alfa·vetor + (1−alfa)·texto` (alfa = 0,5; o que falta numa lista conta 0) |
| `hibrido-rrf` | soma de `1/(60 + posição)` nas duas listas |

1. **Índice full-text:** `child_ft` sobre `Child.text` (que já traz o caminho da seção), analisador `brazilian`, exatamente como na §6.3.
2. **Pergunta em linguagem natural → Lucene seguro:** caracteres especiais escapados e `AND`/`OR`/`NOT` descartados como palavras reservadas; o operador padrão do Lucene (OU) une os termos, e o analisador remove as palavras vazias. Pergunta em branco não consulta o índice.
3. **Candidatos:** cada lista traz `k × 4` (como no cap. 3); a fusão corta em `k`. Cada resultado informa a posição em cada lista (`v#`, `t#`), o que ajuda a ler o efeito da fusão.
4. **Comandos:** `criar-indice`, `buscar "pergunta" --modo … --k … [--alfa …] [--json]` e `comparar` (sondas informativas). A busca roda no indexador (Python); a API TypeScript da F8 repetirá a lógica com os mesmos modos e parâmetros.

## Alternativas consideradas

- **Escore combinado do Lucene com o vetorial por soma bruta:** as escalas são incomparáveis (cosseno em [0, 1], BM25 sem teto); daí a normalização.
- **Só RRF:** ignora a magnitude dos escores, o que o cap. 2 não recomenda como única opção; as duas ficam para a F3 decidir.
- **`alfa` calibrado agora:** sem golden set (F3.1) seria ajuste às cegas; fica 0,5 e vira parâmetro de calibração.

## Consequências

- A F2.5 (retriever parent-document) usa `buscar` com k×4 e a deduplicação por Pai.
- A F3 compara A1 (`vetor`) com A2 (`hibrido-max` e `hibrido-rrf`) sobre perguntas reais e decide o modo padrão e o `alfa`.

## Verificação do aceite da F2.4

| Critério | Resultado |
|---|---|
| `child_ft` criado | tipo `FULLTEXT`, **ONLINE**, 100% populado, analisador `brazilian` (`indice_ft.txt`) |
| Vetor, híbrido-máximo e híbrido-RRF selecionáveis por flag | `--modo vetor\|texto\|hibrido-max\|hibrido-rrf` executados de verdade sobre o banco: a mesma pergunta devolveu rankings diferentes em cada modo (por exemplo, o topo do `texto` era o 8º do `vetor`, e o RRF reordenou o topo do máximo) |
| Testes | 11 testes novos em `test_busca.py` (matemática das duas fusões, escape do Lucene, índices consultados por modo, k×4, instrução de consulta); 139 no indexador, ruff limpo |

**Sondas informativas** (`comparar`, 166 Filhos, k = 5; em [`ADR-021-bruto/comparar.json`](ADR-021-bruto/comparar.json)). A "pergunta" é (a) um trecho de ~40 palavras do meio do próprio Filho ou (b) as 3 palavras mais raras dele:

| Sonda | Modo | recall@1 | recall@5 |
|---|---|---:|---:|
| trecho do meio | vetor | 0,892 | 0,982 |
| | texto | 0,994 | 1,000 |
| | híbrido-máx. | **1,000** | 1,000 |
| | híbrido-RRF | 0,940 | 0,994 |
| palavras raras | vetor | 0,374 | 0,572 |
| | texto | **0,970** | 0,994 |
| | híbrido-máx. | 0,759 | 0,952 |
| | híbrido-RRF | 0,584 | 0,946 |

## Ressalvas

1. **As sondas são lexicais por construção** (a "pergunta" sai do próprio texto do Filho), então favorecem o full-text e dizem pouco sobre perguntas reais, em linguagem natural e com sinônimos, onde o vetor tende a ajudar. **Não concluir que o texto ou o híbrido vencem**: a conclusão é da F3, com o golden set. O que as sondas mostram é que os três caminhos funcionam e que o vetor sozinho falha em termos raros (0,37 de recall@1), o caso que o full-text cobre.
2. O RRF ficou atrás do máximo nas duas sondas, e o máximo atrás do texto puro na sonda de palavras raras: com `alfa` = 0,5 o vetor "dilui" a pista lexical. Reforça que o `alfa` precisa de calibração (F3).
3. O corpus tem 166 Filhos; os números mudam com as 423 páginas.
4. A consulta Lucene é OU entre os termos: perguntas longas trazem muitos candidatos de baixa relevância; é aceitável no esquema k×4 + reranker (F2.6).
5. As saídas de `buscar` mostram trechos do documento só no terminal; as evidências versionadas trazem apenas números.

## Evidência

`indexer/src/indexer/busca.py`, `indexer/tests/test_busca.py`, `docs/adr/ADR-021-bruto/`.
