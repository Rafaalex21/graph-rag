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

## Errata 1 (26/11/2026, antes da rodada r3): metade solta de par UTF-16 vinda do LLM

A r2 falhou por um defeito do projeto (ver a linha da r2). A regra continua a mesma: o conserto vai num commit antes da rodada seguinte, e a rodada seguinte roda num clone novo. O que muda no código:

- `cache_json.limpar` troca cada metade solta de par UTF-16 por U+FFFD, em todo texto do dado, inclusive nas chaves. Um par completo, como o 𝑥 de U+1D465, fica igual.
- `cache_json.gravar` grava o dado limpo e **devolve** esse dado limpo. Se a gravação falhar, apaga o temporário.
- `cache_json.ler` limpa o que lê.
- As sete etapas que gravam cache passam a usar o que `gravar` devolve: `tabelas-gerar`, `extrair`, `aberta`, `catalogo-mapear`, `resolver`, `resumos` e `relatorios`. Assim o texto que segue para o plano do resolver e para o grafo é o mesmo que ficou no cache. Sem isso, o plano (`write_text` em UTF-8) cairia logo depois.

**Conferido por mim, antes do commit:**
- Um JSON com `\ud835` solto, `\ud835\udc65` em par e `\udc65` solto numa lista: o dado gravado e o lido são iguais, e só as metades soltas viraram U+FFFD.
- Um texto normal com acentos e 𝑥 volta igual.
- O plano gravado com `write_text` em UTF-8 passa.
- Uma falha no meio da gravação não deixa `.tmp`.
- `ruff` e os imports das sete etapas passam.
- **No caso real:** copiei os oito arquivos para o clone da r2 e rodei só `indexer.resolver planejar` de novo, às 15:54. O par `af568b52e98996fdd83d` foi gravado às 16:07:11. A justificativa termina em `clubes` seguido de U+FFFD, onde antes estava a metade solta, e nenhum `.tmp` ficou para trás. Parei o diagnóstico nesse ponto.
- **`up.ps1 -Parar`**, achado ao parar a pilha da r2: um id da lista já tinha caído junto com o processo pai (`taskkill /T`). O "não foi encontrado" que o `taskkill` escreve no stderr virou erro fatal (PowerShell 5.1 com `Stop`), e o Neo4j ficou no ar. Agora o `-Parar` pula o id que já não existe e roda o `taskkill` com `Continue`. **Conferido:** com uma janela falsa "graphrag web" e um filho na porta 3000, o `-Parar` terminou com código 0, as portas 4200, 3000, 7474, 7687 e 8080 ficaram livres e o Neo4j parou. Isso não muda o critério: o `-Parar` não é um dos dois comandos.

O diagnóstico no clone da r2 não muda o resultado da r2, que continua reprovada. Ele não conta como rodada: só confirma o conserto no caso real antes de gastar outra indexação de ~9 h. A **r3** roda num clone novo, `C:\Users\Rafael\graphrag-teste-f102-r3`, no commit desta errata. A pilha da r2 (Neo4j e llama-swap) é parada antes.

## Execuções (toda rodada é contada)

| Rodada | Clone (commit) | Início | Resultado | Notas |
|---|---|---|---|---|
| r3 | `C:\Users\Rafael\graphrag-teste-f102-r3` (`a20f703`, errata 1) | 26/11 16:10 | em andamento | Antes da rodada: relógio igual ao da internet (16:08:35 local, 19:08:36 GMT); `git fsck` sem erro (só blobs soltos); SignalRgb e SignalRgbLauncher fechados (só o serviço SignalRgbService no ar, como na r2); a pilha da r2 foi parada com o `up.ps1 -Parar` consertado, e as portas 4200, 3000, 7474, 7687 e 8080 estavam livres; RAM livre 22,3 GB, commit livre 40,1 de 69,9 GB; PDF v7 copiado. Os comandos são os mesmos da r2: o 1 sem redirecionamento, e o 2 numa janela própria com `Start-Transcript` em `C:\Users\Rafael\graphrag-f102-r3-up.log`. Comando 1 passou de 16:09:01 a 16:11:06. Comando 2 às 16:11:17: Neo4j às 16:11:17, llama-swap no ar às 16:11:30, parse às 16:11:30. Etapas: parse 12,2 min, chunks 0,5 min, tabelas-gerar 47,2 min; `extrair` começou às 17:11:24. **Pausa 1 (26/11 18:01, a pedido do dono, que ia desligar o PC):** fechei a janela do comando 2 com os processos filhos e rodei o `up.ps1 -Parar` (código 0). As portas ficaram livres. O `extrair` estava em andamento, com 432 arquivos no `extracao_cache` e nenhum `.tmp`. A retomada é a repetição do comando 2, depois da checagem de boot. **Retomada 1 (27/11 07:16):** boot às 07:15:32. Checagem: relógio igual ao da internet (07:16:09 local, 10:16:10 GMT); `git fsck` sem erro; caches válidos com Python (`extracao_cache` 432, `tabelas_cache` 407, nenhum inválido e nenhum `.tmp`); portas livres; RAM livre 22,8 GB, commit livre 58,4 de 71,9 GB; SignalRgb e SignalRgbLauncher reabriram no boot e foram fechados. Comando 2 repetido às 07:16:33 (1ª repetição), numa janela nova com o mesmo título e o mesmo transcript (`-Append`). Neo4j às 07:16:35, llama-swap no ar às 07:16:45, e o `up.ps1` retomou sozinho a partir de `extrair` (`inicio extrair` às 07:16:46). |
| r2 | `C:\Users\Rafael\graphrag-teste-f102-r2` (`5166218`, código igual ao `7643520`; a linha dizia `aa683d9` por engano) | 26/11 07:05 | **falhou**: o comando 2 parou em `resolver-planejar` às 15:50:46, depois das 3 tentativas do run-all (15:23:57, 15:37:35 e 15:50:46), e terminou com `Falhou: resolver-planejar`. A API e a interface não subiram; não havia o que conferir no critério | Antes da rodada: relógio igual ao da internet; `git fsck` sem erro; SignalRgb e SignalRgbLauncher fechados (reabrem no boot); portas 4200, 3000, 7474, 7687 e 8080 livres; RAM livre 22,5 GB, commit livre 53,3 de 69,9 GB; PDF v7 copiado. Comando 1 digitado como está na ferramenta PowerShell, **sem redirecionamento**: passou de 07:01:50 a 07:03:55. Comando 2 numa janela própria do PowerShell (`-ExecutionPolicy Bypass`), com `Start-Transcript` num log fora do clone; nenhuma pausa e nenhuma repetição. Neo4j no ar às 07:04:07, llama-swap às 07:04:20. Etapas: parse 12,4 min, tabelas-gerar 46,6, extrair 155,6, catalogo-mapear 30,5, aberta 163,8 e as etapas curtas de 13:53:42 a 13:58:31. `resolver-planejar` começou às 13:58:31. **Causa (defeito do projeto):** `UnicodeEncodeError: 'utf-8' codec can't encode character '\ud835' ... surrogates not allowed` em `cache_json.gravar`, chamado pelo `resolver.julgar`. Para um par de entidades, o LLM devolveu um JSON com uma metade solta de par UTF-16. O `json.loads` aceita esse texto, mas ele não pode ser escrito em UTF-8. Foi o mesmo arquivo de cache (`af568b52e98996fdd83d`) nas 3 tentativas, e cada uma deixou um `.tmp` vazio. O defeito é anterior ao `7643520`: a gravação antiga (`write_text(..., encoding="utf-8")`) também cairia. Na p4 da F10.1 o LLM não produziu esse texto, porque os pares saem da extração, que muda de uma rodada para outra. Conserto na errata 1. |
| r1 | `C:\Users\Rafael\graphrag-teste-f102` (`7643520`) | 25/11 12:30 | **invalidada por erro meu de operação, não conta como falha do script** | Antes da rodada: pilha da p4 parada (portas 4200, 3000, 7474, 7687 e 8080 livres); RAM livre 24,0 GB, commit livre 41,7 de 69,9 GB; SignalRGB fechado; PDF v7 conferido (`B0D17566`). Comando 1 rodado na ferramenta PowerShell. Comando 2 rodado numa janela própria do PowerShell (`-ExecutionPolicy Bypass`), com `Start-Transcript` para o registro, porque o Neo4j e o llama-swap ficam no ar e prenderiam a saída da ferramenta. O horário de início foi corrigido de 12:58, escrito por engano, para 12:30, que é o horário real. O comando 1 parou em 12:30:42 + ~2 min, no `neo4j-admin dbms set-initial-password` (NativeCommandError). A causa fui eu: rodei `.\infra\instalar.ps1 *>&1 | ...`, e no PowerShell 5.1 o redirecionamento transforma o aviso `WARNING: Using incubator modules` que o `neo4j-admin` escreve no stderr num erro fatal. Sem redirecionamento, o mesmo instalador passou na p4 da F10.1. Para não misturar a regra com uma ajuda minha, a r1 não é reaproveitada. A **r2** vai rodar num clone novo, `graphrag-teste-f102-r2`, com o comando 1 digitado exatamente como está, sem redirecionamento. |
