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

## Antes da rodada r1 (25/11/2026): consertos que vieram da p4 da F10.1

A F10.1 fechou com a p4 (ADR-083). A rodada mostrou um defeito do projeto que também pode derrubar esta medida, porque a indexação de ~13 h fica exposta a queda de luz. O conserto foi commitado **antes** da r1:

- **Caches da indexação:** novo `indexer/src/indexer/cache_json.py`. A gravação vai para um temporário único, faz `fsync` e troca o nome com `os.replace`. A leitura trata um arquivo ausente, inválido, cheio de bytes nulos ou que não seja objeto JSON como "não está no cache" e refaz o pedido. Passam a usar o módulo `tabelas-gerar`, `extrair`, `aberta`, `catalogo-mapear`, `resolver`, `resumos` e `relatorios`. Antes, só `extrair` e `aberta` gravavam de forma atômica, e nenhuma etapa lia com tolerância. **Conferido por mim:** `ler` devolve None para os 3 arquivos que a queda de 13:47 de 24/11 estragou na p4 (`metricas_cache_corrompidos`), e também para um arquivo de 300 bytes nulos, um JSON cortado, um arquivo vazio, uma lista e um texto em latin-1. `gravar` não deixa `.tmp` para trás. `ruff` e os imports passam.
- **README** (atritos 2 a 6 da p4):
  - Na retomada, só a última linha `inicio` sem `fim` importa. Linhas repetidas, um `falhou` antigo e linhas com caracteres estranhos de queda de luz podem ser ignorados.
  - Como saber que uma etapa longa não travou: `http://127.0.0.1:8080/running` e o Gerenciador de Tarefas.
  - Os avisos `property key does not exist` do Neo4j são normais.
  - O contador do `f58_estado.txt` recomeça com `-De`.
  - O `pergunta.json` do exemplo passa a ir para `$env:TEMP`. **Conferido por mim** contra a pilha da p4: o fluxo terminou em `fim` e mencionou a União.
  - A "primeira resposta mais lenta" só acontece com o modelo ainda não carregado.
- O `up.ps1` não muda. A leitura do `f58_etapas.log` aceita as linhas com bytes nulos que a queda deixa, porque o padrão `^\S+\s+inicio` casa com elas.

## Execuções (toda rodada é contada)

| Rodada | Clone (commit) | Início | Resultado | Notas |
|---|---|---|---|---|
| r1 | `C:\Users\Rafael\graphrag-teste-f102` (`7643520`) | 25/11 12:58 | em andamento | Antes da rodada: pilha da p4 parada (portas 4200, 3000, 7474, 7687 e 8080 livres); RAM livre 24,0 GB, commit livre 41,7 de 69,9 GB; SignalRGB fechado; PDF v7 conferido (`B0D17566`). Comando 1 rodado na ferramenta PowerShell. Comando 2 rodado numa janela própria do PowerShell (`-ExecutionPolicy Bypass`), com `Start-Transcript` para o registro, porque o Neo4j e o llama-swap ficam no ar e prenderiam a saída da ferramenta. |
