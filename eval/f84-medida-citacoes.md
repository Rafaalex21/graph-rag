# F8.4: medida das 10 citações sorteadas (definição fixada ANTES de rodar)

Aceite da etapa: "10 citações sorteadas abrem na página certa".

## Definições

- **Universo**: os pares únicos (id, rótulo de página) das `citacoes` das respostas do redator já gravadas pela F7.5 e pela F7.12 (`data/avaliacao/f75-redator-detalhes.json` e `data/avaliacao/f712-redator-novas-detalhes.json`, que não vão para o git, ADR-009). São citações que o sistema de fato produziu. O tamanho do universo é registrado.
- **Sorteio**: 10 citações sem reposição, com o gerador `mulberry32` de semente **84**, sobre o universo ordenado por id e rótulo.
- **Abrir**: abre-se, no navegador (Edge), a mesma URL que o clique no chip abre, `/chat/fontes?pagina=<primeira página do rótulo>&fonte=<id>`, contra a pilha real (API, Neo4j e o PDF original servido por `/api/documento/pdf` com `Range`).
- **Página certa** (o aceite), por citação, passa se:
  - (a) o visualizador mostra "Página N de M" com N igual à primeira página do rótulo citado (o rótulo `p. 6-7` abre na 6);
  - (b) para as fontes de **texto literal** (`pai`, `filho`, `tabela`, `fato`): a camada de texto da página aberta contém a primeira sequência de 4 palavras do `texto` devolvido por `/api/fonte/:id` (comparação sem acento, caixa e pontuação). Para `entidade` e `comunidade` (um resumo, que não está escrito no PDF) só vale (a).
- **Medidas à parte, sem entrar no aceite**: quantas das citações de texto literal tiveram o trecho **destacado** na página (alguma marca `destaque`), e o tempo até a página aparecer.

## Regra de aceite (fixada agora)

- Cumprido só se **10 de 10** passarem em (a) e, nas de texto literal, também em (b).
- Se não, a etapa fica `[~]` com os números como saíram, e nada de trocar a regra depois: uma reescrita do aceite só por decisão do dono, registrada como pós-hoc.
- Uma segunda execução com a mesma semente e o mesmo universo deve dar as mesmas 10 citações; o teste confere isso.

## Emenda, feita ANTES da primeira execução ao vivo (ao ler o formato real dos arquivos de detalhes)

Os detalhes do redator trazem `{ref, id, tipo, paginas}` e o universo tem **109** pares únicos, de tipos que a definição acima não previa (69 `pai`, 15 `risco`, 11 `tabela`, 6 `fato`, 5 `consulta`, 2 `ponto`, 1 `pessoa`), e **2 sem rótulo de página**. Para não decidir isso depois de ver o resultado:

- **Só entram no sorteio os pares com rótulo de página** (107): uma citação sem página não tem página para abrir. Os 2 sem página ficam anotados no resultado.
- **A condição (b) vale quando `/api/fonte/:id` devolve `tipo` em `pai`, `filho`, `tabela` ou `fato`.** Para qualquer outro `tipo` devolvido, e para um 404/503 da fonte, só vale (a). O resultado registra, das 10, quantas foram avaliadas por (a) e (b) e quantas só por (a); um `tipo` fora da lista que a API trate como texto literal não vira (b) depois.
- A ordenação do universo é por `id` e depois pelo rótulo (comparação de texto simples), e o sorteio usa `mulberry32(84)` com troca de Fisher-Yates a partir do fim.

Limites já sabidos: n = 10 num universo de ~109; o documento é um só; o "página certa" é a do rótulo que o redator citou, não uma conferência de que a citação sustenta a afirmação.

Reprodução: ver o ADR-070.
