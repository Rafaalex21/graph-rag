# ADR-013 · Ferramentas de desenvolvimento portáteis e TypeScript 6.0 fixado

- **Estado:** aceita (28/10/2026)
- **Data:** 2026-10-28
- **Tarefa(s):** F0.8

## Contexto

A F0.8 cria o esqueleto dos três apps. A inspeção do ambiente mostrou que **Node, npm e uv não estão instalados** (só o Python 3.12 e o git), ao contrário do que o início do projeto supunha. Além disso, o `latest` do TypeScript no npm é a **7.0.2**, mas o Angular 22 (`@angular/compiler-cli`, `@angular/build`) exige `typescript >=6.0 <6.1` e o `typescript-eslint` 8.x aceita `<6.1.0`.

## Decisão

1. **Node 24.22.1 (LTS) e uv 0.13.6 portáteis** em `infra/bin/`, com hash conferido, no mesmo padrão do JDK da F0.7. O `infra/dev-env.ps1` põe os dois no PATH **da sessão**, redireciona os caches do npm e do uv para `infra/bin/` e desliga analytics, notificador de atualização e download de Pythons pelo uv. Nada é instalado no sistema e nenhuma permissão de administrador é usada.
2. **TypeScript fixado em 6.0.3** (versão exata) na `api` e no `web`, até que o Angular e o `typescript-eslint` aceitem a 7.x.
3. **Versões exatas** nas dependências da API (`--save-exact`) e **travas versionadas** (`indexer/uv.lock`, `api/package-lock.json`, `web/package-lock.json`).
4. **Testes sem navegador**: o Angular 22 gera Vitest + jsdom por padrão, então `ng test` roda em qualquer lugar. O CI deixa de usar Karma e Chrome.
5. **CI corrigido**: os jobs usavam `test -f pyproject.toml` (e `package.json`) com `working-directory: .`, ou seja, olhavam a raiz do repositório e **pulariam os três jobs em silêncio, para sempre**. Agora os jobs rodam sem esse guarda, já que os esqueletos existem.

## Alternativas consideradas

- **Instalar Node e uv no sistema (winget, instaladores).** Mexe no PATH global e pode exigir administrador; os portáteis são reproduzíveis e removíveis apagando `infra/bin/`.
- **TypeScript 7.0.2.** É o `latest`, mas quebra o Angular 22 e o `typescript-eslint`.
- **Karma + ChromeHeadless para o Angular.** O schematic oferece, mas exige Chrome no CI e na máquina; o Vitest com jsdom dispensa o navegador (a contrapartida é não testar em um navegador real, o que a F8 pode complementar).

## Consequências

- Reproduzir o ambiente é baixar dois zips e rodar `npm ci` / `uv sync --frozen`; a F10.2 automatiza.
- Mudar a versão do TypeScript exige confirmar antes os `peerDependencies` do Angular e do `typescript-eslint`.
- Os testes de componente rodam em jsdom, que não é um navegador: comportamentos de layout, `pdf.js` e canvas (F8.4, F8.5) precisarão de teste próprio.

## Verificação do aceite da F0.8

| App | Comando | Resultado |
|---|---|---|
| indexer | `uv run pytest` | 1 passed |
| indexer | `uv run ruff check .` | All checks passed |
| api | `npm test` (Vitest 5.0.5) | 1 passed |
| api | `npm run lint` · `npm run typecheck` · `npm run build` | sem erros |
| web | `ng test --watch=false` (Vitest 5.0.5 + jsdom) | 2 passed |
| web | `ng lint` | All files pass linting |
| web | `ng build` (produção) | 190,40 kB inicial, 52,03 kB transferido, sem avisos |

Saída bruta em [`ADR-013-bruto/aceite.txt`](ADR-013-bruto/aceite.txt).

## Ressalvas

1. O tamanho dos pacotes: `web/node_modules` 241 MB, `api/node_modules` 87 MB, cache do npm 527 MB e cache do uv 36 MB, tudo ignorado pelo git.
2. `angular-eslint` 22.6.0 trouxe `typescript-eslint` 8.71.0 no `web`, enquanto a `api` usa a 8.72.1; são independentes e ambos aceitam o TypeScript 6.0.
3. O Python do indexador é o do sistema (3.12.0). O uv foi impedido de baixar outro (`UV_PYTHON_DOWNLOADS=never`).

## Evidência

Versões consultadas em 28/10/2026 no registro do npm (`@angular/cli` 22.2.5, `@angular/build`, `@angular/compiler-cli`, `typescript-eslint`, `vitest`, `eslint`, `fastify`), em `nodejs.org/dist` (Node 24.22.1 LTS e `SHASUMS256.txt`), na API de releases do GitHub (uv 0.13.6) e no PyPI (pytest 9.2.0, ruff 0.17.3).
