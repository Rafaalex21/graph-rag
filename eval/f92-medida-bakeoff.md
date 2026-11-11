# F9.2: bake-off de modelos locais por papel (definição fixada ANTES de rodar)

Aceite da etapa (ETAPAS.md): "ADR com a escolha final por papel". O projeto usa modelos locais em quatro papéis: **extração** (indexação), **agente e redator** (consulta), **Text2Cypher** e **juiz** (avaliação). A F9.2 compara candidatos nos papéis em que há alternativa realista, com o mesmo código, o mesmo índice e o mesmo juiz, e registra a escolha de cada papel com a evidência.

## Escopo (decidido com o Rafael em 11/11/2026)

O escopo escolhido foi **"agente e redator + extração em amostra"**. Isso quer dizer:

| Papel | O que a F9.2 mede | Evidência usada |
|---|---|---|
| **Agente e redator** | os 3 LLMs abaixo no A6 inteiro (60 perguntas + 24 do grupo novo) | medida nova |
| **Extração** | os 3 LLMs numa amostra de 30 Pais, só métricas mecânicas | medida nova (amostra) |
| **Text2Cypher** | **não é medido de novo.** Dentro do A6 o `consultar_grafo` passa a usar o LLM do desafiante, mas a medida isolada do Text2Cypher (golden de 15 perguntas, F6.4/F6.6, F7.10) não é refeita | F6.4, F6.6 (Qwen 13/15; Gemma 3 4B 0-1/15), F7.10 (9/10 em TS) |
| **Juiz** | **não é medido de novo** | ADR-028 e ADR-030 (Gemma 4 26B-A4B, 95% de concordância em 20 correções), ADR-001 (HIP) |

Os dois últimos papéis entram no ADR apenas como "mantido, com a evidência anterior", dito assim, sem passar por medida nova.

## Candidatos

| Apelido | Modelo no llama-swap | Perfil (conjunto) | Como roda |
|---|---|---|---|
| `qwen` (incumbente) | `qwen36-35b-a3b` | `consultar` (`q & e & r`) | Vulkan, `--n-cpu-moe 28 -lm none`, sem raciocínio. Já em produção |
| `gptoss` | `gpt-oss-20b` | `consultar-rapido` (`g & e & r`) | Vulkan, `--n-cpu-moe 4 -lm none`; `reasoning_effort: low` (o que a F7.13 usou) |
| `gemma` | `gemma4-26b-a4b` (**novo**) | `consultar-gemma` (`m & e & r`, **novo**) | Vulkan, `-c 32768 -np 2 -ngl 99 --n-cpu-moe 8 -fa on -ctk q8_0 -ctv q8_0 --jinja --reasoning-budget 0` |

O Gemma 4 26B-A4B já era o juiz (perfil `avaliar`, HIP, `-c 16384`, sozinho na GPU). Para ser o LLM do agente ele precisa coexistir com o reranker na GPU, então ganhou um perfil Vulkan com parte dos experts na CPU. Os três são MoE de famílias diferentes.

### Calibração do `--n-cpu-moe` do Gemma (`infra/calibrar-gemma-agente.ps1`, `eval/resultados/f92-calibracao-gemma.jsonl`)

Gemma + reranker na GPU, o embedding na CPU, uma chamada de ~6.100 tokens (o tamanho de um prompt do redator) e 217 a 252 tokens gerados. A VRAM é o total do adaptador (desktop incluído, ~1,3 GB em repouso). **Alvo do projeto: pico abaixo de 15,0 GB.**

| `--n-cpu-moe` | VRAM pico (MB) | Geração (tok/s) | Prompt (tok/s) |
|---:|---:|---:|---:|
| 0 | 15.817 | 52,8 | 1.153 |
| 6 | 15.247 | 65,9 | 1.073 |
| 8 | **14.423** | 54,3 | 928 |
| 10 | 13.602 | 49,2 | 792 |
| 14 | 11.960 | 41,5 | 634 |

Escolhido **8**: é o menor valor medido que fica abaixo de 15,0 GB. A velocidade de geração tem ruído de execução para execução (uma chamada por valor), então a ordem 0 / 6 / 8 / 10 não é um resultado, é a calibração do limite de VRAM. **O 8 foi escolhido pela VRAM e não foi ajustado depois de ver o resultado do bake-off.**

## O que roda

`infra/rodar-f92.ps1` (retomável), nesta ordem:

1. **Sondas de VRAM:** as 8 primeiras perguntas do `golden.csv` no A6 com cada um dos 3 LLMs, com amostragem do total do adaptador a cada 3 s. Mesma carga para os três. As respostas das sondas não entram em nenhuma tabela de qualidade (`f92-sonda-<m>`).
2. **Extração:** 30 Pais sorteados (`--amostra 30 --semente 92`, mínimo de 300 tokens, sem exclusões), os mesmos para os três, cada LLM com o seu cache vazio (`data/parsed/f92_cache_<m>`) e o seu arquivo (`<doc>.f92_<m>.json`), nunca o `aberta.json` da produção. Mesmo prompt, mesmo esquema, `-np 2`, 2 em paralelo, sem *gleaning* (o padrão). Aquecimento do modelo antes de cada um (a carga fria não conta).
3. **Geração do agente (A6 inteiro, `executarCiclo` + `redigir`)** com `gptoss` e `gemma`, nas 60 perguntas do `golden.csv` (`f92-a6-<m>`) e nas 24 de `golden_novas.csv` (`f92n-a6-<m>`). A troca de LLM vale para **todo** o pipeline (atualizador, roteador, executor, Text2Cypher, panorama, crítico e redator): é uma troca do perfil `principal` só dentro da CLI de avaliação (`--modelo`); a API de produção não muda.
4. **Juiz** (Gemma 4 26B-A4B, perfil `avaliar`, como na F9.1) e métricas mecânicas, sem mudança.
5. **Tabela e regras:** `uv run python -m indexer.f92` gera `eval/resultados/f92-bakeoff.md` e `f92-extracao.json` (só contagens) **e aplica as regras abaixo**.

O **Qwen no agente reaproveita as execuções da F9.1** (`v1-a6` e `v1n-a6`: mesmo código, mesmos prompts, mesmo juiz; a única diferença é que a CLI ganhou a opção `--modelo`, cujo padrão não toca nada). Não são refeitas. O Qwen na **extração** é refeito nesta amostra, para as três terem as mesmas condições e o mesmo servidor.

## Métricas

- **Agente e redator:** as da F9.1 (§13.2): correção, fidelidade e recall de contexto (juiz); page recall, página citada, acerto numérico e latência p50/p95 (mecânicas); erros do sistema e falhas do juiz. **VRAM pico** da sonda (e da rodada completa, quando houver).
- **Extração (todas mecânicas):** validade do JSON no esquema (%), válidas na primeira chamada, chamadas por Pai, entidades e relações por Pai (nos Pais válidos), **nomes sem lastro no texto do Pai** (%) (o mesmo teste conservador da F5.x, `lastro_de_nome`), nomes repetidos, tokens de saída e segundos por Pai (só chamadas feitas).

## Regras de decisão (fixadas agora)

**Agente e redator.** Cada desafiante (`gptoss`, `gemma`) é comparado ao Qwen. Δ = correção do desafiante − correção do Qwen; **|Δ| < 0,05 é empate** (3 perguntas nas 60; 1 pergunta nas 24 vale 0,042).

- **Qualidade:** "melhor" se Δ ≥ +0,05 **nos dois grupos** (60 e 24); "pior" se Δ ≤ −0,05 **em qualquer um**; "equivalente" no resto.
- **Condições de elegibilidade (todas):**
  1. erros do sistema ≤ 3 nas 60 e ≤ 1 nas 24;
  2. falhas do juiz ≤ 3 nas 60 e ≤ 1 nas 24;
  3. fidelidade nas 60 não menor que a do Qwen menos 0,05;
  4. **página citada e acerto numérico** (as duas mecânicas) nas 60 não menores que as do Qwen menos 0,05 (contra um juiz que favoreça o próprio modelo: o Gemma é o juiz);
  5. VRAM pico da sonda **abaixo de 15,0 GB**.
- **Substitui o Qwen** se as 5 condições valem **e** (qualidade "melhor" **ou** (qualidade "equivalente" **e** latência p50 ≤ 0,7× a do Qwen **e** p95 ≤ a do Qwen)). Se os dois desafiantes cumprem, vale o de maior correção nas 60 em passos de 0,05 e, no empate, o de menor p50. Em qualquer outro caso **o Qwen fica**: o incumbente só sai com evidência a favor, não por empate.
- O desafiante que não substitui pode continuar como perfil alternativo (o `gpt-oss` já é o modo rápido da F7.13); o ADR diz isso sem que a regra decida.

**Extração.** Um desafiante só vira **candidato** a substituir o Qwen se **todas** valem, comparado ao Qwen nesta amostra:

1. validade ≥ a do Qwen;
2. nomes sem lastro ≤ o do Qwen + 2 pontos percentuais;
3. entidades por Pai ≥ 0,9× as do Qwen;
4. relações por Pai ≥ 0,9× as do Qwen;
5. segundos por Pai ≤ 0,7× os do Qwen.

**"Candidato" não é "escolhido".** Essas métricas não dizem se as entidades e relações estão certas nem completas, e trocar o LLM da extração obrigaria a reindexar o documento e a repetir a F9.1. Por isso: a **escolha final da extração é o Qwen**, a menos que um desafiante cumpra a regra, e mesmo então o ADR registra **"candidato, a validar ponta a ponta antes de reindexar"**, não uma troca.

**Aceite da F9.2:** existe o ADR-079 com a escolha por papel e a evidência de cada uma, as regras acima foram aplicadas **como estão** (sem afinar depois de ver o resultado), e todas as execuções estão contadas aqui. O aceite é o ADR com a escolha, qualquer que seja ela: manter o Qwen em tudo é um resultado válido.

## Limites já sabidos

- **Uma execução por LLM**, 60 perguntas (24 no grupo novo, que vale 0,042 por pergunta): a variância do LLM de resposta e do juiz não é medida. Diferença menor que 0,05 é empate.
- **O Gemma é juiz e candidato ao mesmo tempo** (viés de autopreferência possível). O juiz já julga o Qwen e o gpt-oss de outra família, mas aqui julgaria o próprio texto. A condição 4 usa métricas mecânicas contra isso, **sem eliminar** o risco: se o Gemma "ganhar" só no juiz, a leitura é cautelosa.
- A latência de cada LLM vem de configurações de VRAM e de camadas na CPU diferentes (`--n-cpu-moe` 28, 4 e 8): é o desempenho **do perfil**, não do modelo "em si".
- **A extração mede forma e custo, não acerto:** não há gabarito de entidades, e o lastro de nome é um teste conservador (deixa passar entidade com nome certo e descrição inventada). A amostra de 30 Pais é uma semente só; o prompt de extração foi ajustado em Pais do mesmo documento (F5.x) com o Qwen, o que favorece o incumbente.
- O Text2Cypher e o juiz **não são medidos de novo** aqui (ver o escopo). Dentro do A6 o Text2Cypher do desafiante é usado, mas não é isolado.
- A VRAM é o total do adaptador (desktop incluído); o pico depende do que o Windows estiver usando na hora.
- O `gpt-oss-20b` com saída restrita por gramática (`response_format` json_schema) na extração é uma combinação não testada antes neste projeto; se falhar, a falha entra na tabela como saiu.
- Golden e rótulos do juiz são do Claude (ADR-027, ADR-030); o N01 segue marcado incorreto pelo juiz embora correto por decisão do Rafael.

## Reprodução

```powershell
# serviços no ar: .\infra\neo4j.ps1 iniciar ; .\infra\swap.ps1   (swap em outra janela)
.\infra\calibrar-gemma-agente.ps1                 # calibração do --n-cpu-moe (sem o swap; usa a porta 8099)
.\infra\rodar-f92.ps1                             # sondas, extração, geração, juiz e tabela (~7 h de GPU)
cd indexer; uv run python -m indexer.f92          # só a tabela e as regras, sem LLM
```

## Execuções (toda execução é contada)

**Calibração do `--n-cpu-moe`:** 4 execuções do `infra/calibrar-gemma-agente.ps1`. As 2 primeiras não deram dado por defeito meu no script (o texto lido do arquivo ia ao `/tokenize` como objeto e o servidor devolveu 400 nos 4 valores; conserto: converter para `string`; o arquivo de saída dessas duas, só com erros, foi apagado). A terceira mediu 0, 6, 10 e 14; a quarta mediu o 8 sozinho. Valor usado: 8.

**Da medida** (uma execução por item, nenhuma refeita; roteiro `infra/rodar-f92.ps1` iniciado em 11/11 às 10:03 e terminado às 13:33, sem pausa):

| Item | Relatório / arquivo | Perguntas ou Pais | Erros do sistema | Falhas do juiz |
|---|---|---:|---:|---:|
| Sondas de VRAM (A6, 8 perguntas) | `f92-sonda-qwen`, `-gptoss`, `-gemma` (só `data/`) | 8 cada | 0 | não julgadas |
| Extração | `<doc>.f92_qwen.json`, `.f92_gptoss.json`, `.f92_gemma.json` | 30 cada | 0 inválidas | n/a |
| Agente, golden | `f92-a6-gptoss`, `f92-a6-gemma` | 60 cada | 0 | 0 |
| Agente, grupo novo | `f92n-a6-gptoss`, `f92n-a6-gemma` | 24 cada | 0 | 0 |

O Qwen no agente é `v1-a6` e `v1n-a6` (F9.1), não refeitas. Resultados e a aplicação das regras: `eval/resultados/f92-bakeoff.md`; leitura: ADR-079.

**Defeitos de infraestrutura meus, sem efeito nos resultados de qualidade:**

1. O agregador de picos de VRAM do roteiro (`$arq | Get-Content`) falhou em tudo e gravou `null` em `f92-vram.json`; o passo final `tabela` saiu com código 1 por isso. Os CSVs de amostragem (a cada 3 s) estavam íntegros: o `f92-vram.json` foi regerado a partir deles com Python (máximo de cada CSV) e o roteiro foi corrigido (`Get-Content -LiteralPath`). Picos: sonda 11.699 / 12.887 / 14.775 MB (Qwen / gpt-oss / Gemma); rodada completa 12.995 (gpt-oss) e 15.004 MB (Gemma).
2. O Qwen não teve rodada completa amostrada (reaproveita a F9.1), por isso a coluna de rodada completa dele é n/a.

## Resultado por item do aceite

- **Regras aplicadas como fixadas:** sim. Agente: nenhum desafiante substitui o Qwen (gpt-oss equivalente e mais rápido, mas falha página citada e acerto numérico; Gemma pior nas 60 e também falha as duas). Extração: nenhum candidato (entidades e relações por Pai abaixo de 90% do Qwen).
- **ADR-079 com a escolha por papel e a evidência:** sim. Escolha: Qwen3.6 em extração, agente e redator e Text2Cypher; Gemma 4 (HIP) no juiz; os dois últimos citam evidência anterior, sem medida nova.
- **Todas as execuções contadas:** sim (esta seção).

