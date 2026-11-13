# F9.5: medida do congelamento da v1 (definição fixada ANTES de rodar)

Aceite da etapa: "`eval/resultados/v1.md` e tag `v1.0.0` no git"; tarefa: "Congelar a v1: metas da §1.3 atingidas ou desvios justificados em ADR". A F9.4 deixou duas pendências ditas por escrito: (1) os degraus A3ts, A4 e A5 da F9.1 foram medidos com o redator antigo (corte de 900 caracteres, tabelas achatadas) e precisam ser refeitos; (2) o RNF-2 segue em aberto e a F9.3 deixou uma dívida (reranker com `-c 4096`, HTTP 500 em ~1,3%). Esta etapa **mede cada meta da §1.3 no código final e escreve o que saiu**, com a escada refeita. **O aceite não exige que todas as metas sejam atingidas**: exige que cada uma tenha número medido, regra fixada aqui e veredito `atingida` ou `desvio` (com justificativa no ADR). Nada abaixo é trocado depois de ver o resultado.

## O que fica congelado

- **O código do produto** é o do commit `5a5266d` (F9.4): `api/src` (agente, ferramentas, LLM, HTTP, telemetria, artefatos), `contracts/`, `web/src`, `infra/llama-swap.yaml` e os prompts. Esta etapa só acrescenta **ferramentas de medida** (`eval/`, `indexer/src/indexer/f95.py`, `infra/rodar-f95.ps1`, `infra/amostrar-recursos.ps1`, `api/test/http/medir-latencia.ts`) e documentos. Conferência na hora da tag: `git diff 5a5266d -- api/src contracts web/src infra/llama-swap.yaml` só pode listar arquivos de `api/src/avaliacao/` (nenhum é do produto); qualquer outra diferença invalida as medidas e obriga a refazê-las.
- **O A6 da v1 é a r3 da F9.4** (`f94r3-a6` nas 60, `f94r3n-a6` nas 24): o código não mudou desde então, então não é refeito. É **uma execução** e a variância do Qwen e do juiz continua não medida (dito no `v1.md`).
- **A0 a A3** (Python, índice e embeddings sem mudança desde a F9.1, ADR-080 manteve o Qwen3-Embedding-0.6B) ficam como estão em `v1-a0` … `v1-a3` e `v1n-a3`.
- `eval/resultados/v1-ablacao.md` (F9.1) **não é reescrito**: é o registro daquela rodada. A escada final está em `v1.md`, com a coluna da F9.1 ao lado nos degraus refeitos.

## Parte A: a escada refeita (A3ts, A4, A5)

Mesmas 60 perguntas (`eval/golden.csv`), mesmo Qwen3.6 (temperatura 0,2), mesmo juiz (Gemma 4 26B-A4B), mesmo índice, mesmas definições de degrau da `eval/f91-medida-ablacao.md` (uma rodada do agente, sem crítico, ferramentas restritas, sem `tabelasJuntas` por construção). **A única diferença é o código do redator e do crítico da F9.4** (o crítico não roda nesses degraus; vale o redator: 3.000 caracteres por evidência, 16 evidências, quebras de linha das tabelas, regra 6 do prompt). Nomes: `f95-a3ts`, `f95-a4`, `f95-a5`. Comandos: `npm run avaliar:ablacao -- --degrau <d> --nome f95-<d>` e `uv run python -m indexer.avaliar executar --nome f95-<d> --degrau <d>`. Uma execução por degrau.

**Regra da parte A** (cumprida só se tudo valer): (1) cada degrau responde as 60; erro do sistema conta como incorreta e **não se refaz**; rodada interrompida por queda de serviço é retomada e isso é escrito; (2) o juiz responde ≥ 95% das chamadas em cada degrau; (3) nada é afinado entre as rodadas (prompt, limiar, ferramenta, golden, juiz); (4) o que a escada mostra é descrito como saiu, inclusive degrau que não melhora ou piora, e a comparação com a F9.1 mostra o efeito do redator novo. Diferença menor que 0,05 vale como empate.

## Parte B: as metas da §1.3, uma a uma

Medidas no código congelado, Neo4j e llama-swap reais, API em produção local (`npm run build; npm start`, `127.0.0.1:3000`), perfil `consultar` (o padrão da tela) salvo onde dito. Em cada item vale o **limite escrito na ARQUITETURA §1.3**; o que esta medida fixa é só o *como* e a *regra de veredito*.

| Meta | Como se mede | Veredito `atingida` se |
|---|---|---|
| **RNF-1** Privacidade: nenhuma chamada de rede externa em tempo de consulta | (a) auditoria do código: todo `http(s)://` em `api/src`, `web/src`, `contracts/` e `infra/llama-swap.yaml` cujo host não seja `127.0.0.1`, `localhost` ou `[::1]`, com contexto (as que forem só comentário ou espaço de nomes de esquema são listadas e explicadas, não escondidas); (b) amostragem das conexões TCP dos processos `node`, `llama-server`, `llama-swap` e `java` (Neo4j) a cada 2 s durante toda a rodada da API (RNF-2/3), listando todo endereço remoto que não seja de loopback | (a) nenhum host externo alcançável no caminho da consulta e (b) zero endereços remotos fora de loopback nas amostras. A amostragem **não prova ausência** (conexão curta pode escapar); é dito no `v1.md` |
| **RNF-2** Latência, pergunta simples: 1º token ≤ 5 s, resposta completa ≤ 20 s | pela **API real, SSE**: as 30 perguntas simples do golden (T01 a T15 e N01 a N15), uma conversa nova por pergunta, uma execução, um aquecimento descartado (a 1ª de `eval/perguntas_latencia.txt`). Tempo do 1º token = do envio do POST ao 1º evento `token`; completa = ao evento `fim`. Mede-se também o perfil `consultar-rapido` (só a rodada 1; informativo), com a **ordem alternada** entre os dois perfis a cada pergunta | **≥ 27 das 30 (≥ 90%)** com **os dois** tempos dentro do limite, no perfil `consultar` |
| **RNF-3** Latência, busca global: ≤ 90 s, com progresso transmitido | pela API: as 10 perguntas temáticas do golden (P01 a P10), perfil `consultar`, tempo até o `fim`; progresso = quantidade de eventos `etapa` que chegam **antes** do 1º `token` | as **10 de 10** terminam em ≤ 90 s **e** cada uma recebe ≥ 3 eventos `etapa` antes do 1º `token` |
| **RNF-4** Fidelidade ≥ 0,90 | fidelidade do A6 (juiz) nas 60 (`f94r3-a6`) e nas 24 (`f94r3n-a6`) | ≥ 0,90 **nas duas** |
| **RNF-5** Correção ≥ 0,70 e ≥ +15 p.p. sobre a linha de base vetorial | correção do A6 contra a do **A3** (vetor com Pai e reranker, a linha de base mais forte da escada), nas 60 e nas 24 (`v1-a3`, `v1n-a3`); o A1 (ingênuo) também é mostrado | A6 ≥ 0,70 e A6 − A3 ≥ 0,15 **nas duas**. Se só as 60 passarem, o veredito é "atingida só no conjunto de ajuste" e conta como `desvio` |
| **RNF-6** 100% das afirmações numéricas com página | `npm run avaliar:redator -- --nome f95-redator` (60) e `--golden eval/golden_novas.csv --nome f95n-redator` (24), pipeline inteiro como em produção, com a régua da F7.5 **como está** (`numeros.ts`, `verificar`; sem mudança): frase numérica com marcador `[E#]` que existe entre as evidências | 100% **nas duas** conjuntos. Abaixo de 100%: `desvio`, com a lista das frases. Dito de novo: a régua mede se há citação, não se a citação sustenta a frase (ADR-061) |
| **RNF-7** Reprodutibilidade: versões de modelos, quantizações e prompts fixadas em `infra/models.lock.json` | (a) `infra\verify_models.ps1` confere todos os hashes; (b) todo `.gguf` dos perfis de produção em `infra/llama-swap.yaml` tem entrada com `sha256` no lock (os modelos do bake-off de embeddings da F9.3, que estão no YAML e não no lock, são listados como **fora da v1**); (c) o lock ganha um bloco `prompts` (sha256 dos arquivos que contêm prompts: agente, ferramentas, Text2Cypher, extração e resumos) gerado por comando, com o commit e a tag; (d) o commit da tag é o mesmo em que esses hashes foram gerados | (a), (b), (c) e (d) todos valem |
| **RNF-8** Pico de VRAM ≤ 15,2 GB e de RAM ≤ 28 GB | amostragem a cada 2 s durante toda a rodada da API: VRAM = contador `GPU Adapter Memory\Dedicated Usage` somado (desktop incluído, como na F0.5 e na F9.2); RAM = total visível − livre (sistema inteiro, Neo4j incluído). 15,2 GB = 15.564,8 MB. Também são mostrados, sem amostragem nova, o pico do perfil `avaliar` (`eval/resultados/f92-vram.json`) e o do `indexar` (F0.5) | os dois picos dentro do limite na rodada da API. O estado do desktop (aplicativos abertos) é anotado; fechar aplicativos pesados antes é permitido e é dito |

**Perguntas e perfis da parte B (resumo):** RNF-2 usa T01–T15 + N01–N15 (as mesmas "simples" da F7.13 e da F8.2); RNF-3 usa P01–P10; RNF-6 usa as 60 e as 24. Tudo no modo `auto`.

## Regra de aceite da etapa (fixada agora)

Cumprida só se tudo valer:

1. **Parte A cumprida** (regra acima), com as 60 respostas de cada degrau gravadas.
2. **Cada uma das 8 metas** tem número medido e veredito `atingida` ou `desvio` pela regra da tabela; **nenhum veredito é trocado depois do resultado** e nenhuma medida é refeita para melhorar a nota (uma medida só se refaz por defeito de infraestrutura que a impediu, registrado, e a anterior continua contada).
3. `eval/resultados/v1.md` é **gerado por comando** (`uv run python -m indexer.f95 v1`, a partir dos relatórios em `eval/resultados/`), com a escada final, o grupo novo, a tabela das metas e a lista dos desvios.
4. Cada `desvio` tem justificativa e o que ele significa para quem usa, no **ADR-082**, com o número e a regra violada, sem reescrever a meta.
5. A **tag `v1.0.0`** aponta para o commit que contém `v1.md`, o ADR, o `models.lock.json` com os prompts e a conferência do código congelado (`git diff` acima).

Não há aceite pós-hoc de algo que falhou. Se a parte A ou o item 3 ou 5 não valerem, a F9.5 fica `[~]`. Um `desvio` **não** impede o congelamento: é o que o aceite chama de "desvio justificado".

## Limites já sabidos

- **Golden e rótulos do juiz são do Claude** (ADR-027, ADR-030); o Gemma é juiz de respostas do Qwen; só a correção foi calibrada.
- **O A6 é uma execução** (a r3 da F9.4), em um conjunto em que as falhas foram lidas (60) e em um de 24 que não foi lido pergunta a pergunta; a categoria do grupo novo tem de 3 a 6 perguntas.
- **A6 foi afinado em três rodadas** (r1, r2 e r3 da F9.4, todas contadas); a escada A3ts–A5 desta etapa **não** foi afinada: só o redator mudou.
- **Latência** depende desta máquina (RX 9070 16 GB, 32 GB de RAM, Windows), dos modelos já carregados e do cache de prompt do servidor; o aquecimento descartado e a ordem alternada reduzem, não eliminam, o efeito.
- **Uma execução por medida de latência**, sem intervalo de confiança.

## Reprodução

```powershell
# serviços: .\infra\neo4j.ps1 iniciar ; .\infra\swap.ps1 (outra janela)
.\infra\rodar-f95.ps1 -Fase escada    # A3ts, A4, A5: gerar (60) e julgar
.\infra\rodar-f95.ps1 -Fase metas     # API: RNF-1, 2, 3, 8; redator: RNF-6 (60 e 24); repro: RNF-7
.\infra\rodar-f95.ps1 -Fase tabela    # uv run python -m indexer.f95 v1  (sem LLM)
```

## Execuções (toda execução é contada)

**Fora da medida (preparo):** a primeira tentativa de subir o llama-swap por um `Start-Process` falhou por causa do espaço no caminho da pasta ("Graph Rag") e foi refeita com aspas; o mesmo defeito estava no roteiro, no trecho que inicia o amostrador de recursos, e foi consertado e commitado (db0ea64) **antes** de qualquer medida. Nada foi medido com esses defeitos. A auditoria de rede do código (`indexer.f95 rede`) foi rodada uma vez como teste da ferramenta (mesma saída, arquivo apagado) e de novo pelo roteiro; é determinística.

**Fase "metas"** (`.\infra\rodar-f95.ps1 -Fase metas`, 13/11, 12:34 a 13:34; log em `data/avaliacao/f95-rodadas.log`, fora do git), uma execução de cada, nenhuma refeita:

| Medida | Relatório | Resultado da execução |
|---|---|---|
| RNF-1 (a) auditoria do código | `f95-rede.json` | 111 arquivos varridos; 5 URLs fora de loopback, todas documentais (espaço de nomes do SVG, `$schema` e `$id` dos esquemas JSON); 0 candidatas |
| RNF-7 (a) `verify_models.ps1` | `f95-verify.json` | saída 0 (todos os hashes conferem) |
| RNF-7 (b) e (c) YAML x lock, prompts | `f95-repro.json` | 3 modelos do YAML sem entrada no lock, todos do bake-off da F9.3 (fora da v1); 22 arquivos de prompt com sha256 gravados em `models.lock.json` |
| RNF-1 (b) e RNF-8 amostragem | `f95-recursos.json` | 448 amostras (a cada 2 s, 12:35 a 12:59); 0 conexões remotas fora de loopback; pico de VRAM 11.789 MB; pico de RAM usada 32.341 MB (primeira amostra, antes de qualquer modelo: 8.775 MB) |
| RNF-2 e RNF-3 pela API (SSE) | `f95-latencia.json` | 1 aquecimento descartado + 30 perguntas × 2 perfis + 10 temáticas, todas HTTP 200 e terminando em `fim` (24 min) |
| RNF-6 nas 60 | `f95-redator.json` | 60 respostas, 0 exceções, 0 erros de infraestrutura (26 min); a CLI sai com código 1 quando sobra frase numérica sem citação, como projetada |
| RNF-6 nas 24 | `f95n-redator.json` | 24 respostas, 0 exceções, 0 erros de infraestrutura (9 min), saída 0 |

Os resultados e os vereditos pela regra da tabela estão em `eval/resultados/v1.md` (gerado depois da escada) e abaixo, em "Resultado por item da regra".

**Fase "escada"** (`.\infra\rodar-f95.ps1 -Fase escada`, 13/11, 13:34 a 17:16, sem interrupção; uma execução por degrau, nenhuma refeita):

| Relatório | Perguntas | Geração (TS) | Juiz | Erros do sistema | Falhas do juiz |
|---|---:|---:|---:|---:|---:|
| `f95-a3ts` | 60 | 11 min | 61 min | 0 | 0 |
| `f95-a4` | 60 | 12 min | 60 min | 0 | 0 |
| `f95-a5` | 60 | 16 min | 61 min | 0 | 0 |

O A6 da v1 é a r3 da F9.4 (`f94r3-a6`, 60; `f94r3n-a6`, 24), **não** foi refeito, como fixado. `eval/resultados/v1.md` foi gerado por `.\infra\rodar-f95.ps1 -Fase tabela` (`uv run python -m indexer.f95 v1`) às 17:16. Nenhum código do produto mudou entre o commit `5a5266d` e a tag.

## Resultado por item da regra

**Parte A: cumprida.** Três degraus, 60 respostas cada, 0 erros do sistema, 0 falhas do juiz, nada afinado entre as rodadas (só mudou o redator, que já estava no código desde a F9.4). Lido como saiu (`v1.md`): com o redator novo, A3ts, A4 e A5 sobem de 0,53, 0,54 e 0,53 para **0,57, 0,61 e 0,58** (A3 era 0,54); o acerto numérico **não** mudou (0,29, 0,38, 0,38). Entre degraus vizinhos a diferença fica abaixo de 0,05 (empate); só A4 contra A3 passa de 0,05 (+0,07, dois passos). O salto está no A6 (0,87, +0,29 sobre o A5), que é o degrau com o crítico e a busca de tabelas junto, justamente o que A3ts a A5 não têm por construção.

**Parte B: as 8 metas, vereditos pela regra da tabela (nenhum trocado depois do resultado):**

| Meta | Veredito | Número |
|---|---|---|
| RNF-1 | **atingida** | 0 candidatas no código; 0 endereços remotos fora de loopback em 448 amostras |
| RNF-2 | **desvio** | 0 de 30 (regra: ≥ 27); 1º token ≤ 5 s em 0; completa ≤ 20 s em 24 |
| RNF-3 | **atingida** | 10 de 10 em ≤ 90 s (máx. 85,7 s), progresso em 10 de 10 |
| RNF-4 | **atingida** | 0,97 (60) e 1,00 (24) |
| RNF-5 | **atingida** | A6 0,87 e 0,77 contra A3 0,54 e 0,48 (+33 e +29 p.p.) |
| RNF-6 | **desvio** | 60: 58 de 63 (92,06%); 24: 29 de 29 |
| RNF-7 | **atingida** em (a), (b) e (c); (d) abaixo | `verify_models` 0; 3 modelos do YAML fora do lock, todos do bake-off da F9.3; 22 prompts com sha256 |
| RNF-8 | **desvio** | VRAM 11,51 GB (ok); RAM usada 31,58 GB contra 28 GB |

**Item 3 (v1.md por comando):** cumprido. **Item 4 (ADR-082 com os desvios):** cumprido. **Item 5 (tag `v1.0.0`): cumprido.** A tag anotada aponta para `c7b642c` (o commit com o `v1.md`, o ADR-082, a ETAPAS e o `models.lock.json` com os 22 prompts); `git diff 5a5266d -- api/src contracts web/src infra/llama-swap.yaml` vazio; `uv run python -m indexer.f95 repro --tag v1.0.0`: 0 arquivos de prompt divergentes do lock na tag, `ok: true`, o que fecha o item (d) do RNF-7. **Veredito final: a F9.5 cumpre o aceite** (parte A, 8 metas com número e veredito, `v1.md` por comando, ADR com os 3 desvios, tag); os desvios não impedem o congelamento.
