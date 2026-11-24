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
| 2 | Configurações → "Consulta ao grafo (Cypher)"; volta ao chat e pergunta a G03 ("Somando Auditoria Interna e Riscos Corporativos…"); no Rastro, abre "Ver a consulta" e o **Cypher** gerado fica à vista; volta o modo para Automático | Cypher (modo forçado, dito na legenda) |
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
