# F10.2: medida da subida com dois comandos (definição fixada ANTES de escrever o código)

Aceite da etapa (ETAPAS.md): "máquina limpa → assistente respondendo com dois comandos (fora o download dos modelos)". Entregas: `infra/up.ps1` (sobe tudo) e a indexação completa num comando só ("indexer run-all").

Começou em 24/11/2026, em paralelo com a rodada p4 da F10.1 (a F10.2 depende só da F9.5; o código é escrito agora e a medida roda depois da p4, porque as duas usam as mesmas portas e a GPU). Autorização do dono: a da viagem (18–19/11) e o "segue aí vai" de 24/11.

## Os dois comandos

Num clone novo (`git clone` do commit em teste), com o PDF da v7 posto em `data\raw\banco_do_brasil_formulario_referencia_2026.pdf` (insumo de fora, como na F10.1: o documento não é redistribuído) e `Set-ExecutionPolicy -Scope Process Bypass` na janela:

1. `.\infra\instalar.ps1` — instala tudo o que o lock fixa, inclusive os GGUF (o "download dos modelos" que o aceite exclui; os GGUF de `C:\modelos` podem ser aproveitados pelo próprio instalador, que confere tamanho e sha256).
2. `.\infra\up.ps1` — sobe Neo4j e llama-swap; **se o documento ainda não estiver indexado, roda a indexação completa** (leitura do PDF, seções, trechos e todas as etapas com LLM, o "run-all"), e no fim sobe a API e a interface e espera as duas responderem.

Nenhum outro comando é digitado. Se a indexação parar no meio (PC desligado a pedido do dono, como na errata 2 da F10.1), **repetir o comando 2** deve retomar sozinho de onde parou; isso não conta como terceiro comando (é o mesmo comando, e a retomada é parte do que se mede). Cada repetição é registrada.

## Critério de "subido" (o mesmo da F10.1)

1. `GET http://127.0.0.1:4200/` responde 200; e
2. `POST http://127.0.0.1:4200/api/chat` com `{"conversationId": "<qualquer>", "message": "<T01>"}` (T01: "Quem é o acionista controlador do Banco do Brasil e qual percentual do capital ele detém?") devolve um fluxo SSE que termina em `fim`, com **ao menos uma citação** e um texto que menciona **"União"**.

O comando 2 precisa terminar sozinho (código 0) depois de a interface responder, deixando os serviços no ar.

## Quem roda e regra de aceite

- Rodo eu, num clone novo `C:\Users\Rafael\graphrag-teste-f102`, sem tocar em nada além dos dois comandos (e das repetições do comando 2 depois de uma pausa). Não é um teste de README (esse é o da F10.1): é um teste mecânico de que os dois scripts bastam.
- **Cumprida** se o critério de "subido" valer depois dos dois comandos, sem nenhum outro comando, consertos ou ajuda. Uma falha do script reprova a rodada; o conserto vai numa errata commitada antes da rodada seguinte, num clone novo.
- Toda rodada é contada e registrada aqui. Não se apaga rodada que falhou.
- Antes de cada rodada confiro a memória livre (a p3 da F10.1 caiu por um programa de fora que vazava memória) e registro.

## Limites já sabidos

- Mesma máquina, mesmo usuário, mesma GPU: "máquina limpa" aqui é um clone limpo, sem `data\`, `.env`, `infra\bin` nem caches; os GGUF de `C:\modelos` são aproveitados (fora do aceite).
- A indexação leva de 10 a 14 h; a rodada inteira, umas 13 h.
- O LLM não é determinístico: o grafo sai parecido com o da v1, não igual.

## Execuções (toda rodada é contada)

| Rodada | Clone (commit) | Início | Resultado | Notas |
|---|---|---|---|---|
