# ADR-032 · Esquemas Pydantic da extração dirigida e o JSON Schema em `contracts/`

- **Estado:** aceita (31/10/2026)
- **Data:** 2026-10-31
- **Tarefa(s):** F4.1

## Contexto

A F4.2 vai extrair fatos, organizações, pessoas, segmentos, riscos, eventos e instrumentos de cada Pai e de cada Tabela com `response_format: json_schema`, imposto por gramática no `llama-server`. O aceite da F4.1 é um JSON Schema gerado e versionado em `contracts/`, a partir de modelos Pydantic com descrição em cada campo e `Optional` onde o dado puder faltar (ARQUITETURA §5 I-5).

## Decisão

1. **Modelos em `indexer/src/indexer/schemas/extracao.py`** (Pydantic 2.14.2, versão atual no PyPI em 31/10/2026, fixada no `pyproject.toml`): `FinancialFact`, `Organization`, `Person`, `Segment`, `RiskFactor`, `Event`, `Instrument` e o contêiner **`ExtracaoDirigida`**, que reúne as sete listas e é o que vai em `response_format`. Uma chamada devolve tudo o que há no trecho.
2. **Descrição em todo campo e `extra = "forbid"`** (`additionalProperties: false` no schema). Um teste falha se algum campo ficar sem descrição.
3. **`Optional` só no que o documento pode não dizer.** Em `FinancialFact` são obrigatórios `metric`, `value`, `unit`, `period`, `period_type`, `entity` e `evidence`; `currency`, `scale` e `segment` são opcionais. Em `Person` só `name`; em `Organization`, `name` e `role`.
4. **As sete listas do contêiner são obrigatórias, mas podem ser vazias**: a gramática obriga o modelo a decidir sobre cada tipo, em vez de omitir a chave.
5. **`value` é o número como está escrito na evidência, sem aplicar a escala** ("R$ 16.782 milhões" → 16782, escala 1.000.000). É o que permite o lastro numérico da F4.3 achar o valor no trecho com `numeros.valores_no_texto`.
6. **`period` com padrão** `2025-FY | 2025-Q4 | 2025-12-31`; `evidence` com no máximo 200 caracteres; datas de `Event` e vencimentos de `Instrument` em `2025`, `2025-06` ou `2025-06-30`.
7. **Identificador, página e ligação com o Pai ou a Tabela de origem não estão nos modelos**: são do contexto da chamada (F4.2) e do importador (F4.4, IDs determinísticos).
8. **`contracts/extraction.schema.json`** é gerado por `uv run python -m indexer.schemas` (a partir de `indexer/`) e leva `version` (`VERSAO` = 1.0.0, a subir quando o contrato mudar) e `$id`. `--conferir` falha se o arquivo estiver desatualizado, e um teste faz o mesmo no CI.

## Diferença em relação ao exemplo da ARQUITETURA §5 I-5

O exemplo do documento marca `scale` como obrigatório. Aqui ele é opcional: percentuais, razões e contagens não têm escala, e obrigar o campo faria o modelo inventar `1`, o que o próprio I-5 quer evitar. A semântica de `value` (item 5) também foi explicitada. É um refinamento do exemplo, não uma contradição de medida; o trecho da ARQUITETURA pode ser ajustado quando o contrato estabilizar (F4.2).

## Verificação do aceite da F4.1

- `contracts/extraction.schema.json` gerado (515 linhas, 7 modelos em `$defs`, `version` 1.0.0), e `python -m indexer.schemas --conferir` confirma que está em dia.
- `indexer/tests/test_schemas.py` (16 testes): arquivo versionado igual ao gerado; descrição em todo campo; `additionalProperties: false`; campos obrigatórios e opcionais como acima; contêiner exige as 7 listas e aceita todas vazias; período, escala, unidade, evidência longa, valor infinito e campo extra são rejeitados.

## Ressalvas

- **Ainda não passou pela gramática do `llama-server`.** O llama.cpp converte só um subconjunto do JSON Schema (`pattern`, `maxLength`, `anyOf` com `null` e `enum` de inteiros costumam funcionar, mas não foi medido). Isso se prova na F4.2, a primeira que envia o schema ao modelo; se alguma palavra-chave for recusada, o ajuste vai nos modelos e o `VERSAO` sobe.
- Os esquemas de extração aberta (I-6, F5) e do Text2Cypher não fazem parte desta tarefa.
