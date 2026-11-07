# web

Interface do assistente (Angular 22, standalone, signals, sem zone.js, SCSS). O shell da F8.1 está pronto: rotas sob demanda
(`/chat` com as abas Rastro, Fontes e Grafo, `/configuracoes`, página de erro), cabeçalho acessível e tema claro/escuro/sistema
(ADR-064). O chat, o painel de rastro, o visualizador de fontes e o grafo (ARQUITETURA §12) entram nas tarefas F8.2 a F8.7.

O TypeScript fica **fixado em 6.0.x**: o Angular 22 exige `>=6.0 <6.1`. Os testes usam Vitest com jsdom
(`ng test` roda sem navegador).

```powershell
. ..\infra\dev-env.ps1     # node e npm no PATH desta sessão
npm install
npx ng test --watch=false
npx ng lint
npx ng build
npx ng serve                # http://localhost:4200
```
