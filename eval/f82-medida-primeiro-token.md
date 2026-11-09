# F8.2: medida do primeiro token na tela (definição fixada ANTES de rodar)

Aceite da etapa: "tokens aparecem em ≤ 5 s numa pergunta simples".

## Definições

- **Pergunta simples**: as 5 primeiras do `eval/golden.csv` na categoria `factual_textual` (T01 a T05), as mesmas que a F7.13 já chamou de simples. Mais uma, T15, só para esquentar os modelos (não conta).
- **t0**: o instante (`performance.now()` da página) em que o Enter é disparado na caixa de texto.
- **Primeiro token na tela**: o primeiro instante em que a bolha da resposta (`[data-papel="assistente"] app-resposta-markdown`) tem texto visível (`textContent.trim() !== ''`), visto por um `MutationObserver` instalado antes do Enter. Mede-se também o **primeiro sinal de vida** (a bolha da resposta aparece, com "Gerando a resposta…") e o **fim** (o `role="status"` passa a "Resposta pronta.").
- **Ambiente**: Chrome embutido do app (Browser pane), `ng serve` com proxy `/api` para a API em `127.0.0.1:3000`, API em produção local (`npm run build; npm start`), Neo4j e llama-swap no ar, perfil `consultar` (o padrão da tela), uma conversa nova por pergunta, uma execução por pergunta, em sequência.
- **Verificação do streaming**: na T01 conta-se quantos textos distintos a bolha mostrou antes do "Resposta pronta." (mais de um = os tokens chegaram em pedaços pelo proxy, não de uma vez no fim).

## Regra de aceite (fixada agora)

- Aceite cumprido só se as **5 de 5** perguntas tiverem o primeiro token na tela em ≤ 5 s.
- Se não, a etapa fica `[~]` com os números como saíram, e a regra do aceite volta ao dono para decisão. Nada de trocar a medida depois.
- Limites já sabidos: o redator só começa a escrever depois do ciclo de busca (F7.4/F7.5), e a F7.6 mediu o primeiro token da API entre 2,8 e 21 s. Esta medida confere se a tela acrescenta algo a isso.

Reprodução: ver o ADR-068.
