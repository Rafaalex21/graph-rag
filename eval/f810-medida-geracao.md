# F8.10: medida da geração de gráficos, tabelas e arquivos Office (definição fixada ANTES de rodar)

Aceite da etapa: "pedidos como 'faça um gráfico do lucro líquido…', 'monte uma tabela…', 'gere uma planilha / um documento / uma apresentação…' voltam o gráfico e a tabela na resposta e um `.xlsx` / `.docx` / `.pptx` para baixar; o modelo só escreve uma especificação validada, o código desenha e grava os arquivos, todo número vem de dado citado com a página e, se o documento não tem o dado, a resposta é 'não consta' em vez de preencher".

## Como a etapa funciona (para a medida fazer sentido)

- **Detecção do pedido** por palavras da própria mensagem (gráfico, tabela, planilha/Excel, documento/Word, apresentação/PowerPoint/slides), **sem chamar o modelo**: pergunta comum não paga nada a mais.
- A pergunta segue o caminho de sempre (ciclo + redator). **Depois** do redator, só se houve pedido, o modelo recebe a pergunta e as evidências e devolve **só uma especificação em JSON** (título, unidade, séries com pontos `{rótulo, valor, evidência}`), validada por esquema (zod).
- **Verificação por código (regra do ADR-061):** cada valor da especificação tem de aparecer (0,5% de tolerância, mesma régua de `numeros.ts`) na evidência que ele cita; o ponto que não passa é **removido** e contado; sem nenhum ponto, não há artefato e a resposta fica só no texto ("não consta").
- **O código desenha e grava:** gráfico em SVG (desenhado por nós, sem biblioteca de gráficos), tabela, `.xlsx` (exceljs), `.docx` (docx) e `.pptx` (pptxgenjs), com a página de cada número. O modelo nunca escreve código nem arquivo.
- Os arquivos ficam em `data/artefatos/` (fora do git) e saem por `GET /api/arquivos/:id`; novo evento SSE `artefato`.

## Definições

- **Pedidos (fixos agora, não mudam depois):**
  - **A1:** "Faça um gráfico do lucro líquido do exercício de 2023 a 2025."
  - **A2:** "Monte uma tabela e uma planilha com a receita líquida de juros de 2023 a 2025."
  - **A3:** "Gere um documento Word com o lucro líquido do exercício de 2023 a 2025."
  - **A4:** "Faça uma apresentação com o lucro líquido do exercício de 2023 a 2025."
  - **A5:** "Faça um gráfico do lucro líquido do Santander Brasil de 2023 a 2025." (o documento é só do Banco do Brasil: tem de dar "não consta")
- **Gabarito (do próprio golden, página 93 do Formulário, R$ milhões):** lucro líquido do exercício 2023 = 33.166, 2024 = 29.172, 2025 = 16.782; receita líquida de juros 2023 = 88.749, 2024 = 104.514, 2025 = 101.011. Os mesmos valores já estão nas linhas `N01`, `N02` e `G09` do golden.
- **Valores certos:** os pontos mostrados têm os três anos, na ordem, com o valor do gabarito (tolerância de 0,5%) e a página 93 em cada um.
- **Arquivo certo:** o pedido de arquivo (A2 `.xlsx`, A3 `.docx`, A4 `.pptx`) traz o arquivo na resposta; baixar (`GET /api/arquivos/:id`) dá 200, com o tipo MIME certo e tamanho dentro do limite; o arquivo é **relido** (o `.xlsx` pelo exceljs; `.docx` e `.pptx` abertos como zip, com `[Content_Types].xml` e as partes em XML bem formado) e **contém os três valores do gabarito**. Limite: não há Word, Excel nem PowerPoint nesta máquina para abrir de verdade; a releitura é por biblioteca.
- **Gráfico (A1):** a tela mostra o gráfico (imagem SVG com texto alternativo) **e** a tabela com os mesmos valores; o `.svg` baixa.
- **"Não consta" (A5):** a resposta **não** traz gráfico, tabela nem arquivo, e nenhum número do Santander aparece em lugar nenhum (nenhum ponto de especificação sobrevive).
- **Todo número rastreável:** em A1 a A4, todo valor mostrado ou gravado tem página e passou na verificação de lastro (o evento `artefato` traz `removidos` = quantos pontos o código tirou).

## Regra de aceite (fixada agora)

Cumprido só se **5 de 5** pedidos passarem por todos os itens que se aplicam a cada um (A1: valores e gráfico e tabela e `.svg`; A2: valores, tabela e `.xlsx`; A3: valores e `.docx`; A4: valores e `.pptx`; A5: "não consta" sem artefato). A regra não muda depois; uma reescrita só por decisão do dono, registrada como pós-hoc. Toda rodada ao vivo é contada e fica no relatório, inclusive as que falharem ou abortarem.

## Medidas à parte, sem entrar no aceite

- Tempo de cada pedido, e quanto a chamada extra do modelo (a especificação) soma ao tempo da resposta.
- Quantos pontos o código removeu por falta de lastro.
- Tamanho dos arquivos.
- A **qualidade** do texto da resposta não é medida aqui (já tem as medidas da F7).

Limites já sabidos: n = 5 pedidos, 1 execução cada; só séries de 3 pontos de um mesmo valor; gráfico só de barras e de linhas; o `.xlsx` e o `.docx` levam a tabela (o `exceljs` e o `docx` não desenham gráfico nativo; o `.pptx` leva o gráfico nativo do `pptxgenjs`); sem fórmulas, macros nem dados de fora do documento.

Reprodução: ver o ADR-075.

## Rodadas ao vivo e o que mudou entre elas (registrado ANTES da rodada 3)

Todas as execuções ao vivo, contadas:

1. **Rodada 1** (`eval/resultados/f810-geracao-rodada1.json`): **1 de 5**. A recuperação trouxe só o ano-base (o grafo tem o lucro só de 2025): A1 e A3 saíram com 1 ponto, A2 e A4 sem material (nenhum ponto passou). Só A5 ("não consta") passou. Nada foi tirado do resultado.
2. **Uma chamada de diagnóstico** (só A1, por `curl`, entre as rodadas 1 e 2) para ver as evidências: eram 10 trechos e um fato de 2025, nenhuma tabela. Causa: a série de vários anos está numa tabela do documento, que o roteador não buscou.
3. **Mudança geral, não por pedido** (commit ao lado): o pedido de gráfico, tabela ou arquivo faz o agente buscar também `buscar_tabelas` (`complementarTabelas`), e as evidências de tabela vão primeiro ao modelo da especificação.
4. **Rodada 2** (`f810-geracao-rodada2.json`): **2 de 5** pela regra fixada. Rótulos, valores (os três anos, na ordem), arquivos relidos e "não consta" corretos nos 5; A1, A3 e A4 falharam **só** no item de página: a tela citou **p. 80** e o meu gabarito dizia **p. 93**. Conferido no PDF (`data/parsed/…tabelas.json`): a linha "Lucro líquido 33.166 29.172 16.782" está em tabelas das pp. 80, 92 e 93 (e a conciliação gerencial na p. 13); o gabarito de página que escrevi foi estreito demais.

**A regra de aceite não muda** (5 de 5 com `p. 93`). Para a **rodada 3** (a mesma pergunta, os mesmos cinco pedidos, depois de tirar a legenda repetida do gráfico, ajuste de tela sem relação com a regra) o teste passa a gravar, por pedido, as páginas citadas e um item **pós-hoc** `paginasNoPdf`: o valor mostrado está numa tabela do PDF extraído **na página que a célula cita**. É só informativo; se o aceite deve ou não ser lido assim é decisão do dono, registrada como pós-hoc (o resultado pela regra original continua no relatório).

## Resultado da rodada 3 (a última) e leitura final

`eval/resultados/f810-geracao.json` (= `f810-geracao-rodada3.json`): **2 de 5 pela regra fixada.** Só A2 (p. 93) e A5 ("não consta") passam em todos os itens. Em A1, A3 e A4 o que falha é **só** o item de página: a tela cita **p. 80**, o gabarito fixado dizia p. 93. Todo o resto passou nos 5: rótulos 2023, 2024 e 2025 na ordem, valores do gabarito, gráfico carregado (A1 e A4), arquivo baixado com 200 e MIME certo e **relido** (svg como XML; `.xlsx` pelo exceljs com os 3 valores; `.docx` e `.pptx` com todas as partes XML bem formadas e os valores no texto), o evento `artefato` dentro do esquema do contrato em 4 de 4, nenhum ponto removido e, em A5, nenhum gráfico, tabela ou arquivo, e resposta que diz que não consta.

**Item pós-hoc (informativo, não muda o resultado acima):** `paginasNoPdf` = o valor mostrado está numa tabela do PDF extraído na página que a célula cita: **verdadeiro em todas as 12 células** das 4 respostas com material (A1, A3 e A4 citam p. 80 e A2 cita p. 93). Se a regra for lida como "a página citada contém o valor", o resultado seria 5 de 5. A decisão de ler assim é do dono.

Tempos (s, ponta a ponta pela tela): rodada 1: 31,6 / 37,2 / 29,5 / 29,0 / 5,0; rodada 2: 31,0 / 47,4 / 33,6 / 34,6 / 4,4; rodada 3: 44,8 / 48,9 / 35,2 / 29,5 / 5,0 (A1 a A5). Tamanhos: svg 2,3 KB, xlsx 6,9 KB, docx 9,9 KB, pptx 91,5 KB. **O custo da especificação não foi isolado:** os pedidos de material levaram 29 a 49 s contra 8 a 28 s das perguntas da F8.9, mas aqui também há a busca extra de tabelas e a resposta é maior. A F8.10 não mexe no RNF-2, que segue em aberto.

Limites vistos: o selo de estado vem do crítico do ciclo, que não conhece o pedido de arquivo, e disse `incompleta` ("Encontrei só em parte") em A1 a A4 mesmo com o material completo e conferido; n = 5 pedidos, 3 anos, uma série; o "abrir" foi por biblioteca, não pelo Word, Excel ou PowerPoint; a verificação prova que o número existe na evidência citada, não que está no ano certo (isso é o que o gabarito conferiu nesta medida); valor negativo não tem o sinal conferido.

**Decisão do dono (09/11):** aceitou a leitura pós-hoc "a página citada contém o valor" (5 de 5) e fechou a F8.10 com ela. O resultado pela regra original (2 de 5) continua registrado acima.
