# ADR-017 · Normalizador numérico

- **Estado:** aceita (28/10/2026)
- **Data:** 2026-10-28
- **Tarefa(s):** F1.7

## Contexto

A ARQUITETURA §5 (I-2) chama o normalizador numérico de "o ponto onde documentos financeiros mais enganam um RAG". Os formatos reais das 15 tabelas auditadas na F1.6 (`docs/auditoria-tabelas.md`) mostram o que ele precisa tratar: `914.535` (milhar com ponto), `8,5` (decimal com vírgula), `(6,3)` (negativo entre parênteses), `-` (célula sem valor, que em colunas de variação significa "acima de 200%"), `66,25%`, `-30,0 a -27,0` (faixas), `Não Aplicável`, e a escala dita no cabeçalho (`R$ milhões, exceto percentuais`). O esquema `FinancialFact` da §5 (I-5) já separa `value`, `scale` e `currency`, o que pede um normalizador que também separe o valor impresso da escala.

## Decisão

Módulo `indexer/src/indexer/numeros.py`, em `Decimal` (sem ponto flutuante):

1. **`parse_valor(texto, formato)`** devolve um `Valor` imutável com `valor` (sinal já aplicado, **como impresso**, sem multiplicar pela escala), `unidade` (`numero`, `percentual`, `pontos_base`, `pontos_percentuais`), `moeda`, `escala_inline` ("169.235 milhões"), `negativo_por_parenteses`, `formato` e `ambiguo`. `com_escala(fator_do_cabecalho)` multiplica; percentuais e pontos não têm escala.
2. **Formato:** `pt` (`1.234,56`), `en` (`1,234.56`) ou `auto`. No `auto`: com os dois separadores, o último é o decimal; vários separadores iguais são milhar; um separador seguido de ≠ 3 dígitos é decimal; **um separador seguido de exatamente 3 dígitos (`1.234`) é ambíguo**: sai como pt-BR e marcado `ambiguo=True`. Com o formato conhecido (`pt` ou `en`) a ambiguidade não existe, e milhares mal agrupados (`1.23.4`) viram `None` em vez de um valor inventado.
3. **`detectar_formato(amostra)`** decide o formato do documento pelos números que não são ambíguos; o resto do pipeline passa o formato explícito.
4. **Célula sem valor nunca vira zero:** `-`, `–`, `—`, `n.a.`, `n/d`, `Não Aplicável` e vazio voltam como `ausente=True` com um `motivo`. O significado do traço depende do contexto (a legenda "Obs:" da F1.6).
5. **`detectar_escala(cabeçalho)`** lê fator (mil, milhões, bilhões, em português e inglês) e moeda (BRL, USD, EUR) do cabeçalho; sem escala declarada devolve `None`.
6. **`parse_faixa`** (`8,0 a 12,0`, `-30,0 a -27,0`, `9,53% a 15,77% DI`) e **`valores_no_texto`** (os números de um trecho, base do lastro numérico da F4.3).
7. **`python -m indexer.numeros`** resume as células de um `DoclingDocument` (número, faixa, ausente, texto, não interpretado).

## Alternativas consideradas

- **`float`.** Perde exatidão em somas e comparações de lastro; `Decimal` mantém `0,10` e `1.045.338` exatos.
- **Bibliotecas de localidade (`babel` e afins).** Resolvem um formato conhecido, mas não decidem sozinhas entre pt-BR e EN, e não tratam parênteses, escala nem traço.
- **Tratar `-` como zero.** Errado neste documento (em colunas de variação quer dizer "acima de 200%"; em outras, "sem valor").
- **Aplicar a escala dentro do valor.** Perde o número que está no documento (`835.670`) e dificulta a verificação de lastro contra o texto; a escala fica separada, como no `FinancialFact`.

## Consequências

- A F4.3 (lastro numérico) usa `valores_no_texto` com o formato detectado e compara valores normalizados, não texto.
- A F2.1 e a F4 devem guardar `valor`, `escala` e `moeda` separados (o `com_escala` junta quando preciso).
- `1.234` em modo `auto` é sinalizado; quem consome decide (ou passa o formato do documento).

## Verificação do aceite da F1.7

| Critério | Resultado |
|---|---|
| ≥ 30 testes unitários passando | **83 testes** do normalizador passam (102 no indexador); cobrem pt-BR, EN, parênteses, sinal Unicode, percentuais, pontos-base, ausentes, ambiguidade, formas inválidas, moeda, escala inline e de cabeçalho, faixas e lastro |
| Células reais do recorte | 4.180 células das tabelas: **2.577 números, 64 faixas, 287 ausentes, 1.249 de texto e 3 não interpretadas** (uma referência de seção "3.1", uma linha pontilhada do sumário e um par de páginas); formato detectado: pt |
| Identidade contábil nas células reais | na tabela de captações (original p. 84), **A + B + C = D fecha nos três anos** com B ("Depósitos no Banco Central") entre parênteses, e a soma dos componentes de A também; escala do cabeçalho "R$ milhões" lida como 1.000.000 em reais |

Evidência: [`ADR-017-bruto/numeros_celulas_recorte.json`](ADR-017-bruto/numeros_celulas_recorte.json).

## Ressalvas

1. O formato real do recorte é só pt-BR; o **EN está coberto por testes unitários, não por um documento em inglês**.
2. A primeira versão classificava mal 104 células (faixas, rótulos com número, referências de seção); a classificação foi refinada e a faixa ganhou suporte a sufixo de indexador. A comparação de células reais não foi feita célula a célula contra o PDF aqui (isso foi a F1.6); aqui mediu-se a taxa de interpretação e as identidades contábeis.
3. Não cobre múltiplos (`1,5x`), frações, notação científica nem números por extenso. As abreviações de escala `mi` e `bi` só valem como palavra inteira.
4. Um `-` de coluna de variação só vira "acima de 200%" se a legenda for lida junto (a nota da tabela, ADR-015).
5. A detecção de escala no cabeçalho usa a primeira escala encontrada (de bilhões para mil); um cabeçalho com duas escalas não é tratado.

## Evidência

Testes em `indexer/tests/test_numeros.py`; células reais: `data/parsed/bb_fre_2026_recorte.docling.json` (ADR-014).
