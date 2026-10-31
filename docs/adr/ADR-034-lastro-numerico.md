# ADR-034 · Lastro numérico dos fatos extraídos

- **Estado:** aceita (31/10/2026)
- **Data:** 2026-10-31
- **Tarefa(s):** F4.3

## Contexto

O aceite da F4.3 é: taxa de rejeição registrada e 30 fatos aceitos auditados, com pelo menos 95% corretos. A §5 I-5 (guarda 1) define o lastro como "o valor normalizado aparece em `evidence`, e `evidence` existe no texto do Pai ou da Tabela". Os 1.225 fatos do recorte vêm da F4.2 ([ADR-033](./ADR-033-extracao-por-pai-e-por-tabela.md)), que provou formato válido, não correção.

## Decisão

**`indexer/src/indexer/lastro.py`** (`python -m indexer.lastro`): conferência determinística, sem LLM, de cada fato contra o texto exato que o modelo recebeu (o pedido da unidade). Um fato é aceito só se passar em todas; o primeiro motivo que falha fica registrado.

| Motivo | O que confere |
|---|---|
| `evidencia_fora_do_texto` | cada célula (ou pedaço entre reticências) da evidência está no texto enviado; em tabela a evidência junta cabeçalho e linha, então a ordem não conta |
| `metrica_generica` | a métrica não é só "Outros", "Total" etc. |
| `valor_ausente` | algum número da evidência tem o módulo de `value` |
| `sinal` | o sinal impresso vale: "(900)" é -900, e "redução de R$ 400 milhões" é 400 (a direção fica no nome da métrica) |
| `faixa` | o valor não é só um extremo de faixa ("7,0 a 11,0") |
| `linha` | em tabela, o número está numa linha que traz também o rótulo da evidência ou a métrica do fato |
| `coluna` | o ano do período é o do cabeçalho da coluna ("Var.% 25/24" é 2025) e a dimensão da coluna ("Centro-Oeste", "Conselho Fiscal") está na métrica, na entidade ou no segmento |
| `unidade` | percentual acima de 1.000 é valor em reais; em tabela "R$ bilhões ou %", a unidade tem de ser a do rótulo da linha |
| `escala` | a escala dita ao lado do número ("R$ 625 milhões", "85,2 mil") ou, sem ela, uma das que o cabeçalho da tabela declara; percentual e ponto-base têm escala 1 |
| `escala_sem_lastro` | escala maior que 1 que nem a evidência nem a tabela mencionam |

Os números vêm do normalizador da F1.7 (`Decimal`, pt-BR). O fator declarado pela detecção de tabela nem sempre serve (uma das 4 tabelas com fator de 1 bilhão tem "R$ milhões" no cabeçalho e um segundo bloco em bilhões); por isso vale o conjunto de escalas citadas nas células de cabeçalho.

## Verificação do aceite da F4.3

Evidência: `docs/adr/ADR-034-bruto/resumo.json` (contagens) e `ADR-034-bruto/auditoria.json` (ids e classe de cada erro, sem texto do documento). Comando: `uv run python -m indexer.lastro ../data/parsed/bb_fre_2026_recorte`, a partir de `indexer/`.

**Taxa de rejeição: 418 de 1.225 fatos (34,1%); 807 aceitos.**

| Motivo | Fatos |
|---|---|
| `unidade` | 100 |
| `coluna` | 90 |
| `sinal` | 66 |
| `linha` | 47 |
| `escala_sem_lastro` | 46 |
| `faixa` | 30 |
| `evidencia_fora_do_texto` | 24 |
| `metrica_generica` | 7 |
| `escala` | 6 |
| `valor_ausente` | 2 |

Por tipo de unidade do documento: Pais 38 de 98 rejeitados (39%), Tabelas 380 de 1.127 (34%). Por `unit`: percentual 166 de 352, monetário 216 de 687, contagem 33 de 183, ponto-base 3 de 3 (os 3 `basis_points` que ficaram sem conferência na F4.2 não passaram).

**Auditoria dos aceitos: 29 de 30 corretos (96,7%) na amostra final.** "Correto" aqui é: valor, unidade, escala, período, entidade e métrica dizem o que o texto diz; a moeda ausente não conta como erro (é lacuna conhecida da F4.2). Cada fato foi conferido contra a linha e o cabeçalho da tabela, ou contra o parágrafo do Pai. Foram quatro rodadas, e as regras da tabela acima nasceram dos erros das três primeiras:

| Rodada (semente) | Regras no ar | Corretos | Erros achados |
|---|---|---|---|
| 1 | só número, linha por rótulo, escala | 25 de 30 (83%) | extremo de faixa tomado como ponto (2), dimensão da coluna perdida, total rotulado como média, R$ marcado como `percent` |
| 2 | + `faixa`, `coluna`, percentual > 1.000 | 28 de 30 (93%) | R$ bilhões marcado como `percent` em tabela "R$ bilhões ou %" (2) |
| 3 | + unidade da tabela mista | 28 de 30 (93%) | dimensão da coluna só na evidência, não na entidade; métrica "Outros" |
| **4** | + dimensão nos campos do fato, métrica genérica | **29 de 30 (96,7%)** | `Var.% 24/23` gravada como 2023 |

A amostra 4 é nova (nunca vista quando as regras foram escritas) e foi sorteada com as regras anteriores à do ano da coluna de variação. O seu único erro motivou essa última regra; com ela, esse fato sai e os outros 29 continuam aceitos. A amostra final é, portanto, certificação das regras menos uma, não das regras finais em outra amostra.

## O que a medição mudou na ARQUITETURA

A guarda 1 da §5 I-5 supunha que "o número aparece na evidência" bastasse. Medido: **os erros que passam por esse teste são o número certo no lugar errado** (outra coluna, outra linha, extremo de faixa, unidade trocada), não número inventado. Só 2 fatos de 1.225 falharam em `valor_ausente`. A guarda foi corrigida na ARQUITETURA para dizer que o lastro confere também linha, coluna, faixa, sinal, escala e unidade, e remetê-la a este ADR.

## Consequências e ressalvas

- **Quem audita sou eu, não uma pessoa.** As 120 verificações (4 amostras de 30) foram feitas por mim, lendo a tabela de origem, o mesmo caso dos rótulos da F3.4. Recomendo uma conferência humana de 10 a 15 fatos da amostra 4 (ids em `auditoria.json`; `python -m indexer.lastro ... --amostra 30 --semente 4` não reproduz a amostra depois das regras finais, por isso os ids estão salvos).
- **Escala não declarada.** A tabela de risco de mercado (p. 157, "Fator de Risco | Conceito | Resultado") não diz a unidade em nenhum trecho do recorte, e o modelo gravou escala 1 ("(12.345)" como R$ 12.345). Se o PDF disser "R$ mil", 3 dos 30 fatos da amostra final (10%) estão com o valor 1.000 vezes menor, e a precisão cai para 26 de 30. **Confirmar a unidade na p. 157 do PDF** antes de a F4.4 importar esses fatos; o lastro não consegue provar nem negar isso. A escala 1 em fato monetário nunca é rejeitada, pelo mesmo motivo.
- **A taxa de rejeição é conservadora.** 34% inclui fatos corretos que o texto não permite provar: células mescladas que o Markdown deixa sem rótulo (`linha`), tabelas achatadas em texto corrido dentro de um Pai, onde o modelo remontou a linha e as datas (`evidencia_fora_do_texto`), e escala não declarada (`escala_sem_lastro`, 46 fatos). A taxa de falsos rejeitados não foi medida; a auditoria cobre só os aceitos.
- **O sinal impresso vale.** 66 fatos foram rejeitados porque o modelo gravou "(1.000)" como +1000 (despesa em módulo) ou "redução de R$ 400 milhões" como -400. O prompt manda manter o sinal do texto; se a decisão for aceitar o módulo para despesas, é uma mudança de contrato, não do lastro.
- **A unidade era o maior erro do modelo.** 100 fatos de unidade errada (a maioria R$ bilhões marcado como `percent`) mostram que o Qwen3.6 confunde `unit` em tabelas de unidade mista. Para a F4.6, a unidade de uma linha de tabela pode vir do cabeçalho e do rótulo, não do LLM.
- **Pais com tabela achatada** (colunas viram parágrafos soltos) rendem fatos que o lastro rejeita por não haver linha; o conserto é a detecção de tabela (F2), não o lastro.
- Os fatos aceitos e rejeitados ficam em `data/parsed/<prefixo>.fatos.json` (fora do git: a evidência é trecho literal do documento). Com o ADR-009 em aberto, nenhum trecho da amostra entra no repositório.
