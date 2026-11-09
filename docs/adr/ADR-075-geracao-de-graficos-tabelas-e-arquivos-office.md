# ADR-075 · Geração de gráficos, tabelas e arquivos do pacote Office pelo assistente

- **Estado:** aceita (09/11/2026), com ressalva: a regra de aceite fixada antes (5 de 5, página 93) **não foi cumprida** (2 de 5); a leitura pós-hoc "a página citada contém o valor" (5 de 5) **não foi aceita pelo dono**: ele aceitou sem querer em 09/11 e retirou; a etapa segue `[~]` (ver Evidência)
- **Data:** 2026-11-09
- **Tarefa(s):** F8.10

## Contexto

O dono pediu que o assistente gere, a pedido, gráficos, tabelas e arquivos do pacote Office, com o modelo local fazendo o trabalho de entender o pedido. O risco de uma ideia assim é o modelo escrever número ou arquivo de memória. A medida e a regra de aceite foram escritas antes do código (`eval/f810-medida-geracao.md`, commit `68bbcce`) e os testes são só E2E, escritos antes do código (ADR-068).

## Decisão

- **O modelo só escreve uma especificação.** Depois do redator, e só se a mensagem pediu algo (palavras: gráfico, tabela, planilha/Excel, "gere um documento"/Word, apresentação/slides; **sem chamar o modelo para decidir isso**), uma chamada `chatJson` com esquema JSON (o llama.cpp o converte em gramática) devolve `{titulo, unidade, coluna_rotulo, grafico, pontos[{rotulo, valor, escrito, evidencia}]}`, validado por zod (`api/src/artefatos/especificacao.ts`). O modelo nunca escreve binário, código, fórmula nem endereço.
- **Todo número é conferido por código** (`verificacao.ts`, a régua do ADR-061): o `valor` tem de bater com o `escrito` e esse número tem de aparecer, com a tolerância de 0,5% de `numeros.ts`, na evidência que o ponto cita. O ponto que não passa é **removido e contado** (`removidos`, que a tela mostra), nunca corrigido. Sem nenhum ponto não há material, e a resposta ganha a frase "Não gerei o material pedido: …". A página de cada valor é a da evidência.
- **Código desenha e grava:** gráfico em SVG nosso (`svg.ts`: barras ou linhas, eixo no zero, texto alternativo, tudo escapado), `.xlsx` com **exceljs 4.4.0**, `.docx` com **docx 9.15.3** e `.pptx` com **pptxgenjs 4.0.1** (gráfico nativo e tabela), versões exatas. `.xlsx` e `.docx` levam a tabela; as duas bibliotecas não desenham gráfico nativo.
- **A busca muda quando há pedido:** o agente acrescenta `buscar_tabelas` à busca (`complementarTabelas`) e as evidências de tabela vão primeiro ao modelo da especificação (só as 10 primeiras evidências vão). Sem isso a recuperação trazia só o ano-base (o grafo tem o lucro só de 2025).
- **Entrega:** evento SSE novo `artefato` (antes do `fim`; título, unidade, gráfico, tabela, arquivos, `removidos`) e `GET /api/arquivos/:id` (UUID gerado pela API, tipo e tamanho limitados a 5 MB, pasta `data/artefatos/` fora do git, validade de 1 hora, no máximo 200 arquivos; o SVG sai `inline` com política `default-src 'none'; sandbox`, os do Office como anexo, `nosniff`). Ambos em `contracts/api.openapi.yaml`.
- **Tela** (`assistente/material-gerado.ts`, dentro do cartão da resposta): o gráfico é uma `<img>` do SVG do servidor (com `alt` com os valores), a tabela tem a página de cada valor (clicar abre o visualizador nessa página), e os links "Baixar planilha (.xlsx)", "documento (.docx)", "apresentação (.pptx)", "gráfico (.svg)" com o tamanho. Só endereço `/api/arquivos/<id>` vira imagem ou link; formato desconhecido, `javascript:` ou endereço de fora somem; todo texto entra como texto.
- **Fora do escopo:** macros, fórmulas, dado de fora do documento, mais de uma série, PNG, qualquer coisa executada na máquina do usuário.

## Alternativas consideradas

- **Deixar o modelo escrever o arquivo ou código que o gera:** inseguro e impossível de verificar. A especificação é um dado fechado.
- **Biblioteca de gráficos (Chart.js, ECharts, Plotly):** mais bonita, mas é código de terceiros a mais no servidor ou na tela e, em alguns casos, rede. O SVG de um gráfico de barras ou linhas tem uns 100 linhas nossas.
- **Decidir "é um pedido de gráfico?" com o modelo:** uma chamada a mais em toda pergunta. Palavras bastam para o que o dono descreveu; o custo do erro é pequeno (um pedido sem material, ou material que o usuário não queria).
- **Rasterizar o SVG para PNG no `.docx`:** exigiria outra dependência nativa; o `.docx` leva a tabela.
- **Fixar a página no esquema do modelo:** a página sai da evidência, não do que o modelo escreve.

## Consequências

- O custo de uma resposta com material é maior: busca extra de tabelas, resposta maior e uma chamada ao modelo (29 a 49 s ponta a ponta, contra 8 a 28 s das perguntas da F8.9; o custo da chamada não foi isolado). O RNF-2 segue em aberto.
- O `exceljs` traz dependências antigas com aviso de descontinuação do npm (`rimraf`, `glob`, `fstream`); não há alternativa mantida com o mesmo escopo, e o arquivo só é escrito, nunca aberto de fora. **O Dependabot abriu alertas por causa das novas dependências** (todas transitivas): `image-size` 1.2.1 (alto, laço infinito em JXL, HEIF e ICNS; vem do `pptxgenjs`, que só o usa para imagens, e nós não pomos imagem no `.pptx`) e `uuid` 8 (médio, falta de checagem de limite quando se passa `buf`; vem do `exceljs`, que só chama `v4()`). Nenhum dos dois é alcançável por este código. **Não foram sobrescritos** (`overrides` para `uuid` 11.1.1 e `image-size` 2.0.3) porque trocaria a versão que as bibliotecas testaram, e fica como dívida aberta.
- O selo de estado ("Encontrei só em parte") vem do crítico do ciclo, que não conhece o pedido de arquivo; ele disse `incompleta` nos 4 pedidos com material.
- A verificação prova que o número está na evidência citada, não que está ligado ao rótulo certo (o ano). Isso foi conferido contra o gabarito na medida, não pelo código. O sinal de um valor negativo não é conferido.
- A telemetria não registra o pedido de material nem os pontos removidos.

## Evidência

**E2E da interface** (`cd e2e; npm test`): 222 testes passam (18 novos, `tests/interface/artefatos.spec.ts`) e 444 de 444 em duas repetições. Cobrem: gráfico com texto alternativo e imagem carregada, tabela com cabeçalhos e página por valor, a página abre o visualizador, downloads de `.svg`, `.xlsx`, `.docx` e `.pptx` com o nome do arquivo e zip íntegro, tamanho no link, "não consta" sem material, aviso de pontos removidos, HTML hostil como texto, endereço de fora, `javascript:` e formato desconhecido sem link, imagem que dá 404 com aviso e tabela mantida, conversa restaurada com os links, o modo técnico sem quebrar e o encaixe a 390 e 320 px. Os testes ficaram vermelhos (14 de 18) antes do código. `npm run build`, `typecheck` e `lint` da API e `ng lint` e `ng build` da web limpos.

**Pilha real** (`eval/resultados/f810-geracao.json`, ids, números e páginas): A1 a A5 só pela tela `/assistente`, **três rodadas ao vivo, mais uma chamada de diagnóstico, todas contadas** (`eval/f810-medida-geracao.md`). Rodada 1: **1 de 5** (a busca só trazia 2025; mudança geral na busca). Rodadas 2 e 3: **2 de 5 pela regra fixada**: rótulos, valores, gráfico, arquivos relidos (exceljs; XML bem formado), contrato do evento (4 de 4) e "não consta" (A5) certos em todos; A1, A3 e A4 falharam só no item de página: a tela citou **p. 80** (tabela "Lucro líquido 33.166 29.172 16.782") e o gabarito que fixei dizia p. 93; o PDF extraído tem a linha nas pp. 80, 92 e 93. Pós-hoc, informativo: o valor está numa tabela do PDF na página citada em 12 de 12 células; lido assim seria 5 de 5. **A regra não foi mudada**; a decisão de aceitar essa leitura é do dono.

**Limites:** n = 5 pedidos, 3 anos, uma série; arquivos abertos por biblioteca, não pelo Word, Excel ou PowerPoint; o gráfico foi visto a olho em 1 captura (A1, linhas); o tempo da chamada do modelo não foi isolado.

Reproduzir: `cd e2e; npm ci; npm test` (interface); com Neo4j, llama-swap e a API no ar (`npm run build` em `api/` antes), `npx playwright test --project=ao-vivo tests/ao-vivo/arquivos.spec.ts`.
