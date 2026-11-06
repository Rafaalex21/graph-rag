# ADR-053 · Atualizador de pergunta: reescrita autônoma e subperguntas com dependências, em JSON forçado, com fallback para a pergunta inteira

- **Estado:** aceita (06/11/2026)
- **Data:** 2026-11-06
- **Tarefa(s):** F7.2

## Contexto

O primeiro passo do agente (ARQUITETURA §7.1) transforma a pergunta do usuário em algo que o roteador (F7.3) consiga tratar uma subpergunta por vez: sem pronomes ("e quantos membros ele tem?"), sem elipse ("e em 2024?") e separada em perguntas atômicas quando junta fatos diferentes. O aceite da F7.2 é **10 perguntas compostas decompostas corretamente**.

Duas coisas pedem cuidado, e foram o que os testes cobriram:

- **Quebrar demais custa tanto quanto quebrar de menos.** "Somando A e B, quanto dá?" é uma consulta ao grafo (Text2Cypher, F6.4); partida em duas, vira duas buscas e uma soma na mão do redator. O mesmo vale para uma lista, para uma série ("em quais anos caiu") e para dois atributos da mesma entidade.
- **Dependência é informação.** "Qual empresa audita o Banco e desde quando ela presta o serviço?" tem duas subperguntas, mas a segunda só se faz depois da resposta da primeira. As independentes o roteador executa em paralelo; as dependentes, em sequência.

## Decisão

`api/src/agente/atualizador.ts` (`atualizarPergunta`), sobre o cliente da F7.1 (`chatJson`):

- **Saída** em JSON forçado pela gramática do llama.cpp, com o esquema gerado do Zod 4.6.7 (fixado): `{autonoma, subperguntas: [{pergunta, depende_de: [índices]}]}`. O resultado para o agente é `{original, autonoma, subperguntas: [{pergunta, dependeDe}], fallback, erro?, uso, ms}`.
- **Prompt** (Qwen3.6-35B-A3B, temperatura 0, sem raciocínio, 500 tokens, 30 s): a autônoma troca pronomes e elipses pelo que o histórico designa e, se a pergunta é nova, **não copia nada do histórico**; a decomposição só vale para fatos diferentes; **não decompõe** soma, diferença, comparação, ranking, lista, série ou variação no tempo, nem dois atributos da mesma entidade; cada subpergunta se entende sozinha; `depende_de` só aponta para trás; máximo de 4. Sete exemplos, nenhum do conjunto de avaliação (um teste confere).
- **Histórico**: só os 4 últimos turnos, cada um cortado em 600 caracteres, dentro de um bloco `<historico>` cujo delimitador não pode ser fechado de dentro (o texto de um turno antigo do assistente é dado, não instrução; o prompt avisa).
- **Normalização** do que o LLM devolve (`normalizarSaida`): descarta subperguntas em branco ou com menos de 8 caracteres, junta repetidas (sem acento nem caixa) reapontando as dependências, remove dependência para si mesma, para uma posterior, inexistente ou repetida, zera a dependência de uma subpergunta única, usa a pergunta original quando a autônoma vem vazia.
- **Fallback**: nunca derruba o agente. Lista vazia → a autônoma como única subpergunta; **mais de 4 subperguntas** (decomposição descontrolada) → a autônoma inteira, em vez de cortar partes e perder um pedaço da pergunta; tempo-limite, llama-swap fora do ar, HTTP, JSON quebrado ou forma errada → a pergunta original inteira, com `fallback` e `erro` anotados para a telemetria (F7.7). Pergunta vazia ou com mais de 2.000 caracteres nem chega ao LLM. Só o cancelamento do chamador sobe como erro.

## Avaliação

`eval/golden_decomposicao.json` (38 casos) e `npm run avaliar:decomposicao`. O avaliador (`api/src/avaliacao/decomposicao.ts`, 19 testes) não exige uma decomposição única: confere a **quantidade** de subperguntas, que cada uma **cubra** o assunto esperado (termos normalizados, em qualquer ordem), as **dependências** (exatas, mapeadas pela correspondência: a esperada tem de estar declarada e uma inventada, que impediria paralelizar, é erro) e os **termos proibidos** (pronome que sobrou; assunto do histórico que vazou para uma pergunta nova).

Grupos: `ajuste` (9: 5 compostas, 2 simples, 2 seguimentos), usado para escrever o prompt; `teste` (20: 10 compostas, 6 simples, 4 seguimentos; 5 das compostas são as `M01`–`M05` do golden set), que o prompt nunca viu; e `teste2` (9), escrito **depois** da correção que o `teste` pediu, para a segunda versão do prompt ter uma medida que não foi usada no diagnóstico.

| Prompt | Grupo | Compostas | Simples | Seguimentos | Total |
|---|---|---|---|---|---|
| v1 | ajuste | 5/5 | 2/2 | 2/2 | **9/9** |
| v1 | teste | **9/10** | 4/6 | 4/4 | **17/20 (85%)** |
| v2 | ajuste | 5/5 | 2/2 | 2/2 | 9/9 |
| v2 | teste | **9/10** | 6/6 | 4/4 | **19/20 (95%)** |
| v2 | teste2 (novo) | 4/4 | 4/4 | 1/1 | **9/9** |

Mediana de 3,1 a 3,3 s por pergunta (Qwen já carregado), máximo de 5,4 s; nenhum fallback nos 38 casos.

**Resultado do aceite: 10 compostas do `teste`, todas com o número e o conteúdo certos das subperguntas; 9 de 10 com as dependências exatas.** A que falhou foi `D17` ("Quais são os principais riscos ambientais citados e que ações o Banco adota para mitigá-los?"): o modelo fez as duas subperguntas certas e declarou-as independentes, e o gabarito dizia que a segunda depende da primeira. Os dois entendimentos são defensáveis (as ações podem ser buscadas sem a lista de riscos) e **não mudei o gabarito depois de ver a resposta**; fica registrado como 9/10.

As duas falhas de quebrar demais do v1 foram reais: `D22` ("Em quais anos, entre 2023 e 2025, o lucro líquido caiu em relação ao ano anterior?") virou **4 subperguntas, uma por ano**, e `D25` ("o endereço da sede e o telefone") virou 2. O v2 acrescenta duas regras (série ou variação no tempo é uma pergunta; dois atributos da mesma entidade são uma) e dois exemplos. Como `D22` e `D25` orientaram a correção, o número do `teste` no v2 não vale como medida independente delas; o `teste2` (séries, variação, dois atributos, soma, três composições e um seguimento) vale.

## Alternativas consideradas

- **Decompor tudo o que tem "e"**: dá muito mais chamadas e quebra somas e listas; o v1 já errava assim em 2 de 6 perguntas simples.
- **Cortar nas 4 primeiras quando passar de 4**: perde parte da pergunta sem avisar; descartado em favor de seguir inteira.
- **Dependência decidida pelo roteador, não pelo atualizador**: o atualizador já lê a pergunta inteira e o paralelismo do roteador depende disso.
- **Raciocínio ligado (`enable_thinking`)** ou o perfil rápido: não medidos; o Qwen sem raciocínio já deu 9/9 no ajuste. O `--perfil rapido` do avaliador permite medir o gpt-oss se a latência de 3 s virar problema.
- **Reaproveitar a reescrita da F2.8 (step-back/HyDE, Python)**: ela reescreve para a busca vetorial; aqui o objetivo é outro (a pergunta autônoma e a divisão), e fica no TypeScript, onde o agente roda.

## Limites

- **n = 10 compostas** no aceite, 38 casos no total, todos escritos por mim sobre este documento; a diferença de uma pergunta é 10 pontos. O conjunto é sobre o Formulário de Referência do Banco do Brasil; os pronomes e elipses são os do português, mas há poucos seguimentos (7) e nenhum com mais de um turno antigo relevante.
- **A decomposição correta é parcialmente subjetiva** (D17, D25): o avaliador confere o que importa para o roteador, não a "melhor" divisão. A medida de dependência é a mais frágil.
- **O histórico usa respostas inventadas** nos casos de teste ("Fulano de Tal", "Fictícia Auditores"); com respostas reais longas o corte de 600 caracteres pode tirar justamente o nome que o pronome designa.
- **Não há verificação de que a autônoma preserva o sentido**: só que não tem pronome proibido e que as subperguntas cobrem os termos esperados. Uma autônoma que troque o período por outro passaria se os termos estivessem lá.
- **Latência de 3 s por pergunta** soma-se ao roteador e ao redator; o perfil `rapido` é a saída, se a F7.6 medir que o primeiro evento passa de 1 s (a etapa pode ser anunciada ao usuário antes de terminar).
- **O prompt de sistema é grande o bastante para ter prefixo em cache**: a primeira pergunta depois de carregar o Qwen é mais lenta (17 s medidos no Text2Cypher, ADR-051).
