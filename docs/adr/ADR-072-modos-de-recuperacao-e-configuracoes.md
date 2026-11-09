# ADR-072 · Modos de recuperação forçados e tela Configurações (modo e perfil)

- **Estado:** aceita (09/11/2026)
- **Data:** 2026-11-09
- **Tarefa(s):** F8.6

## Contexto

Até a F8.5 a API só aceitava `mode: "auto"` (os outros valores davam 400 `modo_nao_implementado`) e a página Configurações era um texto. A F8.6 entrega os modos e a tela que os escolhe. O aceite é "trocar o modo muda a rota observada no Rastro". A medida foi escrita antes de rodar (`eval/f86-medida-modo.md`, commit `fbbe7ae`) e os testes são só E2E (ADR-068), escritos antes do código.

## Decisão

- **Modo forçado = a ferramenta da subpergunta é fixa, sem LLM no roteamento.** `api/src/agente/modos.ts`: `trechos` → `buscar_trechos`, `tabelas` → `buscar_tabelas`, `local` → `entidade`, `global` → `panorama`, `cypher` → `consultar_grafo`; `auto` mantém o roteador. O roteamento forçado é uma chamada, `ms: 0`, sem plano de reserva. O resto do ciclo (reescrita, crítico, rodada 2, redator) não muda. O modo `local` passa a pergunta (cortada em 200 caracteres) como "nome" da entidade.
- **Onde entra:** `OpcoesAgente.modo` → `rotearCom` em `rotearSubperguntas`; o evento SSE `etapa{tipo:"rota"}` ganha `forcado: <modo>` só quando o modo não é `auto`. O contrato (`contracts/api.openapi.yaml`) e a ARQUITETURA §11.1 trazem a tabela modo → ferramenta; o 400 `modo_nao_implementado` foi removido.
- **Web:** `ConfiguracoesService` (raiz, signals `modo` e `perfil`, guardados em `localStorage["graphrag.config"]`; valor desconhecido ou armazenamento bloqueado → padrão, sem erro). A página tem dois `radiogroup` (modo com 6 opções, perfil com 2), cada opção com uma descrição ligada por `aria-describedby`, "Configuração salva." num `role="status"` e "Restaurar o padrão". O `ChatService` manda `mode`/`profile` **só quando diferem do padrão** (os corpos de pedido de antes não mudam). O chat mostra "Modo: … · Perfil: …" com o link "Alterar modo e perfil". No Rastro, o passo "Rota" ganhou o atributo `data-ferramentas` e a linha "Modo forçado: <rótulo>".
- **Perfil:** `consultar-rapido` já existia na API (F7.13: só a rodada 1); a tela só o escolhe.

## Alternativas consideradas

- **Dica ao roteador ("prefira tabelas") em vez de forçar:** o Qwen não a obedece sempre e a rota observada deixaria de ser determinística, que é o que o aceite pede.
- **Guardar a escolha na API (por conversa):** exigiria estado no servidor para uma preferência que é do navegador; o `localStorage` basta.
- **Mandar sempre `mode`/`profile` no corpo:** mudaria todos os corpos já testados sem ganho.

## Consequências

- **A qualidade num modo forçado não foi medida e, na prática, é pior fora do `auto`:** na medida abaixo, de 15 execuções forçadas só 6 terminaram `suficiente` (T15 nos 5 modos e N01 em `cypher`); as outras 9 terminaram `incompleta` (a crítica não achou o dado e o ciclo seguiu até o limite; os passos de cada rodada estão no JSON). O modo existe para inspecionar e comparar ferramentas, não para melhorar a resposta.
- **`panorama` forçado levou 100,1 s em N01 e G03** (ambas quase idênticas, o que sugere um teto de tempo de alguma etapa; a causa não foi investigada) contra 22,9 s em T15. Fica como dívida.
- O modo `local` com uma pergunta inteira como "nome" devolve entidades ao acaso (24, 43 e 62 evidências nas três perguntas).
- A escolha vale por navegador e não é compartilhada entre abas abertas ao mesmo tempo (a segunda aba só lê o `localStorage` ao carregar).

## Evidência

**E2E da interface** (`cd e2e; npm test`): 123 testes passam (19 novos em `configuracoes.spec.ts`), e 246 de 246 numa repetição (`--repeat-each=2`). Cobrem: página com 6 + 2 opções e padrões marcados, descrição acessível, salvar e sobreviver ao recarregamento, restaurar o padrão, valor guardado inválido, `localStorage` bloqueado, setas do teclado, 375 px sem rolagem horizontal, corpo do pedido (padrão sem `mode`; escolhido com `mode` e `profile`, valendo só para as perguntas seguintes), legenda do chat e o link, rota do Rastro com marca "Modo forçado" nos 5 modos, `auto` sem a marca, as 5 rotas diferentes entre si, troca no meio da conversa e perfil rápido com uma rodada contra duas. `ng lint` limpo, `ng build` sem avisos (chunk da página de 3,8 kB); API: `tsc`, lint e build limpos.

**Pilha real** (`cd e2e; npm run test:ao-vivo -- modo`, `eval/resultados/f86-modo.json`, ids, rotas e tempos): T15, N01 e G03, cada uma no `auto` e nos 5 modos, trocando o modo pela tela Configurações. **15 de 15 execuções forçadas tiveram como rota observada exatamente a ferramenta do modo**; em cada pergunta as 5 rotas forçadas foram diferentes entre si e **todas as 5** diferiram da do `auto` (a regra pedia pelo menos 4): T15 `pessoas_cargos`, N01 `fato_financeiro`, G03 `consultar_grafo+buscar_tabelas+buscar_trechos`. O `mode` do corpo de `POST /api/chat` foi o escolhido nas 18 execuções. Perfil rápido (T15, `auto`): `profile: "consultar-rapido"` no corpo, 1 passo "Rota" e nenhuma "Rodada 2" (10,6 s contra 16,2 s da mesma pergunta no perfil padrão). O aceite se cumpre pela regra fixada antes de rodar.

**Limites:** n = 3 perguntas, 1 execução por par; a rota do `auto` depende do Qwen; a medida só olha a rota, não a qualidade da resposta; as rotas `pessoas_cargos` e `fato_financeiro` do `auto` são ferramentas especializadas que os 5 modos forçados não alcançam (só o `auto` as usa).

Reproduzir: `cd e2e; npm ci; npm test` (interface); com Neo4j, llama-swap e a API no ar (`cd api; npm run build; node dist/server.js`), `npm run test:ao-vivo -- modo`.
