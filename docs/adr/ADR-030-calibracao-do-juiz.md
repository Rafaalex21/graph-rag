# ADR-030 · Calibração do juiz contra 20 rótulos manuais

- **Estado:** aceita (28/10/2026), com a ressalva de rotulagem abaixo
- **Data:** 2026-10-28
- **Tarefa(s):** F3.4

## Contexto

O aceite da F3.4 é concordância ≥ 80% entre o juiz local (Gemma 4 26B-A4B, [ADR-028](./ADR-028-metricas-com-juiz-local.md)) e 20 rótulos manuais. Sem isso, as notas de correção da F3.2 não têm lastro.

## Decisão

1. **Módulo `indexer/src/indexer/calibrar.py`** (sem LLM): `planilha` escolhe e exibe as 20 respostas; `concordancia` compara os rótulos com o veredito de correção do juiz.
2. **Amostra estratificada e determinística** (semente 34, ordem embaralhada) sobre a execução `f3-2-a3-60`: 4 numéricas respondidas, 4 temáticas, 2 multi-hop, 4 factuais, 3 fora do escopo e 3 recusas de perguntas que tinham resposta. O veredito do juiz serviu só para a amostra ter casos fáceis e difíceis; **a planilha não o mostra**, então o rótulo é cego.
3. **Critério do rótulo = critério do prompt do juiz:** `c` (todos os fatos do gabarito, sem contradição), `p` (parte dos fatos) e `i` (contradiz, erra valor/unidade ou não responde); recusa vale `c` em pergunta sem resposta e `i` em pergunta com resposta.
4. **Rótulos em `eval/calibracao_juiz.csv`** (`posicao, id, rotulo, rotulador`, sem texto do documento); a planilha de leitura fica em `data/avaliacao/` (fora do git). O comando `planilha` nunca sobrescreve rótulos já dados.
5. **Só a correção foi calibrada.** Rotular fidelidade exigiria conferir cada afirmação contra os trechos recuperados, o que não coube nesta tarefa.

## Ressalva sobre quem rotulou

Os 20 rótulos foram dados **pelo Claude, a pedido do Rafael** (campo `rotulador = claude`), e não por uma pessoa. O Claude não é o juiz (modelo e prompt diferentes) e rotulou lendo só a planilha cega, mas escreveu o golden set e o `ask` ([ADR-027](./ADR-027-golden-set.md)) e conhecia o tamanho de cada estrato; é uma verificação independente do juiz, **não** a validação humana que a tarefa descreve. Recomendação: o Rafael conferir os 20 rótulos (em especial o item **N01**, abaixo) e, se discordar de algum, editar o CSV e rodar `python -m indexer.calibrar concordancia --nome f3-2-a3-60`.

## Verificação do aceite da F3.4

Evidência: `eval/resultados/calibracao-f3-2-a3-60.json` (cópia em `ADR-030-bruto/`).

| Medida | Resultado |
|---|---|
| **Concordância exata (3 classes)** | **19 de 20 = 95%** (meta ≥ 80%) |
| Concordância correta × não correta | 95% |
| Kappa de Cohen | 0,83 |
| Matriz (humano → juiz) | correta → correta 16, correta → incorreta 1; incorreta → incorreta 3; nenhuma `parcial` |
| Divergência | **N01** |

A única divergência é a N01: o gabarito é "R$ 16.782 milhões" e a resposta diz "R$ 16,8 bilhões". Rotulei `c`, pelo mesmo critério da F3.3 (arredondamento de 0,1%, dentro da tolerância de 0,5%); o juiz, que exige valor exato, marcou `incorreta`. É uma questão de política, não de erro do juiz: se a resposta arredondada deve valer ou não. Com o rótulo `i` a concordância seria 20 de 20; com `p`, 19 de 20.

## Consequências e ressalvas

- **A classe `parcial` não foi testada:** nenhuma das 20 respostas foi rotulada nem julgada `parcial`. Das 60 respostas da rodada, o juiz deu `parcial` a uma só. Quando surgirem mais respostas parciais (F3.5, com A0 a A2), vale rotular algumas.
- **Recusas dominam a parte fácil:** 6 dos 20 itens são recusas (3 certas, 3 erradas), em que o juiz quase não tem o que errar; nos 14 itens com resposta de fato, o juiz concordou em 13.
- Vinte itens dão uma margem larga (um item vale 5 pontos): o resultado diz que o juiz não está quebrado, não que ele erra menos de 5%.
- A política de arredondamento (N01) deve ser decidida antes da F3.5, para a regra numérica e o juiz usarem o mesmo critério.
