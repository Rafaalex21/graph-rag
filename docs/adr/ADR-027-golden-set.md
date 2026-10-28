# ADR-027 · Golden set de 60 perguntas, conferido contra o PDF

- **Estado:** aceita (28/10/2026)
- **Data:** 2026-10-28
- **Tarefa(s):** F3.1

## Contexto

A F3 mede a linha de base (A0 a A3) e, depois, cada camada do grafo. Para isso precisa de perguntas com gabarito confiável, na distribuição da ARQUITETURA §13.1, com páginas e rota esperada. O aceite da F3.1 é `eval/golden.csv` com pergunta, gabarito (texto ou Cypher), páginas e rota esperada.

## Decisão

1. **60 perguntas em 6 categorias** (§13.1): 15 factuais textuais (`T`), 15 numéricas (`N`), 10 de agregação e filtro (`G`), 10 temáticas/globais (`P`), 5 multi-hop (`M`) e 5 fora do escopo (`F`: saudação, ausente, outro banco, cotação "de hoje", pergunta alheia ao documento).
2. **Colunas** (descritas em [`eval/README.md`](../../eval/README.md)): `pergunta`, `gabarito` (texto), `tipo_gabarito` (`texto`, `valor`, `lista`, `recusa`), `valor` e `unidade` (número normalizado para o acerto numérico de ±0,5%), `paginas` (**físicas**, as do pdf.js), `rota_esperada` (ferramentas da §7.2), `no_recorte`, `pontos_chave` (para listas e temáticas), `evidencia` e `ausencia` (regex de verificação) e `cypher_gabarito` (reservada).
3. **O gabarito é conferido contra o PDF original, linha a linha.** `eval/validar_golden.py` lê as 423 páginas com o `pypdfium2` e exige que cada regex de `evidencia` case no texto das páginas citadas e que a regex de `ausencia` não case em página nenhuma. As páginas, portanto, não vêm do meu pipeline.
4. **`no_recorte`** (pedido na nota da F3.1): `sim` quando **toda** a evidência está nas 79 páginas do recorte; é conferido contra as faixas versionadas em `eval/recorte_paginas.json` (e, localmente, contra o mapa da F1.2). As perguntas fora do escopo contam como `sim`, porque a recusa vale em qualquer índice.
5. **Gabarito em texto agora, Cypher depois:** as 10 perguntas de agregação têm resposta em texto/valor e a coluna `cypher_gabarito` fica vazia até existir o esquema do grafo (F4); escrever Cypher hoje seria inverificável.

## Composição

| Categoria | Qtde. | `no_recorte` = sim | Rotas esperadas |
|---|---:|---:|---|
| Factual textual | 15 | 10 | `buscar_trechos` (14), `entidade` (1) |
| Numérica | 15 | 14 | `fato_financeiro` (2), `buscar_tabelas` (9), `buscar_trechos` (4) |
| Agregação e filtro | 10 | 10 | `consultar_grafo` (10) |
| Temática/global | 10 | 10 | `panorama` (10) |
| Multi-hop | 5 | 5 | `varias` (5) |
| Fora do escopo | 5 | 5 | `nenhuma` (5) |
| **Total** | **60** | **54** | |

Os 6 itens com `no_recorte` = não (itens 1.5, 1.7, 2.7, 7.1, 12.5 e 13.0 do formulário) existem para a avaliação sobre o documento inteiro (F9.1).

## Verificação do aceite da F3.1

| Critério | Resultado |
|---|---|
| `eval/golden.csv` com pergunta, gabarito, páginas e rota | 60 linhas, 15 colunas; distribuição exata da §13.1 |
| Gabarito conferido no PDF | **60 de 60** linhas com evidência encontrada nas páginas citadas e 5 de 5 ausências confirmadas no PDF inteiro (`ADR-027-bruto/validacao_golden.json`) |
| O validador reprova de verdade | controle negativo: com 4 linhas adulteradas (valor errado em duas, página errada, ausência impossível) ele reprovou **exatamente essas 4** e aprovou as outras 56 |
| Aritmética dos gabaritos derivados | conferida à mão: 398 + 698 = 1.096; 26.136 + 12.607 = 38.743; 2.341.685,44 − 1.408.277,03 = 933.408,41; 247.575,24 + 455.465,85 = 703.041,09 |
| Testes | 8 testes novos em `test_golden.py` (estrutura do CSV real, recorte versionado, validador com casos bons e ruins); 186 no indexador, ruff limpo |

## Ressalvas

1. **Quem escreveu as perguntas também construiu o sistema.** Li as páginas do recorte antes de redigi-las, então há viés a favor do que o pipeline já acha. Recomendo uma revisão humana das 60 linhas e, se possível, perguntas suas, redigidas sem olhar o documento.
2. **A regex prova que o fato está na página, não que a pergunta é boa.** Ela não garante que o gabarito esteja completo (os `pontos_chave` das listas não são verificados mecanicamente) nem que a pergunta seja inequívoca. Algumas são compostas (T12, T13, N15, M01 a M05).
3. **90% do conjunto está no recorte** (54 de 60). A F3 mede o recorte; a avaliação do documento inteiro (F9.1) precisará de mais perguntas fora dele.
4. **A coluna de rota reflete o desenho da §7.2,** não o que o sistema atual faz: só `buscar_trechos`/`buscar_tabelas` existem hoje; `fato_financeiro`, `consultar_grafo`, `panorama` e `entidade` dependem das fases F4 a F7. Até lá, essas perguntas só medem a recuperação por texto.
5. **As perguntas numéricas esperam o valor impresso** (R$ milhões, bilhões etc.), com a unidade na coluna; o acerto numérico da F3.3 deve normalizar a escala.
6. **O `golden.csv` contém fatos curtos do documento** (valores, nomes e frases de uma linha, nos gabaritos e nas regex). São fatos, não trechos reproduzidos, mas vale lembrar a ressalva do ADR-009 sobre publicar excertos do documento do BB sem consultar a RI do emissor, caso o repositório se torne público.
7. Um conjunto de 60 perguntas dá intervalos de confiança largos: diferenças de poucos pontos entre os degraus A0 a A3 não serão significativas.

## Evidência

`eval/golden.csv`, `eval/validar_golden.py`, `eval/recorte_paginas.json`, `eval/README.md`, `indexer/tests/test_golden.py`, `docs/adr/ADR-027-bruto/validacao_golden.json`.
