# Decisões de arquitetura (ADRs)

Uma decisão por arquivo: `ADR-NNN-assunto.md`. As nove decisões iniciais estão resumidas na tabela da §15 de [`../ARQUITETURA.md`](../ARQUITETURA.md); cada uma ganha seu arquivo aqui quando a fase que a confirma (ou refuta) for concluída.

| ADR | Assunto | Onde se fecha |
|---|---|---|
| [001](ADR-001-backend.md) | Backend de inferência (Vulkan × HIP) | F0.4 — aceita, revisada na F0.5 |
| [010](ADR-010-offload-moe.md) | Offload de experts do Qwen3.6 (`-lm none`, `--n-cpu-moe`) | F0.5 — aceita, com as medições |
| [011](ADR-011-perfis-swap.md) | Perfis do `llama-swap` (motor `matrix`) e orçamento de VRAM | F0.6 — aceita |
| [012](ADR-012-neo4j-nativo.md) | Neo4j nativo no Windows, sem Docker nem WSL2 | F0.7 — aceita |
| [013](ADR-013-ferramentas-dev.md) | Ferramentas de desenvolvimento portáteis e TypeScript 6.0 fixado | F0.8 — aceita |
| [009](ADR-009-documento.md) | Documento escolhido | F1.1: aceita (Banco do Brasil, FRE 2026 v7) |
| [014](ADR-014-parsing-docling.md) | Docling: versão, modelos e configuração do parsing | F1.3 — aceita |
| [015](ADR-015-normalizacao.md) | Normalização do DoclingDocument (repetidas, figuras decorativas, notas) | F1.4 — aceita, com dois adendos |
| [016](ADR-016-secoes.md) | Árvore de seções pela numeração do documento | F1.5 — aceita |
| [017](ADR-017-numeros.md) | Normalizador numérico | F1.7 — aceita |
| [018](ADR-018-pais-e-filhos.md) | Segmentação em Pais e Filhos | F2.1 — aceita |
| [019](ADR-019-camada-lexica-neo4j.md) | Camada léxica no Neo4j: constraints e carga | F2.2 — aceita |
| [020](ADR-020-embeddings-e-child-vec.md) | Embeddings dos Filhos e índice `child_vec` | F2.3 — aceita |
| [021](ADR-021-busca-hibrida.md) | Full-text `child_ft` e busca híbrida (máximo × RRF) | F2.4 — aceita |
| [022](ADR-022-retriever-parent-document.md) | Retriever parent-document (k×4 Filhos → Pais únicos) | F2.5 — aceita |
| [023](ADR-023-rerank-dos-pais.md) | Rerank dos Pais com o Qwen3-Reranker-0.6B | F2.6 — aceita |
| [024](ADR-024-tabelas-e-perguntas-hipoteticas.md) | Tabelas: descrição, perguntas hipotéticas e `question_vec` | F2.7 — aceita |
| [025](ADR-025-reescritas-da-consulta.md) | Reescritas opcionais da consulta: step-back e HyDE | F2.8 — aceita |
| [026](ADR-026-cli-ask.md) | CLI `ask`: resposta só com o contexto e citação `[p. N]` | F2.9 — aceita |
| [027](ADR-027-golden-set.md) | Golden set de 60 perguntas, conferido contra o PDF | F3.1 — aceita |
| [028](ADR-028-metricas-com-juiz-local.md) | Métricas com o juiz local (recall de contexto, fidelidade, correção) e orçamento de raciocínio | F3.2 — aceita |
| [029](ADR-029-metricas-mecanicas.md) | Métricas mecânicas: page recall@k, acerto numérico (0,5%) e latência p50/p95 | F3.3 — aceita |
| [030](ADR-030-calibracao-do-juiz.md) | Calibração do juiz contra 20 rótulos (95% de concordância; rótulos dados pelo Claude) | F3.4 — aceita |
| [031](ADR-031-linha-de-base-v0.md) | Linha de base v0: escada A0 a A3r (de memória 0,22; vetor 0,50; híbrida 0,51; Pai + reranker 0,55; reescrita sem ganho) | F3.5 — aceita |
| [032](ADR-032-esquemas-de-extracao.md) | Esquemas Pydantic da extração dirigida e o JSON Schema versionado em `contracts/` | F4.1 — aceita |
| [033](ADR-033-extracao-por-pai-e-por-tabela.md) | Extração dirigida a esquema por Pai e por Tabela (164 de 164 válidas; a gramática não impõe `pattern`) | F4.2 — aceita |
| [034](ADR-034-lastro-numerico.md) | Lastro numérico dos fatos (34% rejeitados no recorte; 29 de 30 auditados corretos; só o número não basta) | F4.3 — aceita |
| [035](ADR-035-importacao-idempotente.md) | Importação idempotente da extração dirigida (a chave de ID da §5 fundia 46 fatos; 803 fatos e 106 entidades, duas importações iguais) | F4.4 — aceita |
| [036](ADR-036-resolucao-de-entidades.md) | Resolução de entidades (o embedding a 0,92 pega 1 de 14 duplicatas; cinco fontes de candidatos + LLM; 106→94 entidades, 9/12 fusões corretas na leitura estrita) | F4.5 — aceita, com o critério ajustado (12 fusões no recorte; 20 na F5.8) |
| [037](ADR-037-catalogo-de-metricas.md) | Catálogo de métricas canônicas e mapeamento PT↔EN (97 métricas; sinônimo × componente; recorte na `dimension` do `OF_METRIC`; 99,6% dos fatos ligados, ≈ 2% sob métrica errada) | F4.6 — aceita |
| [038](ADR-038-extracao-aberta.md) | Tipos de entidade e prompt da extração aberta (11 tipos: 8 de 9 `PRODUCT_OR_SERVICE` eram políticas e programas; nomes que são data ou valor recusados por validação; prompt v3 em 5 Pais) | F5.1 — aceita |
| [039](ADR-039-gleaning.md) | *Gleaning* da extração aberta: +60% de entidades e +69% de relações em 20 Pais novos, mas só 51% dos acréscimos corretos e +62% de LLM; configurável, padrão 0 | F5.2 — aceita |
| [040](ADR-040-convergencia-das-camadas.md) | Convergência das entidades abertas e de domínio: 658 entidades abertas em 116 Pais (17 min); 513 → 433 nós com 61 fusões; conflitos deixam de bloquear o grupo (o emissor ficava em duas grafias); sobram 2 pares duplicados nas 30 mais citadas | F5.3 — aceita, com o critério ajustado (até 2 pares na amostra; a F5.8 mede de novo) |
| [041](ADR-041-resumos-de-entidades-e-relacoes.md) | Resumos de entidades e relações: só chama o LLM com mais de um texto; ranking por diversidade de seção, lotes de 30 e teto de 300; emissor em 2 níveis; maior prompt 817 tokens para um slot de 16 mil | F5.4 — aceita |
| [042](ADR-042-leiden-hierarquico.md) | Leiden hierárquico sem o emissor: 294 nós (138 entidades sem aresta ficam de fora), 3 níveis com 67/47/45 comunidades e modularidade 0,825/0,887/0,889 (GDS e recalculada coincidem); reprodutível | F5.5 — aceita |
| [043](ADR-043-relatorios-de-comunidade.md) | Relatórios de comunidade em JSON e `community_vec`: 159 de 159 válidos; o prompt `v1` vazava etiqueta em 61% e especulava em 16%, o `v2` em 0%; 10 revisados à mão; recall@1 = 1,0 | F5.6 — aceita |
| [044](ADR-044-embeddings-de-entidade.md) | Embeddings dos resumos de entidade e `entity_vec`: 433 em 4,3 s, incrementais por hash; recall@1 = 1,0; sonda pelo nome 96,8% no top-3; 4 entidades-lixo (nome vazio, `N/A`, `null`) achadas, filtradas no importador e apagadas | F5.7 — aceita |
| [045](ADR-045-indexacao-do-documento-inteiro.md) | Indexação do documento inteiro: 423 de 423 páginas, 2.474 entidades, 745 comunidades, 0 órfãos; 4 correções (erro 5xx, Leiden que não aninha, dois falsos positivos de validação); cobertura de métricas 88,4% e duplicatas entre camadas ficam abertas; ~9,5 h de execução | F5.8 — aceita com ressalva |
| [046](ADR-046-busca-local.md) | Busca local (`entidade`): `entity_vec` + `entity_ft` só pelo nome citado, reranker sobre `nome: resumo`, Pais por RRF (contagem × similaridade), tetos e orçamento de tokens; recall de contexto 1,00 nas 3 "quem é…" do golden e nas 10 do conjunto separado (n pequeno, ajustado nas 3) | F6.1 — aceita com ressalva |
| [047](ADR-047-busca-global.md) | Busca global (`panorama`): `community_vec` no nível 1 com `rating` ≥ 5, 16 comunidades em lotes, mapa com pontos notados em JSON validado, seleção sem repetição, reduce opcional e orçamento de tempo de 45 s; máximo de 56 s nas 10 perguntas panorama (aceite ≤ 90 s); recall de contexto 0,50 (n = 10) | F6.2 — aceita com ressalva |
| [048](ADR-048-templates-cypher.md) | Templates Cypher (`fato_financeiro`, `serie_metrica`, `comparar_segmentos`, `riscos`, `eventos`, `pessoas_cargos`): consultas fixas e somente leitura sobre o que o grafo real tem (recorte em `OF_METRIC.dimension`, mesmo valor em várias escalas, ano-base, cargos gravados como nome); 12 testes de contrato no grafo real batem N01, N02 e T15 com o golden | F6.3 — aceita com ressalva |
| [049](ADR-049-text2cypher.md) | Text2Cypher (`indexer.text2cypher`): prompt com esquema pela APOC (relações entre entidades agrupadas, 687 rótulos de `f.metric` amostrados), terminologia PT↔EN, 11 exemplos *few-shot* em JSON e 12 rótulos candidatos por pergunta; sessão `READ` com tempo limite e teto de linhas; acurácia de execução 90% (9/10) nas perguntas de teste de `eval/golden_agregacao.csv`, 86,7% no geral, mediana de 3,2 s; só 2 das 10 perguntas de agregação do golden têm dado no grafo, e as sem dado voltam números errados | F6.4 — aceita com ressalva |
| [050](ADR-050-guarda-corpos-text2cypher.md) | Guarda-corpos do Text2Cypher: texto sem comentários e com strings mascaradas, só leitura, sem procedimentos, `LIMIT 100` injetado; plano do `EXPLAIN` sem operador de escrita (o `EXPLAIN` roda em sessão `READ` mesmo para `CREATE`); sessão `READ`, 5 s; uma autocorreção que nunca atende violação; 26 de 26 entradas maliciosas bloqueadas sem escrita no grafo real, 0 falsos bloqueios, acurácia da F6.4 mantida (13/15) | F6.5 — aceita |
| [051](ADR-051-especialista-text2cypher.md) | O especialista Text2Cypher Gemma 3 4B (Q8_0, GGUF da comunidade) não compete neste grafo: 0/15, 0/15 e 1/15 com três prompts (inclusive o de treino) contra 13/15 do Qwen3.6-35B-A3B; 2 a 3 vezes mais rápido (0,95–1,4 s contra 2,85 s; carga 4,5 s contra 14,2 s), mas erra em silêncio; o Text2Cypher fica no LLM principal | F6.6 — aceita |
| [052](ADR-052-cliente-llm-typescript.md) | Cliente LLM em TypeScript sobre o SDK `openai` 7.43.0 fixado: perfis `principal` (Qwen sem raciocínio) e `rapido` (gpt-oss, esforço baixo), tempo-limite e cancelamento por chamada, erros por causa, uma nova tentativa só para rede e 5xx, vetores e índices do rerank conferidos; 47 testes unitários e 8 de integração; embedding 79 ms, rerank 513 ms, Qwen 1,3 s (carga a frio 13,9 s) | F7.1 — aceita |
| [053](ADR-053-atualizador-de-pergunta.md) | Atualizador de pergunta: autônoma + subperguntas com dependências em JSON forçado (Zod), histórico de 4 turnos delimitado, normalização e fallback para a pergunta inteira; soma, lista, série e atributos da mesma entidade não se decompõem; 10/10 compostas decompostas (9/10 com dependências exatas), teste 19/20 e `teste2` 9/9, ~3 s | F7.2 — aceita |
| [054](ADR-054-roteador-tool-calling.md) | Roteador com *tool calling* nativo: 12 ferramentas da §7.2 com esquema Zod, argumentos normalizados e validados, `buscar_trechos` como caminho seguro, subperguntas por ondas (até 2 juntas); 85,0% (17/20) de rota no `teste3` limpo, 82,5% na primeira medição de um grupo novo; nomear a companhia fez o modelo responder de memória; contas ainda vão para `buscar_tabelas` | F7.3 — aceita |
| [055](ADR-055-execucao-das-ferramentas-em-typescript.md) | As 12 ferramentas de recuperação passam a rodar no `api/` em TypeScript (tarefas F7.8 a F7.11), com paridade conferida contra o Python no grafo real; serviço Python e híbrido descartados | F7.3 — aceita |
| [056](ADR-056-templates-cypher-em-typescript.md) | Executor de ferramentas em TypeScript (`api/src/ferramentas`): contrato `evidencias[]`, `neo4j-driver` em sessão `READ` e os seis templates Cypher da F6.3; 54/54 chamadas idênticas ao Python no grafo real, N01/N02/T15 batendo com o golden; única divergência deliberada: lista vazia em vez de chave ausente nos erros de validação | F7.8 — aceita |

Modelo em [`ADR-000-modelo.md`](ADR-000-modelo.md).
