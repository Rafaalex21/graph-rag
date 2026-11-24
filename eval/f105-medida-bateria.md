# F10.5: bateria final de precisão (definição fixada ANTES de escrever as perguntas)

Pedido do dono em 24/11/2026: fechar a F10 com uma bateria de perguntas maior que as 24 do grupo novo, publicar o resultado no README e usá-lo num post no LinkedIn (publicado por ele). Esta etapa **mede**; não tem meta a cumprir, e o número vai para o README qualquer que seja.

## O conjunto: 150 perguntas novas (`eval/golden_f105.csv`)

Mesmas colunas de `eval/golden.csv`. Mesma proporção de categorias das 60:

| Categoria | Perguntas |
|---|---:|
| factual_textual | 38 |
| numerica | 38 |
| agregacao_filtro | 25 |
| tematica_global | 25 |
| multi_hop | 12 |
| fora_do_escopo | 12 |
| **total** | **150** |

### Sorteio das páginas (para não escolher as fáceis)

- **Universo:** páginas do PDF (1 a 423) com pelo menos 400 caracteres de texto ou ao menos uma tabela, **menos** as páginas que são gabarito de qualquer pergunta já existente (`golden.csv`, `golden_novas.csv`, `golden_agregacao.csv`, `golden_entidades.csv`). Assim nenhuma pergunta nova cai numa página em que o sistema já foi ajustado.
- **Sorteio:** `uv run python -m indexer.f105 sortear` (semente fixa 105) embaralha o universo e embaralha a lista de 138 categorias (as 150 menos as 12 fora do escopo). A i-ésima categoria recebe a próxima página da fila. A multi-hop recebe **duas** páginas seguidas da fila. A lista sai em `eval/f105-sorteio.json` e entra no mesmo commit desta medida.
- **Página que não serve para a categoria sorteada** (ex.: numérica numa página só de texto; multi-hop sem ligação real entre as duas páginas): a categoria pega a próxima página da fila, e a página pulada volta para o fim da fila. Cada pulo fica registrado no sorteio, com o motivo.
- **Temática:** a página sorteada define o tema (a seção dela). A pergunta pede um panorama desse tema, e o gabarito traz os pontos-chave com as páginas.
- **Fora do escopo (12):** escritas sem sorteio, cobrindo os mesmos tipos das 60: outra empresa, cotação, previsão, conselho de investimento, conhecimento geral e dado posterior ao documento.

### Regras de escrita

- Escrevo eu (Claude), lendo a página pelo texto e pelas tabelas em Markdown do documento indexado (v7). O leitor de páginas (`indexer.f105 pagina N`) **não mostra** a descrição nem as perguntas que o LLM gerou para cada tabela na indexação, que entram no índice e dariam vantagem ao sistema.
- Cada pergunta tem: gabarito, página(s), evidência (trecho curto que sustenta o gabarito) e, nas numéricas, valor e unidade.
- Pergunta em português natural, como um analista perguntaria, sem copiar a frase do documento.
- **Nenhuma pergunta é rodada no sistema antes do congelamento.** O congelamento é um commit com o sha256 de `eval/golden_f105.csv` anotado aqui. Depois dele, o CSV não muda.
- **Gabarito errado achado depois:** não se edita o congelado. Uma errata lista a pergunta e o conserto, e o relatório mostra os dois números, o congelado e o corrigido.

## A medida

- **Degraus:** **A3**, a busca vetorial com documento-pai e reranker, a linha de base (Python, `indexer.avaliar --degrau a3`), e **A6**, o agente completo (`npm run avaliar:ablacao -- --degrau a6`). O código, os modelos e o índice são os da v1 (`v1.0.0`), e o juiz é o mesmo, Gemma 4 26B-A4B (ADR-028 e ADR-030). Uma execução de cada.
- **Métricas:** as da v1: correção, fidelidade, recall de contexto, page recall@1/@6, página citada, acerto numérico e latência p50/p95.
- **Incerteza:**
  - IC de 95% por *bootstrap* (10.000 reamostragens das perguntas, semente 105) para a correção, a página citada e o acerto numérico de cada degrau;
  - IC da diferença A6 − A3 por *bootstrap* pareado (as mesmas perguntas nos dois degraus).
  - Por categoria, só a média: com 12 a 38 perguntas, o intervalo é largo e é mostrado como tal.
- **Comparação com a v1:** lado a lado com as 60 e as 24, sem misturar os conjuntos.
- **Rodada inválida:** se mais de 5% das perguntas tiverem erro do sistema ou falha do juiz (infraestrutura, como HTTP 500/502), a rodada é refeita e contada, e as perguntas não mudam. Abaixo de 5%, essas perguntas contam como zero e são listadas.
- **Relatório:** `eval/resultados/f105-bateria.md`, gerado por `uv run python -m indexer.f105 relatorio`, sem LLM.

## Ressalvas já sabidas

- As perguntas e os rótulos de calibração do juiz são do Claude, não de um especialista no documento. O sorteio de páginas tira a escolha das páginas, não a do texto da pergunta.
- Uma execução por degrau: a variância do Qwen (temperatura 0,2) e do juiz não é medida. O IC por bootstrap mede a incerteza da amostra de perguntas, não a do modelo.
- Mesma máquina e mesmo índice da v1. A latência vale para esta máquina.

## Execuções (toda rodada é contada)

| Rodada | Degrau | Início | Resultado | Notas |
|---|---|---|---|---|
