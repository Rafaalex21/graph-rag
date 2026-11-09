# F8.7: medida de "5 perguntas do golden set feitas pela interface sem tocar no terminal" (definição fixada ANTES de rodar)

Aceite da etapa: "5 perguntas do golden set feitas pela interface sem tocar no terminal".

## O que a etapa entrega (para a medida fazer sentido)

- **Selo de saúde** no topo de todas as páginas: "Sistema: no ar", "degradado" (llama-swap ou Neo4j fora, ou índice que não está ONLINE) ou "fora do ar" (a API não respondeu). Vem de `GET /api/saude`, é consultado ao abrir a página, a cada 30 s e sob demanda ("Verificar de novo"), e abre um painel com o estado de cada parte.
- **Feedback por resposta:** cada resposta pronta tem "Resposta útil" e "Resposta não útil" (nota `1` ou `-1` em `POST /api/feedback`, usando o `mensagemId` do evento `fim`) e um comentário opcional.

## Definições

- **Perguntas (fixadas agora, uma por categoria do golden, sem olhar resultado):** **T15** (factual de texto), **N01** (numérica), **G03** (agregação), **P01** (temática global) e **F01** (fora do escopo, "Olá, tudo bem?").
- **"Pela interface, sem tocar no terminal":** o teste só usa o navegador (a caixa de pergunta, os botões, o selo). Não chama a API por fora (`curl`, `fetch` do teste) nem lê log do terminal. Os serviços (Neo4j, llama-swap, API) são iniciados **antes**, pelos scripts `infra\`, como em qualquer uso: a interface não os inicia, e o selo de saúde é o que diz ao usuário se estão no ar. Isto é um limite declarado, não parte da medida.
- **Por pergunta, o fluxo completo é:** (1) o selo diz "no ar" antes de perguntar; (2) a pergunta é digitada e enviada; (3) a resposta termina com "Resposta pronta." (não com erro) e tem texto; (4) o usuário avalia a resposta pelos botões: **nota `1` se a resposta traz pelo menos uma citação de página (chip), `-1` se não traz** (regra mecânica, fixada agora; ela não mede se a resposta está certa) e, nas de nota `-1`, um comentário fixo ("sem citação de página"); (5) a tela confirma "Nota registrada." e o navegador recebe `201` do `POST /api/feedback`.
- **Verificação do registro:** o arquivo de feedback da API (`FEEDBACK_JSONL`) é lido **depois** do teste e tem, para cada uma das 5 respostas, uma linha com o `mensagemId` visto no `fim` e a nota enviada.

## Regra de aceite (fixada agora)

Cumprido só se as **5 de 5** perguntas passarem pelos cinco passos acima **e** o arquivo de feedback tiver as 5 linhas certas (mesmo `mensagemId` e nota). Uma pergunta que termina em erro, ou cujo registro de nota falha, conta como não cumprida; a regra não muda depois (uma reescrita só por decisão do dono, registrada como pós-hoc).

## Medidas à parte, sem entrar no aceite

- O tempo de cada pergunta, o número de citações, o estado do ciclo e se a resposta foi "não consta" (para F01).
- O selo depois da última pergunta (deve continuar "no ar").
- A **qualidade** das respostas não é medida aqui (já tem as medidas das F7); a nota do teste é mecânica e não vale como avaliação de qualidade.

Limites já sabidos: n = 5 perguntas, 1 execução por pergunta; a medida prova que o fluxo funciona de ponta a ponta pela interface, não que as 5 respostas estão certas; o caso "pilha fora do ar" (selo "fora do ar" ou "degradado") só é exercitado nos E2E com a API falsa, porque derrubar o Neo4j no meio da medida exigiria o terminal.

Reprodução: ver o ADR-073.
