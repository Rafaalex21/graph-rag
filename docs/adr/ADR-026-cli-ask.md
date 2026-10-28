# ADR-026 · CLI `ask`: resposta só com o contexto e citação `[p. N]`

- **Estado:** aceita (28/10/2026)
- **Data:** 2026-10-28
- **Tarefa(s):** F2.9

## Contexto

Fecha a fase F2 (linha de base vetorial): a pergunta passa pelo retriever (ADR-022), pelo reranker (ADR-023) e chega a um LLM que deve responder **só com os trechos recuperados** e **citar a página**. O aceite da F2.9 é "5 perguntas de fumaça com a página correta".

## Decisão

Módulo `indexer/src/indexer/ask.py` (`python -m indexer.ask "pergunta"` e `python -m indexer.ask avaliar`).

1. **Pipeline do degrau 3:** pergunta → (reescritas opcionais `--stepback`/`--hyde`, ADR-025) → k×4 Filhos → até 24 Pais (`--k`) → rerank → 6 Pais (`--top`) → LLM. Modo de busca padrão `hibrido-rrf` (a F3 pode trocar).
2. **Contexto:** cada Pai entra rotulado com a **página física original** (a do pdf.js), `[p. 80] Seção: <caminho>` seguido do texto; um Pai que cobre duas páginas é rotulado `[p. 156-157]`.
3. **Prompt de sistema:** usar apenas os trechos, sem conhecimento externo nem estimativas; terminar cada afirmação com `[p. N]` copiando o rótulo; se não houver resposta, dizer exatamente "Não encontrei essa informação nos trechos recuperados."; português direto, números e unidades como no texto. Temperatura 0,2, sem raciocínio, 700 tokens.
4. **Citações conferidas pelo código:** cada `[p. ...]` da resposta é extraído e só é válido se as páginas citadas couberem na faixa de um dos trechos entregues; uma citação fora disso sai marcada (`citacoes_invalidas`) e a CLI avisa. Isto pega página inventada; **não** pega página errada que por acaso esteja entre as entregues.
5. **Sem candidatos** a recuperação não chama o LLM e responde "não encontrei".
6. **Saída:** a resposta, as fontes (páginas, caminho da seção, nota do reranker) e a latência por etapa; `--json` para o resultado completo.
7. **Avaliação de fumaça reproduzível:** `ask avaliar` roda [`eval/fumaca_f2_9.json`](../../eval/fumaca_f2_9.json): 5 perguntas com a página correta e o fato esperado, mais 2 perguntas sem resposta no documento.

## Como o gabarito foi feito

As **páginas corretas vêm do PDF original**, achadas por busca de texto com o `pypdfium2` (script e saída em [`ADR-026-bruto/gold_paginas_pdf.py`](ADR-026-bruto/gold_paginas_pdf.py) e `.json`), e não do sistema: caixa operacional → p. 91; empréstimo do NDB → p. 90; criação do Programa de Integridade → p. 194; auditor KPMG → p. 62 e 363 (aparece nas duas); processos julgados em 2023 → p. 200. Uma citação conta como correta se nomeia (ou, sendo intervalo, cobre) uma dessas páginas.

## Verificação do aceite da F2.9

| Critério | Resultado |
|---|---|
| 5 perguntas de fumaça com a página correta | **5 de 5** páginas corretas; **5 de 5** com o fato esperado na resposta; **0** citações inválidas (`avaliacao_fumaca.json`) |
| Responde só com o contexto | os 2 negativos (lucro de outro banco; cotação "de hoje") foram **recusados** com a frase prevista |
| Tempo por pergunta (aquecido) | 4,0 a 7,4 s no total (recuperação, rerank e geração); a 1ª chamada, que carregou os três modelos do perfil `consultar`, levou ~23 s |
| Perfil `consultar` | LLM + embedding + reranker ficaram **residentes ao mesmo tempo** (`/running`), sem expulsão |
| Com reescritas | `ask … --stepback --hyde` respondeu corretamente (p. 194) |
| Testes | 9 testes novos em `test_ask.py`; 178 no indexador, ruff limpo |

## Ressalvas

1. **O teste é fácil e enviesado a favor do sistema.** Escolhi os fatos lendo os Pais do recorte, e as perguntas repetem o vocabulário do texto. Cinco perguntas factuais de uma só passagem **não** medem a qualidade da recuperação (isso é a F3, com o golden set). O resultado mostra que o fluxo inteiro funciona de ponta a ponta, não que o sistema é bom.
2. **Citação por intervalo é imprecisa:** um Pai que atravessa páginas é citado como `[p. 195-196]`, sem dizer em qual delas está o fato; os 5 casos acertaram em Pais de uma página só. A interface (F8) precisará de granularidade por Filho ou marcadores de página dentro do Pai.
3. **O conferidor de citações é fraco por construção** (ver decisão 4): ele não detecta que o modelo atribuiu um fato à página errada entre as entregues. O 5 de 5 vem da comparação com o PDF, não do conferidor.
4. **Tabelas ainda não entram na resposta:** o `ask` usa os Pais de texto; as tabelas e o `question_vec` (F2.7) só serão integrados ao agente. Perguntas cuja resposta está numa tabela (por exemplo a composição acionária) podem falhar.
5. **Não há memória de conversa nem streaming;** são da F7/F8.
6. A segunda pergunta de negativos ("cotação hoje") testa a recusa, mas um modelo poderia recusar por motivos errados; um conjunto maior de negativos é da F3.
7. Latência de 4 a 7 s é aceitável para CLI, mas a geração domina; o `consultar-rapido` (gpt-oss) é a alternativa se a interface exigir menos.

## Evidência

`indexer/src/indexer/ask.py`, `indexer/tests/test_ask.py`, `eval/fumaca_f2_9.json`, `docs/adr/ADR-026-bruto/` (`avaliacao_fumaca.json`, `gold_paginas_pdf.py`, `gold_paginas_pdf.json`).
