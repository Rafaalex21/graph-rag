# F8.10d: medida do aceite depois do conserto (pedidos novos, mesma regra mecânica da F8.10c), fixada ANTES de rodar

Histórico, sem esconder nada:

- **F8.10 (A1–A5): 2 de 5** (gabarito de página meu, estreito). **F8.10b (B1–B5): 4 de 5** (idem). **F8.10c (C1–C5): 3 de 5**, com regra de página mecânica, e as duas falhas eram do sistema: C3 (roteador tratou "um Word com o patrimônio líquido" como assunto de fora) e C4 (a linha do fim de uma tabela longa foi cortada, o material saiu só com 2025).
- O dono mandou consertar. O conserto (ADR-076) é geral, não por pedido: (1) o roteador recebe, só em pedido de material, a dica de que pergunta sem outra empresa é da companhia do documento; (2) a evidência de tabela que vai ao modelo da especificação traz o cabeçalho e as linhas do pedido em vez do começo cortado em 900 caracteres. Foi desenvolvido com testes E2E escritos antes (`e2e/tests/ao-vivo/material-dev.spec.ts`: 2 vermelhos, 3 guardas verdes → 5 verdes) em **pedidos que a F8.10c já tinha usado** (C3, C4 e três pedidos sobre outras empresas). Esses pedidos, portanto, **foram usados para desenvolver o conserto e não valem como aceite**.
- Por isso esta medida usa **cinco pedidos novos**, nunca enviados ao sistema antes (nem em A, B, C nem no desenvolvimento). Os resultados de A (2 de 5), B (4 de 5) e C (3 de 5) **não mudam**.

## Regra de página (a mesma da F8.10c, mecânica)

Uma página é aceita se alguma tabela extraída dela (`data/parsed/banco_do_brasil_formulario_referencia_2026.tabelas.json`, fora do git) tem uma **linha** cujo **primeiro campo** é o rótulo da série (sem acento, caixa nem pontuação) e que traz os **três valores, como no documento, em ordem** (2023, 2024, 2025), com ou sem outras células no meio. O teste calcula o conjunto no código e **reprova o pedido se for diferente do registrado abaixo** (calculado antes de rodar). Linha com os mesmos números e outro rótulo não conta. Cabeçalhos conferidos à mão: as colunas de valor são 2023, 2024 e 2025.

## Pedidos (fixos agora)

| Id | Pedido | Formato | Rótulo da linha | Série (R$ milhões, 2023 / 2024 / 2025) | Páginas aceitas |
|---|---|---|---|---|---|
| D1 | "Faça um gráfico dos depósitos de poupança de 2023 a 2025." | gráfico (`.svg`) | Depósitos de Poupança | 206.915 / 218.363 / 215.189 | 84 |
| D2 | "Monte uma tabela e uma planilha com a receita de tarifas e comissões de 2023 a 2025." | tabela e `.xlsx` | Receita de Tarifas e Comissões | 30.793 / 33.198 / 34.714 | 96 e 97 |
| D3 | "Gere um documento Word com os depósitos à vista de 2023 a 2025." | `.docx` | Depósitos à Vista | 109.358 / 107.901 / 92.013 | 84 |
| D4 | "Faça uma apresentação com a receita líquida de juros após provisão para perdas de 2023 a 2025." | `.pptx` | Receita Líquida de Juros após Provisão para Perdas | 63.396 / 56.808 / 34.377 | 93 |
| D5 | "Faça um gráfico do lucro líquido da Americanas de 2023 a 2025." | — | — | o documento é só do Banco do Brasil: tem de dar "não consta" | — |

- D2 tem duas páginas aceitas pela regra e a linha com percentuais no meio (`30.793 | 60,7 | 33.198 | 61,3 | 34.714 | 64,5 | …` na p. 96; `… | 100,0 | …` na p. 97).
- D3 tem uma série que **cai** (109.358 → 92.013), para o gráfico e o arquivo não assumirem alta.
- D4 é a linha mais funda de uma tabela longa (a p. 93, a mesma do C4): é o caso que o corte de 900 caracteres escondia, **sem** o nome da companhia no pedido, e com um rótulo longo.
- Nenhum desses números aparece em texto corrido (só em tabelas). "Americanas" tem 0 ocorrências em tabelas e em trechos.
- Nenhum rótulo tem sufixo de nota nem negativo; todos os valores são positivos.

## Itens por pedido (iguais aos da F8.10c)

D1 a D4 passam por **todos**: (1) evento `artefato` dentro do contrato; (2) rótulos 2023, 2024 e 2025 na ordem; (3) valores da tabela da tela iguais aos da série (tolerância de 0,5%); (4) **página**: toda célula cita ao menos uma página e todas as citadas estão nas aceitas; (5) gráfico carregado na tela quando o pedido ou o formato traz gráfico (D1, D4); (6) arquivo do formato pedido (D1 `.svg`, D2 `.xlsx`, D3 `.docx`, D4 `.pptx`) baixa com 200, MIME certo, até 5 MB, é relido e contém os três valores. **D5:** sem evento `artefato`, gráfico, tabela nem link de download, e a resposta diz que não consta, não encontrou, não traz ou não há.

## Regra de aceite (fixada agora)

Cumprido só se **5 de 5** passarem por todos os itens que se aplicam. A regra não muda depois. Reescrita só por decisão do dono, registrada como pós-hoc **com o resultado pela regra original mantido**; não há aceite pós-hoc de algo que falhou. Toda rodada ao vivo é contada. **Se der menos de 5 de 5, a F8.10 continua `[~]`** e não se mexe no sistema nem na regra na mesma rodada.

## Medidas à parte, sem entrar no aceite

- Pós-hoc informativo `paginasNoPdf`; tempo por pedido; `removidos`; tamanho dos arquivos; selo de estado (sabidamente `incompleta` em parte dos casos com material completo).
- **Limite conhecido e não consertado:** o texto do redator ainda usa o corte de 900 caracteres e pode dizer "não encontrei" ao lado de um material correto (visto em C1 e C4). Não entra no aceite.
- Limites gerais: n = 5, 1 execução cada; arquivos abertos por biblioteca; a verificação prova que o número está na evidência, não que está no ano certo (o gabarito confere).

## Reprodução

Com Neo4j, llama-swap e a API (`npm run build` em `api/` antes) no ar:

```powershell
cd e2e
$env:F810_CONJUNTO = "D"
npx playwright test --project=ao-vivo tests/ao-vivo/arquivos.spec.ts
```

Grava `eval/resultados/f810d-geracao.json` (ids, valores, páginas citadas, aceitas e calculadas, contagens e tempos; sem texto do documento, ADR-009).

## Rodadas (preenchido depois de rodar; toda rodada é contada)

_Nenhuma rodada ainda._
