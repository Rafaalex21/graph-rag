# ADR-016 · Árvore de seções

- **Estado:** aceita (28/10/2026)
- **Data:** 2026-10-28
- **Tarefa(s):** F1.5

## Contexto

A segmentação (F2.1) precisa de uma árvore de seções com título, nível e páginas: o Pai nunca atravessa uma seção e cada Filho leva o caminho da seção como prefixo. O Docling entrega os 170 títulos do recorte **todos no nível 1**, então não há hierarquia pronta. O PDF também não ajuda: o marcador (`outline`) do PDF tem só 2 entradas (capa e o arquivo). O índice do PDF é o **sumário impresso** (107 entradas), com numeração impressa = página física − 1 (ADR-009).

## Decisão

Em `indexer/src/indexer/sections.py`:

1. **Hierarquia pela numeração do próprio documento**:
   - títulos numerados (`1.`, `1.1`, `8.15`): nível = número de partes; pai = o prefixo mais próximo já visto (4.2 sem o "4." no recorte fica sem pai);
   - títulos com letra (`(a) produtos e serviços`): filhos da última seção numerada;
   - títulos sem marca (`Segmento bancário`): filhos do último título numerado ou com letra, e irmãos entre si.
2. **Fim de cada seção** = antes do primeiro título que **não é seu descendente** na árvore. A regra "próximo título de nível menor ou igual" foi tentada primeiro e falhou: sem as seções 4 e 5 no recorte, os títulos 4.2, 4.3 e 5.3 (nível 2, sem pai) eram engolidos pela seção 3.
3. **Cada nó** guarda `numero`, `titulo`, `nivel`, `pai`, `caminho` (títulos da raiz até ele), `pagina_inicio` e `pagina_fim` (páginas **físicas do original**, pelo mapa do ADR-009) e `indice_inicio`/`indice_fim` nos elementos normalizados (ADR-015).
4. **Comparação com o sumário**: o sumário é lido do PDF original com o `pypdfium2` (já presente com o Docling) e, **só nas entradas cuja página inicial existe no recorte**, exige-se número, título (sem acentos, caixa e pontuação) e página inicial iguais.

## Alternativas consideradas

- **Níveis do Docling.** Todos iguais a 1: inútil para hierarquia.
- **Marcadores (outline) do PDF.** Só 2 entradas.
- **Ler o sumário pelo Docling** (as tabelas `document_index`). Seria o mesmo extrator dos dois lados da comparação; o `pypdfium2` é independente.
- **Fim da seção pelo nível.** Falha quando faltam seções-pai (o caso do recorte).

## Consequências

- A F2.1 pode usar `indice_inicio`/`indice_fim` para nunca atravessar seção e o `caminho` como prefixo dos Filhos.
- Os 140 títulos com letra ou sem marca têm hierarquia **heurística**, sem sumário para conferir.
- Na F5.8 (423 páginas) haverá números repetidos no sumário (por exemplo, duas entradas "13.1"); a comparação por número precisará tratar duplicatas.

## Verificação do aceite da F1.5

| Critério | Resultado |
|---|---|
| Sumário gerado bate com o índice do PDF em ≥ 95% das entradas | **30 de 30 (100%)**: número, título e página inicial. O sumário tem 107 entradas; só as 30 cuja página inicial está no recorte entram na conta |
| Seções numeradas na árvore que não estão no sumário | nenhuma |
| Independência da leitura do sumário | o `pypdfium2` reproduz **exatamente** (107 entradas, mesmos números e páginas) a extração que eu havia feito antes com o `pypdf` |
| Consistência dos 170 nós | início dentro do recorte, fim no mesmo bloco contíguo do recorte, filhos aninhados dentro do pai (em elementos e em páginas): **nenhuma falha** |
| Estrutura | 170 nós: 30 numerados, 25 com letra, 115 sem marca; níveis {1: 10, 2: 25, 3: 84, 4: 51}; 17 raízes (seções sem pai no recorte); 14 testes passam |

Exemplo de caminho: `ATIVIDADES DO EMISSOR › Informações relacionadas aos segmentos operacionais › produtos e serviços comercializados › Segmento bancário`, páginas 10 a 11.

## Ressalvas

1. A taxa de 100% vale para as **30 seções numeradas**; as 140 restantes não têm referência para comparar.
2. A taxa por si só **não detectou** o defeito dos fins de página (todos os títulos estavam certos, mas as páginas finais não). Foi preciso olhar os intervalos e fazer uma verificação de consistência dos nós, que agora faz parte da evidência.
3. O sumário é lido pelo padrão `N.N Título ..... página`; títulos que quebram em duas linhas no sumário seriam perdidos (não ocorreu: as 107 entradas batem com a extração anterior).
4. Os 17 nós sem pai são seções cujo pai não está no recorte (por exemplo 4.2, 5.3, 7.5); no documento inteiro eles se ligam às seções 4, 5 e 7.

## Evidência

Resumo e as 30 seções numeradas com intervalos em [`ADR-016-bruto/bb_fre_2026_recorte.secoes_resumo.json`](ADR-016-bruto/bb_fre_2026_recorte.secoes_resumo.json); entrada: `data/parsed/bb_fre_2026_recorte.normalizado.json` (ADR-015) e o sumário do PDF original (`data/raw/banco_do_brasil_formulario_referencia_2026.pdf`, SHA-256 no ADR-009).
