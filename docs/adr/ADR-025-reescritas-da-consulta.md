# ADR-025 · Reescritas opcionais da consulta: step-back e HyDE

- **Estado:** aceita (28/10/2026)
- **Data:** 2026-10-28
- **Tarefa(s):** F2.8

## Contexto

O cap. 3 do livro e a ARQUITETURA (§2 degrau 3, §7) preveem duas reescritas opcionais da pergunta antes da busca: o *step-back* (uma pergunta mais geral, que traz o contexto necessário) e o *HyDE* (um trecho hipotético que responderia à pergunta; o vetor dele se parece mais com os Filhos do que o da pergunta). A F2.8 exige as flags `--stepback` e `--hyde` na CLI. O ganho é hipótese a medir na F3 (A3); o estudo citado na §2 com FinanceBench aponta reescrita e reranking entre as técnicas que mais ajudaram.

## Decisão

Módulo `indexer/src/indexer/reescrita.py`, mais parâmetros `stepback` e `hyde` em `recuperador.recuperar` e em `reranker.recuperar_e_reranquear`.

1. **Flags:** `--stepback`, `--hyde` e `--llm MODELO` em `python -m indexer.recuperador buscar` e `python -m indexer.reranker buscar` (um teste confere o `--help` dos dois). Sem as flags, o comportamento é idêntico ao da F2.5/F2.6 (há teste).
2. **LLM:** Qwen3.6 do perfil `consultar` por padrão (`--llm gpt-oss-20b` no `consultar-rapido`), `json_schema` estrito e sem raciocínio. As duas reescritas rodam **em paralelo** (2 slots).
   - *Step-back:* uma pergunta geral, com 2 exemplos genéricos no prompt, temperatura 0,2, 120 tokens.
   - *HyDE:* um trecho de 80 a 130 palavras no estilo do Formulário de Referência, temperatura 0,4, 400 tokens, pedindo para evitar números exatos.
3. **Como entram na busca:** cada reescrita produz um ranking de Filhos próprio. O step-back usa o **mesmo modo** da pergunta (vetor, texto ou híbrido), com a instrução de consulta. O HyDE é sempre vetorial e **sem instrução** (lado do documento). Os rankings se unem por **RRF** com o da pergunta original (`fundir_variantes`), e a deduplicação por Pai segue como antes.
4. **O reranker lê só a pergunta original:** as reescritas ampliam a recuperação, não mudam o que o usuário perguntou.
5. **Falha não derruba a busca:** erro de rede, JSON inválido ou reescrita fora das regras (pergunta geral igual à original, sem `?`, trecho curto demais) descarta aquela reescrita, registra o motivo em `erros` e a recuperação segue com a pergunta.
6. **Medição reproduzível:** `python -m indexer.recuperador comparar-reescritas` mede custo e quanto as reescritas mudam o top-k.

## Alternativas consideradas

- **Substituir a pergunta pela reescrita:** perde a pergunta original, que costuma ser a melhor para termos exatos (números, nomes). A união por RRF preserva as duas.
- **Aplicar a reescrita sempre:** custa segundos por consulta (ver abaixo) sem evidência de ganho; fica opcional, decidida pela F3 e pelo roteador do agente (F7+).
- **HyDE também no full-text:** o trecho hipotético inventa números e frases, e o casamento lexical com isso é ruído; só o vetor.

## Consequências

- A F3 (degrau A3) mede o ganho de cada reescrita separadamente; o custo abaixo entra no cálculo.
- O agente (F7+) pode ligar as reescritas só para perguntas conceituais.
- Há dependência do LLM no caminho da consulta quando as flags estão ligadas: com `consultar` o Qwen3.6 já está residente; no `consultar-rapido` o gpt-oss é mais rápido.

## Verificação do aceite da F2.8

| Critério | Resultado |
|---|---|
| Flags `--stepback` e `--hyde` na CLI | Presentes em `indexer.recuperador buscar` e `indexer.reranker buscar` (teste do `--help`); executadas de verdade sobre o banco nos dois comandos, com 0 erros |
| Testes | 8 testes novos em `test_reescrita.py` (só chama o LLM para o que foi pedido, falha silenciosa, validações, fusão de N rankings, retriever com e sem reescritas, step-back também no texto, flags na CLI); 169 no indexador, ruff limpo |

**Medição informativa** (`comparar-reescritas`, 20 perguntas de `eval/perguntas_latencia.txt`, modo `hibrido-rrf`, k = 6; [`ADR-025-bruto/comparar_reescritas.json`](ADR-025-bruto/comparar_reescritas.json)):

| | step-back | HyDE | os dois (em paralelo) |
|---|---:|---:|---:|
| Tempo da reescrita, p50 | 3,7 s | 7,3 s | 7,3 s |
| Tempo da reescrita, máx. | 4,4 s | 9,2 s | 9,2 s |
| Reescritas com erro | 0 | 0 | 0 de 40 |
| Sobreposição (Jaccard) do top-6 de Pais com a busca sem reescrita | 0,611 | 0,612 | 0,564 |
| Perguntas em que o 1º Pai mudou | 6 de 20 | 6 de 20 | 9 de 20 |

Para comparação, a recuperação sem reescrita leva ~0,1 s (ADR-022).

## Ressalvas

1. **A qualidade não foi medida.** As reescritas mudam cerca de 40% do top-6 e o 1º Pai em 30 a 45% das perguntas, mas não sei se para melhor; não há gabarito até a F3.1.
2. **O custo é de segundos.** Uma consulta com HyDE passa de ~0,1 s para ~7 s só na reescrita (o p50 em paralelo é o do HyDE; cada reescrita roda mais devagar quando as duas disputam os 2 slots). Para uso interativo isso só se justifica se a F3 mostrar ganho claro.
3. **O HyDE inventa números** (no exemplo testado, "lucro líquido ajustado de R$ 10,5 bilhões") apesar de o prompt pedir para evitá-los. É inerente à técnica e o vetor tende a ser dominado pelo estilo, mas é um risco de puxar Pais com números parecidos. Por isso o trecho nunca vai ao LLM de resposta, só ao embedding.
4. **As primeiras chamadas incluem a carga do modelo** (16 a 20 s na primeira vez); a tabela acima é pós-aquecimento.
5. **Os exemplos do prompt do step-back são genéricos e em português**; para documentos em inglês o prompt precisa de versão própria.
6. As 20 perguntas são de fumaça, sem gabarito (as mesmas da F2.5).

## Evidência

`indexer/src/indexer/reescrita.py`, `indexer/src/indexer/recuperador.py`, `indexer/src/indexer/reranker.py`, `indexer/tests/test_reescrita.py`, `docs/adr/ADR-025-bruto/`.
