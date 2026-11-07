# eval/

Avaliação do GraphRAG (ARQUITETURA §13, fase F3). Tudo aqui mede contra o **Formulário de Referência 2026 do Banco do Brasil (v7)**; as páginas são as **físicas** do PDF (as mesmas do pdf.js), não as impressas.

| Arquivo | O que é |
|---|---|
| `golden.csv` | Golden set da F3.1: 60 perguntas com gabarito, páginas e rota esperada (colunas abaixo) |
| `validar_golden.py` | Valida o `golden.csv` e **confere cada gabarito contra o texto do PDF original** |
| `golden_entidades.csv` | 10 perguntas "quem é / o que é" da F6.1, escritas **depois** de a busca local estar ajustada e conferidas contra o PDF (mesmas colunas do `golden.csv`, ids `E01`–`E10`, rota `entidade`); servem de conjunto separado, porque as três perguntas "quem é…" do golden foram as que orientaram o ajuste. Não fazem parte dos 60 do golden set |
| `golden_agregacao.csv` | 15 perguntas de agregação **respondíveis pelo grafo** (AG01–AG15; AG01 = G03 e AG02 = G07) da F6.4, com valor, páginas e o `cypher_gabarito` que o teste de contrato executa no grafo real; `grupo` é `ajuste` (5, usadas para iterar o prompt do Text2Cypher) ou `teste` (10, o número do aceite). Traz também as 8 perguntas oficiais de agregação que o grafo não responde, com `grupo = fora` e o motivo (dívidas de extração). Na F7.10 as 23 perguntas servem à paridade do prompt do Text2Cypher entre Python e TypeScript e as 15 de `ajuste` e `teste` à acurácia de `consultar_grafo`: `npm run avaliar:consultar` (em `api/`, com Neo4j e llama-swap no ar); o relatório é `resultados/f710-consultar.json` |
| `golden_decomposicao.json` | 38 casos do atualizador de pergunta (F7.2): `composta`, `simples` (não se decompõe) e `seguimento` (com histórico). Cada caso traz os termos que cada subpergunta esperada deve cobrir (`a\|b` = alternativas), as dependências e os termos proibidos. `grupo`: `ajuste` (9, para escrever o prompt), `teste` (20, o número do aceite) e `teste2` (9, escrito depois da correção do prompt). Medida: `npm run avaliar:decomposicao -- --grupo teste` (em `api/`) |
| `paridade_templates.json` | 54 chamadas dos 6 templates Cypher (fato, série, comparar, riscos, eventos, pessoas; 9 são erros esperados) para comparar o Python (F6.3) com o TypeScript (F7.8) no grafo real. Só parâmetros, sem trecho do documento. Medida: `npm run avaliar:paridade` (em `api/`, com o Neo4j no ar); o relatório é `resultados/f78-paridade.json` |
| `paridade_busca.json` | 12 nomes de entidade (e um inexistente) para comparar `indexer.busca_local` (F6.1) com `entidade` em TypeScript (F7.9); as perguntas de `buscar_trechos` e `buscar_tabelas` vêm do `golden.csv`. Só nomes, sem trecho do documento. Medida: `npm run avaliar:busca` (em `api/`, com Neo4j e llama-swap no ar); o relatório é `resultados/f79-busca.json` |
| `golden_rotas.json` | 100 casos do roteador (F7.3): os 60 do golden com a `rota_esperada` literal e `aceitas` (rotas que cobrem a pergunta de verdade, fixadas antes de medir; vazio em `varias`), mais 40 novas. `grupo`: `ajuste` (20, para escrever o prompt), `teste` (40), `teste2` (20) e `teste3` (20), cada um escrito depois do ajuste que o anterior orientou. Medida: `npm run avaliar:rotas -- --grupo teste3` (em `api/`); o relatório traz o critério estrito e o aceito |
| `fumaca_f2_9.json` | 5 perguntas de fumaça do `ask` (F2.9); não é o golden set |
| `perguntas_latencia.txt` | 20 perguntas sem gabarito, só para medir latência (F2.5) |
| `calibracao_juiz.csv` | Os 20 rótulos de correção da F3.4 (`c`/`p`/`i`) e quem os deu; a planilha de leitura fica em `data/avaliacao/` |
| `resultados/` | Um relatório por execução (`<nome>.json`, sem texto do documento): métricas do juiz (F3.2), page recall@k, acerto numérico e latência (F3.3), no geral, no recorte e por categoria, e a nota de cada pergunta |
| `resultados/f711-agente-v1.json`, `-v2.json`, `-v3.json` | Medida do agente da F7.11 nas 60 perguntas (`npm run avaliar:agente` em `api/`, com Neo4j e llama-swap no ar): execução sem erro de infraestrutura, rota, tempo por etapa e page recall @1/@3/@6 contra o Python (`f79-busca.json`). A v1 é a medida pré-registrada; a v2 (`--complementar`) e a v3 (padrão atual do agente) são pós-hoc. Só ids, números e nomes de ferramenta (ADR-009); as saídas completas ficam em `data/avaliacao/` |
| `resultados/v0.md` | A tabela da escada de ablações A0 a A3r (F3.5, ADR-031), só nas perguntas com `no_recorte` = sim; gerada por `python -m indexer.tabela` |

## Colunas do `golden.csv`

| Coluna | Significado |
|---|---|
| `id` | `T` textual, `N` numérica, `G` agregação/filtro, `P` temática/global, `M` multi-hop, `F` fora do escopo |
| `categoria` | uma das 6 da §13.1 (15 / 15 / 10 / 10 / 5 / 5) |
| `pergunta`, `gabarito` | a pergunta e a resposta esperada em texto |
| `tipo_gabarito` | `texto`, `valor`, `lista` (com `pontos_chave`) ou `recusa` (o certo é dizer que não consta) |
| `valor`, `unidade` | só em `valor`: número já normalizado (ponto decimal, sinal aplicado) e a unidade; o acerto numérico da F3.3 usa tolerância de 0,5% |
| `paginas` | páginas físicas da evidência, separadas por `\|` (vazio nas perguntas fora do escopo) |
| `rota_esperada` | ferramenta esperada do roteador (§7.2): `buscar_trechos`, `buscar_tabelas`, `fato_financeiro`, `entidade`, `consultar_grafo`, `panorama`, `varias` ou `nenhuma` |
| `no_recorte` | `sim` se **toda** a evidência está nas 79 páginas do recorte (F1.2); até a F5.8 só estas têm resposta possível |
| `pontos_chave` | itens que uma boa resposta deve cobrir (listas e temáticas), separados por `\|` |
| `evidencia` | regex (ou várias, separadas por ` && `) que tem de casar no texto das páginas citadas; é como o gabarito é conferido |
| `ausencia` | regex que **não** pode casar em nenhuma página (perguntas sem resposta no documento) |
| `cypher_gabarito` | reservado: o Cypher das perguntas de agregação será acrescentado quando o esquema do grafo existir (F4) |
| `observacao` | ressalvas sobre o gabarito |

## Conferir o gabarito

O PDF fica fora do git (`data/raw/`); o `pypdfium2` vem de uma execução efêmera:

```powershell
uv run --no-project --with pypdfium2 python -I eval/validar_golden.py
```

A estrutura (colunas, distribuição, rotas, `no_recorte` contra o mapa do recorte) também é testada na integração contínua (`indexer/tests/test_golden.py`), que não precisa do PDF.
