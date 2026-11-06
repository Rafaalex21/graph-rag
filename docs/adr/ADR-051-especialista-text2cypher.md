# ADR-051 · O especialista Text2Cypher Gemma 3 4B não compete com o LLM principal neste grafo; fica o Qwen3.6-35B-A3B

- **Estado:** aceita (06/11/2026)
- **Data:** 2026-11-06
- **Tarefa(s):** F6.6

## Contexto

A ARQUITETURA §7.3 deixou aberta a pergunta: um especialista pequeno, treinado só para traduzir pergunta em Cypher (`neo4j/text-to-cypher-Gemma-3-4B-Instruct-2025.04.0`), competiria com o LLM principal em agregações simples, e com muito menos latência? O aceite da F6.6 é **um ADR com a acurácia de execução e a latência dos dois**.

O modelo oficial da Neo4j só existe em *safetensors* (licença Gemma, sem *gate*). Usei a conversão da comunidade `mradermacher/text-to-cypher-Gemma-3-4B-Instruct-2025.04.0-GGUF`, quantização **Q8_0** (4.130.403.040 bytes, 4,1 GB; o SHA-256 do arquivo local, `7acb37df…0292`, é o mesmo que o Hugging Face publica). O download foi autorizado pelo Rafael. Registrado em `infra/models.lock.json` (papel `text2cypher-especialista`); o `.gguf` fica em `C:\modelos`, fora do repositório. Perfil novo no llama-swap: `especialista` (`gemma3-4b-text2cypher & embedding & reranker`, Vulkan, tudo na GPU, contexto de 16k).

## Método

Mesma medida, mesma guarda e mesmas perguntas para os dois: as 15 de `eval/golden_agregacao.csv` (10 `teste`, 5 `ajuste`), `indexer.text2cypher medir`, que roda cada consulta pela guarda da F6.5 (texto, `EXPLAIN`, sessão `READ`, 5 s, uma autocorreção) e dá como certa a consulta cujo resultado contém o valor do gabarito (até 5 linhas). Temperatura 0, sem raciocínio, o mesmo grafo (8.787 nós, 22.259 relações).

Para o resultado não medir o prompt em vez do modelo, o especialista foi medido com **três prompts**:

| Variante | O que é |
|---|---|
| `completo` | O prompt de 4 seções da F6.4, igual ao do Qwen: esquema com os 687 rótulos de `f.metric`, terminologia PT↔EN, regras do grafo, 11 exemplos, formato. É o confronto "mesmo prompt". |
| `nativo` | O formato em que o especialista foi treinado (uma mensagem de usuário, sem papel `system`: `Generate Cypher statement to query a graph database... Schema: ... Question: ... Cypher output:`), com o mesmo esquema longo e os 12 rótulos candidatos da pergunta. |
| `compacto` | O mesmo formato nativo com o esquema só estrutural (nós, relações, `Entidade`), sem a lista de rótulos, recortes e valores, e com os 12 candidatos. É a melhor chance do especialista: o tamanho de esquema com que foi treinado. |

O Qwen foi medido com `completo` (o da F6.4) e, como controle, com `compacto`.

## Resultado

Neo4j com o grafo da F5.8, llama-swap local, GPU AMD (Vulkan). Latência: mediana e máximo **sem a primeira pergunta** (que paga o preenchimento do prompt de sistema, ~12 mil tokens, ainda sem cache); `llm` é só a geração.

| Modelo e prompt | Teste (10) | Ajuste (5) | Geral (15) | Consultas que rodaram | Mediana | Máximo | 1ª pergunta |
|---|---|---|---|---|---|---|---|
| **Qwen3.6-35B-A3B**, `completo` | **9** (90%) | 4 | **13 (86,7%)** | 15 | **2,85 s** | 4,0 s | 17,0 s |
| Qwen3.6-35B-A3B, `compacto` (controle) | 0 | 0 | 0 | 12 (3 bloqueadas) | 3,37 s | 17,9 s | 3,8 s |
| Gemma 3 4B, `completo` | 0 | 0 | **0** | 13 | 1,04 s | 3,2 s | 2,9 s |
| Gemma 3 4B, `nativo` | 0 | 0 | **0** | 11 | 1,39 s | 5,7 s | 0,9 s |
| Gemma 3 4B, `compacto` | 0 | 1 | **1 (6,7%)** | 15 | 0,95 s | 4,3 s | 1,2 s |

**Carga do modelo** (primeira chamada depois de trocar de perfil, medida por `aquecer`): especialista **4,5 s** (com o Qwen residente), Qwen **14,2 s** (com o especialista residente). Depois de carregado, o especialista responde a uma chamada de 1 token em 0,16 s.

O que está por trás dos zeros (de `data/avaliacao/`, fora do repositório, ADR-009):

- **O especialista ignora o esquema que recebe.** Em 9 (`completo`), 14 (`nativo`) e 11 (`compacto`) das 15 consultas ele nem cita `FinancialFact`, o nó onde estão os números; nas que li, usa rótulos que não existem no grafo (`Event`, `Empregados`, `Localizacao`, `Terceirizado`...). O Qwen citou `FinancialFact` em 15 de 15. Os avisos do `EXPLAIN` (rótulo inexistente) alimentaram a autocorreção, que não bastou.
- **Falha em silêncio**: 11 (`completo`), 11 (`nativo`) e 14 (`compacto`) das 15 consultas rodam e devolvem vazio ou zero. É o pior tipo de erro para `consultar_grafo`, porque não dá erro; só o aviso de "sem página" (F6.4) o denuncia.
- **O prompt não é o culpado do lado do especialista**: o prompt de 38 mil caracteres, o nativo longo e o compacto dão 0, 0 e 1 de 15. **E o prompt é tudo do lado do Qwen**: com o prompt compacto (sem rótulos, regras e exemplos) ele também cai para 0 de 15. A diferença entre os dois modelos está em seguir um prompt longo e específico de um grafo com métricas reificadas e rótulos em português; o especialista, treinado com esquemas curtos e propriedades diretas, não o faz.
- A guarda bloqueou 3 consultas do Qwen `compacto` (`limit_invalido` duas vezes, `incompleta`) e 1 em cada corrida `completo` e `nativo` do especialista: funcionou como projetada, e os bloqueios contam como erro de execução, não como erro de medida.

## Decisão

**O Text2Cypher do agente continua sendo o Qwen3.6-35B-A3B com o prompt da F6.4** (ADR-049). O especialista não entra como padrão nem como primeira tentativa de roteamento: ganha em latência (2 a 3 vezes mais rápido na mediana e 3 vezes mais rápido para carregar), mas acerta 0 a 1 de 15 contra 13 de 15, e erra em silêncio.

O perfil `especialista` e a entrada no `models.lock.json` ficam, para repetir a medição se o grafo ou o modelo mudarem (`indexer.text2cypher medir --llm gemma3-4b-text2cypher --prompt compacto`). Nada no caminho de consulta o chama.

Mudanças de código que a medição exigiu, todas com teste (`tests/test_text2cypher_especialista.py`, 27 testes):

- `montar_mensagens(variante, ...)` e `perguntar(prompt=...)` escolhem a variante; nome desconhecido dá `erro = "prompt_invalido: ..."` sem chamar o LLM.
- `extrair_cypher` passou a entender o que o especialista devolve: `Cypher output: MATCH ...`, prosa depois de uma linha em branco e **`\n` escrito com barra entre as cláusulas** (o modelo foi treinado com Cypher dentro de JSON; sem esse tratamento a guarda recusava tudo como `incompleta`). A sequência dentro de uma string do Cypher é preservada.
- `resumir_casos` separa a primeira chamada da mediana, conta quantas consultas ao menos rodaram (`taxa_rodou`), agrupa os erros por tipo e dá a mediana só da geração; `aquecer` mede a carga do modelo e propaga a falha do servidor em vez de medir um erro.

## Alternativas consideradas

- **Adotar o especialista pela latência**: descartado, 1 de 15 não é aceitável nem para uma primeira tentativa que o Qwen refaria, porque o erro vem em silêncio.
- **Roteamento (especialista primeiro, Qwen se falhar)**: descartado; a falha do especialista não dispara a regra de fallback (não dá erro), e a guarda e o critério de página não distinguem zero legítimo de zero errado.
- **Ajuste fino do especialista com os 11 exemplos e o esquema do grafo**: não feito. Exigiria treinar, com GPU ocupada por indexação e avaliação, e os 11 exemplos são poucos; fica como hipótese se algum dia a latência de 3 s do Qwen virar problema.
- **Medir só o `completo`**: justo na forma, mas mede o prompt, não o modelo; por isso as três variantes.

## Limites

- **n = 15** (10 no teste): a diferença 13/15 contra 0/15 é grande demais para ser acaso, mas o número exato do especialista num conjunto maior (ou em perguntas que não sejam agregação) não é conhecido. Consultas de entidade simples (nome, cargo) não foram testadas com o especialista: a busca local e os templates da F6.1/F6.3 já cobrem esse caso sem LLM.
- **O prompt foi iterado para o Qwen** (quatro rodadas na F6.4). O especialista recebeu três variantes, mas nenhuma foi iterada por mim; um prompt escrito para ele pode melhorar o resultado, e o ajuste fino é o caminho mais provável.
- **Conversão de terceiro**: GGUF da comunidade (mradermacher), Q8_0, quase sem perda. O hash confere com o do Hugging Face, não com a Neo4j. A licença é a Gemma; o uso aqui é local e de avaliação.
- **Latência sob carga diferente**: o Qwen roda com `-np 2` e experts na CPU; o especialista, inteiro na GPU. A comparação é a do sistema como está montado, não de modelos em hardware igual. O máximo de 17,9 s do Qwen `compacto` (uma única pergunta) não foi investigado; no `completo` o máximo é 4,0 s.
- **A primeira pergunta do Qwen custa 17 s** (preenchimento do prompt de sistema sem cache). Isso vale para a F7: manter o modelo e o prefixo aquecidos.
