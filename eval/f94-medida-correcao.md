# F9.4: ciclo de correção das falhas recorrentes (definição fixada ANTES de rodar)

Aceite da etapa: "falhas das categorias mais fracas reduzidas à metade". A F9.1 mediu o A6 (agente completo) nas 60 perguntas do `eval/golden.csv` e nas 24 do `eval/golden_novas.csv`. Esta etapa é o ciclo do cap. 8: ler as falhas, achar a causa, corrigir, medir de novo.

## O que é "falha" e quais são as categorias mais fracas

- **Falha de uma categoria = 1 − correção média** da categoria (pontos perdidos por pergunta; correção do juiz: 1, 0,5 ou 0), no **A6**, que é o sistema entregue.
- **Linha de base: o A6 da F9.1 como está** (`v1-a6` nas 60, `v1n-a6` nas 24), mesmo Qwen3.6, mesmo juiz (Gemma 4 26B-A4B), mesmo índice. Não é refeita.
- **As mais fracas** são as duas de maior falha nas 60 (a base de decisão): **agregação e filtro (falha 0,80; correção 0,20; n = 10)** e **numérica (falha 0,50; n = 15)**. As seguintes são multi-hop (0,40; n = 5), factual (0,30) e temática (0,25). Fora do escopo está em 0,00 e tem de ficar assim.

## Diagnóstico (feito só nas 60; sem juiz)

Li as respostas do A6 das perguntas com correção < 1 nas 60 (`data/avaliacao/v1-a6/respostas.jsonl`, fora do git). O contexto que o redator e o crítico veem não é o texto das evidências: é **cortado** (`selecionar` no redator: 900 caracteres por evidência e 9.000 no total; crítico: 350 por evidência e 7.000 no total). Um Pai tem cerca de 1.200 tokens e uma tabela do documento passa de 900 caracteres, então a frase ou a linha da tabela que traz o valor é cortada, o redator escreve "não encontrei" e o crítico pede mais uma busca (uma rodada a mais: 2 rodadas em 7 das 8 falhas de agregação). Exemplos nas 60: G10 (a tabela de remuneração da p. 352 é cortada antes da linha "maior remuneração"), G05 (célula da tabela de cor ou raça), G06, N11, N14, T03, T14.

Dois sinais de fora disso: o A3 em Python, que entrega o Pai inteiro, acerta **0,90** em factual e 0,90 em temática, e o A6, com o corte, **0,70 e 0,75**; e a causa se vê no próprio texto entregue (o contexto gravado na rodada termina em "…" antes da célula que o gabarito pede).

**Rodada de diagnóstico, fora da medida** (`f94-diag`, A6 com os limites abaixo nas 23 perguntas das 60 que falharam no A6 da F9.1: G02, G03, G05 a G10, N03, N06, N07, N08, N10, N11, N12, N14, T03, T08, T12, T14, M01, M02, M05; sem juiz, 23 respostas, ~22 min, `data/avaliacao/f94-diag/`): pela minha leitura contra o gabarito, **8 passaram a trazer o valor certo** (T03, T14, N06, N11, N14, G05, G06, G10) e 15 seguem sem trazer (G02, G03, G07, G08, G09, N03, N07, N08, N10, N12, T08, T12, M01, M02, M05), por causas **outras** (o valor não está nas evidências recuperadas ou no grafo; G09: a série do lucro só devolveu 2025). Essa leitura é minha, não do juiz, e foi feita nas 60 (conjunto de ajuste); não é um resultado, só a razão da mudança.

## A mudança da rodada 1 (a única)

Só os **limites** de texto, em `api/src/agente/redator.ts` e `api/src/agente/critico.ts`:

| Constante | Antes | Rodada 1 |
|---|---:|---:|
| redator: caracteres por evidência | 900 | 3.000 |
| redator: caracteres das evidências no total | 9.000 | 24.000 (a escada de redução, que divide o limite por evidência por 2 até caber, fica) |
| crítico: caracteres por evidência | 350 | 1.200 |
| crítico: caracteres no total | 7.000 | 14.000 (escada 1.200, 600, 300, 150) |

A janela do `consultar` é de 16.384 tokens por vaga (`-c 32768 -np 2`); 24.000 caracteres são cerca de 7 mil tokens, mais o prompt e 700 de saída. Cabe. O custo esperado é mais tempo de processamento do prompt por resposta, que a medida registra.

**Nada mais muda**: prompts, templates, roteador, Text2Cypher, golden, juiz e índice ficam como no commit da F9.3 (`55190ed`).

## Rodadas

- **r1** = a mudança acima. É medida inteira (A6 nas 60 e nas 24), sempre contada.
- Se o aceite não for cumprido na r1, uma **r2** (e no máximo uma **r3**) pode acrescentar correções (novos *few-shots*, templates, limites) **decididas olhando as falhas que sobraram nas 60**, escritas como errata neste arquivo **e commitadas antes de rodar**. As rodadas anteriores ficam no relatório; **a rodada que passa não substitui a que falhou**. Sem r3, a F9.4 fica `[~]` com o resultado como saiu.

## O que se mede e a regra de aceite (por rodada)

A6 completo (agente, crítico e redator), **60 perguntas** e **24 do grupo novo**, uma execução (`f94r1-a6`, `f94r1n-a6`), as mesmas métricas da F9.1; tabela em `eval/resultados/f94-correcao.md`, **gerada por comando** (`uv run python -m indexer.f94`, que aplica a regra abaixo).

A rodada cumpre o aceite se **tudo** valer:

1. **Metade da falha nas duas mais fracas, nas 60:** agregação com falha ≤ 0,40 (correção ≥ 0,60) **e** numérica com falha ≤ 0,25 (correção ≥ 0,75).
2. **Sem regressão nas 60:** nenhuma categoria (fora do escopo à parte) perde 0,10 ou mais de correção contra a F9.1.
3. **Fora do escopo segue em 1,00** nas 60 e nas 24 (contexto maior não pode fazer o redator responder o que não consta).
4. **Fidelidade geral ≥ 0,95** nas 60 (era 0,97).
5. **Grupo novo (24, fora do ajuste): a correção geral não cai mais de 0,05** (base 0,46). Só é escrito "confirmado fora do ajuste" se subir **0,05 ou mais**; se ficar entre, o ganho é descrito como visto só nas 60, o conjunto em que as falhas foram diagnosticadas.
6. Cada rodada responde as 60 e as 24 perguntas; erro do sistema conta como incorreta e **não se refaz**; o juiz responde pelo menos 95% das chamadas; **nada é afinado entre a geração e a nota** de uma rodada.

**Informativo, não reprova:** a latência p50 e p95 do A6 (F9.1: 22,9 e 111,6 s; o relatório diz se ficou dentro de 125%), o recall de contexto (o contexto entregue ao juiz agora é maior, então **não é comparável 1 a 1** com a F9.1), página citada e acerto numérico.

Não há aceite pós-hoc de algo que falhou. Se a rodada não cumprir, o resultado é escrito como saiu e a decisão é do dono.

## Limites já sabidos

- **A base de decisão são as mesmas 60** em que os prompts, os templates e o roteador foram ajustados nas etapas anteriores; o diagnóstico acima também foi feito nelas. O resultado nelas é **otimista**. O grupo novo (24) é a checagem, e é pequeno: uma pergunta vale 0,042, e as categorias do grupo novo têm 3 a 6 perguntas.
- **Sobre o grupo novo:** ao escolher as categorias vi o **id e a nota** das falhas do A6 no grupo novo (`v1n-a6`), não o conteúdo das respostas nem das evidências; ele não foi usado no diagnóstico e não será lido pergunta a pergunta antes da r1.
- **Uma execução por rodada** (variância do Qwen a 0,2 e do juiz não medida). Diferença menor que 0,05 vale como empate. Com n = 10 (agregação) e n = 15 (numérica), uma pergunta vale 0,10 e 0,067 de correção: a meta de agregação é 4 perguntas a mais corretas (de 2 para 6) e a da numérica é 4 a mais (de 7,5 para 11,25), com meias notas.
- **Golden e rótulos do juiz são do Claude** (ADR-027, ADR-030); o juiz e o gerador não são a mesma família, mas o Gemma continua sendo juiz de respostas do Qwen.
- **A causa dominante é uma só (o corte de texto); as 15 falhas restantes têm causas diferentes** (G09: série incompleta no grafo; G03: separar duas áreas dentro de uma linha da tabela; N12 e M05: capital autorizado fora das evidências). A r1 não promete resolvê-las.
- **A latência pode piorar** (mais texto por chamada): é custo da mudança, e o RNF-2 já estava em aberto (F9.2: p95 de 112 s).
- A falha do reranker `-c 4096` achada na F9.3 (3 em 240 chamadas do A3 em Python) **não** é tratada aqui: o agente em TS usa outro caminho e a dívida segue aberta.

## Reprodução

```powershell
# serviços no ar: .\infra\neo4j.ps1 iniciar ; .\infra\swap.ps1
.\infra\rodar-f94.ps1 -Rodada r1        # gera A6 nas 60 e nas 24, julga e gera a tabela (~3 h, quase tudo juiz)
```

## Execuções (toda execução é contada)

**Fora da medida:** `f94-diag` (diagnóstico acima, 23 respostas sem nota, limites da r1; relatório não gerado; respostas em `data/avaliacao/f94-diag/`).

**Da medida:**

| Rodada | Relatórios | Perguntas | Erros do sistema | Falhas do juiz | Geração e juiz |
|---|---|---:|---:|---:|---|
| r1 (só os limites de texto) | `f94r1-a6`, `f94r1n-a6` | 60 e 24 | 0 e 0 | 0 e 0 | 12/11, 16:20 a 18:50 (geração 31 min, juiz 2 h) |

Nenhuma resposta ou nota foi refeita; o roteiro rodou de uma vez (`infra/rodar-f94.ps1 -Rodada r1`). A tabela é `eval/resultados/f94-correcao.md`.

## Resultado da rodada 1 por item da regra

**O aceite NÃO foi cumprido** (itens 1 e 2 falharam; os demais valem):

1. **Não.** Agregação: falha 0,80 → 0,60 (meta ≤ 0,40; correção 0,20 → 0,40). Numérica: falha 0,50 → 0,37 (meta ≤ 0,25; correção 0,50 → 0,63).
2. **Não, por pouco:** multi-hop perdeu 0,10 de correção (0,60 → 0,50; n = 5, uma meia nota). A regra diz "0,10 ou mais", então reprova; as outras categorias subiram (factual 0,70 → 0,83, temática 0,75 → 0,80).
3. **Sim.** Fora do escopo seguiu em 1,00 nas 60 e nas 24.
4. **Sim.** Fidelidade 0,99 (era 0,97).
5. **Sim, e confirmado fora do ajuste:** grupo novo 0,46 → 0,58 (+0,13); factual 0,42 → 0,92 no grupo novo, numérica, agregação, temática e multi-hop sem mudança.
6. **Sim.** 0 erros do sistema e 0 falhas do juiz.

**Informativo:** latência p50 / p95 do A6 **melhorou**, 22,9 / 111,6 → 16,9 / 55,9 s (com o texto inteiro, o crítico pede menos buscas extras); acerto numérico 0,48 → 0,62; página citada 0,60 → 0,67; recall de contexto 0,63 → 0,75 (contexto maior, não comparável 1 a 1).

**Leitura:** o corte de texto era a causa dominante de factual e de parte da numérica e da agregação, e consertá-lo ganhou 0,10 de correção geral nas 60 e 0,12 no grupo novo, sem custo de latência. Mas as duas categorias mais fracas não chegaram à metade da falha: sobram as falhas de outra causa (valor fora das evidências recuperadas ou do grafo). A r1 fica no relatório e **não é substituída**. A r2 depende de ler as falhas que sobraram nas 60 e será escrita como errata, commitada antes de rodar.

## Errata 1: rodada 2 (escrita e commitada ANTES de rodar; 13/11)

A r1 não cumpriu o aceite (agregação 0,60 e numérica 0,37 de falha; metas 0,40 e 0,25; multi-hop −0,10). O dono mandou fazer a r2. O que segue foi decidido lendo **só as falhas das 60** na r1 (`data/avaliacao/f94r1-a6/respostas.jsonl`) e o texto parseado do documento (`data/parsed/*.tabelas.json`, `*.chunks.json`); o grupo novo (24) **não foi lido pergunta a pergunta**.

**Diagnóstico das 24 falhas que sobraram nas 60** (21 com correção < 1 na r1: 3 factuais, 6 numéricas, 6 de agregação, 3 temáticas e 3 multi-hop):

- **Valor numa tabela indexada, e o agente chamou só `buscar_trechos` (ou grafo) e não `buscar_tabelas`:** N03 (receitas de juros da carteira, R$ 175.442 mi, tabela de composição das receitas de juros), N07 e N08 (lucro líquido ajustado 20,7 e margem financeira bruta 103,1 na tabela de acompanhamento das projeções), N10, G01, G02 e M01 (66,25% e a lista de participações na tabela de participações societárias), T12 (reservas estatutárias, tabela de retenção e distribuição de lucros). A rota esperada do golden das numéricas é `buscar_tabelas`. Nas numéricas, de agregação e multi-hop do golden, as respostas com `buscar_tabelas` na rota ficaram certas ou meio certas em 10 de 12 (N05, N06, N09, N11, N14, G04, G05, G06, G10 e M03; erraram G07 e G08), e as 7 que erraram com o valor numa tabela indexada (N03, N07, N08, N10, G01, G02 e M01) não a tinham. **É o padrão mais frequente das falhas que sobraram.**
- **Outras causas, que a r2 não corrige:** G09 (a série do lucro só devolveu 2025: dado do grafo), G03 e G07 (soma de duas linhas de tabela; a tabela vem, o redator não monta a soma), G08 (contagem sobre uma lista que não existe pronta), T08 (a evidência traz o texto, mas o redator responde com outro órgão), N12 e M05 (o "R$ 30 bilhões" remanescente não aparece no texto do documento: pode não ser respondível por busca), P01, P04, P09 e M02 (temáticas e multi-hop de resposta incompleta).

**A mudança da r2 (a única além da r1):** `tabelasJuntas` em `api/src/agente/agente.ts`, ligada por padrão. Para toda subpergunta roteada para alguma ferramenta, o agente acrescenta uma busca de tabelas (`buscar_tabelas`, a que o agente já tem), em paralelo e com as evidências **depois** das da ferramenta escolhida, mesmo para quem só chamou `buscar_trechos`. Não se aplica a quem já chama `buscar_tabelas` ou `resposta_ja_dada`, às rotas `panorama` e `entidade`, aos modos forçados pelo usuário e às execuções com ferramentas restritas (A3ts a A5 da escada, que ficam como estão). Não muda o prompt do roteador. É o mecanismo `complementarTabelas` que já existia, desligado, para o pedido de gráfico (F8.10), sem a parte que mexe no prompt do roteador. A r2 = a r1 (limites) + isto; prompts, templates, Text2Cypher, golden, juiz e índice continuam como na F9.3.

**Regra da r2: a mesma da r1, sem mudança**, contra a F9.1 (não contra a r1); a tabela mostra r1 e r2 lado a lado (`uv run python -m indexer.f94 --rodadas r1 r2`). A r1 continua contada e **não** é substituída.

**Riscos declarados:** mais evidência por pergunta (uma tabela de até 10.000 caracteres por chamada, cortada em 3.000 pelo redator) pode diluir as respostas factuais que a r1 já acertava, e custa uma chamada de busca a mais por subpergunta (busca vetorial, sem LLM); a latência e a regressão por categoria dizem. Multi-hop tem n = 5 e já perdeu 0,10 na r1 por uma meia nota. Se a r2 também não cumprir, vale a mesma regra: no máximo uma r3, também por errata antes de rodar; sem r3, a F9.4 fica `[~]` com o resultado como saiu.

**Execuções da r2:**

| Rodada | Relatórios | Perguntas | Erros do sistema | Falhas do juiz | Geração e juiz |
|---|---|---:|---:|---:|---|
| r2 (limites + `tabelasJuntas`) | `f94r2-a6`, `f94r2n-a6` | 60 e 24 | 0 e 0 | 0 e 0 | 13/11, 06:42 a 08:53 (geração 36 min, juiz 1 h 35) |

Nenhuma resposta ou nota foi refeita (`.\infra\rodar-f94.ps1 -Rodada r2`, de uma vez); tabela com r1 e r2 em `eval/resultados/f94-correcao.md` (`uv run python -m indexer.f94 --rodadas r1 r2`). O agente usou `buscar_tabelas` em 49 das 60 respostas.

## Resultado da rodada 2 por item da regra

**O aceite NÃO foi cumprido** (itens 1 e 1b; a regressão da r1 sumiu):

1. **Não, nas duas.** Agregação: falha 0,80 → 0,60 (meta ≤ 0,40; **igual à r1**). Numérica: falha 0,50 → 0,27 (meta ≤ 0,25; **faltou 0,02, meia nota em 15 perguntas**).
2. **Sim.** Nenhuma categoria perdeu correção contra a F9.1 (multi-hop voltou a 0,60).
3. **Sim.** Fora do escopo em 1,00 nas 60 e nas 24.
4. **Sim.** Fidelidade 0,98.
5. **Sim, e confirmado fora do ajuste:** grupo novo 0,46 → 0,67 (+0,21): factual 0,42 → 1,00, numérica 0,33 → 0,50, agregação 0,67 → 0,83; temática e multi-hop sem mudança.
6. **Sim.** 0 erros do sistema e 0 falhas do juiz.

**Informativo:** correção geral 0,59 → 0,72 nas 60 (r1: 0,69); latência p50 / p95 22,1 / 61,8 s (F9.1: 22,9 / 111,6; r1: 16,9 / 55,9: o p50 voltou ao da F9.1 por causa da busca de tabelas a mais, o p95 segue bem abaixo); acerto numérico 0,48 → 0,67; página citada 0,60 → 0,78; recall de contexto 0,63 → 0,88 (contexto maior, não comparável 1 a 1).

**Leitura:** a busca de tabelas junto de toda rota consertou o que o diagnóstico previa nas numéricas (N10 0 → 1, N08 0 → 0,5; mais factuais e temáticas melhoraram junto) e subiu muito o grupo novo. Mas a agregação ficou em 0,40 de correção, **igual à r1**, porque o que ela ganhou de um lado perdeu do outro: G01, G03 e G05 estão certas e G06 e G10, que estavam certas na r1, erraram na r2 (mesma pergunta, mais evidência; uma execução só, então parte disso é variância do Qwen a 0,2 e do juiz, não medida). As falhas que sobram em agregação são as que o diagnóstico já dizia que não eram de busca: G02, G07, G08, G09 (soma ou contagem sobre linhas de tabela e a série do lucro que o grafo traz só com 2025) e G06/G10 (comparação entre três órgãos). Numérica: N03, N07, N12 (e meia nota em N06 e N08).

**A F9.4 NÃO está cumprida.** Pela regra desta medida, a r2 não substitui nem apaga a r1 nem vira aceite pós-hoc: o aceite pedia metade da falha nas duas categorias mais fracas e só a numérica chegou perto (0,27 contra 0,25). A decisão do que fazer (uma r3 por errata antes de rodar, ou encerrar a F9.4 com o resultado como saiu) é do dono.

## Errata 2: rodada 3 (escrita e commitada ANTES de rodar; 13/11)

A r2 não cumpriu o aceite (agregação 0,60 e numérica 0,27 de falha; metas 0,40 e 0,25). O dono mandou fazer a r3. O que segue vem de ler **só as falhas das 60** na r2 e de rodar o agente nelas (o grupo novo continua sem ser lido pergunta a pergunta).

**Diagnóstico (nas 60, sem juiz).** Em 5 das falhas numéricas e de agregação o valor **estava no contexto do redator** (N03, N07, N08, G06, G10), e mesmo assim a resposta dizia "não encontrei". Rodando o ciclo com o crítico impresso, a causa apareceu: o **crítico** só vê 4 evidências por subpergunta, cada uma cortada em 1.200 caracteres e com as quebras de linha achatadas (`compacta`), então uma tabela larga vira uma linha só e ele não acha a célula; responde "o valor não foi encontrado nas evidências", o ciclo termina `incompleta` e a instrução do redator para esse estado é **dizer "Não encontrei nos trechos consultados"**. O redator recusa mesmo com a tabela inteira na mão. Outro defeito do mesmo tipo: o redator também achatava as quebras de linha das tabelas e só recebia 10 evidências, e com a busca de tabelas junto (r2) a tabela certa, que vem depois das de trechos, ficava na 15ª posição e era descartada (G06).

**Rodadas de diagnóstico, fora da medida** (nas falhas das 60, 14, 11 e 14 respostas, sem juiz, lidas por mim contra o gabarito; `data/avaliacao/f94-diag3`, `f94-diag4`, `f94-diag5`): `diag3` (quebras de linha e 16 evidências no redator) acertou N03 e G10 e não mexeu no resto; `diag4` (mais uma regra de leitura de tabela no prompt do redator) não mudou nada sozinha; `diag5` (com o crítico corrigido, abaixo) passou a trazer a resposta certa em N03, N07, N08, N12, G06, G09, G10 e M02, e melhorou M01 e T12. Ficam sem resposta T08, G02, G07 e G08. É leitura minha, não nota do juiz, e foi nas 60 (conjunto de ajuste): é a razão da mudança, não um resultado.

**A mudança da r3** (r1 e r2 continuam valendo; a r3 = r2 + isto):

| Onde | Antes (r2) | r3 |
|---|---|---|
| crítico: evidências por subpergunta | 4 | 8 |
| crítico: caracteres por evidência | 1.200 | 2.500 (escada 2.500, 1.200, 600, 300, 150) |
| crítico: caracteres no total | 14.000 | 22.000 |
| crítico: quebras de linha da tabela | achatadas | mantidas |
| crítico: tempo-limite por chamada | 30 s | 60 s (o prompt é maior) |
| redator: máximo de evidências | 10 | 16 (o total de 24.000 caracteres e a escada de redução ficam) |
| redator: quebras de linha da tabela | achatadas | mantidas |
| redator: regra 6 do prompt | não havia | como ler tabela em Markdown (cruzar o rótulo da linha com o cabeçalho da coluna; "Observado" é o resultado do período; se o valor está na célula, responder com ele; para soma, diferença ou contagem, achar cada valor e mostrar a conta) |

Nada mais muda (roteador, templates, Text2Cypher, golden, juiz e índice como na F9.3; `tabelasJuntas` da r2 fica).

**Regra da r3: a mesma, sem mudança**, contra a F9.1 (`uv run python -m indexer.f94 --rodadas r1 r2 r3`). As rodadas anteriores continuam contadas e **a r3 não as substitui**.

**Riscos declarados:** (1) um crítico que vê mais e diz "suficiente" com mais frequência pode deixar passar o que deveria virar "ausente" ou "não consta": a regra exige fora do escopo em 1,00 (60 e 24) e fidelidade ≥ 0,95. (2) O prompt do crítico é maior (até 22.000 caracteres): o tempo por chamada sobe e o tempo-limite foi dobrado; a latência dirá. (3) São quatro mudanças juntas, então a r3 não diz qual delas fez o ganho; o aceite é a meta de falha, não a atribuição. (4) Se a r3 também não cumprir: nova decisão do dono; sem aceite pós-hoc.

**Execuções da r3:** `f94r3-a6` e `f94r3n-a6` (`.\infra\rodar-f94.ps1 -Rodada r3`); a preencher abaixo depois de rodar.
