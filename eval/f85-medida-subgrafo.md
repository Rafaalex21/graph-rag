# F8.5: medida do "subgrafo de uma pergunta 'quem é…' renderizado em ≤ 1 s" (definição fixada ANTES de rodar)

Aceite da etapa: "subgrafo de uma pergunta 'quem é…' renderizado em ≤ 1 s".

## Definições

- **Perguntas**: todas as perguntas dos conjuntos de avaliação (`eval/golden*.csv`) que começam com "Quem é": **T01**, **E04** e **E07**. Não há outras; não se inventam perguntas para aumentar o n.
- **Subgrafo da resposta**: as entidades que aparecem como evidência da resposta (evento `evidencia` do SSE com `tipo` `entidade` ou `id` começando em `ent:`), com a vizinhança de profundidade 1 de cada uma (`GET /api/grafo/vizinhanca`), unidas sem repetir nós e arestas (no máximo 6 entidades-semente por resposta).
- **Pergunta medida**: aquela cuja resposta tem pelo menos uma entidade como evidência. A que não tem **não tem subgrafo para desenhar**: entra no resultado como "sem entidade na resposta" (com os ids das evidências), não conta como tempo nem como falha de tempo, e isso fica dito no registro. O aceite exige **pelo menos 2** das 3 medidas.
- **Renderizado**: o resumo "N entidades e M ligações" está visível e há N nós desenhados (`role=button` dentro do grupo "Subgrafo da resposta"), com N ≥ 2.
- **Tempo (a)**: da abertura da aba Grafo (clique em "Grafo", **depois** de "Resposta pronta.") até "renderizado". Inclui a chamada à API, a união e o layout. O clique do Playwright entra na conta (conservador).
- **Tempo (b)**, para ter mais do que uma amostra por pergunta: 5 repetições do mesmo subgrafo pelo campo "Explorar uma entidade" (uma consulta nova à API a cada vez), com o id da primeira entidade-semente. O tempo vai do clique em "Explorar" até "renderizado".
- **Expansão** (medida à parte, sem entrar no aceite): clicar num nó não expandido e medir o tempo até as novas entidades estarem desenhadas, registrando quantos nós entraram.
- Todas as medidas rodam no Edge, contra a pilha real (API, Neo4j e os modelos), no mesmo PC.

## Regra de aceite (fixada agora)

- Cumprido só se **todas** as perguntas medidas tiverem o tempo (a) e **todas** as repetições (b) em **≤ 1000 ms**, com pelo menos 2 perguntas medidas.
- Se não, a etapa fica `[~]` com os números como saíram, e a regra não muda depois: uma reescrita do aceite só por decisão do dono, registrada como pós-hoc.

Limites já sabidos: n ≤ 3 perguntas (é tudo o que o golden tem); o grafo é de um só documento; os tempos (b) repetem a mesma consulta e o Neo4j já a terá em cache de página; o tempo da resposta em si (dezenas de segundos) não faz parte da medida.

Reprodução: ver o ADR-071.
