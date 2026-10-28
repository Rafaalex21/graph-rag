# api

API e agente do GraphRAG local (Node 24, TypeScript 6.0, Fastify). Esqueleto da F0.8: só a rota
`GET /api/saude`. O agente, as ferramentas e o SSE (ARQUITETURA §7 e §11) entram na fase F7.

O TypeScript fica **fixado em 6.0.x**: o Angular 22 e o `typescript-eslint` ainda não aceitam a 7.x.

```powershell
. ..\infra\dev-env.ps1     # node e npm no PATH desta sessão
npm install
npm test
npm run lint
npm run build
```
