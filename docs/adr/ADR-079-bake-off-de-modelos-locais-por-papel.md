# ADR-079 · Bake-off de modelos locais por papel: o Qwen3.6 fica em todos

- **Estado:** aceita (11/11/2026); regras de `eval/f92-medida-bakeoff.md` aplicadas como estavam
- **Data:** 2026-11-11
- **Tarefa(s):** F9.2

## Contexto

O projeto usa modelos locais em quatro papéis: extração, agente e redator, Text2Cypher e juiz. A F9.2 pergunta, com a evidência medida, se algum desafiante merece tirar o Qwen3.6-35B-A3B de algum deles. Escopo escolhido pelo Rafael: **agente e redator** (A6 inteiro, 60 perguntas do golden e 24 do grupo novo) e **extração em amostra** (30 Pais), com três LLMs; Text2Cypher e juiz **não foram medidos de novo**. Definição, regras de decisão e limites foram commitadas **antes** de rodar (commit 393b62e) e nada foi afinado depois.

## Decisão (escolha final por papel)

| Papel | Escolha | Base |
|---|---|---|
| **Agente e redator** | **Qwen3.6-35B-A3B** (sem mudança) | nenhum desafiante cumpriu a regra (abaixo) |
| **Extração** | **Qwen3.6-35B-A3B** (sem mudança) | nenhum desafiante cumpriu a regra; amostra só mecânica |
| **Text2Cypher** | **Qwen3.6-35B-A3B** (sem mudança) | **evidência anterior, não refeita**: F6.4 (90%), F6.6 (Gemma 3 4B 0-1/15 contra Qwen 13/15), F7.10 (9/10 em TS) |
| **Juiz** | **Gemma 4 26B-A4B, perfil `avaliar` (HIP)** (sem mudança) | **evidência anterior, não refeita**: ADR-028, ADR-030 (95% de concordância em 20), ADR-001 |

O gpt-oss-20b continua como **modo rápido** (F7.13), sem mudança. O perfil Vulkan do Gemma 4 como LLM do agente (`consultar-gemma`, `--n-cpu-moe 8`) fica no `infra/llama-swap.yaml` só para a avaliação; a API de produção não o usa.

## Resultado

### Agente e redator (A6 inteiro, mesmo código e mesmo juiz; Qwen = execuções da F9.1)

| LLM | Correção (60) | Correção (24 novas) | Página citada (60) | Acerto numérico (60) | Latência p50 / p95 (60, s) | VRAM pico (sonda / rodada completa, GB) |
|---|---:|---:|---:|---:|---:|---:|
| Qwen3.6-35B-A3B | 0,59 | 0,46 | 0,60 | 0,48 | 22,9 / 111,6 | 11,7 / n/a |
| gpt-oss-20b | 0,58 | 0,42 | 0,47 | 0,38 | 10,5 / 19,3 | 12,9 / 13,0 |
| Gemma 4 26B-A4B | 0,53 | 0,50 | 0,47 | 0,29 | 12,3 / 43,4 | 14,8 / 15,0 |

Erros do sistema: 0 em todas as execuções. Falhas do juiz: 0. Fidelidade: 0,97 nos três nas 60.

- **gpt-oss-20b:** qualidade **equivalente** (Δ −0,01 nas 60 e −0,04 nas 24, ambos dentro do empate) e **mais rápido** (p50 10,5 s contra 22,9; p95 19,3 s contra 111,6). Mas **falha duas condições de elegibilidade**: página citada 0,47 contra 0,60 e acerto numérico 0,38 contra 0,48, ambos mais de 0,05 abaixo do Qwen. Pela regra, **não substitui**.
- **Gemma 4 26B-A4B:** Δ −0,06 nas 60 (**pior** pela regra, que olha qualquer um dos grupos) e **+0,04 nas 24** (empate). Também falha página citada (0,47) e acerto numérico (0,29, o mais baixo). A fraqueza está em agregação (0,00 contra 0,20) e temática global (0,60 contra 0,75). **Não substitui.**
- Nenhum bate o Qwen nas duas métricas mecânicas, que a regra pôs de propósito para o caso de o Gemma, que é o juiz, ser favorecido. Aqui ele não foi: o juiz o nota abaixo do Qwen nas 60.
- **Custo da escolha:** o Qwen é o mais lento (p95 de 111,6 s, com uma pergunta de 209 s). O RNF-2 segue em aberto, como na F9.1. Quem precisa de rapidez tem o modo rápido (gpt-oss), com perda medida em citação de página e em números.

### Extração aberta (30 Pais, mesma amostra, cache limpo; todas mecânicas)

| LLM | Válidas | Entidades/Pai | Relações/Pai | Nomes sem lastro | Segundos/Pai |
|---|---:|---:|---:|---:|---:|
| Qwen3.6-35B-A3B | 30/30 | 12,67 | 10,53 | 7,1% | 59,1 |
| gpt-oss-20b | 30/30 (26 na 1ª) | 11,17 | 8,97 | 8,4% | 28,6 |
| Gemma 4 26B-A4B | 30/30 | 11,27 | 6,90 | 5,6% | 30,5 |

Os dois desafiantes são **cerca da metade do tempo** do Qwen (que roda com 28 camadas de experts na CPU) e têm lastro de nome parecido, mas **extraem menos**: entidades por Pai em 88% e 89% do Qwen (a regra pede 90%), relações em 85% e 66%. Ficam de fora pela regra; o gpt-oss por pouco nas entidades. Como a medida não diz se as entidades e relações estão certas, "extrair menos" pode ser tanto perda quanto menos ruído: **não se sabe**.

## Alternativas consideradas

- **Trocar o agente para o gpt-oss pela velocidade:** a regra pedia qualidade equivalente **e** as duas métricas mecânicas; ele perde 0,13 em página citada. Seria uma troca de página citada por tempo, decisão que o Rafael pode tomar com os números acima, mas que a regra pré-registrada não toma.
- **Medir Text2Cypher e juiz de novo:** fora do escopo escolhido.
- **Ajustar o Gemma (mais camadas na GPU, outro contexto):** não; o `--n-cpu-moe 8` foi escolhido pela VRAM antes da medida e a mudança depois de ver o resultado seria afinar sobre o teste.

## Consequências e ressalvas

- **Uma execução por LLM**, 60 perguntas (24 no grupo novo, 1 pergunta = 0,042): variância do LLM e do juiz não medida; diferença menor que 0,05 é empate. O Δ do Gemma nas 60 (−0,06) é de 3,6 perguntas e o das 24 foi para o outro lado.
- **O Gemma julga a si mesmo:** possível viés de autopreferência; o resultado dele não foi favorecido, mas o risco não foi eliminado.
- **A VRAM da rodada completa do Gemma tocou 15.004 MB**, 4 MB acima do alvo de 15,0 GB (a regra olhava a sonda, 14.775 MB, que passa). É ruído de desktop, mas mostra que o perfil está no limite; o resultado não muda, porque ele já fica de fora por qualidade e citação.
- **Latência por perfil:** compara o Qwen (`--n-cpu-moe 28`), o gpt-oss (4) e o Gemma (8), não os modelos em si.
- **Extração:** só forma e custo, uma semente, prompt ajustado com o Qwen. Trocar o LLM da extração exigiria reindexar e repetir a F9.1; **nenhum candidato passou**, então nada disso é necessário.
- **A causa da queda em página citada** do gpt-oss e do Gemma, e a de agregação 0,00 do Gemma, **não foram investigadas**.

## Evidência

`eval/resultados/f92-bakeoff.md` (gerado por `uv run python -m indexer.f92`, que também aplica as regras), `f92-extracao.json` (só contagens, ADR-009), `f92-vram.json`, `f92-calibracao-gemma.jsonl` e os relatórios `f92-a6-*`, `f92n-a6-*` em `eval/resultados/`; respostas e notas do juiz ficam em `data/avaliacao/`, fora do git. Medida e trilha de execuções em `eval/f92-medida-bakeoff.md`.

Reproduzir (Neo4j e llama-swap no ar; ~3,5 h de GPU a partir do perfil calibrado): `.\infra\rodar-f92.ps1`.
