# F8.10c: terceira medida da geração de material, com regra de página mecânica escrita ANTES de rodar

Histórico, para não esconder nada:

- **F8.10 (`eval/f810-medida-geracao.md`, A1–A5): 2 de 5.** Os três que falharam erraram só a página: meu gabarito dizia p. 93 e a tela citou a p. 80, que também tem a linha.
- **F8.10b (`eval/f810b-medida-geracao.md`, B1–B5): 4 de 5.** B3 falhou só na página: a tela citou a p. 96, que tem a linha "Receitas Não de Juros" com os três valores e colunas de percentual no meio; minha regra de "células seguidas" só aceitava a p. 93.
- O dono recusou aceitar pós-hoc algo que falhou. Os dois resultados acima **não mudam** e continuam valendo para as regras deles.

Nas duas vezes o sistema citou uma página onde o dado realmente está e eu fui estreito demais ao escrever o gabarito. Esta medida troca o gabarito escrito à mão por **uma regra mecânica, aplicada por código, sobre as tabelas extraídas do PDF**, e os cinco pedidos são **novos** (nenhum de A nem de B). Nenhum código de produção muda.

## Regra de página (mecânica, fixada agora)

Para cada pedido, o teste calcula as **páginas aceitas** assim, sem olhar o que o sistema devolveu:

> uma página é aceita se alguma **tabela extraída** dela (`data/parsed/banco_do_brasil_formulario_referencia_2026.tabelas.json`, fora do git) tem uma **linha** cujo **primeiro campo** é o rótulo da série (comparação sem acento, caixa nem pontuação) e que traz os **três valores, escritos como no documento, em ordem** (2023, 2024, 2025). Podem existir outras células entre os valores (percentuais, variações). O cabeçalho dessas tabelas foi conferido à mão: as colunas de valor são 2023, 2024 e 2025 nessa ordem.

O teste calcula o conjunto no próprio código e **falha o pedido se o conjunto calculado for diferente do que está escrito abaixo** (a lista abaixo foi calculada antes de rodar, com um script à parte). Uma linha com os mesmos números e **outro rótulo** (por exemplo "Passivo Total" com os números do ativo) **não conta**.

## Pedidos (fixos agora)

| Id | Pedido | Formato | Rótulo da linha | Série (R$ milhões, 2023 / 2024 / 2025) | Páginas aceitas |
|---|---|---|---|---|---|
| C1 | "Faça um gráfico dos depósitos a prazo de 2023 a 2025." | gráfico (`.svg`) | Depósitos a Prazo | 495.670 / 547.447 / 590.567 | 84 |
| C2 | "Monte uma tabela e uma planilha com as receitas de juros de 2023 a 2025." | tabela e `.xlsx` | Receitas de Juros | 265.439 / 273.505 / 319.462 | 93 e 94 |
| C3 | "Gere um documento Word com o patrimônio líquido de 2023 a 2025." | `.docx` | Patrimônio Líquido | 173.570 / 184.236 / 193.567 | 81 |
| C4 | "Faça uma apresentação com o lucro antes dos impostos de 2023 a 2025." | `.pptx` | Lucro Antes dos Impostos | 41.147 / 27.711 / 5.614 | 93 |
| C5 | "Faça uma apresentação com o lucro líquido do Nubank de 2023 a 2025." | — | — | o documento é só do Banco do Brasil: tem de dar "não consta" | — |

- C2 já tem **duas** páginas aceitas pela regra: a p. 93 (valores seguidos) e a p. 94 (percentuais no meio), de propósito.
- C3 é uma série com percentuais no meio da linha (`173.570 | 8,1 | 184.236 | 7,7 | 193.567 | 7,9`).
- Nenhum desses números aparece em texto corrido do documento extraído (conferido nos trechos pai e filho), só em tabelas. "Nubank" tem 0 ocorrências em tabelas e em trechos.
- Se o sistema citar um trecho de texto em vez de tabela, a regra reprova: o limite é conhecido e fica registrado.

## Itens por pedido (iguais aos da medida B)

C1 a C4 passam por **todos** os itens que se aplicam:
1. Evento `artefato` dentro do contrato (`EventoArtefato`).
2. Rótulos 2023, 2024 e 2025, na ordem.
3. Valores da tabela da tela iguais aos da série (tolerância de 0,5%).
4. **Página (regra mecânica acima):** toda célula da coluna "Fonte" cita pelo menos uma página e todas as páginas citadas estão no conjunto de páginas aceitas do pedido.
5. Gráfico na tela (imagem carregada) quando o pedido ou o formato traz gráfico (C1 e C4).
6. Arquivo do formato pedido (C1 `.svg`, C2 `.xlsx`, C3 `.docx`, C4 `.pptx`): baixa com 200, MIME certo, até 5 MB, é relido (svg como XML; `.xlsx` pelo exceljs; `.docx` e `.pptx` como zip com todas as partes XML bem formadas) e contém os três valores (número no `.xlsx`; nos outros, como escritos no documento ou em pt-BR).

**C5:** passa se não houver evento `artefato`, gráfico, tabela nem link de download, e a resposta disser que não consta, não encontrou, não traz ou não há.

## Regra de aceite (fixada agora)

Cumprido só se **5 de 5** pedidos passarem por todos os itens que se aplicam. A regra não muda depois de rodar. Uma reescrita só por decisão do dono, registrada como pós-hoc, **com o resultado pela regra original mantido**. Toda rodada ao vivo é contada e fica no relatório, inclusive as que falharem ou abortarem. **Se der menos de 5 de 5, a F8.10 continua `[~]`**: não se mexe no sistema nem na regra para passar na mesma rodada, e não há aceite pós-hoc de algo que falhou.

## Medidas à parte, sem entrar no aceite

- Item pós-hoc informativo: o valor mostrado está numa tabela do PDF na página que a célula cita (`paginasNoPdf`), mesmo fora do conjunto aceito.
- Tempo de cada pedido, `removidos`, tamanho dos arquivos e o selo de estado (sabidamente `incompleta` mesmo com material completo; limite conhecido, não entra no aceite).

Limites: n = 5 pedidos, 1 execução cada; séries de 3 pontos de uma só linha; arquivos abertos por biblioteca, não pelo Word, Excel ou PowerPoint; a verificação prova que o número está na evidência citada, não que está no ano certo (aqui o gabarito confere); nenhuma série é negativa.

## Reprodução

Com Neo4j, llama-swap e a API no ar (`npm run build` em `api/` antes):

```powershell
cd e2e
$env:F810_CONJUNTO = "C"
npx playwright test --project=ao-vivo tests/ao-vivo/arquivos.spec.ts
```

Grava `eval/resultados/f810c-geracao.json` (ids, valores, páginas citadas, páginas aceitas calculadas, contagens e tempos; sem texto do documento, ADR-009).

## Rodadas (preenchido depois de rodar; toda rodada é contada)

### Rodada 1 (09/11, a única até agora): **3 de 5 pela regra fixada. O aceite NÃO foi cumprido.**

`eval/resultados/f810c-geracao.json`. Commits antes da rodada: medida `aa00cdb`, teste `9f29556`; nenhum código de produção mudou. As páginas aceitas calculadas pelo teste bateram com as registradas nos 4 pedidos (84; 93 e 94; 81; 93).

| Pedido | Resultado | Páginas citadas | Tempo | Selo |
|---|---|---|---|---|
| C1 gráfico, depósitos a prazo | passou | p. 84 nas 3 | 53,5 s | incompleta |
| C2 tabela e planilha, receitas de juros | passou | **p. 94 nas 3** (a página com percentuais no meio, que a regra de B recusaria e a de C aceita) | 53,5 s | suficiente |
| C3 Word, patrimônio líquido | **falhou: nenhum material** | — | 6,5 s | sem_consulta |
| C4 apresentação, lucro antes dos impostos | **falhou: só 1 dos 3 anos** | p. 93 (só 2025) | 29,5 s | incompleta |
| C5 "não consta", Nubank | passou | — | 4,9 s | sem_consulta |

**Desta vez as duas falhas são do sistema, não do gabarito** (conferido depois, lendo as respostas gravadas no `trace.zip` do Playwright, sem nova chamada ao sistema):
- **C3:** o roteador devolveu rota vazia (`sem_consulta`) e a resposta foi "Isso está fora do que o documento traz.", mais a frase "Não gerei o material pedido…". O patrimônio líquido **está** no documento (p. 81). Ou seja, o roteador tratou um pedido de "documento Word com o patrimônio líquido" como assunto de fora. Em A3 e B3 o mesmo formato de pedido funcionou; aqui a mudança foi a métrica.
- **C4:** a busca trouxe só o fato de 2025 (R$ 5.614 milhões, p. 93); a resposta diz "não encontrei … 2023 e 2024" e o material saiu com **um** ponto. A linha completa com os três anos existe na tabela da p. 93. O código manteve o que tinha lastro e não inventou os outros dois anos, que é o comportamento desenhado, mas o pedido de três anos não foi atendido.
- Em C1, o texto da resposta diz que não encontrou os valores de depósitos a prazo, enquanto o material ao lado traz os três valores certos com a p. 84. O texto do redator e o material gerado se contradizem; isso não entra no aceite, mas o usuário vê.

Passaram por todos os itens: C1 (contrato, rótulos, valores, página, gráfico, `.svg`), C2 (`.xlsx` relido com os 3 valores) e C5 (sem evento, gráfico, tabela nem link, e diz que não consta). `removidos` = 0 em todos.

**O que isso muda:** a F8.10 continua `[~]` e não há aceite pós-hoc. Acumulado de rodadas ao vivo desta etapa: medida antiga 3 rodadas + 1 diagnóstico (1, 2, 2 de 5), F8.10b 1 rodada (4 de 5), F8.10c 1 rodada (3 de 5). A regra de página mecânica funcionou como previsto (C2 citou a p. 94 e passou). O que falta é do produto, e de forma geral: (1) o roteador não pode tratar como "fora do documento" um pedido de material sobre uma métrica que existe; (2) a busca do pedido de material precisa trazer a série dos três anos (hoje depende de sorte do `serie_metrica`/`buscar_tabelas`). Qualquer conserto vira tarefa com teste E2E escrito antes e uma rodada nova, em pedidos novos, contada à parte (F8.10d), por decisão do dono.

