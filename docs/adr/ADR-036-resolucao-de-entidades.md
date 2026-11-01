# ADR-036 · Resolução de entidades

- **Estado:** aceita (01/11/2026), com o critério da F4.5 ajustado: as 12 fusões possíveis no recorte foram auditadas (12 de 12 na leitura aceita, 9 de 12 na estrita) e as 20 fusões ficam para a F5.8 (ver "Fechamento")
- **Data:** 2026-11-01
- **Tarefa(s):** F4.5

## Contexto

O aceite da F4.5 é: 20 fusões auditadas com ≥ 90% corretas, aliases preservados. A §5 I-7 descrevia seis passos: normalização, bloqueio por tipo e primeiro token, candidatos por embedding de nome + descrição (limiar inicial 0,92), confirmação por LLM, fusão com `apoc.refactor.mergeNodes` e chaves fortes (ticker, CNPJ) acima de qualquer heurística. A entrada são as 106 entidades que a F4.4 importou ([ADR-035](./ADR-035-importacao-idempotente.md)): 67 organizações, 13 pessoas, 12 segmentos, 9 riscos, 5 instrumentos.

## Medição que corrigiu a ARQUITETURA

**O embedding não separa duplicatas de não duplicatas.** Antes de rodar qualquer coisa escrevi, lendo a lista das 106 entidades, uma referência: 9 grupos que considero a mesma entidade (14 pares, 11 fusões) e 6 grupos ambíguos. Depois medi a similaridade de cosseno (Qwen3-Embedding-0.6B, `nome. descrição`) dos 2.359 pares do mesmo tipo:

| Limiar | Pares acima | Pares da referência acima | Outros |
|---|---|---|---|
| 0,92 (§5 I-7) | 1 | 1 de 14 | 0 |
| 0,90 | 2 | 2 | 0 |
| 0,85 | 6 | 4 | 2 |
| 0,80 | 14 | 6 | 8 |
| 0,70 | 32 | 6 | 26 |

Até em 0,70 só 6 dos 14 pares verdadeiros aparecem; os outros 8 têm similaridade de 0,43 a 0,62 (sigla e nome por extenso, "Cielo" e "Cielo S.A. - Instituição de Pagamento"). E há não duplicatas acima de 0,85 ("bancário" e "investimentos", 0,88; "UBS" e "UBS BB", 0,86). Com 0,92 só a Vice-Presidência × Vice-Presidente passaria, e o LLM disse não a ela.

Por isso o embedding virou **um gerador de candidatos entre quatro** e o LLM é quem decide.

## Decisão

**`indexer/src/indexer/resolver.py`** (`python -m indexer.resolver planejar|aplicar`). `planejar` usa o LLM e não toca no grafo além de reconstruí-lo sem fusões; `aplicar` funde e não usa LLM.

1. **Normalização** (`nome_base`): minúsculas, sem acento nem pontuação, sem o sufixo societário (S.A., Ltda., Inc., Corp., Ltd., Limited).
2. **Bloqueio** (`chaves_de_bloco`): tipo da entidade (nunca se comparam tipos diferentes) e, por nome, o primeiro token significativo mais as iniciais de cada parte ("BCB" e "Banco Central do Brasil" caem no mesmo bloco; "CEF - Caixa Econômica Federal" é tratado em duas partes).
3. **Candidatos** (um par entra se tiver ao menos uma razão):

| Razão | Regra | Pares |
|---|---|---|
| `nome_contido` | os tokens significativos de um nome estão no outro (em qualquer bloco) | 19 |
| `embedding_no_bloco` | mesmo bloco e cosseno ≥ 0,70 | 18 |
| `embedding_global` | cosseno ≥ 0,80 em qualquer bloco | 14 |
| `mesmo_cnpj` | mesmo CNPJ (ou ticker) e nomes diferentes | 3 |
| `sigla` | um nome de um token é igual às iniciais do outro | 2 |

   Os 34 candidatos somam mais que 56 razões porque um par pode ter várias. CNPJs diferentes **vetam** o par; nomes inválidos ("N/A", "null", "Desconhecido") e o tipo `Event` (sem dado real) ficam de fora.
4. **Confirmação por LLM** (Qwen3.6-35B-A3B, `temperature` 0, JSON por gramática `{mesma_entidade, justificativa}`, cache por hash do pedido em `data/parsed/resolucao_cache/`): cada par recebe os dois nomes, os papéis, a descrição, o CNPJ e um trecho do documento onde o nome aparece. Resultado: 13 "sim" e 21 "não" em 34. O prompt manda responder `false` na dúvida e lista o que é e o que não é a mesma entidade.
5. **Fusão**: componentes ligados por pares aceitos (um grupo com um par julgado "não" dentro seria um conflito e não funde; nenhum apareceu). Sobrevive o nó mais citado (fatos + menções), depois o de nome mais completo. `apoc.refactor.mergeNodes([sobrevivente, absorvidos...], {properties: 'discard', mergeRels: true})`.
6. **Chave forte:** mesmo CNPJ ou ticker **e o mesmo nome sem sufixo** funde sem LLM (0 pares no recorte). Com nomes diferentes o par vai ao LLM.

**O plano sobrevive à reimportação.** `mergeNodes` não tem volta e o importador da F4.4 recriaria os nós absorvidos (os ids são hash do nome). Por isso `planejar` grava `data/parsed/<prefixo>.resolucao.json` (fora do git) com `redirecionar` (id absorvido → id que fica) e `nomes` (nome canônico), e `indexer.importar` o lê sozinho: os ids absorvidos viram o sobrevivente e `absorbedIds` registra quem foi fundido. As propriedades finais (aliases, papéis, descrição, CNPJ) vêm do importador, não do `mergeNodes`.

**O plano parte do grafo sem fusões.** `planejar` apaga os sobreviventes de uma fusão anterior (`reconciliar`) e reimporta sem redirecionamento, então rodar `planejar` e `aplicar` de novo dá o mesmo plano e o mesmo grafo. Isso só apaga nós de entidade que o próprio importador recria a partir da extração; nenhum fato nem texto do documento é tocado. Um instantâneo das 106 entidades e suas relações antes da fusão foi guardado em `data/parsed/bb_fre_2026_recorte.pre_resolucao.json` (fora do git).

**Uma correção durante a auditoria.** A primeira versão tratava CNPJ igual como chave forte absoluta (a regra da §5 I-7). A auditoria mostrou que isso fundia a Procuradoria-Geral e a Secretaria do Tesouro Nacional no Ministério da Fazenda só porque o documento lista as três com o CNPJ do Ministério. Mudei a regra para a de cima (chave forte só com o mesmo nome) **depois de ver a auditoria**, o que enviesa a correção para o resultado desejado. O resultado não mudou: o LLM, vendo o mesmo CNPJ, respondeu "sim" aos três pares.

## Verificação (F4.5)

Evidência: `docs/adr/ADR-036-bruto/resumo.json` (contagens, sem texto do documento). Comandos, a partir de `indexer/` com Neo4j e llama-swap no ar:

```
uv run python -m indexer.resolver planejar ../data/parsed/bb_fre_2026_recorte --doc-id bb-fre-2026-v7
uv run python -m indexer.resolver aplicar  ../data/parsed/bb_fre_2026_recorte --doc-id bb-fre-2026-v7
```

| | Antes | Depois |
|---|---|---|
| `__Entity__` | 106 | **94** (12 absorvidos em 9 grupos: 7 de 2 nós, 1 de 3, 1 de 4) |
| `Organization` / `Segment` | 67 / 12 | 56 / 11 |
| Pessoas, riscos, instrumentos | 13 / 9 / 5 | 13 / 9 / 5 |
| `FinancialFact`, `REPORTED_IN`, `ABOUT`, `FOR_PERIOD` | 803, 803, 796, 803 | iguais |
| `MENTIONED_IN` | 225 | 223 (duas menções da mesma unidade se uniram) |
| `HOLDS_POSITION`, `ISSUED_BY` | 15, 5 | iguais |

Conferido no Neo4j depois de `aplicar`: nenhum id absorvido continua no grafo; **todas as grafias dos 106 nós estão nos `aliases` dos sobreviventes** (0 perdidas); todas as 1.048 relações de antes (com os ids redirecionados) existem agora (0 ausentes); nenhum auto-laço; a sanidade da F4.4 deu 0 em todas; reimportar duas vezes depois da fusão não mudou contagem nem impressão digital (`e4a7696995c9a8be`), e `planejar` seguido de `aplicar` de novo deu a mesma impressão digital. Os 730 fatos do Banco do Brasil continuam ligados a "Banco do Brasil S.A.", que absorveu "Banco do Brasil" (95 menções).

**Recall dos candidatos e do LLM contra a referência escrita antes:** dos 14 pares da referência, 9 viraram candidatos e o LLM aceitou 8; das 11 fusões da referência, 8 foram feitas. Perdas conhecidas: "Bacen" nunca vira candidato (portmanteau, sem iniciais nem token em comum); "BB-BI" e "BB - Banco de Investimento S.A." não casam; o LLM recusou Vice-Presidente × Vice-Presidência por ser cargo × unidade (argumento defensável, e a minha referência é só uma opinião).

## Auditoria das fusões

Audite as 12 absorções lendo o trecho do documento onde cada nome aparece. "Correta" quer dizer que os dois nomes são a mesma entidade do mundo real.

| Fusão | Veredito |
|---|---|
| BB Seguridade → BB Seguridade Participações S.A. | correta |
| Banco do Brasil → Banco do Brasil S.A. | correta |
| Banco Patagonia → Banco Patagonia S.A. | correta |
| Caixa Econômica Federal → CEF - Caixa Econômica Federal | correta |
| BCB → Banco Central do Brasil | correta (a sigla vem de "Resolução BCB") |
| Banco Central → Banco Central do Brasil | correta |
| Cielo S.A. - Instituição de Pagamento → Cielo | correta |
| investimentos → Segmento de investimentos | correta |
| Comitê de Prevenção à Ilícitos → Comitê Executivo de Prevenção a Ilícitos Financeiros e Cambiais | provável (mesma seção, sem outro comitê com esse nome) |
| Procuradoria Geral da Fazenda Nacional/MF → Ministério da Fazenda | órgão do ministério, mesmo CNPJ |
| Ministério da Fazenda / Secretaria do Tesouro Nacional → Ministério da Fazenda | órgão do ministério, mesmo CNPJ |
| Tesouro Nacional → Ministério da Fazenda | órgão do ministério |

**Corretas ou prováveis: 9 de 12 (75%).** Os 3 últimos só contam como corretos se "órgãos de um mesmo ministério, que o documento identifica pelo CNPJ do ministério" forem a mesma entidade; nessa leitura são 12 de 12. Duas leituras honestas, e o aceite (≥ 90%) passa numa e falha na outra.

## Fechamento

Em 01/11/2026 o Rafael decidiu: (1) órgãos do Ministério da Fazenda que o documento lista com o CNPJ do ministério contam como a mesma entidade, então as 12 fusões são corretas; (2) a F4.5 fecha com as 12 fusões possíveis no recorte. A conferência das 12 foi refeita contra o plano e o texto do documento: os 13 pares aceitos pelo LLM (7 grupos de 2 nós, 1 de 3 com 2 pares e 1 de 4 com 4 pares) formam exatamente os 9 grupos e as 12 absorções da tabela acima. Para o comitê, o trecho do documento tem o nome completo com a sigla CEPI e, mais adiante, a forma curta "Comitê de Prevenção à Ilícitos", sem outro comitê com esse escopo no recorte. Na justificativa de alguns "sim" o LLM deixou caracteres estranhos (CJK) no meio do texto; a decisão `true/false` não é afetada, mas o texto não deve ser citado como está. O critério de 20 fusões auditadas vira medição da F5.8.

## Consequências e ressalvas

- **O recorte tem 12 absorções, não 20.** Não dá para chegar a 20 aqui sem inventar duplicatas; medir em 20 fusões exige a extração do documento inteiro (F5.8, ~8 h estimadas).
- **A auditoria é minha, não de uma pessoa**, e a referência também foi escrita por mim. O Rafael aceitou o resultado, mas uma conferência humana independente da família Ministério da Fazenda e do comitê continua desejável.
- **A correção da chave forte foi feita depois de ver a auditoria.** Os números acima são de depois dela; os de antes eram os mesmos (9 de 12), porque o LLM chegou à mesma fusão.
- **O LLM é o árbitro, e erra para os dois lados.** Funde órgão com ministério quando o CNPJ é igual e recusa cargo × unidade. Os 21 "não" não foram auditados: a taxa de falsos negativos medida é só a da referência (3 fusões perdidas em 11).
- **Lixo de extração continua no grafo.** Há pessoas chamadas "N/A", "null", "Desconhecido", "Membro Titular", um nome vazio e uma pessoa chamada "Ministério da Fazenda". A resolução as ignora (nome inválido) mas não as remove; isso é problema da extração (F4.2) ou de uma limpeza própria.
- **`ABOUT` aponta sempre para `Organization`.** Depois da fusão, "Diretoria Executiva", "Conselho Fiscal" e "Conselho de Administração" (60 fatos) seguem como organizações separadas.
- **Resolução do recorte, não do documento.** Os limiares (0,70 e 0,80) foram escolhidos olhando 106 entidades; no documento inteiro haverá centenas de nomes por tipo e o bloqueio fica mais importante. A F5.3 repete a resolução com as entidades da extração aberta.
- **Eventos:** o tipo `Event` não é resolvido (0 no recorte).
- **Desfazer:** `data/parsed/bb_fre_2026_recorte.pre_resolucao.json` guarda as 106 entidades e as relações antes da fusão; `python -m indexer.resolver planejar` reconstrói o grafo sem fusões.
