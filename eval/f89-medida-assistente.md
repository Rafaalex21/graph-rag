# F8.9: medida da tela do usuário final (definição fixada ANTES de rodar)

Aceite da etapa: "as 5 perguntas do golden feitas só pela tela do assistente (`/assistente`) mostram, em cada resposta, o estado certo, a fonte que abre a página certa, o passo a passo e a nota registrada; o modo técnico continua em `/chat`".

## O que a etapa entrega (para a medida fazer sentido)

- **`/assistente` (a tela inicial):** barra lateral (marca, "Nova conversa", conversas recentes guardadas no navegador, estado do sistema, tema e o link "Modo técnico"), conversa ao centro e, ao lado, o painel da fonte.
- **A resposta** vem num cartão com: o **selo de estado** (a partir de `metricas.estado` do evento `fim`), o texto com as citações de página, os **cartões de fonte** (um por evidência com página, sem repetir), a nota (Resposta útil / Não ajudou) e **"Como cheguei a esta resposta"** (os passos em português simples, montados dos eventos do Rastro).
- **O painel da fonte** é o mesmo visualizador da aba Fontes (pdf.js, trecho destacado), agora reaproveitado como componente.
- **Como buscar** (os 6 modos) e **Completa / Rápida** (o perfil) ficam na própria tela e são os mesmos de Configurações (mesmo `localStorage`).
- **O modo técnico** (`/chat` com Rastro, Fontes e Grafo, e `/configuracoes`) continua como estava, com um link de volta para o assistente.

## Definições

- **Perguntas (as mesmas da F8.7, fixadas agora):** **T15**, **N01**, **G03**, **P01** e **F01**.
- **Só pela tela do assistente:** o teste começa em `/` (que tem de levar a `/assistente`), digita a pergunta na caixa e usa só os botões e cartões da tela. Os serviços (Neo4j, llama-swap, API) são iniciados antes, pelos scripts `infra\` (mesmo limite da F8.7).
- **Selo esperado:** o `estado` do `fim` da resposta SSE (lida do corpo do `POST /api/chat`, como nas medidas anteriores): `suficiente` com pelo menos uma evidência → "Encontrado no documento"; `incompleta` → "Encontrei só em parte"; `ausente` → "Não consta no documento"; `suficiente` sem nenhuma evidência (a saudação) → **nenhum selo**; resposta com erro → "Não consegui responder".
- **Fonte que abre a página certa:** nas respostas com pelo menos um cartão de fonte com página, clica-se no **primeiro** cartão com página; vale se o painel mostrar "Página N de 423" e o desenho (`canvas`) com o nome "Página N do documento", onde **N é a primeira página do rótulo do cartão**. Não se aplica à resposta sem cartão com página.
- **Passo a passo:** "Como cheguei a esta resposta" abre com pelo menos 3 passos (itens da lista).
- **Nota:** um clique em "Resposta útil" ou "Não ajudou" (regra mecânica da F8.7: útil se há citação de página, senão não ajudou) é confirmado na tela ("Nota registrada.") e o navegador recebe `201`.
- **Modo técnico:** no fim, o link "Modo técnico" leva a `/chat` (o título da página é "Chat · GraphRAG local").

## Regra de aceite (fixada agora)

Cumprido só se as **5 de 5** perguntas passarem por todos os itens que se aplicam a elas (selo, fonte, passo a passo, nota) **e** o link do modo técnico funcionar. A regra não muda depois (uma reescrita só por decisão do dono, registrada como pós-hoc).

## Medidas à parte, sem entrar no aceite

- O tempo de cada pergunta, o tempo do clique no cartão de fonte até o desenho da página, o número de cartões de fonte e de passos.
- A **qualidade** das respostas não é medida (já tem as medidas das F7); a nota do teste é mecânica.
- Uma captura de tela da tela do assistente a 1280 px, para o olho (não entra na regra).

Limites já sabidos: n = 5 perguntas, 1 execução cada; a tela **não** destaca um número em tamanho grande nem desenha gráfico por resposta (o protótipo do design fazia isso com dados escolhidos à mão; uma resposta real é texto com citações); a resposta sem evidência com página (F01) não exercita o painel da fonte.

Reprodução: ver o ADR-074.
