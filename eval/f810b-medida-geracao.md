# F8.10b: nova medida da geração de material, com regra de página escrita ANTES de rodar

Esta medida existe porque a F8.10 ficou `[~]` com **2 de 5 pela regra fixada** em `eval/f810-medida-geracao.md` (A1–A5): os três pedidos que falharam erraram **só** o item de página, porque o gabarito que eu escrevi (`p. 93`) era estreito demais (a mesma linha "Lucro líquido 33.166 29.172 16.782" está nas pp. 80, 92 e 93 do PDF). O dono pediu uma medida nova em vez de aceitar o resultado por reinterpretação. **O resultado da medida antiga (2 de 5) não muda e continua valendo para aquela regra.** Esta medida só passa a valer como evidência da F8.10 se for cumprida como está escrita aqui.

Honestidade sobre a origem: a mudança da regra de página (de "a página 93" para "uma página onde a linha existe no PDF") foi motivada pelo que vi na medida antiga. Para não ajustar o teste ao que já vi, **os cinco pedidos são novos** (métricas e anos que o assistente nunca recebeu como pedido de material) e o conjunto de páginas aceitas foi calculado **a partir das tabelas extraídas do PDF, antes de qualquer execução**, não a partir do que o sistema devolve. Nenhum código de produção muda entre a medida antiga e esta.

## Pedidos (fixos agora, não mudam depois)

| Id | Pedido | Formato | Série esperada (R$ milhões, 2023 / 2024 / 2025) | Páginas aceitas |
|---|---|---|---|---|
| B1 | "Faça um gráfico dos depósitos totais de 2023 a 2025." | gráfico (`.svg`) | Depósitos Totais: 811.944 / 873.711 / 897.937 | 83 |
| B2 | "Monte uma tabela e uma planilha com o ativo total de 2023 a 2025." | tabela e `.xlsx` | Ativo Total: 2.153.878 / 2.398.719 / 2.455.143 | 80 |
| B3 | "Gere um documento Word com as receitas não de juros de 2023 a 2025." | `.docx` | Receitas Não de Juros: 50.740 / 54.152 / 53.788 | 93 |
| B4 | "Faça uma apresentação com o lucro por ação de 2023 a 2025." | `.pptx` | Lucro por Ação (Básico e Diluído), em R$: 5,23 / 4,62 / 2,40 | 80 |
| B5 | "Faça um gráfico do lucro líquido do Magazine Luiza de 2023 a 2025." | — | o documento é só do Banco do Brasil: tem de dar "não consta" | — |

- **Valores e anos:** conferidos nas tabelas extraídas do PDF (`data/parsed/banco_do_brasil_formulario_referencia_2026.tabelas.json`, fora do git), onde o cabeçalho da tabela diz `2023 | 2024 | 2025` nas três colunas seguidas. B4 tem decimais em pt-BR (o teste de escrita "2,40" é de propósito).
- **Páginas aceitas (calculadas antes de rodar):** para cada série, as páginas das tabelas do PDF que trazem uma **linha com os três valores em células seguidas, na ordem dos anos**. Só uma tabela por série satisfaz isso (B1 p. 83; B2 p. 80; B3 p. 93; B4 p. 80); nenhuma outra tabela do PDF tem os três valores juntos numa linha. Isso é mais **estrito** que a medida antiga: aqui não existem três páginas para o sistema escolher.
- **B5:** "Magazine Luiza" não aparece em nenhuma tabela nem em nenhum trecho de texto do documento extraído (0 ocorrências), conferido antes de escolher.

## Itens por pedido (os mesmos da medida antiga, só a página muda)

Cada pedido de B1 a B4 tem de passar por **todos** os itens que se aplicam:
1. **Evento `artefato` dentro do contrato** (`EventoArtefato` do `contracts/api.openapi.yaml`).
2. **Rótulos** 2023, 2024 e 2025, na ordem.
3. **Valores** da tabela da tela iguais aos da série esperada (tolerância de 0,5%).
4. **Página (nova regra):** **toda** célula da coluna "Fonte" cita pelo menos uma página e **todas** as páginas citadas estão no conjunto de páginas aceitas daquele pedido. Citar uma página fora do conjunto (inclusive num intervalo, como "pp. 83–84" quando só a 83 vale) reprova.
5. **Gráfico** na tela (imagem carregada) quando o pedido ou o formato traz gráfico (B1 e B4).
6. **Arquivo:** o formato pedido (B1 `.svg`, B2 `.xlsx`, B3 `.docx`, B4 `.pptx`) baixa pelo link da tela com 200, MIME certo, 1 byte a 5 MB, é **relido** (svg como XML; `.xlsx` pelo exceljs; `.docx` e `.pptx` como zip com `[Content_Types].xml` e todas as partes XML bem formadas) e **contém os três valores**: no `.xlsx` como número; nos demais, escritos como no documento (por exemplo "2,40") ou em pt-BR.

**B5 ("não consta"):** passa se **não** houver evento `artefato`, gráfico, tabela nem link de download, e a resposta disser que não consta/não encontrou/não traz/não há.

Mudança de teste junto desta medida (sem relação com a regra de aceite): o item 6 passa a aceitar o valor escrito como no documento, porque `String(2.4)` e o formato pt-BR sem casas fixas dão "2,4", e o documento escreve "2,40"; sem isso o teste reprovaria B4 por defeito dele, não do sistema.

## Regra de aceite (fixada agora)

Cumprido só se **5 de 5** pedidos passarem por todos os itens que se aplicam. A regra não muda depois. Uma reescrita só por decisão do dono, registrada como pós-hoc, e **o resultado pela regra original continua no relatório**. Toda rodada ao vivo é contada e fica no relatório, inclusive as que falharem ou abortarem. **Se der menos de 5 de 5, a F8.10 continua `[~]`**: não se corrige o sistema nem a regra para "passar" na mesma rodada; um conserto geral (nunca por pedido) exigiria uma rodada nova, contada à parte, e é decisão do dono.

## Medidas à parte, sem entrar no aceite

- **Pós-hoc informativo (o item da medida antiga):** o valor mostrado está numa tabela do PDF extraído **na página que a célula cita**, mesmo que essa página não esteja no conjunto aceito (`paginasNoPdf`).
- Tempo de cada pedido (ponta a ponta pela tela) e `removidos` por pedido.
- Tamanho dos arquivos.
- O selo de estado (`metricas.estado`) de cada resposta: sabidamente `incompleta` mesmo com material completo (limite conhecido, não entra no aceite).

Limites já sabidos: n = 5 pedidos, 1 execução cada; séries de 3 pontos de uma só linha; gráfico só de barras e linhas; arquivos abertos por biblioteca, não pelo Word, Excel ou PowerPoint; a verificação prova que o número está na evidência citada, não que está no ano certo (aqui isso é conferido pelo gabarito); sinal negativo não conferido (nenhuma das séries é negativa).

## Reprodução

Com Neo4j, llama-swap e a API (`npm run build` em `api/` antes) no ar:

```powershell
cd e2e
$env:F810_CONJUNTO = "B"
npx playwright test --project=ao-vivo tests/ao-vivo/arquivos.spec.ts
```

Grava `eval/resultados/f810b-geracao.json` (ids, valores, páginas citadas, contagens e tempos; sem texto do documento, ADR-009). Sem `F810_CONJUNTO`, o teste roda o conjunto A da medida antiga e grava `f810-geracao.json`.

## Rodadas (preenchido depois de rodar; toda rodada é contada)

_Nenhuma rodada ainda._
