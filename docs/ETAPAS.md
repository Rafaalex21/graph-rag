# Etapas — GraphRAG Local

> Plano executável derivado de [`ARQUITETURA.md`](./ARQUITETURA.md). Este arquivo alimenta o painel de acompanhamento: altere-o, e o painel muda junto.
>
> **Versão:** 0.1 · 27/10/2026

## Como ler e editar

- Cada fase começa com `## F<n> · Título`.
- Linhas `> chave: valor` logo abaixo do título descrevem a fase (`objetivo`, `capítulos`, `modelos`, `entrega`, `esforço`).
- Tarefas: `- [ ]` pendente · `- [~]` em andamento · `- [x]` concluída · `- [!]` bloqueada. O identificador vem em negrito: `**F2.3**`.
- Sob cada tarefa, sub-itens `aceite:` (critério verificável), `depende:` (IDs) e `nota:`.
- Uma tarefa só se marca `[x]` quando o critério de aceite foi verificado — não quando o código "parece pronto".

## F0 · Fundações e ambiente
> objetivo: Ambiente reproduzível, com cada modelo medido nesta GPU antes de qualquer linha de RAG.
> capítulos: Apêndice A
> modelos: todos (download, verificação e medição)
> entrega: llama-swap com perfis funcionando, Neo4j com APOC e GDS, esqueleto dos três apps
> esforço: M

- [x] **F0.0** Redigir a especificação v0.1 (`ARQUITETURA.md`, `ETAPAS.md`) e publicar o painel
  - aceite: documentos revisados por Primo
- [x] **F0.1** Criar o repositório com a estrutura da §10 e mover os documentos para `docs/`
  - aceite: commit inicial com README apontando para os documentos
  - depende: F0.0
  - nota: repositório privado `Rafaalex21/graph-rag`; 11 marcos, 72 issues e workflows CI e ETAPAS conferidos em 27/10/2026
- [x] **F0.2** Instalar o llama.cpp em dois builds (Vulkan e HIP/ROCm) e fixar a versão em `infra/models.lock.json`
  - aceite: `llama-server --list-devices` mostra a RX 9070 nos dois builds
  - nota: llama.cpp b11932 (27/10/2026), SHA-256 conferido; Vulkan e HIP listam a RX 9070. O HIP precisa das DLLs hipblas/rocblas, que vêm de wheels `rocm-sdk` 10.0.0 em `infra/bin/rocm-venv` (~1,1 GB); `infra/hip-env.ps1` ajusta o PATH do processo
- [~] **F0.3** Baixar os GGUF da matriz (§8) e registrar repositório, arquivo, quantização e SHA-256
  - aceite: `infra/verify_models.ps1` confere todos os hashes sem erro
- [ ] **F0.4** Medir cada LLM com `llama-bench` (pp512 e tg128) nos dois backends
  - aceite: tabela em `docs/adr/ADR-001-backend.md`; backend escolhido para `indexar` e para `consultar`
  - depende: F0.2, F0.3
- [ ] **F0.5** Calibrar `--n-cpu-moe` do Qwen3.6-35B-A3B para 2 × 16K de contexto
  - aceite: pico de VRAM ≤ 15,2 GB e de RAM ≤ 28 GB; geração ≥ 20 tok/s
  - depende: F0.4
- [ ] **F0.6** Configurar o `llama-swap` com os perfis `indexar`, `vetorizar`, `consultar`, `consultar-rapido` e `avaliar`
  - aceite: `/v1/models` lista todos; `/v1/embeddings` e `/v1/rerank` respondem; troca de perfil ≤ 60 s
  - depende: F0.5
- [ ] **F0.7** Subir o Neo4j 2026.10 com APOC e GDS no Docker, volume persistente e `.wslconfig` limitando o WSL2
  - aceite: `RETURN gds.version(), apoc.version()` responde; WSL2 ≤ 8 GB
- [ ] **F0.8** Esqueleto dos três apps (indexador em Python com `uv`, API em TypeScript, web em Angular 22) com lint e testes vazios
  - aceite: `uv run pytest`, `npm test` e `ng test` verdes
  - depende: F0.1

## F1 · Corpus e parsing
> objetivo: Converter o documento sem perder página, seção, sinal ou escala — erros aqui contaminam tudo o que vem depois.
> capítulos: 2, 3
> modelos: Docling (layout + TableFormer) · Granite-Docling-258M como reserva
> entrega: DoclingDocument fiel, árvore de seções e normalizador numérico testado
> esforço: M

- [ ] **F1.1** Escolher o documento pelos critérios da §16 e registrar no ADR-009
  - aceite: ADR com fonte, número de páginas, idioma e condições de uso
- [ ] **F1.2** Separar um recorte de até 80 páginas, com narrativa e tabelas, para os ciclos rápidos de F1 a F5
  - aceite: recorte salvo em `data/raw/` e descrito no ADR-009
  - depende: F1.1
- [ ] **F1.3** Converter com Docling (OCR desligado, TableFormer *accurate*) e salvar o JSON
  - aceite: 100% das páginas com texto; tempo de conversão registrado
  - depende: F1.2
- [ ] **F1.4** Remover cabeçalhos e rodapés repetidos e associar notas de rodapé
  - aceite: nenhuma linha repetida em mais de 30% das páginas
  - depende: F1.3
- [ ] **F1.5** Construir a árvore de seções (título, nível, páginas)
  - aceite: o sumário gerado bate com o índice do PDF em ≥ 95% das entradas
  - depende: F1.3
- [ ] **F1.6** Auditar 15 tabelas sorteadas contra o PDF (valores, sinais, escala, cabeçalhos)
  - aceite: ≥ 13 de 15 sem erro de valor; achados em `docs/auditoria-tabelas.md`
  - depende: F1.3
- [ ] **F1.7** Implementar o normalizador numérico (pt-BR e EN, parênteses, "em milhões", %, p.b.)
  - aceite: ≥ 30 testes unitários passando

## F2 · Linha de base vetorial
> objetivo: Uma linha de base honesta — do RAG ingênuo ao avançado — contra a qual o grafo será medido.
> capítulos: 2, 3
> modelos: Qwen3-Embedding-0.6B · Qwen3-Reranker-0.6B · Qwen3.6-35B-A3B
> entrega: retriever de trechos com parent-document e rerank, respondendo com citações pela CLI
> esforço: M

- [ ] **F2.1** Gerar Pais (≈ 1.200 tokens, sem cruzar seção, com páginas) e Filhos (≈ 320 tokens, 12% de sobreposição, prefixo com o caminho da seção)
  - aceite: tokens contados via `/tokenize`; nenhum Pai acima de 1.600 tokens
  - depende: F1.5
- [ ] **F2.2** Aplicar as *constraints* da §6.3 e carregar Document, Section, Parent e Child
  - aceite: consultas de sanidade da §6.4 sem órfãos
  - depende: F0.7, F2.1
- [ ] **F2.3** Embutir os Filhos e criar `child_vec` (1024 dims, cosseno)
  - aceite: índice ONLINE; autoteste trecho → si mesmo com recall@1 ≥ 0,98
  - depende: F2.2
- [ ] **F2.4** Criar `child_ft` e a busca híbrida em duas variantes: normalização pelo máximo (cap. 2) e RRF
  - aceite: vetor, híbrido-máximo e híbrido-RRF selecionáveis por flag
  - depende: F2.3
- [ ] **F2.5** Retriever parent-document: k×4 filhos → deduplicação por Pai → top-k
  - aceite: nenhum Pai duplicado; ≤ 300 ms sem rerank
  - depende: F2.3
- [ ] **F2.6** Reranquear os Pais com Qwen3-Reranker-0.6B via `/v1/rerank`
  - aceite: 24 Pais reranqueados em ≤ 2 s
  - depende: F2.5, F0.6
- [ ] **F2.7** Tabelas: descrição e 3 a 5 perguntas hipotéticas por tabela, embutidas em `question_vec`
  - aceite: 100% das tabelas com perguntas; 10 revisadas à mão
  - depende: F2.2
- [ ] **F2.8** Reescritas opcionais da consulta: step-back e HyDE
  - aceite: flags `--stepback` e `--hyde` na CLI
- [ ] **F2.9** CLI `ask` respondendo só com o contexto e citando `[p. N]`
  - aceite: 5 perguntas de fumaça com a página correta
  - depende: F2.6

## F3 · Benchmark e avaliação v0
> objetivo: Medir a linha de base antes de construir o grafo; daqui em diante, toda mudança é um número.
> capítulos: 8
> modelos: Gemma 4 26B-A4B (juiz, perfil avaliar)
> entrega: golden set, harness de avaliação e tabela A0–A3
> esforço: M

- [ ] **F3.1** Redigir 60 perguntas com gabarito, na distribuição da §13.1
  - aceite: `eval/golden.csv` com pergunta, gabarito (texto ou Cypher), páginas e rota esperada
  - depende: F1.1
- [ ] **F3.2** Implementar recall de contexto, fidelidade e correção com o juiz local (prompts do cap. 8); RAGAS como opção
  - aceite: as três métricas rodam no golden set inteiro sem intervenção
  - depende: F3.1, F0.6
- [ ] **F3.3** Acrescentar page recall@k, acerto numérico (tolerância 0,5%) e latência p50/p95
  - aceite: relatório único por execução em `eval/resultados/`
  - depende: F3.2
- [ ] **F3.4** Calibrar o juiz contra 20 rótulos manuais
  - aceite: concordância ≥ 80%
  - depende: F3.2
- [ ] **F3.5** Rodar A0, A1, A2 e A3 e publicar a tabela
  - aceite: `eval/resultados/v0.md` com as quatro linhas e as métricas da §13.2
  - depende: F2.9, F3.3

## F4 · Grafo de domínio
> objetivo: Transformar o texto em fatos consultáveis — filtrar, somar e comparar exige estrutura, não similaridade.
> capítulos: 6
> modelos: Qwen3.6-35B-A3B com JSON Schema (perfil indexar)
> entrega: fatos financeiros, organizações, pessoas, segmentos, riscos e eventos no grafo, com lastro
> esforço: G

- [ ] **F4.1** Modelar em Pydantic os esquemas da §5 I-5, com descrição em cada campo e `Optional` onde puder faltar
  - aceite: JSON Schema gerado e versionado em `contracts/`
- [ ] **F4.2** Extrair por Pai e por Tabela com `response_format: json_schema`, cache por hash e retomada
  - aceite: 100% de JSON válido; interromper e retomar não repete chamadas
  - depende: F4.1, F2.1
- [ ] **F4.3** Lastro numérico: rejeitar fatos cujo valor normalizado não aparece na evidência
  - aceite: taxa de rejeição registrada; 30 fatos aceitos auditados com ≥ 95% corretos
  - depende: F4.2, F1.7
- [ ] **F4.4** Importar com MERGE e IDs determinísticos
  - aceite: importar duas vezes não altera nenhuma contagem
  - depende: F4.3
- [ ] **F4.5** Resolução de entidades: normalização, bloqueio, similaridade, confirmação por LLM e `apoc.refactor.mergeNodes`
  - aceite: 20 fusões auditadas com ≥ 90% corretas; aliases preservados
  - depende: F4.4
- [ ] **F4.6** Catálogo de métricas canônicas (`Metric`) e mapeamento terminológico PT↔EN
  - aceite: ≥ 95% dos fatos ligados a uma métrica canônica
  - depende: F4.4

## F5 · Camada MS GraphRAG
> objetivo: Entidades, relações e comunidades resumidas para perguntas sobre "quem" e sobre "o todo".
> capítulos: 7
> modelos: Qwen3.6-35B-A3B · Qwen3-Embedding-0.6B
> entrega: entidades e relações resumidas, comunidades Leiden hierárquicas com relatórios embutidos
> esforço: G

- [ ] **F5.1** Fixar os tipos de entidade financeiros (§5 I-6) e o prompt de extração em JSON
  - aceite: prompt versionado; 5 Pais extraídos e revisados à mão
- [ ] **F5.2** Extração aberta por Pai, com *gleaning* configurável
  - aceite: ganho do *gleaning* medido em 20 Pais e decidido em ADR
  - depende: F5.1
- [ ] **F5.3** Convergir entidades abertas e de domínio pela mesma resolução da F4.5
  - aceite: nenhum par duplicado entre camadas na amostra de 30 entidades mais citadas
  - depende: F5.2, F4.5
- [ ] **F5.4** Resumir descrições de entidades e relações, com ranking e teto para supernós
  - aceite: nenhum prompt estoura o contexto; emissor resumido em dois níveis
  - depende: F5.3
- [ ] **F5.5** Leiden hierárquico no GDS (peso = força), excluindo o emissor da projeção
  - aceite: modularidade e número de comunidades por nível registrados
  - depende: F5.4
- [ ] **F5.6** Relatórios de comunidade em JSON e embeddings em `community_vec`
  - aceite: 100% com relatório válido; 10 revisados à mão
  - depende: F5.5
- [ ] **F5.7** Embutir os resumos de entidade em `entity_vec`
  - aceite: índice ONLINE; busca "entidade → si mesma" com recall@1 ≥ 0,95
  - depende: F5.4

## F6 · Recuperadores de grafo
> objetivo: Cada pergunta encontra a ferramenta certa — templates para o previsível, Text2Cypher para o resto.
> capítulos: 4, 7
> modelos: Qwen3.6-35B-A3B · neo4j Text2Cypher Gemma 3 4B (comparação)
> entrega: busca local, busca global, templates Cypher e Text2Cypher com guarda-corpos
> esforço: G

- [ ] **F6.1** Busca local (Cypher do cap. 7 adaptado) com limites de trechos, comunidades e relações
  - aceite: perguntas "quem é…" do golden set com recall de contexto ≥ 0,8
  - depende: F5.7
- [ ] **F6.2** Busca global *map-reduce* com escolha de nível e limiar de *rating*
  - aceite: ≤ 90 s no perfil `consultar`, com progresso por comunidade
  - depende: F5.6
- [ ] **F6.3** Templates Cypher: `fato_financeiro`, `serie_metrica`, `comparar_segmentos`, `riscos`, `eventos`, `pessoas_cargos`
  - aceite: testes de contrato contra o grafo real
  - depende: F4.6
- [ ] **F6.4** Text2Cypher com esquema (APOC), terminologia, *few-shot* e instruções de formato
  - aceite: acurácia de execução ≥ 70% nas perguntas de agregação
  - depende: F4.6
- [ ] **F6.5** Guarda-corpos: sessão READ, cláusulas proibidas, `EXPLAIN`, `LIMIT`, tempo-limite e uma autocorreção
  - aceite: 20 entradas maliciosas ou malformadas bloqueadas sem escrita no banco
  - depende: F6.4
- [ ] **F6.6** Comparar o especialista Text2Cypher Gemma 3 4B com o LLM principal
  - aceite: ADR com acurácia de execução e latência dos dois
  - depende: F6.4

## F7 · Agente e API
> objetivo: Orquestrar reescrita, rota, ferramentas, crítica e redação — e transmitir cada passo à interface.
> capítulos: 5
> modelos: Qwen3.6-35B-A3B · gpt-oss-20b (perfil rápido)
> entrega: API TypeScript com SSE, oito ferramentas e telemetria
> esforço: G

- [ ] **F7.1** Cliente LLM em TypeScript (SDK OpenAI → llama-swap) com perfis, tempos-limite e `chat_template_kwargs`
  - aceite: testes de integração para chat, *tool call*, embeddings e rerank
  - depende: F0.6, F0.8
- [ ] **F7.2** Atualizador de pergunta com decomposição em subperguntas
  - aceite: 10 perguntas compostas decompostas corretamente
  - depende: F7.1
- [ ] **F7.3** Roteador com *tool calling* nativo e as oito ferramentas da §7.2
  - aceite: acurácia de rota ≥ 85% no golden set
  - depende: F7.2, F6.1, F6.2, F6.3, F6.5
- [ ] **F7.4** Crítico com uma rodada extra e critério de saída
  - aceite: nenhuma conversa ultrapassa duas rodadas; casos "ausente" respondidos como ausentes
  - depende: F7.3
- [ ] **F7.5** Redator: citações por id → página, números em pt-BR, "não consta" quando faltar
  - aceite: 100% das afirmações numéricas citadas no golden set
  - depende: F7.4
- [ ] **F7.6** Endpoint SSE `/api/chat` e rotas `/api/fonte`, `/api/documento/pdf`, `/api/grafo`, `/api/saude`, `/api/feedback`
  - aceite: testes de contrato contra `contracts/api.openapi.yaml`; primeiro evento em ≤ 1 s
  - depende: F7.5
- [ ] **F7.7** Telemetria em JSONL por requisição (rota, ferramentas, tokens, latência)
  - aceite: relatório diário gerado a partir dos logs
  - depende: F7.6

## F8 · Interface Angular
> objetivo: Um assistente que mostra o caminho: rota, Cypher, evidências e páginas a um clique.
> capítulos: —
> modelos: — (consome a API)
> entrega: chat com streaming, painel de rastro, visualizador de fontes e explorador de grafo
> esforço: G

- [ ] **F8.1** Shell em Angular 22 (standalone, signals, rotas), tema claro e escuro
  - aceite: build de produção sem avisos
  - depende: F0.8
- [ ] **F8.2** Chat com streaming SSE (`fetch` + `ReadableStream`), markdown sanitizado e chips de citação
  - aceite: tokens aparecem em ≤ 5 s numa pergunta simples
  - depende: F7.6, F8.1
- [ ] **F8.3** Painel "Rastro": reescrita, rota, Cypher, evidências e crítica em linha do tempo
  - aceite: todos os eventos da §11.1 representados
  - depende: F8.2
- [ ] **F8.4** Visualizador de fonte com pdf.js: abre a página citada e destaca o trecho
  - aceite: 10 citações sorteadas abrem na página certa
  - depende: F8.2
- [ ] **F8.5** Explorador do subgrafo usado na resposta, com expansão por clique
  - aceite: subgrafo de uma pergunta "quem é…" renderizado em ≤ 1 s
  - depende: F8.2
- [ ] **F8.6** Configurações de perfil e modo de recuperação
  - aceite: trocar o modo muda a rota observada no Rastro
  - depende: F8.3
- [ ] **F8.7** Selo de saúde e feedback por resposta
  - aceite: 5 perguntas do golden set feitas pela interface sem tocar no terminal
  - depende: F8.6

## F9 · Avaliação final e bake-offs
> objetivo: Fechar a escada A0–A6 e escolher os modelos com números, não com impressões.
> capítulos: 8
> modelos: Qwen3.6-35B-A3B × gpt-oss-20b × Gemma 4 26B-A4B · Qwen3-Embedding 0.6B × 4B × EmbeddingGemma 2
> entrega: tabela de ablações, bake-offs e v1 congelada
> esforço: M

- [ ] **F9.1** Rodar A4, A5 e A6
  - aceite: `eval/resultados/v1-ablacao.md` com a escada completa
  - depende: F7.5, F3.5
- [ ] **F9.2** Bake-off do LLM principal: qualidade × latência × VRAM
  - aceite: ADR com a escolha final por papel
  - depende: F9.1
- [ ] **F9.3** Bake-off de embeddings (reindexação completa por candidato)
  - aceite: ADR com recall de contexto e page recall@k de cada candidato
  - depende: F9.1
- [ ] **F9.4** Corrigir as falhas recorrentes: novos *few-shots*, templates e limites (ciclo do cap. 8)
  - aceite: falhas das categorias mais fracas reduzidas à metade
  - depende: F9.2
- [ ] **F9.5** Congelar a v1: metas da §1.3 atingidas ou desvios justificados em ADR
  - aceite: `eval/resultados/v1.md` e tag `v1.0.0` no git
  - depende: F9.4

## F10 · Portfólio e acabamento
> objetivo: Deixar o projeto apresentável e reproduzível por quem nunca o viu.
> capítulos: —
> modelos: —
> entrega: README com números, scripts de subida, demonstração gravada
> esforço: P

- [ ] **F10.1** README com arquitetura, tabela de ablações e GIF de demonstração
  - aceite: alguém de fora sobe o projeto seguindo só o README
  - depende: F9.5
- [ ] **F10.2** Scripts `infra/up.ps1` (sobe tudo) e `indexer run-all` (indexação completa)
  - aceite: máquina limpa → assistente respondendo com dois comandos (fora o download dos modelos)
  - depende: F9.5
- [ ] **F10.3** Vídeo de até 3 minutos mostrando rota, Cypher e citações
  - aceite: publicado e linkado no README
  - depende: F10.1
- [ ] **F10.4** Artigo técnico: "GraphRAG 100% local numa GPU de 16 GB", com os números medidos
  - aceite: rascunho revisado
  - depende: F10.1

## Matriz de modelos

| Papel | Modelo padrão | Quantização | Onde roda | Alternativas |
|---|---|---|---|---|
| Parsing de PDF | Docling (Heron + TableFormer) | — | CPU | Granite-Docling-258M |
| Embeddings | Qwen3-Embedding-0.6B | Q8_0 | GPU no lote · CPU na consulta | Qwen3-Embedding-4B · EmbeddingGemma 2 |
| Reranker | Qwen3-Reranker-0.6B | Q8_0 | GPU | bge-reranker-v2-m3 · Qwen3-Reranker-4B |
| Extração | Qwen3.6-35B-A3B | UD-Q4_K_XL | GPU + RAM | Gemma 4 26B-A4B QAT · gpt-oss-20b |
| Agente e redator | Qwen3.6-35B-A3B | UD-Q4_K_XL | GPU + RAM | gpt-oss-20b · Gemma 4 12B |
| Text2Cypher | LLM do agente + *few-shot* | — | — | neo4j Text2Cypher Gemma 3 4B |
| Juiz | Gemma 4 26B-A4B | QAT Q4_0 | GPU | Qwen3.6 com raciocínio |
