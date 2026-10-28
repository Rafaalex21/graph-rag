# Auditoria de tabelas (F1.6)

Auditoria de **15 tabelas** sorteadas do recorte de 79 páginas do Formulário de Referência 2026 do Banco do Brasil, convertido pelo Docling (ADR-014), contra o PDF. Critério de aceite da F1.6: **≥ 13 de 15 sem erro de valor**.

**Resultado: 15 de 15 sem erro de valor** (nenhum erro de valor), com **3 tabelas com problema de estrutura ou cabeçalho** (a 4, a 9 e a 12) e uma perda de hierarquia de linhas (2 e 12). Critério atendido.

## Método

1. **População:** as 62 tabelas rotuladas `table` pelo Docling no recorte (as 4 do sumário, `document_index`, foram conferidas na F1.5). Nenhuma ocupa mais de uma página nem tem uma só linha ou coluna.
2. **Sorteio:** 15 tabelas, `random.Random(20261028).sample` sobre a lista ordenada por número (reprodutível; sem filtrar por conteúdo numérico). 42% da população está nas seções 2.1 e 2.2, e a amostra reflete isso.
3. **Comparação automática de números** (`indexer.auditoria`): os números das células de cada tabela são comparados, como multiconjunto, com os números que o **pdfium** lê na mesma região da página (independente do Docling). Pega dígito trocado, sinal, parêntese, vírgula e ponto. **Não** pega número na coluna ou linha errada, nem cabeçalho e escala.
4. **Inspeção visual das 15 tabelas:** imagem recortada da página renderizada, conferida célula a célula contra a saída do Docling: valores, sinais (parênteses), escala e unidade no cabeçalho, cabeçalhos e a coluna e linha de cada valor.
5. **Definição de erro de valor:** um número ausente, diferente do PDF ou colocado sob a linha ou coluna errada (o que mudaria o seu significado). Problemas de estrutura e de cabeçalho que não alteram o valor são classificados à parte.

## Resultado por tabela

| # | Tabela (`id`) | Pág. orig. | Seção | Grade | Números (Docling / PDF) | Erro de valor | Observações |
|---:|---|---:|---|---|---:|---|---|
| 1 | `#/tables/43` | 157 | 4.3 Descrição dos principais riscos de mercado | 6×5 | 21 / 21 | não | Cabeçalho em duas linhas (datas e "Resultado") correto. O título do cenário fica fora da tabela. |
| 2 | `#/tables/39` | 115 | 3.2 Acompanhamento das Projeções | 12×9 | 77 / 77 | não | Cabeçalho mesclado achatado ("1T24 - Observado"). Perde a hierarquia de linhas: Pessoas Físicas, Empresas e Agronegócios são subitens de Carteira de Crédito. |
| 3 | `#/tables/48` | 205 | 6.4 Participações em sociedades | 6×3 | 20 / 20 | não | CNPJ e percentuais corretos. |
| 4 | `#/tables/50` | 333 | 8.2 Remuneração total por órgão | 24×5 | 44 / 44 | não | **Estrutura**: a linha "b) Número total de membros" foi fundida ao cabeçalho ("Conselho Fiscal - 5"), e o texto longo de "Observações" se espalhou em duas linhas, deixando restos ("apurado mensalmente.") colados no "-" da linha "f) Total de remuneração". Todos os números estão nas colunas certas. |
| 5 | `#/tables/41` | 157 | 4.3 Descrição dos principais riscos de mercado | 6×5 | 21 / 21 | não | Idêntica em forma à tabela 1 (outro cenário); só o título fora da tabela as distingue. |
| 6 | `#/tables/5` | 13 | 1.3 Informações relacionadas aos segmentos ope | 7×10 | 48 / 48 | não | Cabeçalho mesclado "2023 → Gerencial / Ajustes / Consolidado" correto; negativos entre parênteses preservados. |
| 7 | `#/tables/61` | 367 | 10.1 Descrição dos recursos humanos | 8×4 | 24 / 24 | não | Totais por faixa etária corretos; o "-" de Exterior preservado. |
| 8 | `#/tables/47` | 204 | 6.3 Distribuição de capital | 3×3 | 6 / 6 | não | Tabela de 3 linhas sem cabeçalho no PDF; correta. |
| 9 | `#/tables/16` | 88 | 2.1 Condições financeiras e patrimoniais | 25×11 | 176 / 176 | não | **Estrutura**: o texto das células mescladas se repete nas colunas cobertas, inclusive na coluna "Remuneração a.a." em 4 linhas ("Curto Prazo", "Longo Prazo 2028"), que no PDF está vazia. Valores e cabeçalho corretos. |
| 10 | `#/tables/60` | 367 | 10.1 Descrição dos recursos humanos | 8×8 | 37 / 37 | não | Matriz região × raça/cor correta, incluindo os "-" e os zeros. |
| 11 | `#/tables/35` | 114 | 3.2 Acompanhamento das Projeções | 2×2 | 2 / 2 | não | Tabela só de texto (indicador e conceito); correta. |
| 12 | `#/tables/38` | 115 | 3.2 Acompanhamento das Projeções | 12×9 | 87 / 87 | não | **Cabeçalho**: o primeiro "Revisão" saiu sem o prefixo "1T25" (na tabela 2 saiu "1T24 - Revisão"), o que deixa o período da coluna ambíguo. Valores corretos. Mesma perda de hierarquia de linhas da tabela 2. |
| 13 | `#/tables/12` | 84 | 2.1 Condições financeiras e patrimoniais | 19×6 | 96 / 97 | não | A ferramenta apontou "200%" como faltando: é a legenda "Obs: Variações superiores a 200% são representadas por '-'", abaixo da tabela (falso positivo). Tabela correta. |
| 14 | `#/tables/19` | 92 | 2.1 Condições financeiras e patrimoniais | 10×6 | 48 / 49 | não | Mesmo caso da 13 (legenda "Obs" fora da tabela). Tabela correta. |
| 15 | `#/tables/0` | 2 | — | 8×2 | 41 / 41 | não | Controle de versões da capa; correta. |

Números nas 15 tabelas: **748 nas células do Docling contra 750 no texto do PDF** na mesma região; os 2 a mais são a legenda "Obs: … 200% …" das tabelas 13 e 14 (fora da tabela). Todos os outros números são idênticos, inclusive sinais, parênteses, vírgulas e pontos.

## Achados

1. **Valores:** nenhum erro de valor nas 15 tabelas. Parênteses de negativos, percentuais, CNPJs, "Não Aplicável" e os "-" foram preservados; os cabeçalhos trazem a escala ("R$ milhões, exceto percentuais", "R$ bilhões ou %").
2. **Cabeçalhos mesclados** são achatados em "período - coluna" (por exemplo "2023 - Gerencial"). Funciona bem nas tabelas 2 e 6, mas na 12 um dos cabeçalhos perdeu o prefixo (`Revisão` sem `1T25`).
3. **Linha fundida ao cabeçalho e texto longo espalhado** na tabela 4 (formulário de remuneração, com células de texto longas): o "b) Número total de membros" entrou nos títulos das colunas, e restos do texto de "Observações" ficaram colados num "-". Os números estão certos, mas um leitor que use só a célula "-" veria texto espúrio.
4. **Células mescladas repetidas** na tabela 9: o texto de uma célula que cobre várias colunas aparece em todas elas, inclusive numa coluna que no PDF está vazia.
5. **Hierarquia de linhas perdida** (2 e 12): os subitens recuados (Pessoas Físicas, Empresas, Agronegócios) aparecem como linhas do mesmo nível de Carteira de Crédito.
6. **Contexto fora da tabela:** os títulos "Cenário I/III" (tabelas 1 e 5, idênticas em forma) e a legenda "Obs:" não fazem parte da grade.
7. **Legenda que muda o significado:** em 4 tabelas (páginas 84, 92, 93 e 96) a legenda *"Variações superiores a 200% são representadas por '-'"* diz que o "-" das colunas de variação significa **mais de 200%**, e não "sem dado". A regra de notas da F1.4 só reconhecia `(n)`, então a legenda ficava como parágrafo solto. **Corrigido nesta tarefa:** `Obs:` passou a ser nota da tabela (ADR-015, adendo 2); no recorte, 24 → 28 notas associadas.
8. **Falso positivo da ferramenta:** a margem de 3 pt do recorte capturou a legenda "Obs:" colada na base das tabelas 13 e 14.

## Limites desta auditoria

- **Amostra de 15 em 62** (24%): resultados por tabela não se generalizam estatisticamente; os problemas de estrutura aparecem em tabelas com células mescladas e texto longo, e as demais 47 tabelas podem ter o mesmo padrão.
- A conferência de **linha e coluna de cada valor** foi visual (feita por mim, lendo as imagens), não automática; as duas maiores (4: 24×5 e 9: 25×11) foram conferidas linha a linha, mas uma troca isolada de dois números iguais em dígitos não seria detectada pela comparação de números.
- O recorte tem mais tabelas por página do que o documento inteiro; o documento completo (F5.8) deve repetir a auditoria numa amostra.
- Não foi auditado o conteúdo de células de texto longo palavra por palavra (tabelas 4, 9 e 11).

## O que isso pede das próximas tarefas

- **F2.1 (segmentação):** tratar a tabela como unidade atômica com as **notas**, o **caminho da seção** e o título do cenário junto, e emitir o markdown já com o cabeçalho achatado.
- **Pós-processamento de cabeçalho** (candidato): completar o prefixo de período em cabeçalhos mesclados e colapsar texto repetido de células mescladas.
- **Tabelas tipo formulário** (como a 4): candidata ao *fallback* do Granite-Docling previsto na ARQUITETURA §5 (I-1), se o problema se repetir em outras tabelas do documento inteiro.

## Reproduzir

```powershell
# a partir de indexer/, com . ..\infra\dev-env.ps1
uv run --group parse python -m indexer.auditoria ..\data\parsed\bb_fre_2026_recorte.docling.json `
    --pdf ..\data\raw\bb_fre_2026_recorte.pdf --mapa ..\data\raw\bb_fre_2026_recorte_mapa.json `
    --saida ..\data\parsed\auditoria --n 15 --semente 20261028
```

Os recortes de imagem e o markdown de cada tabela ficam em `data/parsed/auditoria/` (fora do git, porque são trechos do documento; ver a pendência de autorização no ADR-009).
