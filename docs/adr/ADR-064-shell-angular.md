# ADR-064 · Shell Angular 22: rotas carregadas sob demanda, painel do chat como rotas filhas e tema claro/escuro por tokens CSS

- **Estado:** aceita (07/11/2026)
- **Data:** 2026-11-07
- **Tarefa(s):** F8.1

## Contexto

O aceite da F8.1 é: build de produção sem avisos. A `web/` era o esqueleto da F0.8 (uma página com título e o roteador vazio). A ARQUITETURA §12 define a disposição (chat ao centro, painel lateral com as abas Rastro, Fontes e Grafo) e o tema claro e escuro; as tarefas F8.2 a F8.7 preenchem cada parte, então o shell precisa deixar o lugar de cada uma pronto sem fingir que já funcionam.

## Decisão

- **Rotas** (`app.routes.ts`), todas carregadas sob demanda: `/` leva a `/chat`; `/chat` (página com a conversa e o painel) tem as filhas `rastro` (a padrão), `fontes` e `grafo`; `/configuracoes`; `**` mostra "Página não encontrada" com o caminho de volta. A aba ativa fica na URL, então o link para uma aba funciona e as F8.3 a F8.5 trocam o componente de cada aba sem mexer no resto. O título e o conteúdo provisório de cada aba vêm do `data` da rota (`withComponentInputBinding`); o texto provisório diz o que a aba vai mostrar, sem simular dados.
- **Shell** (`app.ts`, `app.html`): `header` com a marca, `nav` "Principal" (Chat, Configurações; a atual leva `aria-current="page"`), botão de tema e `main#conteudo`, com o link "Ir para o conteúdo". O `href="#conteudo"` sozinho navegaria para `/#conteudo` por causa do `<base href="/">`, então o clique foca o `main` direto.
- **Tema** (`tema/tema.service.ts`, `styles.scss`): preferência `sistema` (padrão), `claro` ou `escuro`, em um `signal`, gravada em `localStorage` (`graphrag.tema`); o botão percorre os três estados e escreve a preferência em texto ("Tema: sistema"). As cores são variáveis CSS (`--fundo`, `--superficie`, `--texto`, `--texto-suave`, `--borda`, `--realce`, `--destaque`). O escuro vale quando o sistema pede e o usuário não escolheu "claro" (`@media (prefers-color-scheme: dark)` com `:root:not([data-theme='light'])`), ou quando escolheu "escuro" (`data-theme="dark"`); em `sistema` o `data-theme` nem existe, e quem decide é o CSS (sem depender de JavaScript para o caso comum). Com uma escolha explícita contrária ao sistema (p. ex. `claro` num sistema escuro), o atributo só entra quando o Angular inicia, e uma piscada breve é possível; não foi medida. Valor salvo inválido, `localStorage` que lança e navegador sem `matchMedia` não quebram nada; o ouvinte do sistema é removido ao destruir o serviço.
- **Endereço malformado** (`/%E0%A4%A`): o roteador do Angular volta para `/` sem avisar; um `SerializadorTolerante` o troca por um caminho que não existe, e a rota `**` responde "Página não encontrada".
- **Acessibilidade e responsividade:** um `h1` por página, marcos `header`/`nav`/`main`/`aside`, foco visível, `prefers-reduced-motion` respeitado, `lang="pt-BR"`; abaixo de 56 rem o painel passa para baixo da conversa; o cabeçalho quebra linha em vez de estourar a largura.

## Resultado

**Testes** (escritos antes do código, Vitest com jsdom): 29, todos passam (`ng test`). Modos de falha cobertos: valor salvo inválido (`roxo`, vazio, `ESCURO`, JSON, `<script>`), `localStorage` que lança na leitura e na gravação, ausência de `matchMedia`, mudança do sistema com `sistema` e com escolha explícita, o ciclo dos três estados e o atributo `data-theme`, ouvinte removido ao destruir, a raiz que leva a `/chat/rastro`, um `h1` por página, quatro endereços inexistentes (incluindo o malformado) com o caminho de volta, título da aba por rota, marcos e link de pular, `aria-current` só na página atual e na aba ativa, botão de tema.

**Build e verificação no navegador:**

| | |
|---|---|
| `ng build` (produção) | **sem avisos nem erros**; 225,9 kB iniciais (61,8 kB transferidos), as quatro páginas em pedaços de 0,5 a 1,8 kB |
| `ng lint` | limpo (inclui as regras de acessibilidade de template) |
| Contraste (calculado, WCAG) | texto, texto suave e destaque sobre superfície, fundo e realce: **mínimo 5,72:1** no claro e no escuro (exigido: 4,5:1) |
| Navegador (`ng serve`, painel do app) | sem erros no console; sistema escuro aplicado sem `data-theme`; o botão gravou `claro` e a escolha **sobreviveu ao recarregamento**; `/nao-existe` mostra a página de erro com o título certo; o link de pular focou o `main` sem sair da rota |
| Defeito achado nessa verificação | em 375 px o cabeçalho passava 11 px da largura (rolagem horizontal, botão de tema cortado); corrigido com `flex-wrap`, depois `scrollWidth` = `clientWidth` |

## Consequências

- **O shell é só estrutura:** o chat, o rastro, as fontes, o grafo e as configurações não fazem nada ainda (F8.2 a F8.7); os textos provisórios dizem isso. Não há lista de conversas (a §12 prevê uma coluna; entra com o chat, F8.2) nem selo de saúde (F8.7).
- **Limites ditos:** a verificação em navegador foi manual, em um só navegador (o do painel do app), em duas larguras (desktop e 375 px); não há teste automatizado de layout, que só a F8.8 (Playwright) cobre; o endereço malformado foi testado no roteador, não no navegador (o servidor de desenvolvimento do Angular responde 500 a esse endereço antes de a página carregar, o que é do servidor, não do shell); os contrastes foram calculados, não medidos na tela; o tema por `localStorage` não é compartilhado entre navegadores.
- **Sem proxy para a API ainda:** a API não tem CORS (ADR-062); o `ng serve` precisará de um `proxy.conf.json` para `/api` na F8.2, que é quando o primeiro `fetch` aparece.

## Como reproduzir

```powershell
. .\infra\dev-env.ps1
cd web
npx ng test --watch=false     # 29 testes
npx ng lint
npx ng build                  # produção; sem avisos
npx ng serve                  # http://localhost:4200
```
