# F10.3: roteiro e checagens do vídeo (fixados ANTES de gravar)

Aceite da etapa (ETAPAS.md): "vídeo de até 3 minutos mostrando rota, Cypher e citações — publicado e linkado no README". **Publicar é com o dono, na conta dele** (nota de 18/11 na F10.1): eu deixo o arquivo pronto em `data/video/graphrag-local.webm` (fora do git, ADR-009, porque mostra páginas do documento) e a linha do README com o lugar do link; o aceite só fecha quando ele publicar e o link entrar.

## Como é gravado (sem baixar nada)

1. `e2e/tests/ao-vivo/video.spec.ts` (`@video`) conduz a interface real (Neo4j, llama-swap, API e `ng serve` no ar, documento indexado) e tira uma captura JPEG a cada 250 ms em `data/video/quadros/`, com `marcas.json` dizendo em que quadro começa cada cena e qual legenda ela leva.
2. `e2e/ferramentas/montar-video.ts` monta o WebM (VP9) no próprio Edge, com `canvas.captureStream` + `MediaRecorder`: nenhum ffmpeg, nada baixado. Quadros iguais em sequência viram um só; **esperas são encurtadas** (cada quadro parado fica no máximo 1,2 s na tela) e a faixa do rodapé diz isso. O tempo real de cada resposta aparece no próprio Rastro ("Resposta pronta · N s").

## Roteiro (cenas, nesta ordem)

| Cena | O que aparece | Mostra |
|---|---|---|
| 0 | cartão de abertura: "GraphRAG 100% local · Radeon RX 9070 16 GB · nada sai da máquina na consulta" | contexto |
| 1 | `/chat`, modo automático: digita a T01 ("Quem é o acionista controlador…"); o Rastro enche ao vivo (pergunta reescrita, **rota**, ferramentas, crítica, evidências); a resposta sai com as páginas; clica a citação e o PDF abre **na página citada** | rota e citações |
| 2 | Configurações → "Consulta ao grafo (Cypher)"; volta ao chat e pergunta a G03 ("Somando Auditoria Interna e Riscos Corporativos…"); no Rastro, abre "Ver a consulta" e o **Cypher** gerado fica à vista; volta o modo para Automático. **Desde a errata 2:** a G03 é feita no automático, sem trocar de modo, e o roteador escolhe o grafo | Cypher (modo forçado, dito na legenda; desde a errata 2, escolhido pelo roteador) |
| 3 | modo automático: pergunta a E07 ("Quem é a Broto S.A.?"); resposta com citação; aba **Grafo** com o subgrafo da resposta | grafo e citações |
| 4 | cartão final: correção A3 0,54 → A6 0,87 nas 60 perguntas (0,48 → 0,77 nas 24 novas); "código, ADRs e medidas no repositório" | números da v1 |

## Checagens (todas precisam valer; uma que falhe reprova a gravação, que é contada)

1. Duração total ≤ 3:00 (o montador falha se passar).
2. Aparecem, legíveis: um passo "Rota: …" no Rastro; um bloco "Consulta Cypher" com o texto da consulta aberto; ao menos uma citação clicada abrindo o visualizador na página dela.
3. As três respostas terminam em "Resposta pronta" (sem erro); a T01 menciona "União".
4. A faixa do rodapé diz a fonte (Banco do Brasil S.A., Formulário de Referência 2026, v7, CVM), "modelos locais, sem rede" e "esperas encurtadas".
5. Só trechos curtos do documento aparecem (respostas e a página citada no visualizador), como no GIF do README (ADR-009); o PDF não é distribuído.
6. Confiro o vídeo eu mesmo antes de dar como pronto: `node ferramentas/conferir-video.ts` (em `e2e/`) mede a duração tocando o WebM e tira um quadro a cada 10 s em `data/video/conferencia/`, e eu olho os quadros.

Pipeline testado antes da gravação com 600 quadros sintéticos (fora da contagem): 303 únicos, 88,6 s calculados e 88,6 s medidos; o primeiro teste achou que o cartão final sumia (o `captureStream` só manda quadro quando o canvas é pintado) e o montador passou a repintar a cada 100 ms.

O LLM não é determinístico: as respostas do vídeo podem diferir das do golden. Se uma das três perguntas sair errada ou sem citação, a gravação é refeita (e contada), sem trocar de pergunta.

## Gravações (toda gravação é contada)

| Gravação | Commit | Data | Duração | Resultado | Notas |
|---|---|---|---|---|---|
| g1 | `9518d3e` (scripts iguais aos de `bb72104`) | 27/11/2026 | 59,8 s | **falhou** (resposta errada da G03 e dois defeitos do montador; ver errata 1) | Pilha do repositório principal (indexado na v1; o `f58_etapas.log` termina em `pronto`), subida com `.\infra\up.ps1` depois de parar a pilha da r3 da F10.2. Portas 4200, 3000, 7474, 7687 e 8080 livres; RAM livre 18,7 GB. Comandos, rodados em `e2e/`: `npx playwright test --project=ao-vivo --grep @video`, `node ferramentas/montar-video.ts` e `node ferramentas/conferir-video.ts`. O @video passou (2,6 min, 568 quadros) e o `checagens.json` deu tudo verdadeiro: T01 "Resposta pronta." com "União" e a p. 6 aberta, rota `buscar_trechos`, G03 e E07 prontas, Cypher visto, subgrafo visto. Montagem: 107 quadros únicos, 59,8 s, sem aceleração. **O que eu vi nos quadros reprova a gravação:** (1) a G03 respondeu "Não encontrei nos trechos consultados o número específico…" e chamou 1.096 de "total geral de empregados"; o número certo estava ali, mas a resposta diz o contrário, então ela é errada; (2) o título do cartão final passa das duas bordas da tela e o "0,87" não aparece; (3) a consulta Cypher aberta e a aba Grafo aparecem por só 1,2 s, porque o limite de pausa também cortou as esperas de propósito; e as linhas do Cypher saem cortadas na borda direita do painel. |
| g2 | `c30e548` (errata 1) | 27/11/2026 | — | **falhou** (G03 errada de novo, palavra por palavra igual à da g1; ver errata 2) | Mesma pilha da g1, ainda no ar. O @video passou (1,7 min); T01 e E07 certas e citadas, Cypher visto e subgrafo visto. A G03, no modo forçado, deu de novo "Não encontrei… o número específico…" e chamou 1.096 de "total geral de empregados". Não montei o vídeo: a resposta errada já reprova a gravação. |
| g3 | `95c991e` (errata 2) | 27/11/2026 | 67,0 s | **cumprida** (as 6 checagens valem; conferido por mim) | Mesma pilha. Mesmos três comandos. @video passou (1,5 min, 309 quadros); montagem: 117 quadros únicos, 57 s de quadros + 2 cartões de 5 s, sem aceleração; `conferir-video` mediu 67,0 s tocando o WebM. Respostas, conferidas contra o golden: **T01** "O acionista controlador do Banco do Brasil é a União Federal [p. 6, 127-128, 203]. Ela detém 50,0% do capital social [p. 6, 203]"; **G03** "Somando os 398 empregados de Auditoria Interna [p. 368] e os 698 empregados de Riscos Corporativos [p. 368], o total é de 1.096 empregados nessas duas áreas"; **E07** Broto S.A. controlada pelo Banco do Brasil e pela Brasilseg, 50% cada, com p. 6, 75 e 102. Quadros que eu vi (capturas a cada 2 s): cartão de abertura; T01 com "Rota: ferramentas · buscar_trechos"; página 6 aberta no visualizador por 4 s; G03 com "Rota: ferramentas · consultar_grafo" e a consulta Cypher inteira, com quebra de linha, por ~6 s; E07 com a aba Grafo (17 entidades e 51 ligações) por ~5 s; cartão final inteiro com "0,54 → agente com grafo 0,87" e "0,48 → 0,77". Rodapé com a fonte, "modelos locais, sem rede" e "esperas encurtadas" em todos os quadros da interface. **Ressalva:** o campo `g03Rotas` do `checagens.json` saiu vazio, porque o spec o leu com a aba Fontes ainda aberta. A rota `consultar_grafo` foi conferida nos quadros, e o `cypherVisto` é verdadeiro. Arquivo: `data/video/graphrag-local.webm` (fora do git). Publicar é com o dono. |

## Errata 1 (27/11/2026, depois da g1, antes da g2)

O que muda, e só isto:

1. **Esperas de propósito não são encurtadas.** No `video.spec.ts`, cada espera feita para o espectador ler ganha uma marca própria com `segurarS`: 4 s na página citada aberta, 6 s na consulta Cypher aberta e 5 s na aba Grafo. O `montar-video.ts` limita a pausa de um quadro ao `segurarS` da marca dele e, sem ele, a `--pausa` (1,2 s), como antes. Quadros iguais de marcas diferentes não se juntam mais. As esperas do LLM continuam encurtadas, e a faixa continua dizendo isso.
2. **O cartão cabe na tela.** O montador mede cada linha do cartão e diminui a fonte até ela caber, com 60 px de margem de cada lado.
3. **O Cypher quebra a linha no painel.** Na interface, o `pre` da consulta no Rastro passa a quebrar as linhas (`white-space: pre-wrap`), em vez de cortar na borda e exigir rolagem lateral. Isso vale para todo uso do Rastro, não só para o vídeo.
4. **As respostas ficam registradas.** O `checagens.json` guarda o texto das três respostas, e eu confiro cada uma contra o golden antes de dar a gravação como boa: T01 diz que a controladora é a União; G03 dá 1.096 como a soma das duas áreas (398 + 698); E07 diz que a Broto é controlada pelo Banco do Brasil e pela Brasilseg. Isso põe por escrito o critério que a g1 já usava ("errada ou sem citação").

As perguntas, as cenas, as legendas e as outras checagens não mudam. A g2 roda com a mesma pilha, num commit novo.

Testes da errata, fora da contagem (não são gravações): o `tests/interface/rastro.spec.ts` passou inteiro (20/20, inclusive "em 375 px o Cypher e o trecho longos não geram rolagem horizontal"); e montei de novo os quadros da g1 com o montador consertado: o cartão final aparece inteiro, com "0,54 → agente com grafo 0,87". As esperas de propósito não puderam ser testadas assim, porque os quadros da g1 não têm as marcas novas: a g2 é que mostra.

## Errata 3 (27/11/2026, depois da g3, antes da g4): a tela do assistente com a visão dev

**Por quê:** pedido do dono depois de ver a g3: o vídeo usou o modo técnico (`/chat`), e não a tela do usuário (`/assistente`, F8.9), que tem o design escolhido. Ele pediu uma "visão dev" que liga e desliga nessa tela (F8.11) e o vídeo regravado com ela, mostrando tudo o que a g3 mostra. A g3 continua contada como cumprida. A g4 a substitui como o vídeo a publicar se também cumprir as checagens; se não cumprir, a g3 continua valendo.

**O que muda (g4 em diante):** as três cenas são gravadas no `/assistente` com a visão dev ligada, cada pergunta numa conversa nova:

| Cena | O que aparece |
|---|---|
| 1 | liga o interruptor "Visão dev" e pergunta a T01; o painel "Bastidores" se enche ao vivo (pergunta reescrita, **rota**, ferramentas, crítica); a resposta sai com as páginas; clica a citação e a página abre ao lado (4 s) |
| 2 | conversa nova, G03 no automático; nos Bastidores, a **consulta Cypher** que o roteador escolheu fica à vista (6 s) |
| 3 | conversa nova, E07; aba "Grafo" dos Bastidores com o subgrafo da resposta (5 s) |

Os cartões de abertura e de fim, as legendas no espírito das anteriores (ajustadas aos nomes da tela nova), o rodapé, as perguntas e as **checagens 1 a 6 não mudam**. Na checagem 2, "um passo Rota" e "um bloco Consulta Cypher" passam a ser procurados nos Bastidores. As respostas continuam conferidas contra o golden, como diz a errata 1.

## Errata 2 (27/11/2026, depois da g2, antes da g3)

**Diagnóstico.** A G03 no modo forçado "Consulta ao grafo" saiu errada duas vezes com o mesmo texto, então refazer sem mudar nada daria o mesmo resultado. O Cypher gerado está certo: ele soma as duas métricas e devolve `total_empregados = 1096`, p. 368. O erro é do redator, que leu o apelido `total_empregados` como o total de empregados do Banco. No modo forçado, o ciclo só roda o `consultar_grafo`, e a evidência é só a soma, sem as duas parcelas. Rodei duas sondas pelo `POST /api/chat` (diagnóstico, fora da contagem) com a mesma pergunta no modo **automático**. Nas duas, o roteador escolheu sozinho o `consultar_grafo`, gerou o mesmo Cypher (evento `cypher` presente) e o ciclo também trouxe trechos e tabelas. As duas respostas foram certas e iguais: "Somando os 398 empregados da Auditoria Interna [p. 368] e os 698 empregados de Riscos Corporativos [p. 368], o total é de 1.096 empregados nessas duas áreas."

**O que muda:** a cena 2 deixa de trocar o modo. A G03 é feita no **automático**, e a legenda passa a dizer "Pergunta de soma: o roteador escolhe consultar o grafo, o modelo escreve Cypher só de leitura e o Neo4j responde". A pergunta é a mesma, e o resto do roteiro e das checagens também. O `checagens.json` passa a guardar a rota da G03. Se o roteador não escolher o grafo, não há bloco Cypher, e a checagem 2 reprova a gravação.

**O que isso não esconde:** escolher o modo depois de ver o resultado é uma mudança de roteiro, e ela fica registrada aqui como tal. O defeito do modo forçado continua no produto: sem as parcelas, o redator pode ler errado o resultado de uma agregação. É uma dívida da v1, não consertada agora, porque mexer no agente mudaria a v1 congelada (tag `v1.0.0`) antes da bateria da F10.5. Na F8.6, os modos forçados já tinham medido qualidade pior que o automático.
