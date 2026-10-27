# ADR-001 · Backend de inferência: Vulkan × HIP

- **Estado:** proposta (aguarda revisão das correções da ARQUITETURA.md listadas abaixo)
- **Data:** 2026-10-27
- **Tarefa(s):** F0.2, F0.4

## Contexto

A ARQUITETURA §2.2 adotava o Vulkan como padrão e o ROCm/HIP como alternativa, com base em estimativas de terceiros medidas na RX 9070 XT: Vulkan geraria tokens 12–18% mais rápido e o ROCm processaria prompt ~40% mais rápido. A F0.4 troca essas estimativas por medições nesta máquina (RX 9070, Ryzen 5 5600X, 32 GB DDR4, driver 32.0.32015.7029, llama.cpp b11932).

Regra de decisão, definida antes de ver os números: `indexar` é dominado por processamento de prompt (escolhe-se pelo `pp2048` do Qwen3.6); `consultar` é dominado por geração (escolhe-se pelo `tg128`); o HIP só vence com ganho **≥ 5%** na métrica dominante, e em empate fica o Vulkan (dispensa as wheels `rocm-sdk` de ~1,1 GB).

## Decisão

Manter **os dois builds** do llama.cpp b11932 e escolher o backend por perfil do `llama-swap`:

| Perfil / modelo | Backend | Base da escolha |
|---|---|---|
| `indexar` (Qwen3.6-35B-A3B) | **HIP** | `pp2048` +34% a +41% sobre o Vulkan em todos os `--n-cpu-moe` medidos |
| `consultar` (Qwen3.6-35B-A3B) | **Vulkan** | `tg128` +7% a +10% sobre o HIP com `--n-cpu-moe` 24 a 40 (em 20 o ganho é de 3%, abaixo do limite, e o empate fica com o Vulkan) |
| `consultar-rapido` (gpt-oss-20b) | **Vulkan** | `pp` ~4× e `tg128` +32% sobre o HIP |
| `avaliar` (juiz Gemma 4) | **HIP, provisório** | `pp` +46% a +49% e `tg128` +10%; ver ressalva de pressão de VRAM |
| `vetorizar` / reranker | a medir na F0.6 | modelos pequenos, não medidos aqui |

Consequência prática: o `llama-swap` terá entradas separadas para o mesmo arquivo do Qwen3.6 (uma com o `llama-server` Vulkan, outra com o HIP), e o HIP exige `infra/hip-env.ps1` no ambiente do processo.

## Alternativas consideradas

- **Só Vulkan (padrão original da ARQUITETURA).** Mais simples, mas abre mão de +34% a +41% de processamento de prompt na indexação, a etapa de várias horas.
- **Só HIP.** Perde 7% a 10% de geração no Qwen3.6 e, no gpt-oss-20b, 4× de prompt e 32% de geração.
- **Ollama, vLLM:** já descartados na ARQUITETURA §2.2 e §8; esta medição não os reabre.

## Consequências

- O perfil `indexar` ganha tempo de prompt, mas depende do venv ROCm local e de uma cópia extra do `llama-server`.
- A estimativa de tempo de indexação da ARQUITETURA §5.2 (hipóteses de ~400 tok/s de prompt e ~30 tok/s de geração) precisa ser refeita com os números medidos aqui (`pp2048` de 304 a 478 tok/s no HIP, `tg128` de 25 a 38 tok/s).
- A F0.5 (calibração do `--n-cpu-moe`) deve medir também o cache `--moe-cache-mib` do llama.cpp v0.7.0, que o `llama-bench` não expõe.
- O juiz (Gemma 4) deve ser reconfirmado com o desktop mais leve (ver ressalvas).

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

### Resultados (média ± desvio de 3 repetições)

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
