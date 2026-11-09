# ADR-070 · Visualizador de fonte com pdf.js: abre a página citada do PDF original e destaca o trecho

- **Estado:** aceita (09/11/2026)
- **Data:** 2026-11-09
- **Tarefa(s):** F8.4

## Contexto

A F8.4 faz a aba Fontes mostrar de onde veio cada afirmação: abre a página do PDF citada e destaca o trecho. O aceite é "10 citações sorteadas abrem na página certa". As citações do projeto usam sempre a página física do PDF original (`bb_fre_2026_recorte_mapa.json`), e a API já serve o PDF inteiro com `Range` (`GET /api/documento/pdf`) e o texto de cada item do grafo (`GET /api/fonte/:id`). A medida do aceite foi escrita antes de rodar (`eval/f84-medida-citacoes.md`) e emendada, também antes da primeira execução, ao ler o formato real dos arquivos (`efe0a12`). Os testes são só E2E (ADR-068), escritos antes do código.

## Decisão

- **A URL manda:** `/chat/fontes?pagina=N&fonte=<id>`. `pagina` é a primeira página do rótulo citado (`p. 9-10` abre na 9); `fonte` é o item do grafo de onde vem o texto a destacar. O chip da resposta acha o `id` na lista de citações do `fim` pela primeira página; o botão de página do Rastro passa o `id` da evidência. Sem `fonte`, a página abre sem destaque; sem `pagina`, a aba mostra o convite.
- **pdf.js 6.4.299 (versão exata), em chunk à parte (435 kB):** só é baixado quando alguém abre uma página. O arquivo chega em faixas de 64 kB pela própria API; o worker, as fontes padrão, os mapas de caracteres, o wasm e os perfis ICC saem de `/pdfjs/` (copiados de `node_modules` pelo `angular.json`). Nenhuma rede externa (um teste confere que todas as requisições vão à mesma origem).
- **Desenho:** canvas na largura do painel (`ResizeObserver`, densidade de pixels do aparelho) com a camada de texto do pdf.js por cima (CSS global, porque o pdf.js cria os elementos fora do Angular). Um desenho por vez no mesmo canvas: o novo cancela o anterior e espera ele terminar, e um número de execução descarta o que chegar atrasado (teste: seis cliques seguidos em "Próxima" terminam na página 7, sem página misturada).
- **Destaque** (`fontes/trecho.ts`, função pura): palavras sem acento, caixa e pontuação, em sequências de 4 palavras do texto da fonte procuradas nas palavras da página; os itens da camada de texto que contêm alguma sequência recebem `destaque` e o primeiro é levado à vista. O PDF e o grafo não têm a mesma quebra de linha nem os mesmos separadores de tabela, por isso é por palavras. Se nada é achado (resumo de entidade, página errada), o aviso é "Trecho não localizado nesta página.", sem alerta de erro.
- **Estados:** página inválida (`0`, negativa, texto, decimal, 99) → aviso neutro com o intervalo do documento; fonte 404 → "Fonte não encontrada"; fonte 503 → "Não foi possível ler o trecho" e a página continua visível; PDF indisponível → `role="alert"` e o resto da aba segue usável. Navegação: Anterior, Próxima, "Ir para a página" (valida e recusa fora do intervalo) e a posição em `role="status"` ("Página 6 de 423"). Sair da página citada tira a `fonte` da URL e o destaque.
- **Tudo da API entra como texto:** o trecho vai em `<blockquote>` por interpolação (o `<img onerror>` do teste aparece como texto).

## Alternativas consideradas

- **`pdf_viewer` do pdf.js (viewer pronto):** traz paginação, zoom e busca, mas é um bloco grande de CSS e DOM próprio, difícil de testar por papel e rótulo, e o aceite pede só abrir a página e destacar.
- **Abrir o PDF num `<iframe>`/`#page=N`:** sem destaque e sem controle do que o navegador mostra.
- **Destacar por coordenadas gravadas na indexação:** o grafo não guarda caixas de texto; refazer a indexação não cabe numa tarefa de interface.
- **Casar o trecho inteiro, não 4 palavras:** quebraria em qualquer diferença de quebra de linha ou hifenização.

## Consequências

- O painel tem 18 a 26 rem de largura no desktop, então a página inteira cabe, mas o texto fica pequeno (≈ 7 px a 416 px). Não há zoom ainda; é a primeira melhoria a fazer se a leitura incomodar.
- O destaque cobre os itens inteiros da camada de texto (uma linha ou um trecho do pdf.js), não só as palavras casadas, e palavras partidas entre dois itens do PDF podem não casar.
- Tipos de citação que o redator emite e a API não trata como texto literal (`risco`, `consulta`, `ponto`, `pessoa`) só são conferidos pela página (condição (a)); no sorteio, 1 das 10 foi assim (uma entidade).
- O aceite mede se a página aberta é a do rótulo citado e se o início do trecho está nela; não mede se a citação sustenta a afirmação.

## Evidência

**E2E da interface** (`cd e2e; npm test`): 81 testes passam (30 novos do visualizador, contra a API falsa com um PDF de 12 páginas feito à mão e `Range`), e 162 de 162 numa repetição (`--repeat-each=2`). Cobrem: convite sem parâmetros (e nenhuma requisição ao PDF), página 6 com o destaque só na frase citada, tabela `p. 9-10`, pixels de fato desenhados no canvas, trecho fora da página, fonte 404/503/HTML hostil, Anterior/Próxima/campo e seus limites, seis cliques seguidos, páginas inválidas, PDF 404 e conexão que cai, só a mesma origem com `Range`, chip e Rastro abrindo a página e a fonte certas, voltar do histórico, teclado, 375 px sem rolagem e redimensionar. Pegou dois defeitos meus antes da pilha real: a validação nativa do `<input type="number">` engolia o Enter fora do intervalo (corrigido com `novalidate`), e o pdf.js deixa um `<canvas>` escondido no `body`, o que quebrava a contagem de canvas.

**Pilha real** (`npm run test:ao-vivo -- fontes`, `eval/resultados/f84-citacoes.json`, ids e números): universo de **109** pares (107 com página), sorteio de 10 com a semente 84 (mesmas 10 nas duas execuções). **10 de 10** abriram na página certa (a); 9 de texto literal (todas `pai`) também tiveram o início do trecho na camada de texto da página (b) e **as 9 foram destacadas**; 1 era entidade (só (a)). Tempo até a página e o texto aparecerem: mediana 0,58 s, máximo 0,91 s (PDF de 423 páginas, no mesmo PC). O chip de uma resposta real (T15) abre na página e na fonte certas. **Limites:** n = 10 num universo de 107, um só documento; as 10 sorteadas são quase todas `pai`; "página certa" é a do rótulo que o redator citou.

**Build:** `ng lint` limpo; `ng build` de produção sem avisos (247,5 kB iniciais; pdf.js 435 kB e a página 12,4 kB em chunks sob demanda).

Reproduzir: `cd e2e; npm ci; npm test` (interface); com Neo4j, llama-swap e a API no ar, `npm run test:ao-vivo -- fontes` (precisa de `data/avaliacao/f75-redator-detalhes.json` e `f712-redator-novas-detalhes.json`, que não vão para o git).
