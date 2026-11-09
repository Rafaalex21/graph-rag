# ADR-074 · Tela do usuário final (assistente) e modo técnico para desenvolvedores

- **Estado:** aceita (09/11/2026)
- **Data:** 2026-11-09
- **Tarefa(s):** F8.9

## Contexto

Depois de ver a tela técnica (chat com Rastro, Fontes e Grafo), o dono pediu uma tela para um usuário final, com UI/UX bonita, e aprovou um protótipo de design (Artifact). A tela técnica fica como modo para desenvolvedores. O aceite e a medida foram escritos antes do código (`eval/f89-medida-assistente.md`, commit `eb13824`) e ajustados uma vez, ainda antes de qualquer rodada ao vivo (commit `a6156ad`). Os testes são só E2E (ADR-068), escritos antes do código.

## Decisão

- **Rotas:** `/` leva a `/assistente`; `/chat` e `/configuracoes` continuam como estavam. O cabeçalho técnico ganhou o link "Assistente" e some na tela do assistente, que tem a própria barra com o link "Modo técnico".
- **Mesmo chat, outra apresentação.** O assistente usa o `ChatService` e as Configurações do modo técnico (modo e perfil no mesmo `localStorage`). Uma conversa começada numa tela continua na outra.
- **Peças** (`web/src/app/assistente/`, `paginas/assistente/`): `BarraLateral` (marca, Nova conversa, recentes, estado do sistema, tema, Modo técnico), `CartaoResposta`, `Compositor` (caixa e "Como buscar", 6 modos com nomes simples) e o painel da fonte. Tudo que vem da API entra como texto.
- **Selo de estado** vem de `metricas.estado` do `fim`: `suficiente` com evidência → "Encontrado no documento"; `incompleta` → "Encontrei só em parte"; `ausente` → "Não consta no documento" (neutro, nunca erro); erro → "Não consegui responder"; `suficiente` sem evidência ou `sem_consulta` (saudação) → nenhum selo.
- **Cartões de fonte:** um por fonte **citada** (`citacoes`) com página, sem repetir; se nenhuma citada tem página, as 3 primeiras evidências com página. Clicar abre o painel (o mesmo pdf.js da aba Fontes, agora o componente `VisualizadorFonte`, com `pagina` e `fonteId` de entrada) na primeira página do rótulo, com o trecho destacado. A citação `[p. N]` no texto também abre o painel.
- **"Como cheguei a esta resposta":** passos em português simples montados dos mesmos eventos do Rastro (`montarRastro`), sem Cypher nem nomes de ferramenta. Só existe quando a resposta buscou algo (a reescrita sozinha não conta).
- **Conversas recentes** (`HistoricoService`): até 20 no `localStorage` (`graphrag.historico`), com mensagens, eventos e `conversationId`; restaurar uma conversa continua a mesma. Armazenamento bloqueado, cheio ou com lixo nunca quebra a tela.
- **Visual:** paleta verde-petróleo própria, escopada em `.assistente` (claro e escuro; contrastes de texto, selos e botões acima de 4,5:1, conferidos por cálculo). Fontes Inter e Space Grotesk servidas pelo app (`@fontsource-variable` 5.3.0, só os subconjuntos latin), nada de CDN: o produto é 100% local. No celular a barra vira um menu e o painel da fonte uma folha de tela cheia.

## Alternativas consideradas

- **Google Fonts do protótipo:** contraria o "100% local" e vaza o acesso à tela para terceiros.
- **Um cartão por evidência (como a medida dizia):** uma resposta real tem até 52 evidências; misturaria o que a resposta citou com o que só foi consultado. Mudado antes de rodar e registrado no commit `a6156ad`.
- **Número em destaque e gráfico por resposta (como no protótipo):** o protótipo usava dados escolhidos à mão; uma resposta real é texto com citações, e extrair um valor para destacar seria inventar estrutura que a API não entrega. Ficou de fora.
- **Duas aplicações separadas:** duplicaria o estado do chat e o cliente SSE.

## Consequências

- A tela não mostra tudo o que o Rastro mostra (Cypher, notas de relevância, rodadas); isso continua no modo técnico, a um clique.
- O histórico é só deste navegador (não sincroniza); com muitas conversas longas o `localStorage` pode encher e as mais antigas saem.
- O tipo de uma fonte que a tela não conhece aparece como "Fonte" (na rodada real, o cartão de uma entidade).
- Defeitos achados pelos testes ou pela medida, já corrigidos: o botão de enviar passava da borda da coluna (grades sem `minmax(0, 1fr)`; o `overflow: hidden` da página escondia isso de um teste de rolagem, por isso há um teste que mede cada peça); o botão verde do tema escuro tinha contraste 4,27:1 (agora 6,42:1); o passo a passo aparecia numa saudação que emite a reescrita (achado pela medida ao vivo, com teste novo).

## Evidência

**E2E da interface** (`cd e2e; npm test`): 204 testes passam (46 novos do assistente) e 408 de 408 em duas repetições (`--repeat-each=2`). Cobrem: tela inicial e sugestões, Enter e Shift+Enter, os quatro selos e a saudação sem selo, erro com "Tentar de novo", Parar, HTML hostil, tabela, cartões (repetidos, sem página, sem citação), painel na página certa, troca de cartão, fechar, chip de citação, passo a passo (sem Cypher), nota e comentário (e falha), modo e perfil (os mesmos de Configurações), recentes (restaurar, recarregar com o mesmo `conversationId`, apagar, título cortado, `localStorage` bloqueado), estado do sistema, tema, modo técnico, encaixe das peças na tela e celular (390 e 320 px, menu, folha da fonte). `ng lint` limpo e `ng build` sem avisos (277,9 kB iniciais; o chunk do assistente é carregado sob demanda).

**Pilha real** (`eval/resultados/f89-assistente.json`, só ids e números): T15, N01, G03, P01 e F01 só pela tela `/assistente`, começando em `/`. **5 de 5** pelos itens que se aplicam a cada uma, e o link "Modo técnico" leva a `/chat/rastro`. Selo certo em todas (T15, N01 e P01 "Encontrado", G03 "Encontrei só em parte", F01 `sem_consulta` sem selo); primeiro cartão abre a página certa (315, 80, 368 e 143 de 423; o desenho em 33 a 555 ms depois do clique); passo a passo com 6, 6, 11 e 15 passos (F01 não buscou: sem botão); 5 notas confirmadas na tela com `201`. Tempos das respostas: 8,5, 8,5, 28,0, 18,8 e 3,4 s. A captura a 1280 px ficou em `data/avaliacao/f89-assistente-1280.png` (fora do git: mostra texto do documento).

**Histórico das rodadas ao vivo (todas contadas):** a 1ª abortou por defeito do meu teste (ler o corpo SSE com `response.text()` não funciona depois do fluxo) antes de gravar resultado; a 2ª deu **2 de 5** (`f89-assistente-rodada2.json`) por dois defeitos: o teste contava os passos antes de a lista aparecer (N01 e G03) e o app oferecia o passo a passo na saudação (F01), contra a regra fixada; corrigi o teste e o app (com teste E2E que falhava antes) e a 3ª deu 5 de 5. A regra de aceite não mudou entre as rodadas.

**Limites:** n = 5 perguntas, 1 execução por pergunta; os serviços foram iniciados antes, pelos scripts `infra\`; a medida prova o fluxo de ponta a ponta, não que as respostas estão certas (a nota é mecânica, como na F8.7); a tela não destaca número nem desenha gráfico por resposta; F01 não exercita o painel da fonte; o visual foi conferido a olho em 1280 px (claro) e no celular, o escuro só por cálculo de contraste e pelos testes.

Reproduzir: `cd e2e; npm ci; npm test` (interface); com Neo4j, llama-swap e a API no ar (`FEEDBACK_JSONL=<arquivo>` ao subir a API), `npx playwright test --project=ao-vivo tests/ao-vivo/assistente.spec.ts`.
