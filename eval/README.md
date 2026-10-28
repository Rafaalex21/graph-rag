# eval/

Avaliação do GraphRAG (ARQUITETURA §13, fase F3). Tudo aqui mede contra o **Formulário de Referência 2026 do Banco do Brasil (v7)**; as páginas são as **físicas** do PDF (as mesmas do pdf.js), não as impressas.

| Arquivo | O que é |
|---|---|
| `golden.csv` | Golden set da F3.1: 60 perguntas com gabarito, páginas e rota esperada (colunas abaixo) |
| `validar_golden.py` | Valida o `golden.csv` e **confere cada gabarito contra o texto do PDF original** |
| `fumaca_f2_9.json` | 5 perguntas de fumaça do `ask` (F2.9); não é o golden set |
| `perguntas_latencia.txt` | 20 perguntas sem gabarito, só para medir latência (F2.5) |
| `resultados/` | Relatórios das execuções (F3.3 em diante) |

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
