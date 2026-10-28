# web

Interface do assistente (Angular 22, standalone, signals, sem zone.js, SCSS). Esqueleto da F0.8: uma página
com título e o roteador vazio. O chat, o painel de rastro, o visualizador de fontes e o grafo (ARQUITETURA §12)
entram na fase F8.

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
