# ADR-010 · Offload de experts do Qwen3.6 no `llama-server`: `-lm none` e `--n-cpu-moe`

- **Estado:** proposta (a configuração do Qwen3.6 está medida; a revisão do ADR-001 que ela impõe aguarda aprovação)
- **Data:** 2026-10-27
- **Tarefa(s):** F0.5

## Contexto

O Qwen3.6-35B-A3B (22,4 GB) não cabe na VRAM de 16 GB; parte das camadas de experts do MoE fica na CPU (`--n-cpu-moe N`: experts das N primeiras camadas na CPU). A F0.5 pede a calibração para 2 slots de 16K de contexto (`-c 32768 -np 2`) com critérios de pico de VRAM ≤ 15,2 GB, pico de RAM ≤ 28 GB e geração ≥ 20 tok/s.

As medições da F0.4 (ADR-001) e a primeira bateria da F0.5 foram feitas com o carregamento padrão do llama.cpp (mmap). Essa bateria deu pico de RAM de ~32,5 GB (todo o sistema) e prompt de ~350 tok/s. O log do `llama-server` avisa: *"tensor overrides to CPU are used with mmap enabled - consider using --load-mode none"*. Seguindo o aviso, medimos de novo sem mmap.

## Decisão

1. **Carregar o Qwen3.6 sempre com `-lm none`** (`--load-mode none`) em todos os perfis.
2. **`--n-cpu-moe 28`** como valor padrão dos perfis `consultar` e `indexar` com `-c 32768 -np 2 -fa on -ctk q8_0 -ctv q8_0`. Com o desktop leve, `--n-cpu-moe 24` é uma opção que rende ~8% a mais de geração.
3. **Não usar `--moe-cache-mib`** por enquanto.
4. **Não usar `--n-cpu-moe` ≥ 32 no Vulkan sem mmap** (ver ressalvas).

Verificação dos critérios na configuração escolhida (Vulkan, `ncmoe 28`, `-lm none`, dois prompts de ~15K tokens):

| Critério | Meta | Medido | Resultado |
|---|---|---|---|
| Pico de VRAM (total do adaptador, desktop incluído) | ≤ 15,2 GB | 12,4 GB (14,2 GB com `ncmoe 24`) | atende |
| Pico de RAM usada (sistema todo, desktop incluído) | ≤ 28 GB | 25,3 GB (23,5 GB com `ncmoe 24`) | atende |
| Geração, um fluxo com ~15K de contexto | ≥ 20 tok/s | 35,1 tok/s (38,0 com `ncmoe 24`) | atende |
| Geração, dois slots saturados ao mesmo tempo | ≥ 20 tok/s | 10,0 e 24,5 tok/s | **não atende** no slot que compartilha tempo com o prefill do outro |

O último ponto é interferência de prefill sobre decode (o outro slot processava um prompt de 15K); não é falta de memória. Fica como regra de uso: com prompts longos simultâneos, não esperar 20 tok/s por slot.

## Alternativas consideradas

- **Manter o mmap.** Rejeitada: RAM de ~32,5 GB (todo o sistema) e prompt 2,6× mais lento.
- **`ncmoe 24`.** Mais rápido (+8% de geração, +10% de prompt), mas o pico de VRAM é 14,2 GB com o desktop em 3,5 GB; com o desktop em 4,5 GB chega a ~15,2 GB, e o reranker do perfil `consultar` ainda soma ~1 GB. Fica como opção para a indexação com o desktop leve.
- **`--moe-cache-mib`.** Com mmap parecia piorar a geração pela metade; sem mmap, `ncmoe 32` + cache de 2048 MiB deu 37,8 tok/s, equivalente ao `ncmoe 24` sem cache (38,0), usando 13,5 GB de VRAM contra 14,2 GB. Ganho pequeno e sem a aceleração de até 2,2× anunciada nas notas do v0.7.0; com cache de 4096 e `ncmoe 40` a geração cai a 28,6 tok/s e a VRAM sobe a 15,1 GB; com 8192 MiB o backend Vulkan do b11932 falha numa asserção interna. Não compensa a complexidade.

## Consequências

- Processamento de prompt do Qwen3.6 sobe de 2,4× a 3,1× com `ncmoe` 24 e 28 (por exemplo, de ~340 para ~1.040 tok/s de `pp2048` no Vulkan, `ncmoe 24`; no `ncmoe 20` chega a 5×), o que muda as contas da ARQUITETURA §5.2.
- **O ADR-001 precisa de revisão** (proposta abaixo): ele escolheu HIP para o `indexar` com a premissa de que a indexação é dominada por prompt. Com os números sem mmap, a geração domina (cerca de 85% do tempo por chamada) e o Vulkan gera cerca de 8% mais rápido (`ncmoe` 24 e 28).
- O pico de RAM de 25,3 GB deixa pouca folga para o embedding na CPU e o navegador. No perfil `consultar` o total estimado é ~26,5 GB.
- A VRAM do desktop (3,5 a 4,5 GB) segue sendo a principal fonte de incerteza dos picos.

### Proposta de revisão do ADR-001 (aguarda aprovação)

| Perfil / modelo | ADR-001 (aceita) | Proposta |
|---|---|---|
| `indexar` (Qwen3.6) | HIP | **Vulkan**: `tg128` +8% e, por chamada de extração, ~5% a 6% menos tempo no total |
| `consultar` (Qwen3.6) | Vulkan | Vulkan (sem mudança) |
| `consultar-rapido` (gpt-oss-20b) | Vulkan | Vulkan (sem mudança; modelo cabe inteiro na GPU, o mmap não pesa) |
| `avaliar` (Gemma 4) | HIP, provisório | HIP, provisório (sem mudança; reconfirmar com o desktop leve) |

Efeito: o HIP e as wheels `rocm-sdk` de ~1,1 GB passam a servir só ao juiz. Se a reconfirmação do Gemma não mostrar vantagem relevante, dá para dispensar o HIP. A ARQUITETURA v0.2 (§0, §2.2, §5.2 e §9) seria ajustada de acordo; o §5.2 passaria a ~4.6 h no Vulkan (tabela abaixo).

## Ressalvas

1. **Cada configuração do servidor foi medida uma vez** (uma rodada de 2 slots e uma de 1 slot, 200 tokens gerados). As diferenças de poucos por cento entre `ncmoe` 24 e 28 estão dentro do que a variação entre rodadas pode explicar; o `llama-bench` (3 repetições, desvio ≤ 1 tok/s na geração) sustenta a ordem.
2. **Anomalia do Vulkan sem mmap com muitos experts na CPU:** no `llama-bench`, `ncmoe 32` e `40` caíram para 3,1 e 0,7 tok/s de geração (e 163 s e 607 s por corrida), enquanto o HIP manteve 30,1 e 25,9. Não investigamos a causa (suspeita: pressão de memória do sistema, já que os experts na CPU ocupam mais de 16 GB e o desktop usa ~10,5 GB). Fica fora da faixa recomendada, mas é uma armadilha: nunca usar `ncmoe` ≥ 32 no Vulkan sem mmap sem remedir. Na corrida de servidor `ncmoe 32` + cache de 2048 MiB, com menos experts na CPU, não houve o problema.
3. **RAM:** o "pico de RAM usada" é `RAM total − disponível` do sistema, incluindo o que o desktop usa (base de 10,3 a 12,4 GB nas corridas). A memória privada do `llama-server` sem mmap reportou ~23 GB (compromisso virtual), mas o conjunto de trabalho real foi de 12,6 GB (`ncmoe 24`) a 14,5 GB (`ncmoe 28`), coerente com os experts na CPU.
4. A VRAM e a RAM do desktop variaram entre corridas (VRAM base de 3,5 a 4,5 GB), o que desloca os picos em até ~1 GB.

## Evidência

Script: `infra/calibrar-moe.ps1 -Backend <vulkan|hip> [-So <filtro>] [-LoadMode none]` (servidor com dois prompts de ~15K tokens, tirados de `docs/ARQUITETURA.md` e `docs/ETAPAS.md`, tokenizados pelo próprio modelo: 14.931 e 14.969 tokens; primeiro os dois ao mesmo tempo, depois um sozinho; `n_predict` 200, `temperature` 0, `cache_prompt` falso). VRAM: contador `GPU Adapter Memory\Dedicated Usage` (soma dos adaptadores); RAM: total menos `AvailableMBytes`.

### Servidor, 2 slots de 16K de contexto

| Backend | `--n-cpu-moe` | Cache MoE | Carga | VRAM pico (MB) | RAM usada pico (MB) | 1 slot: prompt / geração (tok/s) | 2 slots: geração por slot (tok/s) |
|---|---:|---:|---|---:|---:|---|---|
| vulkan | 24 | — | mmap (padrão) | 14210 | 32499 | 352 / 37.6 | 5.7 e 26.4 |
| vulkan | 24 | — | sem mmap (`-lm none`) | 14246 | 23489 | 905 / 38.0 | 11.0 e 27.0 |
| vulkan | 28 | — | mmap (padrão) | 12342 | 32500 | 314 / 34.8 | 5.1 e 24.1 |
| vulkan | 28 | — | sem mmap (`-lm none`) | 12369 | 25270 | 826 / 35.1 | 10.0 e 24.5 |
| vulkan | 32 | — | mmap (padrão) | 10478 | 32437 | 280 / 31.6 | 4.5 e 22.3 |
| vulkan | 32 | 2048 | mmap (padrão) | 12539 | 32165 | 267 / 16.1 | 3.3 e 8.7 |
| vulkan | 32 | 2048 | sem mmap (`-lm none`) | 13486 | 25444 | 851 / 37.8 | 10.7 e 28.0 |
| vulkan | 40 | 4096 | mmap (padrão) | 10785 | 32015 | 227 / 18.9 | 3.3 e 10.8 |
| vulkan | 40 | 4096 | sem mmap (`-lm none`) | 15111 | 25085 | 221 / 28.6 | 3.7 e 19.6 |
| vulkan | 40 | 8192 | mmap (padrão) | — | — | falhou (asserção do backend Vulkan) | — |
| hip | 24 | — | mmap (padrão) | 14422 | 32297 | 500 / 32.4 | 7.3 e 24.6 |
| hip | 24 | — | sem mmap (`-lm none`) | 14394 | 23502 | 991 / 33.4 | 11.2 e 25.0 |
| hip | 28 | — | mmap (padrão) | 12556 | 32276 | 449 / 30.4 | 6.6 e 22.6 |
| hip | 28 | — | sem mmap (`-lm none`) | 12542 | 25341 | 912 / 32.1 | 10.3 e 23.3 |

### `llama-bench` do Qwen3.6, com e sem mmap (tok/s)

Mesmas flags da F0.4 (`-fa 1 -ctk q8_0 -ctv q8_0 -ub 512 -t 6 -p 512,2048 -n 128 -r 3`), mais `-lm none` nas colunas "sem mmap". Dados brutos novos em [`ADR-001-bruto/`](ADR-001-bruto/) (arquivos `*_lmnone.*`).

| `--n-cpu-moe` | Backend | pp2048 mmap | pp2048 sem mmap | tg128 mmap | tg128 sem mmap |
|---:|---|---:|---:|---:|---:|
| 20 | vulkan | 216 | 1149 | 39.3 | 39.8 |
| 20 | hip | 304 | 443 | 38.4 | 35.4 |
| 24 | vulkan | 339 | 1039 | 37.8 | 38.8 |
| 24 | hip | 478 | 1130 | 35.1 | 36.0 |
| 28 | vulkan | 307 | 957 | 34.6 | 35.4 |
| 28 | hip | 413 | 1037 | 32.0 | 32.9 |
| 32 | vulkan | 268 | 919 | 32.4 | 3.1 |
| 32 | hip | 364 | 965 | 29.3 | 30.1 |
| 40 | vulkan | 223 | 886 | 27.3 | 0.7 |
| 40 | hip | 300 | 651 | 24.8 | 25.9 |

### Tempo estimado de indexação por backend (Qwen3.6, `ncmoe 28`, sem mmap)

Mesma conta da ARQUITETURA §5.2 (tokens de entrada ÷ `pp2048` + tokens de saída ÷ `tg128`); limite inferior, sem custo de gramática JSON nem decode com contexto longo.

| Etapa | Chamadas | Vulkan `ncmoe 28` | HIP `ncmoe 28` |
|---|---:|---:|---:|
| Extração dirigida a esquema | 210 | 68 min | 72 min |
| Extração aberta (sem *gleaning*) | 170 | 89 min | 94 min |
| Perguntas hipotéticas das tabelas | 40 | 7 min | 7 min |
| Resumos de entidades e relações | 600 | 67 min | 70 min |
| Relatórios de comunidade | 80 | 46 min | 48 min |
| **Total** | | **4.6 h** | **4.9 h** |

### Comandos

```
hip_ncmoe24: C:\Users\Rafael\Documents\Graph Rag\infra\bin\llama-b11932-hip\llama-server.exe --host 127.0.0.1 --port 8099 -m C:\modelos\Qwen3.6-35B-A3B-UD-Q4_K_XL.gguf -c 32768 -np 2 -ngl 99 -ncmoe 24 -fa on -ctk q8_0 -ctv q8_0 --jinja
hip_ncmoe24_lmnone: C:\Users\Rafael\Documents\Graph Rag\infra\bin\llama-b11932-hip\llama-server.exe --host 127.0.0.1 --port 8099 -m C:\modelos\Qwen3.6-35B-A3B-UD-Q4_K_XL.gguf -c 32768 -np 2 -ngl 99 -ncmoe 24 -fa on -ctk q8_0 -ctv q8_0 --jinja -lm none
hip_ncmoe28: C:\Users\Rafael\Documents\Graph Rag\infra\bin\llama-b11932-hip\llama-server.exe --host 127.0.0.1 --port 8099 -m C:\modelos\Qwen3.6-35B-A3B-UD-Q4_K_XL.gguf -c 32768 -np 2 -ngl 99 -ncmoe 28 -fa on -ctk q8_0 -ctv q8_0 --jinja
hip_ncmoe28_lmnone: C:\Users\Rafael\Documents\Graph Rag\infra\bin\llama-b11932-hip\llama-server.exe --host 127.0.0.1 --port 8099 -m C:\modelos\Qwen3.6-35B-A3B-UD-Q4_K_XL.gguf -c 32768 -np 2 -ngl 99 -ncmoe 28 -fa on -ctk q8_0 -ctv q8_0 --jinja -lm none
vulkan_ncmoe24: C:\Users\Rafael\Documents\Graph Rag\infra\bin\llama-b11932-vulkan\llama-server.exe --host 127.0.0.1 --port 8099 -m C:\modelos\Qwen3.6-35B-A3B-UD-Q4_K_XL.gguf -c 32768 -np 2 -ngl 99 -ncmoe 24 -fa on -ctk q8_0 -ctv q8_0 --jinja
vulkan_ncmoe24_lmnone: C:\Users\Rafael\Documents\Graph Rag\infra\bin\llama-b11932-vulkan\llama-server.exe --host 127.0.0.1 --port 8099 -m C:\modelos\Qwen3.6-35B-A3B-UD-Q4_K_XL.gguf -c 32768 -np 2 -ngl 99 -ncmoe 24 -fa on -ctk q8_0 -ctv q8_0 --jinja -lm none
vulkan_ncmoe28: C:\Users\Rafael\Documents\Graph Rag\infra\bin\llama-b11932-vulkan\llama-server.exe --host 127.0.0.1 --port 8099 -m C:\modelos\Qwen3.6-35B-A3B-UD-Q4_K_XL.gguf -c 32768 -np 2 -ngl 99 -ncmoe 28 -fa on -ctk q8_0 -ctv q8_0 --jinja
vulkan_ncmoe28_lmnone: C:\Users\Rafael\Documents\Graph Rag\infra\bin\llama-b11932-vulkan\llama-server.exe --host 127.0.0.1 --port 8099 -m C:\modelos\Qwen3.6-35B-A3B-UD-Q4_K_XL.gguf -c 32768 -np 2 -ngl 99 -ncmoe 28 -fa on -ctk q8_0 -ctv q8_0 --jinja -lm none
vulkan_ncmoe32: C:\Users\Rafael\Documents\Graph Rag\infra\bin\llama-b11932-vulkan\llama-server.exe --host 127.0.0.1 --port 8099 -m C:\modelos\Qwen3.6-35B-A3B-UD-Q4_K_XL.gguf -c 32768 -np 2 -ngl 99 -ncmoe 32 -fa on -ctk q8_0 -ctv q8_0 --jinja
vulkan_ncmoe32_cache2048: C:\Users\Rafael\Documents\Graph Rag\infra\bin\llama-b11932-vulkan\llama-server.exe --host 127.0.0.1 --port 8099 -m C:\modelos\Qwen3.6-35B-A3B-UD-Q4_K_XL.gguf -c 32768 -np 2 -ngl 99 -ncmoe 32 -fa on -ctk q8_0 -ctv q8_0 --jinja --moe-cache-mib 2048
vulkan_ncmoe32_cache2048_lmnone: C:\Users\Rafael\Documents\Graph Rag\infra\bin\llama-b11932-vulkan\llama-server.exe --host 127.0.0.1 --port 8099 -m C:\modelos\Qwen3.6-35B-A3B-UD-Q4_K_XL.gguf -c 32768 -np 2 -ngl 99 -ncmoe 32 -fa on -ctk q8_0 -ctv q8_0 --jinja --moe-cache-mib 2048 -lm none
vulkan_ncmoe40_cache4096: C:\Users\Rafael\Documents\Graph Rag\infra\bin\llama-b11932-vulkan\llama-server.exe --host 127.0.0.1 --port 8099 -m C:\modelos\Qwen3.6-35B-A3B-UD-Q4_K_XL.gguf -c 32768 -np 2 -ngl 99 -ncmoe 40 -fa on -ctk q8_0 -ctv q8_0 --jinja --moe-cache-mib 4096
vulkan_ncmoe40_cache4096_lmnone: C:\Users\Rafael\Documents\Graph Rag\infra\bin\llama-b11932-vulkan\llama-server.exe --host 127.0.0.1 --port 8099 -m C:\modelos\Qwen3.6-35B-A3B-UD-Q4_K_XL.gguf -c 32768 -np 2 -ngl 99 -ncmoe 40 -fa on -ctk q8_0 -ctv q8_0 --jinja --moe-cache-mib 4096 -lm none
vulkan_ncmoe40_cache8192: C:\Users\Rafael\Documents\Graph Rag\infra\bin\llama-b11932-vulkan\llama-server.exe --host 127.0.0.1 --port 8099 -m C:\modelos\Qwen3.6-35B-A3B-UD-Q4_K_XL.gguf -c 32768 -np 2 -ngl 99 -ncmoe 40 -fa on -ctk q8_0 -ctv q8_0 --jinja --moe-cache-mib 8192
```

### Saída bruta

Em [`ADR-010-bruto/`](ADR-010-bruto/): para cada configuração, `.cmd.txt`, `.out.txt` e `.err.txt` (log do `llama-server`), `.dois_slots.json` e `.um_slot.json` (respostas completas do `/completion`, com `timings`) e `<backend>_resumo.jsonl`.
