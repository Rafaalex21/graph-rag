# ADR-028 · Métricas com o juiz local: recall de contexto, fidelidade e correção

- **Estado:** aceita (28/10/2026)
- **Data:** 2026-10-28
- **Tarefa(s):** F3.2

## Contexto

O aceite da F3.2 é: as três métricas rodam no golden set inteiro, sem intervenção. O juiz é o Gemma 4 26B-A4B no HIP (perfil `avaliar`, [ADR-011](./ADR-011-perfis-swap.md)), com temperatura 0 e saída em JSON estrito. RAGAS ficou de fora (opcional na tarefa): o harness próprio usa os prompts do cap. 8 e não depende de outro cliente de LLM.

## Decisão

1. **Módulo `indexer/src/indexer/avaliar.py`**, com a CLI `python -m indexer.avaliar executar --nome N [--so-recorte] [--limite K] [--modo ...]`. Duas fases, ambas **retomáveis** (arquivo `.jsonl` com uma linha por item; uma nova execução pula o que já existe):
   - `gerar`: roda o `ask` em cada pergunta e guarda resposta, citações e **o contexto que o LLM de fato viu** (`ask.responder` passou a devolver `contexto`);
   - `julgar`: três chamadas ao juiz por pergunta.
2. **Definições das métricas**
   - *Recall de contexto* = fração das afirmações do gabarito que o contexto entregue sustenta. Perguntas de recusa esperada (fora do escopo) não têm recall (`n = 0`).
   - *Fidelidade* = fração das afirmações da resposta sustentadas pelo contexto. Uma recusa não afirma nada: vale 1,0 e é contada à parte (`sem_afirmacoes_na_fidelidade`), para não inflar a média sem aviso.
   - *Correção* = veredito `correta` (1), `parcial` (0,5) ou `incorreta` (0) contra o gabarito. Para pergunta fora do escopo, a recusa é a resposta correta (`TEXTO_RECUSA` no prompt).
3. **Falha do juiz não derruba a rodada:** `_chamar` tenta de novo uma vez e, se falhar, grava `falha_do_juiz` e o item sai da média (contado em `falhas_do_juiz`). Erro do sistema avaliado idem (`erros_do_sistema`).
4. **Orçamento de raciocínio do juiz de 512 tokens** (`--reasoning-budget 512` em `infra/llama-swap.yaml`, espelhado na ARQUITETURA §9, matriz e §13.2). Sem o limite o juiz levava **≈ 53 s por chamada**; com ele, **17,7 s** (319 s em 18 chamadas). Chamadas em paralelo não ganharam nada (uma só GPU).
5. **Saídas:** `data/avaliacao/<nome>/` (ignorado pelo git: contém texto do documento) e `eval/resultados/<nome>.json` (só notas), que é o que se versiona.

## Verificação do aceite da F3.2

Comando: `uv run python -m indexer.avaliar executar --nome f3-2-a3-60` (modo padrão da CLI `ask`, índice do recorte de 79 páginas, sem intervenção). Evidência em [`ADR-028-bruto/`](./ADR-028-bruto/): `f3-2-a3-60.json` (agregado) e `notas_por_pergunta.json` (três notas por pergunta, sem texto do documento).

| Critério | Resultado |
|---|---|
| As três métricas no golden set inteiro | **60 perguntas**; `falhas_do_juiz` = 0, `erros_do_sistema` = 0; 175 chamadas ao juiz com uso medido e 5 itens sem recall (fora do escopo) |
| Sem intervenção | uma única execução, 71 min no total: ≈ 5,5 min de geração (5,5 s por pergunta) e ≈ 65 min de juiz (≈ 102 mil tokens gerados) |

### Resultado (A3, recorte de 79 páginas)

| Categoria | Recall de contexto | Fidelidade | Correção |
|---|---:|---:|---:|
| Factual textual (15) | 0,80 | 1,00 | 0,80 |
| Numérica (15) | 0,33 | 1,00 | 0,20 |
| Agregação e filtro (10) | 0,03 | 1,00 | 0,00 |
| Temática/global (10) | 0,93 | 1,00 | 0,95 |
| Multi-hop (5) | 0,53 | 1,00 | 0,40 |
| Fora do escopo (5) | n/a | 1,00 | 1,00 |
| **Geral (60)** | **0,53** (n = 55) | **1,00** | **0,53** |
| Só `no_recorte` = sim (54) | 0,55 (n = 49) | 1,00 | 0,55 |

Leitura (o diagnóstico fino é da F3.5, não desta tarefa):

- O sistema **recusou 31 das 60 perguntas** (11 numéricas, 10 de agregação, 4 fora do escopo, 3 factuais e 3 multi-hop). As 10 de agregação e a maioria das numéricas são as que dependem de **tabelas e do grafo**, ainda não integrados ao `ask` (tabelas na F2.7 só no índice; grafo na F4). Por isso a correção em agregação é 0,00 e o baseline A3 fica em 0,53: é o piso a superar, não um defeito do harness.
- **Fidelidade 1,00** em todas as categorias: 32 das 60 perguntas não têm afirmação a avaliar (recusa), e nas outras 28 o juiz não achou afirmação sem suporte. Com tantas recusas, esse número ainda **não discrimina**; a F3.4 mede o quanto o juiz erra para os dois lados.

## Consequências e ressalvas

- O juiz com orçamento de 512 tokens foi checado em **9 casos** (6 respostas sintéticas com veredito esperado, 6/6 certos, mais 3 perguntas reais) e agora nas 60. A concordância com rótulos humanos só vem na **F3.4** (meta ≥ 80%); até lá as notas são indicativas.
- Memória de vídeo com o juiz carregado: **15.973 MiB** no total, sobrando ≈ 400 MiB. Reduzir o contexto do juiz ou quantizar o KV (q8_0) não foi testado.
- O golden set foi redigido por quem construiu o sistema ([ADR-027](./ADR-027-golden-set.md)); a revisão humana continua recomendada.
- Os 6 itens com `no_recorte` = não só entram na F9.1; a F5.8 precisa refazer a medição com o documento inteiro.
