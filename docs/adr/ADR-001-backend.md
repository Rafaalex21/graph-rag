# ADR-001 · Backend de inferência: Vulkan × HIP

- **Estado:** aceita em 27/10/2026 e **revisada no mesmo dia** pela F0.5 (ver "Revisão"); ARQUITETURA.md na v0.3
- **Data:** 2026-10-27
- **Tarefa(s):** F0.2, F0.4, F0.5

## Contexto

A ARQUITETURA §2.2 adotava o Vulkan como padrão e o ROCm/HIP como alternativa, com base em estimativas de terceiros medidas na RX 9070 XT: Vulkan geraria tokens 12–18% mais rápido e o ROCm processaria prompt ~40% mais rápido. A F0.4 troca essas estimativas por medições nesta máquina (RX 9070, Ryzen 5 5600X, 32 GB DDR4, driver 32.0.32015.7029, llama.cpp b11932).

Regra de decisão: o HIP só vence com ganho **≥ 5%** na métrica dominante do perfil, e em empate fica o Vulkan (dispensa as wheels `rocm-sdk` de ~1,1 GB). Na versão original eu assumi que `indexar` era dominado por processamento de prompt (escolha pelo `pp2048`) e `consultar` por geração (`tg128`); a F0.5 mostrou que essa premissa estava errada para a indexação (ver "Revisão").

## Decisão

Manter **os dois builds** do llama.cpp b11932, com o **Vulkan como padrão** e o HIP apenas no juiz:

| Perfil / modelo | Backend | Base da escolha |
|---|---|---|
| `indexar` (Qwen3.6-35B-A3B) | **Vulkan** | A geração domina o tempo por chamada (~85%) e o Vulkan gera ~8% mais rápido sem mmap; no total, ~5% a 6% menos tempo (4,6 h contra 4,9 h, ADR-010). *(Revisado: era HIP.)* |
| `consultar` (Qwen3.6-35B-A3B) | **Vulkan** | `tg128` +8% sobre o HIP sem mmap (`ncmoe` 24 e 28); medições com mmap deram +7% a +10% |
| `consultar-rapido` (gpt-oss-20b) | **Vulkan** | `pp` ~4× e `tg128` +32% sobre o HIP |
| `avaliar` (juiz Gemma 4) | **HIP, provisório** | `pp` +46% a +49% e `tg128` +10%; ver ressalva de pressão de VRAM |
| `vetorizar` / reranker | a medir na F0.6 | modelos pequenos, não medidos aqui |

Consequência prática: o `llama-swap` usa **uma só entrada** para o Qwen3.6 (Vulkan) nos perfis `indexar` e `consultar`; o HIP e `infra/hip-env.ps1` servem apenas ao juiz Gemma 4. Se a reconfirmação do juiz não mostrar vantagem relevante do HIP, as wheels `rocm-sdk` (~1,1 GB) e o build HIP podem ser dispensados.

## Alternativas consideradas

- **Só Vulkan, inclusive no juiz.** É a direção natural; fica pendente só a reconfirmação do Gemma 4 com o desktop leve (HIP +46% de prompt e +10% de geração nas medições atuais).
- **HIP também no `indexar` (decisão original).** Revertida: com o carregamento sem mmap a vantagem do HIP em prompt cai de +34% a +41% para +8% a +10%, e o Vulkan gera ~8% mais rápido.
- **Ollama, vLLM:** já descartados na ARQUITETURA §2.2 e §8; esta medição não os reabre.

## Consequências

- O build HIP e o venv ROCm passam a ser opcionais: só o juiz os usa.
- A estimativa de tempo de indexação da ARQUITETURA §5.2 foi refeita duas vezes (v0.2 com mmap, v0.3 sem mmap): **~4,6 h** com o Qwen3.6 no Vulkan, como limite inferior.
- A F0.5 mediu o cache `--moe-cache-mib` e o descartou (ADR-010).
- O juiz (Gemma 4) deve ser reconfirmado com o desktop mais leve (ver ressalvas).

## Revisão (F0.5)

Duas falhas da decisão original, ambas descobertas na F0.5:

1. **Premissa errada sobre a indexação.** A ARQUITETURA v0.1 dizia que a indexação é dominada por prompt ("trechos longos entram, pouco texto sai"), e eu usei isso como regra de decisão. As contas do próprio §5.2 já indicavam o contrário: numa chamada de extração, a saída (~600 tokens a ~35 tok/s) leva ~17 s e a entrada (~2,5K tokens) leva poucos segundos.
2. **Medições com mmap.** O `llama-bench` do Qwen3.6 foi rodado com o carregamento padrão (mmap), que penaliza o prompt quando há experts na CPU. Repetido com `-lm none`, o `pp2048` sobe de 2,4× a 3,1× nos dois backends, a geração fica igual, e a vantagem do HIP em prompt cai para +8% a +10% (tabela no ADR-010).

| Perfil | Decisão original | Decisão revisada |
|---|---|---|
| `indexar` | HIP | Vulkan |
| `consultar`, `consultar-rapido` | Vulkan | Vulkan |
| `avaliar` (Gemma 4) | HIP, provisório | HIP, provisório |

As tabelas da seção "Evidência" abaixo são as da F0.4 **com mmap** e foram mantidas como registro; os números sem mmap estão no ADR-010 e nos arquivos `*_lmnone.*` de `ADR-001-bruto/`.

## Ressalvas sobre as medições

1. **VRAM do desktop.** A VRAM ocupada **antes** de cada corrida foi de 3,5 a 4,5 GB (Firefox, SignalRGB, app do Claude e o Windows), contra os ~0,8 GB que a ARQUITETURA §2.3 supõe. As corridas de gpt-oss-20b, Gemma 4 e Qwen3.6 com `--n-cpu-moe 20` chegaram a ~15,7 a 16,0 GB de pico, perto do teto da placa; o Windows pode ter movido memória de outros processos para a RAM. Esses números valem para o desktop real desta máquina, mas não são o melhor caso. **As conclusões para o Qwen3.6 com `--n-cpu-moe` ≥ 24 não são afetadas**: o pico ficou em 14,7 GB ou menos.
2. **Variância do `pp512` no Qwen3.6.** O desvio-padrão chega a ±61 tok/s, o que sugere que a primeira repetição inclui leitura do modelo do disco (mmap). Por isso a escolha do `indexar` usa o `pp2048`, mais estável (desvio de 2 a 28 tok/s).
3. **Código de saída.** O `resumo.jsonl` tem `exit` vazio por um bug do `Start-Process` no PowerShell 5.1 (corrigido em `infra/bench.ps1` depois da corrida). O sucesso de cada configuração foi verificado pela presença das três linhas de resultado (pp512, pp2048, tg128) no `.jsonl` bruto.
4. **RAM livre mínima** nos arquivos de resumo (até 49 MB) reflete o cache de arquivos do Windows (mmap do modelo), não esgotamento de memória.
5. Contexto medido: profundidade 0. A calibração com contexto de 2 × 16K é da F0.5.

## Evidência

### Ambiente

```
data: 2026-10-27T13:04:50
backend: vulkan  build: b11932
driver: 32.0.32015.7029
cpu: AMD Ryzen 5 5600X 6-Core Processor             
ram total GB: 31.9  livre GB: 15.8
vram em uso antes MB: 4530
energia: GUID do Esquema de Energia: 3ff9831b-6f80-4830-8178-736cd4229e7b  (Revision - Ultra Performance)

data: 2026-10-27T13:14:53
backend: hip  build: b11932
driver: 32.0.32015.7029
cpu: AMD Ryzen 5 5600X 6-Core Processor             
ram total GB: 31.9  livre GB: 20.1
vram em uso antes MB: 4409
energia: GUID do Esquema de Energia: 3ff9831b-6f80-4830-8178-736cd4229e7b  (Revision - Ultra Performance)
```

### Resultados com mmap, a F0.4 original (média ± desvio de 3 repetições)

"VRAM líquida" é o pico menos a VRAM em uso antes da corrida.

| Configuração | Backend | pp512 (tok/s) | pp2048 (tok/s) | tg128 (tok/s) | VRAM pico (MB) | VRAM líquida (MB) |
|---|---|---:|---:|---:|---:|---:|
| gpt-oss-20b MXFP4 (`-ngl 99`) | vulkan | 4685 ± 166 | 4402 ± 60 | 169.8 ± 0.5 | 15978 | 11465 |
| gpt-oss-20b MXFP4 (`-ngl 99`) | hip | 1107 ± 87 | 1140 ± 22 | 128.2 ± 5.0 | 15910 | 11501 |
| Gemma 4 26B-A4B QAT Q4_0 (`-ngl 99`) | vulkan | 602 ± 26 | 589 ± 2 | 49.4 ± 0.5 | 15886 | 11452 |
| Gemma 4 26B-A4B QAT Q4_0 (`-ngl 99`) | hip | 900 ± 4 | 857 ± 4 | 54.1 ± 0.3 | 16000 | 11589 |
| Qwen3.6-35B-A3B UD-Q4_K_XL (`-ngl 99 -ncmoe 20`) | vulkan | 114 ± 51 | 216 ± 2 | 39.3 ± 0.3 | 15754 | 11340 |
| Qwen3.6-35B-A3B UD-Q4_K_XL (`-ngl 99 -ncmoe 20`) | hip | 193 ± 42 | 304 ± 11 | 38.4 ± 0.7 | 15665 | 12158 |
| Qwen3.6-35B-A3B UD-Q4_K_XL (`-ngl 99 -ncmoe 24`) | vulkan | 201 ± 57 | 339 ± 14 | 37.8 ± 0.5 | 14721 | 10307 |
| Qwen3.6-35B-A3B UD-Q4_K_XL (`-ngl 99 -ncmoe 24`) | hip | 257 ± 56 | 478 ± 25 | 35.1 ± 0.1 | 14325 | 10818 |
| Qwen3.6-35B-A3B UD-Q4_K_XL (`-ngl 99 -ncmoe 28`) | vulkan | 209 ± 40 | 307 ± 2 | 34.6 ± 0.5 | 12860 | 8453 |
| Qwen3.6-35B-A3B UD-Q4_K_XL (`-ngl 99 -ncmoe 28`) | hip | 246 ± 61 | 413 ± 21 | 32.0 ± 0.1 | 12465 | 8942 |
| Qwen3.6-35B-A3B UD-Q4_K_XL (`-ngl 99 -ncmoe 32`) | vulkan | 179 ± 33 | 268 ± 8 | 32.4 ± 0.2 | 10987 | 6580 |
| Qwen3.6-35B-A3B UD-Q4_K_XL (`-ngl 99 -ncmoe 32`) | hip | 228 ± 55 | 364 ± 27 | 29.3 ± 0.1 | 10605 | 7082 |
| Qwen3.6-35B-A3B UD-Q4_K_XL (`-ngl 99 -ncmoe 40`) | vulkan | 159 ± 28 | 223 ± 6 | 27.3 ± 0.5 | 7172 | 2765 |
| Qwen3.6-35B-A3B UD-Q4_K_XL (`-ngl 99 -ncmoe 40`) | hip | 182 ± 47 | 300 ± 17 | 24.8 ± 0.8 | 6785 | 3256 |

### HIP em relação ao Vulkan

| Configuração | pp512 HIP vs Vulkan | pp2048 HIP vs Vulkan | tg128 HIP vs Vulkan |
|---|---:|---:|---:|
| gpt-oss-20b MXFP4 (`-ngl 99`) | -76% | -74% | -24% |
| Gemma 4 26B-A4B QAT Q4_0 (`-ngl 99`) | +49% | +46% | +10% |
| Qwen3.6-35B-A3B UD-Q4_K_XL (`-ngl 99 -ncmoe 20`) | +69% | +41% | -3% |
| Qwen3.6-35B-A3B UD-Q4_K_XL (`-ngl 99 -ncmoe 24`) | +28% | +41% | -7% |
| Qwen3.6-35B-A3B UD-Q4_K_XL (`-ngl 99 -ncmoe 28`) | +18% | +35% | -8% |
| Qwen3.6-35B-A3B UD-Q4_K_XL (`-ngl 99 -ncmoe 32`) | +27% | +36% | -9% |
| Qwen3.6-35B-A3B UD-Q4_K_XL (`-ngl 99 -ncmoe 40`) | +14% | +34% | -9% |

Hipóteses da ARQUITETURA, comparadas com o medido: "Vulkan gera 12–18% mais rápido" vale em parte para o Qwen3.6 (+7% a +10%) e é bem maior no gpt-oss-20b (+32%); "ROCm processa prompt ~40% mais rápido" vale para o Qwen3.6 (+34% a +41% no `pp2048`) e para o Gemma 4 (+46%), mas é o oposto no gpt-oss-20b (o Vulkan processa ~4× mais rápido). Estimativas de ~90 tok/s (gpt-oss) e ~30 tok/s (Qwen3.6) de geração ficaram abaixo do medido (170 e 38 a 39 tok/s com `--n-cpu-moe` 20); a estimativa de ~400 tok/s de prompt do Qwen3.6 ficou acima do medido no Vulkan (216 a 339 tok/s) e coerente no HIP (300 a 478 tok/s).

### Comandos

Script: `infra/bench.ps1 -Backend vulkan` e `infra/bench.ps1 -Backend hip` (o HIP carrega `infra/hip-env.ps1`). Condições fixas: `-fa 1 -ctk q8_0 -ctv q8_0 -ub 512 -t 6 -p 512,2048 -n 128 -r 3 --delay 5 -o jsonl`. Comando de cada corrida:

```
vulkan/gptoss: C:\Users\Rafael\Documents\Graph Rag\infra\bin\llama-b11932-vulkan\llama-bench.exe -m C:\modelos\gpt-oss-20b-MXFP4.gguf -ngl 99 -fa 1 -ctk q8_0 -ctv q8_0 -ub 512 -t 6 -p 512,2048 -n 128 -r 3 --delay 5 -o jsonl
vulkan/gemma4: C:\Users\Rafael\Documents\Graph Rag\infra\bin\llama-b11932-vulkan\llama-bench.exe -m C:\modelos\gemma-4-26B_q4_0-it.gguf -ngl 99 -fa 1 -ctk q8_0 -ctv q8_0 -ub 512 -t 6 -p 512,2048 -n 128 -r 3 --delay 5 -o jsonl
vulkan/qwen36_ncmoe20: C:\Users\Rafael\Documents\Graph Rag\infra\bin\llama-b11932-vulkan\llama-bench.exe -m C:\modelos\Qwen3.6-35B-A3B-UD-Q4_K_XL.gguf -ngl 99 -ncmoe 20 -fa 1 -ctk q8_0 -ctv q8_0 -ub 512 -t 6 -p 512,2048 -n 128 -r 3 --delay 5 -o jsonl
vulkan/qwen36_ncmoe24: C:\Users\Rafael\Documents\Graph Rag\infra\bin\llama-b11932-vulkan\llama-bench.exe -m C:\modelos\Qwen3.6-35B-A3B-UD-Q4_K_XL.gguf -ngl 99 -ncmoe 24 -fa 1 -ctk q8_0 -ctv q8_0 -ub 512 -t 6 -p 512,2048 -n 128 -r 3 --delay 5 -o jsonl
vulkan/qwen36_ncmoe28: C:\Users\Rafael\Documents\Graph Rag\infra\bin\llama-b11932-vulkan\llama-bench.exe -m C:\modelos\Qwen3.6-35B-A3B-UD-Q4_K_XL.gguf -ngl 99 -ncmoe 28 -fa 1 -ctk q8_0 -ctv q8_0 -ub 512 -t 6 -p 512,2048 -n 128 -r 3 --delay 5 -o jsonl
vulkan/qwen36_ncmoe32: C:\Users\Rafael\Documents\Graph Rag\infra\bin\llama-b11932-vulkan\llama-bench.exe -m C:\modelos\Qwen3.6-35B-A3B-UD-Q4_K_XL.gguf -ngl 99 -ncmoe 32 -fa 1 -ctk q8_0 -ctv q8_0 -ub 512 -t 6 -p 512,2048 -n 128 -r 3 --delay 5 -o jsonl
vulkan/qwen36_ncmoe40: C:\Users\Rafael\Documents\Graph Rag\infra\bin\llama-b11932-vulkan\llama-bench.exe -m C:\modelos\Qwen3.6-35B-A3B-UD-Q4_K_XL.gguf -ngl 99 -ncmoe 40 -fa 1 -ctk q8_0 -ctv q8_0 -ub 512 -t 6 -p 512,2048 -n 128 -r 3 --delay 5 -o jsonl
hip/gptoss: C:\Users\Rafael\Documents\Graph Rag\infra\bin\llama-b11932-hip\llama-bench.exe -m C:\modelos\gpt-oss-20b-MXFP4.gguf -ngl 99 -fa 1 -ctk q8_0 -ctv q8_0 -ub 512 -t 6 -p 512,2048 -n 128 -r 3 --delay 5 -o jsonl
hip/gemma4: C:\Users\Rafael\Documents\Graph Rag\infra\bin\llama-b11932-hip\llama-bench.exe -m C:\modelos\gemma-4-26B_q4_0-it.gguf -ngl 99 -fa 1 -ctk q8_0 -ctv q8_0 -ub 512 -t 6 -p 512,2048 -n 128 -r 3 --delay 5 -o jsonl
hip/qwen36_ncmoe20: C:\Users\Rafael\Documents\Graph Rag\infra\bin\llama-b11932-hip\llama-bench.exe -m C:\modelos\Qwen3.6-35B-A3B-UD-Q4_K_XL.gguf -ngl 99 -ncmoe 20 -fa 1 -ctk q8_0 -ctv q8_0 -ub 512 -t 6 -p 512,2048 -n 128 -r 3 --delay 5 -o jsonl
hip/qwen36_ncmoe24: C:\Users\Rafael\Documents\Graph Rag\infra\bin\llama-b11932-hip\llama-bench.exe -m C:\modelos\Qwen3.6-35B-A3B-UD-Q4_K_XL.gguf -ngl 99 -ncmoe 24 -fa 1 -ctk q8_0 -ctv q8_0 -ub 512 -t 6 -p 512,2048 -n 128 -r 3 --delay 5 -o jsonl
hip/qwen36_ncmoe28: C:\Users\Rafael\Documents\Graph Rag\infra\bin\llama-b11932-hip\llama-bench.exe -m C:\modelos\Qwen3.6-35B-A3B-UD-Q4_K_XL.gguf -ngl 99 -ncmoe 28 -fa 1 -ctk q8_0 -ctv q8_0 -ub 512 -t 6 -p 512,2048 -n 128 -r 3 --delay 5 -o jsonl
hip/qwen36_ncmoe32: C:\Users\Rafael\Documents\Graph Rag\infra\bin\llama-b11932-hip\llama-bench.exe -m C:\modelos\Qwen3.6-35B-A3B-UD-Q4_K_XL.gguf -ngl 99 -ncmoe 32 -fa 1 -ctk q8_0 -ctv q8_0 -ub 512 -t 6 -p 512,2048 -n 128 -r 3 --delay 5 -o jsonl
hip/qwen36_ncmoe40: C:\Users\Rafael\Documents\Graph Rag\infra\bin\llama-b11932-hip\llama-bench.exe -m C:\modelos\Qwen3.6-35B-A3B-UD-Q4_K_XL.gguf -ngl 99 -ncmoe 40 -fa 1 -ctk q8_0 -ctv q8_0 -ub 512 -t 6 -p 512,2048 -n 128 -r 3 --delay 5 -o jsonl
```

### Saída bruta

Em [`ADR-001-bruto/`](ADR-001-bruto/): para cada configuração, `<backend>_<config>.jsonl` (saída do `llama-bench`, uma linha por teste), `.err.txt` (log do llama.cpp), `.cmd.txt` (comando) e `<backend>_resumo.jsonl` (pico de VRAM e RAM por corrida), mais `ambiente_<backend>.txt`.
