# ADR-011 · Perfis do `llama-swap` (motor `matrix`) e orçamento de VRAM por perfil

- **Estado:** aceita (27/10/2026)
- **Data:** 2026-10-27
- **Tarefa(s):** F0.6

## Contexto

O `llama-swap` v267 oferece três motores de roteamento: `group` (padrão), `matrix` e `capacity`. A ARQUITETURA v0.3 §9 desenhava os perfis com `groups`, mas no motor de grupos **um modelo só pode estar em um grupo**, e o embedding e o reranker são usados por dois perfis (`consultar` e `consultar-rapido`). Além disso, a §2.4 deixou em aberto o perfil `consultar-rapido`: o gpt-oss-20b sozinho chegou a 15,1 GB no adaptador com o desktop atual (3,3 a 3,6 GB), e o teto do RNF-8 é 15,2 GB.

## Decisão

1. **Motor `matrix`** do `llama-swap` v267, com um conjunto por perfil: `indexar = q`, `consultar = q & e & r`, `consultar-rapido = g & e & r`, `vetorizar = el`, `avaliar = j` (q = Qwen3.6, g = gpt-oss, e = embedding na CPU, el = embedding em lote na GPU, r = reranker, j = juiz Gemma 4). Um modelo fora de qualquer conjunto (`el`, `j`) roda sozinho e expulsa os demais; um conjunto também admite qualquer subconjunto de si mesmo.
2. **gpt-oss-20b com `--n-cpu-moe 4 -lm none -ctk q8_0 -ctv q8_0`** no `consultar-rapido`: a geração cai de 170 para ~75 tok/s, mas o perfil fecha em 14,8 GB.
3. **Reranker com `-c 4096 -ub 2048`**: basta para um trecho de até 2.048 tokens e libera ~0,5 GB frente a `-c 8192`.
4. **Escuta só em `127.0.0.1:8080`** (RNF-1) e caminhos por variáveis de ambiente (`infra/swap.ps1` define `GRAG_ROOT` e `GRAG_ROOT_WIN`), sem nada fixo da máquina no YAML.

## Alternativas consideradas

- **Motor `group`.** Rejeitado: não deixa o embedding e o reranker em dois perfis, a menos que se dupliquem as entradas.
- **Motor `capacity`.** Rejeitado por ora: exige declarar a capacidade de cada modelo por pool, sem medição automática; o `matrix` basta para cinco perfis.
- **gpt-oss inteiro na GPU com reranker na CPU.** Reranquear 24 trechos de ~1.200 tokens leva ~4,1 s na CPU contra ~1,9 s na GPU, mas o total do perfil ficaria em ~15,8 GB, acima do teto. Opção de reserva se o reranker na GPU voltar a apertar.
- **`--n-cpu-moe` 8 no gpt-oss.** Libera mais VRAM, mas a geração cai a 51 tok/s.

## Consequências

- O perfil `consultar-rapido` entrega ~75 tok/s, ainda cerca de 2× o Qwen3.6, mas bem abaixo dos 170 tok/s do gpt-oss inteiro na GPU.
- **Pendência do juiz:** `avaliar` fecha em 15,94 GB, 0,7 GB acima do teto de 15,2 GB com o desktop em 3,3 GB. O Windows consegue acomodar, mas a margem é nula. Na F3, testar `-ctk q8_0 -ctv q8_0` e um contexto menor no juiz, ou fechar aplicativos pesados.
- **F2.6:** o aceite de reranquear 24 trechos em ≤ 2 s tem margem pequena (1,9 s a 2,0 s medidos fora do `llama-swap`; 3,2 s na primeira chamada, que carrega o modelo).
- O YAML real é `infra/llama-swap.yaml`; a ARQUITETURA §9 o espelha.

## Verificação do aceite da F0.6

| Critério | Resultado |
|---|---|
| `/v1/models` lista todos os modelos | 6 de 6: `gemma4-26b-a4b-juiz`, `gpt-oss-20b`, `qwen3-embed-0.6b`, `qwen3-embed-0.6b-lote`, `qwen3-rerank-0.6b`, `qwen36-35b-a3b` |
| `/v1/embeddings` responde | dimensão 1024, nos modelos de CPU e de GPU |
| `/v1/rerank` responde | o trecho relevante recebeu nota 1,00 e os outros 0,00 |
| Troca de perfil ≤ 60 s | pior caso **16.0 s** (carga do Qwen3.6 ou do juiz, mais a resposta) |

## Ressalvas

1. Cada passo foi medido uma vez; a VRAM e a RAM são lidas 2 s depois da resposta, em regime.
2. A VRAM de repouso do desktop foi de 3,3 a 3,6 GB nas rodadas, e muda o teto efetivo.
3. O fluxo `consultar` foi medido depois da primeira resposta do Qwen3.6, com contexto de 32K alocado, mas sem prompts longos (a F0.5 mediu os picos com ~15K de contexto: 12,4 GB de VRAM e 25,3 GB de RAM para o Qwen3.6 sozinho).
4. A primeira rodada deste teste (arquivo `testar-swap_1_gptoss_inteiro.jsonl`) usou o gpt-oss inteiro na GPU e o reranker com `-c 8192 -ub 8192`: o `consultar-rapido` chegou a 15,5 GB, o que motivou as decisões 2 e 3.

## Adendo (F2.6, 28/10/2026)

A decisão 3 (reranker com `-c 4096 -ub 2048` "basta para um trecho de até 2.048 tokens") subestimou o limite: medido na F2.6, o servidor aceitou pares de até 4.077 tokens; o limite real é o contexto de 4.096, e não o `-ub`. O que restringe o uso é o tempo, proporcional aos tokens enviados (~22 mil tokens/s na GPU); veja o [ADR-023](ADR-023-rerank-dos-pais.md). A configuração do reranker no `llama-swap.yaml` não mudou.

## Evidência

Roteiro: `infra/testar-swap.ps1` (com o `llama-swap` no ar via `infra/swap.ps1`). Medição direta do reranker: `ADR-011-bruto/rerank_cpu_gpu.ps1` e `.txt` (24 trechos de ~1.200 tokens: GPU 2,17 / 1,88 / 1,85 s; CPU 4,45 / 4,07 / 4,18 s). `llama-bench` do gpt-oss sem mmap, com 0, 4 e 8 camadas de experts na CPU: geração de 169,9, 74,5 e 50,9 tok/s (`ADR-011-bruto/bench_gptoss_ncmoe_lmnone.jsonl`).

### Teste final, com a configuração commitada

| Perfil | Passo | Tempo | VRAM (adaptador) | RAM usada | Resultado |
|---|---|---:|---:|---:|---|
| consultar | embeddings (CPU) | 1.3 s | 3562 MB | 10583 MB | ok dim=1024 |
| consultar | rerank (GPU) | 1.3 s | 4870 MB | 11349 MB | ok 0:1,00 1:0,00 2:0,00 |
| consultar | LLM Qwen3.6 (carga + resposta) | 13.6 s | 13597 MB | 25220 MB | ok pronto. |
| consultar | embeddings com Qwen residente | 0.0 s | 13597 MB | 25224 MB | ok dim=1024 |
| vetorizar | embeddings em lote (GPU) | 2.6 s | 5101 MB | 9618 MB | ok dim=1024 |
| consultar-rapido | LLM gpt-oss-20b | 7.0 s | 13238 MB | 11399 MB | ok |
| consultar-rapido | embeddings (CPU) | 1.3 s | 13476 MB | 12908 MB | ok dim=1024 |
| consultar-rapido | rerank (GPU) com gpt-oss | 1.3 s | 14782 MB | 13691 MB | ok 0:0,83 1:0,00 |
| avaliar | juiz Gemma 4 (HIP) | 14.8 s | 15940 MB | 26125 MB | ok pronto. |
| indexar | LLM Qwen3.6 (volta do juiz) | 16.0 s | 12050 MB | 22825 MB | ok pronto. |

### Saída bruta

Em [`ADR-011-bruto/`](ADR-011-bruto/): `testar-swap.jsonl` e `.txt` (teste final), `testar-swap_1_gptoss_inteiro.jsonl` (primeira rodada), `rerank_cpu_gpu.*`, `bench_gptoss_ncmoe_lmnone.jsonl`, `swap.out` e `swap.err` (log do `llama-swap`).
