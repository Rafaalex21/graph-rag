# ADR-071 · Explorador do subgrafo: SVG próprio com layout de forças, vizinhança por clique

- **Estado:** aceita (09/11/2026)
- **Data:** 2026-11-09
- **Tarefa(s):** F8.5

## Contexto

A F8.5 mostra, na aba Grafo, o subgrafo que a resposta usou, e deixa expandir a vizinhança de uma entidade com um clique. O aceite é "subgrafo de uma pergunta 'quem é…' renderizado em ≤ 1 s". A API já tinha `GET /api/grafo/vizinhanca` (até 100 nós, `truncado`, profundidade 1 ou 2, entidade por id, nome ou apelido). A medida foi escrita antes de rodar (`eval/f85-medida-subgrafo.md`, commit `99ae3b1`) e os testes são só E2E (ADR-068), escritos antes do código.

## Decisão

- **Subgrafo da resposta = as entidades que viraram evidência.** Do último `fim`, pegam-se os eventos `evidencia` com `tipo` `entidade` ou `id` começando em `ent:` (no máximo 6 sementes), consulta-se a vizinhança de profundidade 1 de cada uma, e a união (sem repetir nós nem ligações) é o desenho. O desenho se monta quando a resposta termina, esteja a aba aberta ou não; uma resposta nova o recomeça, e "Nova conversa" o esvazia. Resposta sem entidade nenhuma: "Nenhuma entidade nesta resposta."
- **Explorar pelo nome:** um campo ("Explorar uma entidade") troca o desenho pela vizinhança da entidade pedida (nome sem distinguir caixa, apelido ou id); entidade inexistente só avisa e deixa a tela como estava.
- **Expandir:** clique, Enter ou Espaço num nó traz a vizinhança dele e a junta; os nós que já estavam **não mudam de lugar** (o layout só move os novos), nó já expandido ou semente não consulta de novo, e "Nenhuma ligação nova para X." quando não há nada a acrescentar. Se a consulta falha, um alerta e o nó continua expansível.
- **SVG próprio, sem biblioteca de grafos:** cada entidade é um `<g role="button" tabindex="0">` com nome acessível ("Nome, tipo, expandir vizinhança"), então o Playwright e um leitor de tela o veem como um botão; as ligações são `<line>` com `<title>` ("origem TIPO destino") e seta. O layout é uma força dirigida de Fruchterman–Reingold sem sorteio (mesmo grafo, mesmo desenho; 100 nós em ~10 ms). Zoom por botões (Afastar, Aproximar, Ajustar à tela); a área vista se reajusta ao conteúdo.
- **Cor por tipo (8 cores Okabe–Ito) e o tipo também em texto:** na legenda, no `<title>` e no nome acessível. O estado fica no `GrafoService` (raiz), então trocar de aba não perde nem refaz o desenho.
- **Tudo da API é texto:** rótulos e tipos entram por interpolação do Angular (teste com `<img onerror>` e `<script>`). O corpo é conferido; nó ou ligação malformados são descartados.
- **Mais de 100 vizinhos:** mostra os 100 e avisa "há mais ligações que não couberam"; com mais de 30 nós só sementes e expandidos levam rótulo escrito.

## Alternativas consideradas

- **Cytoscape.js ou NVL (as duas opções da ARQUITETURA §11):** trazem layouts, zoom e arrasto prontos, mas desenham em canvas/WebGL, que o Playwright não enxerga por papel e nome, e somam 400 kB ou mais; para até 100 nós o SVG basta.
- **Layout por anéis (centro e vizinhos num círculo):** não serve para a união de várias sementes nem para expansões que não podem mexer no que já está na tela.
- **Profundidade 2 de saída:** a API aceita, mas com 100 nós de teto a profundidade 1 de cada semente já enche a tela; a expansão por clique faz o papel da profundidade 2.

## Consequências

- Arrastar nós, buscar dentro do desenho e filtrar por tipo ficam de fora. Com mais de 8 tipos a cor repete (no grafo real há 12: ORGANIZATION e RISK têm o mesmo azul); o tipo certo está no nome acessível e no `<title>`.
- Com 100 nós o desenho a 416 px de largura é só uma nuvem de pontos: ele serve para ver a forma, e a leitura vem do zoom e da legenda.
- A entidade só aparece no subgrafo se a ferramenta `entidade` (ou outra que devolva evidência com id `ent:`) tiver rodado: a pergunta T01 ("Quem é o acionista controlador…") foi respondida só com trechos (`pai`) e não tem subgrafo.
- O primeiro teste ao vivo achou um defeito que a API falsa não mostrava: com componentes sem ligação entre si a repulsão os espalhava (uma área de 422 × 2079 e nós fora do alcance do clique). Corrigido com uma gravidade em direção ao centro (0,2), conferida em grafos sintéticos (estrela, denso, desconexo, 100 nós) antes de rodar a medida de novo.

## Evidência

**E2E da interface** (`cd e2e; npm test`): 104 testes passam (23 novos do explorador), e 208 de 208 numa repetição (`--repeat-each=2`); 312 de 312 em três, antes de uma última mudança só de rótulo (`<title>` dos nós). Cobrem: aba vazia sem consulta, resposta sem entidade, subgrafo de uma resposta "quem é" (4 entidades, 3 ligações, 2 sementes, uma consulta por semente com `profundidade=1`), aba já aberta, ≤ 1 s com a API falsa, legenda e nome acessível com o tipo, resposta nova e Nova conversa, expansão (junta sem repetir, sem nova consulta, sem ligação nova, nós parados, teclado, falha da consulta), explorar por nome (inexistente, 503, 100 vizinhos, HTML hostil), no máximo 6 sementes, trocar de aba, nós sem sobreposição, zoom e 375 px sem rolagem horizontal. Um teste antigo do chat era frágil (via uma janela de 300 ms) e foi alargado na API falsa.

**Pilha real** (`npm run test:ao-vivo -- grafo`, `eval/resultados/f85-subgrafo.json`, ids e números): das 3 perguntas "Quem é" do golden, **2 tinham entidade na resposta e foram medidas** (E04: 3 entidades e 5 ligações; E07: 17 entidades e 51 ligações, 6 sementes) e **1 não tinha** (T01, só evidência `pai`). Tempo (a), da abertura da aba até desenhado: **86 ms e 85 ms**. Tempo (b), 5 repetições por pergunta: **58 a 69 ms**. Máximo geral **86 ms, contra o limite de 1.000 ms**: o aceite se cumpre pela regra fixada (pelo menos 2 medidas, todas ≤ 1 s). Fora do aceite: a expansão de um nó levou 156 ms (de 3 para 102 entidades, truncada em 100) e 139 ms (de 17 para 18). **Limites:** n = 2 perguntas medidas (o golden só tem 3 "Quem é"); os tempos (b) repetem a mesma consulta, que o Neo4j já tem em cache; o tempo da resposta em si (dezenas de segundos) não faz parte da medida. A aparência foi vista em capturas a 1280 px no Edge (Broto S.A. e Banco do Brasil).

**Build:** `ng lint` limpo e `ng build` sem avisos (247,6 kB iniciais; a aba Grafo é um chunk de 15,5 kB).

Reproduzir: `cd e2e; npm ci; npm test` (interface); com Neo4j, llama-swap e a API no ar, `npm run test:ao-vivo -- grafo`.
