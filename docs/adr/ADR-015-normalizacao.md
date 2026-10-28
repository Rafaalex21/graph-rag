# ADR-015 · Normalização do documento: cabeçalhos, rodapés e notas

- **Estado:** aceita (28/10/2026)
- **Data:** 2026-10-28
- **Tarefa(s):** F1.4

## Contexto

A ARQUITETURA §5 (I-2) manda remover cabeçalhos e rodapés repetidos (linhas presentes em mais de 30% das páginas) e associar as notas de rodapé ao parágrafo de origem. Antes de implementar, medi o JSON do Docling do recorte (79 páginas, ADR-014):

- **3 linhas** se repetem em mais de 30% das páginas, e as três já vêm rotuladas pelo Docling: o cabeçalho "Formulário de Referência N" (78 páginas), o rodapé "Banco do Brasil S.A. | Relações com Investidores" (78) e o número da página (75, dos quais um rotulado como `text` em vez de rodapé).
- Há **24 blocos de nota**: 6 rotulados `footnote` e 18 parágrafos rotulados `text` que começam com `(n)`. O marcador `(n)` **não aparece** no texto das células das tabelas, então não dá para ligar nota e marcador por texto.
- Em ordem de leitura, 20 desses blocos vêm logo depois de uma tabela, 3 depois de uma figura (organogramas) e 1 depois do rótulo "Notas:".

## Decisão

1. **Remover**, em `indexer/src/indexer/normalize.py`:
   - todo item rotulado `page_header` ou `page_footer`;
   - qualquer linha **curta** (até 120 caracteres) cujo texto, com os números trocados por `#`, apareça em **mais de 30% das páginas e em pelo menos 3** (o mínimo evita remover tudo em documentos minúsculos);
   - o rótulo "Notas:" quando vem logo depois de uma tabela ou figura.
2. **Associar notas por posição**, não por marcador: um bloco de itens `footnote` ou `(n) ...` que segue imediatamente uma tabela ou figura (na ordem de leitura, já sem cabeçalhos e rodapés) vira o campo `notas` desse elemento. Nota sem tabela ou figura antes fica no texto, marcada com `nota_sem_ancora`.
3. **Saída:** `data/parsed/<pdf>.normalizado.json` com a lista de elementos na ordem de leitura (`id` do Docling, `tipo`, `texto`, `nivel` dos títulos, `paginas_recorte` e `paginas_originais` pelo mapa do ADR-009) e as estatísticas. As tabelas e figuras entram por referência (`id`), sem o conteúdo; o markdown da tabela é montado na segmentação (F2.1).
4. A leitura da árvore `body` e as regras são funções puras sobre o dict, **sem importar o Docling**, o que permite testar no CI.

## Alternativas consideradas

- **Remover só por rótulo do Docling.** Deixaria o número de página rotulado como `text` (em 1 página do recorte).
- **Remover só pela regra dos 30%.** Em documentos curtos, ou com cabeçalho que muda de página para página, deixaria cabeçalhos para trás; os dois critérios juntos cobrem os dois casos.
- **Associar nota a marcador.** Inviável: o marcador não está no texto das células.
- **Associar nota ao parágrafo mais próximo.** Mais frágil: as notas deste documento pertencem a tabelas e figuras.

## Consequências

- A F2.1 recebe elementos já sem ruído de página e com as notas junto da tabela que explicam.
- A regra dos 30% é relativa ao documento; ela precisa ser recalculada na F5.8 (423 páginas), embora os rótulos do Docling cubram o essencial.
- Um item curto legítimo que se repita em mais de 30% das páginas seria removido (nenhum no recorte: a maior repetição que sobra é "CNPJ: …", em 6 páginas).

## Verificação do aceite da F1.4

| Critério | Resultado |
|---|---|
| Nenhuma linha repetida em mais de 30% das páginas | linhas repetidas **3 antes, 0 depois**; verificação independente sobre o arquivo gravado (525 linhas distintas, a maior repetição restante em 6 de 79 páginas) |
| Itens | 1060 lidos; 231 cabeçalhos/rodapés por rótulo, 1 pela regra das repetidas, 1 rótulo "Notas:"; **803 elementos** na saída (**725** depois do adendo da F1.5, abaixo) |
| Notas associadas | **24** associadas, **0** sem âncora |
| Tabelas preservadas | 66 de 66 (62 `table` e 4 `document_index`) |
| Testes | 8 passam (cobrem remoção, regra com mínimo de páginas, notas, rótulo "Notas:", nota sem âncora e mapa de páginas) |

Exemplo: as quatro notas da página 23 do recorte (original p. 89), três com `(n)` e uma sem marcador ("Sofr 3m - tarifa interbancária dos EUA"), foram para a tabela `#/tables/17`.

## Ressalvas

1. A associação por posição é uma **suposição de layout** (nota logo depois da tabela pertence a ela). Conferi a página 23 a olho; as demais 23 notas não foram lidas uma a uma. A F1.6 (auditoria de tabelas) é a oportunidade de checar.
2. Não há, no recorte, nota de rodapé ligada a parágrafo de texto corrido; se o documento inteiro tiver, a regra deixa a nota no texto, marcada, em vez de adivinhar o parágrafo.
3. O recorte tem 85 elementos `picture` (logotipos, gráficos e organogramas); a F2.1 decide o que fazer com eles.

## Evidência

Estatísticas em [`ADR-015-bruto/bb_fre_2026_recorte.normalizacao.json`](ADR-015-bruto/bb_fre_2026_recorte.normalizacao.json); entrada: `data/parsed/bb_fre_2026_recorte.docling.json` (ADR-014).

## Adendo (F1.5, 28/10/2026): figuras decorativas repetidas

Ao montar a árvore de seções (ADR-016), os intervalos de páginas saíram errados: o fim de uma seção ia parar na página do título seguinte. A causa era uma **figura decorativa de ~30×30 pt** (um ícone) no topo de quase todas as páginas, que na ordem de leitura vem **antes** do título da página e por isso era atribuída à seção anterior. Das 85 figuras do recorte, 78 são esse ícone.

Nova regra em `normalize.py` (`figuras_decorativas`): remover a figura cujo **tamanho e altura na página** (arredondados a 5 pt) se repetem em mais de 30% das páginas **do mesmo formato** (e em pelo menos 3). O eixo x é ignorado, porque o ícone muda de lado conforme a seção (x = 525, 551 ou 523), e o formato da página entra na chave, porque as páginas em paisagem têm o ícone em outra altura. Uma primeira versão, com o x na chave, deixou 8 ícones para trás e foi corrigida.

Efeito no recorte: **78 figuras removidas**, 725 elementos (eram 803), linhas repetidas ainda 3 → 0, 24 notas associadas e 66 de 66 tabelas preservadas. Restam 7 figuras, todas de conteúdo (logotipo da capa, um gráfico e os organogramas das páginas 55 a 57). O critério de aceite da F1.4 não muda (a regra atua em figuras, não em linhas de texto).
