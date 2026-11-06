# ADR-045 · Indexação do documento inteiro (423 páginas)

- **Estado:** aceita (06/11/2026), com uma ressalva ao critério "reexecutar não repete chamadas ao LLM" aprovada pelo usuário (ver "Reexecução")
- **Data:** 2026-11-06 (execução de 05/11 a 06/11)
- **Tarefa(s):** F5.8

## Contexto

Até a F5.7 o grafo cobria só o recorte da F1.2 (79 páginas, 19% do documento). A F5.8 roda o pipeline das fases F1 a F5 nas 423 páginas, mede o que as tarefas anteriores deixaram para o documento inteiro e confere as consultas de sanidade da §6.4. Evidência: `ADR-045-bruto/resumo.json` (contagens, tempos e taxas; sem nomes de entidades nem trechos do documento, ADR-009).

## Decisão

**Mesmo pipeline, sem o mapa do recorte.** O documento inteiro é o próprio original, então a página física é a do PDF. O normalizador já aceitava ficar sem `--mapa`; o `sections.py` passou a aceitar também (sem o mapa, as páginas presentes são as que o normalizador viu).

```powershell
cd indexer
uv run --group parse python -m indexer.parse ..\data\raw\banco_do_brasil_formulario_referencia_2026.pdf --artefatos ..\infra\bin\modelos-docling --saida ..\data\parsed
uv run python -m indexer.normalize ..\data\parsed\banco_do_brasil_formulario_referencia_2026.docling.json --saida ..\data\parsed
uv run --group parse python -m indexer.sections ..\data\parsed\banco_do_brasil_formulario_referencia_2026.normalizado.json --pdf-original ..\data\raw\banco_do_brasil_formulario_referencia_2026.pdf --saida ..\data\parsed
uv run python -m indexer.chunks ..\data\parsed\banco_do_brasil_formulario_referencia_2026.normalizado.json ..\data\parsed\banco_do_brasil_formulario_referencia_2026.secoes.json --saida ..\data\parsed
cd ..; .\infra\indexar-documento.ps1 -Esvaziar      # retomável: -De <etapa>
```

**Orquestrador `infra/indexar-documento.ps1`.** Encadeia as etapas com LLM e as do Neo4j (tabelas, extração dirigida, lastro, catálogo, extração aberta, carga, embeddings, importação, resolução, resumos, comunidades, relatórios, vetores de entidade). Cada etapa grava uma linha em `data/logs/f58_etapas.log` e o estado em `f58_estado.txt` (uma linha, cabe no celular); repete a etapa até 3 vezes se falhar; os caches por hash fazem a repetição custar só o que faltava. Quem acompanha deve ler o log por varredura, não com `tail -F`: o `tail` segura o arquivo aberto e derrubou o orquestrador uma vez.

**Grafo do recorte esvaziado, com autorização do usuário (05/11/2026).** Antes, um `neo4j-admin database dump` (2.298 nós) em `data/backups/neo4j.dump`, fora do git. O mesmo `doc-id` teria Pais e Filhos de ids diferentes, e as comunidades seriam recalculadas de qualquer forma.

**Quatro correções que o documento inteiro exigiu**, todas com teste escrito antes (551 testes, `ruff` limpo):

1. **Erro 5xx do llama-swap** (um HTTP 500 na extração dirigida, causa não achada; o servidor seguiu saudável): `extrair.py` repete duas vezes (5 s e 20 s) e, se continuar, a unidade vira inválida em vez de parar a execução.
2. **Leiden que não aninha:** o GDS deixou 1 comunidade do nível 0 e 1 do nível 1 com membros em dois pais, e a trava da F5.5 recusou. `comunidades.refinar` divide a comunidade pelos pais (a partição mais grossa que refina a do GDS e aninha); não escolhe pai ao acaso. A modularidade do GDS e a recalculada sobre a partição do GDS continuam iguais; a da hierarquia gravada é registrada ao lado (`modularidade_gravada`, diferença de até 0,0015).
3. **Falso positivo do validador dos relatórios:** nomes de pronunciamentos contábeis com "(R1)", de "revisão 1", eram tomados pela etiqueta `R1` do contexto, e 3 conteúdos (5 comunidades) ficavam sem relatório depois das duas tentativas. Só vale como nome o que o próprio contexto trouxe (`\d{1,3} \(R\d\)`); `E1`, `R1` e `[E2]` soltos continuam barrados.
4. **Falso positivo do validador das perguntas hipotéticas:** o número de processo judicial (`12345.678901/2022-11`) casava com a regra "pergunta sem valor numérico" e deixava 3 tabelas de processos inválidas e sem vetor. O número só sai da checagem logo depois de "processo", "autos", "ação" ou "nº"; valores como `1.045.338` ou `37,0` continuam barrados.

## Resultado

| | Valor |
|---|---|
| Páginas processadas | **423 de 423**, todas com texto; Docling 682 s (1,61 s/página, CPU), 412 tabelas lidas, 408 depois da normalização |
| `Document` / `Section` / `Parent` / `Child` | 1 / 592 / 477 / 1.041 |
| `Table` / `HypotheticalQuestion` | 408 / 1.659 |
| `FinancialFact` / `Metric` / `Period` | 1.243 / 97 / 50 |
| `__Entity__` | **2.474** (11 tipos; 1 `:Issuer`) |
| `RELATED_TO` = `SUMMARIZED_RELATIONSHIP` | 2.772 |
| `__Community__` | **745**: 330 / 156 / 130 / 129 por nível |
| Modularidade por nível (GDS) | 0,697 / 0,823 / 0,831 / 0,832 |
| Índices | `child_ft`, `child_vec`, `question_vec`, `entity_vec`, `community_vec`: ONLINE, 100% populados |

**Consultas de sanidade da §6.4 e afins: 0 órfãos.** Filhos órfãos 0, Pais sem Filho 0, fatos sem evidência 0, entidades sem resumo 0, sem embedding 0, comunidades sem relatório 0, sem embedding 0, Tabelas sem Pai ou Seção 0, comunidades com mais de um pai 0, entidades em mais de uma comunidade do nível 0 0.

**Recalls:** `entity_vec` 1,000 (2.474 de 2.474), sonda pelo nome no top-3 93,0% e por apelido 93,3% (era 97,4% no recorte: mais entidades genéricas competindo); `community_vec` 1,000, sonda pelo título 98,9%; `question_vec` 0,992.

**Extração dirigida:** 827 unidades (419 Pais e 408 tabelas), todas válidas, 798 na primeira resposta; 1.876 fatos propostos, 1.246 aceitos pelo lastro (66,4%; 630 rejeitados, 33,6%), 1.243 no grafo. Um Pai bateu no teto de fatos.

**Extração aberta:** 477 Pais, todos válidos (467 na primeira), 3.794 entidades e 3.149 relações; 2 Pais bateram no teto de 30 entidades; 965 mil tokens de prompt e 382 mil de saída.

**Tabelas:** 408 de 408 válidas depois da correção 4, 3 a 5 perguntas por tabela (39 perguntas da primeira rodada de 10 tabelas, que a carga só acrescenta, foram apagadas do grafo por um script com trava: só o que não estava no `tabelas.json` atual, 0 faltando).

**Tempos** (relógio, 2 chamadas em paralelo; ~9,5 h de execução e ~50 min de reexecução, contra 4,6 h da tabela da §5.2 e 6,5 h da nota da tarefa):

| Etapa | Tempo |
|---|---|
| Docling + normalização + seções + chunks | 12 min |
| Perguntas das tabelas | 39 min |
| Extração dirigida | 90 min (duas rodadas, com o erro 500 no meio) |
| Catálogo de métricas | 15 min |
| Extração aberta | 127 min |
| Carga, embeddings, importação | 5 min |
| **Resolução de entidades** | **130 min** (não estava na tabela da §5.2) |
| Resumos | 21 min |
| Relatórios de comunidade | 119 min (45 + 74) |
| Vetores de entidade | 10 min |

## Medições que as tarefas anteriores deixaram para o documento inteiro

- **Cobertura de métricas canônicas (F4.6): 88,4%** (1.099 de 1.243 fatos), **abaixo dos 95% do critério**, que tinha dado 99,6% no recorte. A nota da F4.6 já avisava que o número era otimista, porque o catálogo foi escrito olhando o recorte. Os 144 fatos sem métrica são o insumo para ampliar `contracts/metricas.json`; não fiz isso aqui.
- **Resolução de entidades (F4.5):** 2.515 candidatos, 750 aceitos e 1.765 recusados pelo juiz, 308 fusões, 438 nós absorvidos (2.912 → 2.474), 45 conflitos parciais.
- **Duplicatas entre camadas nas 30 entidades mais citadas (F5.3): o critério não se sustenta no documento inteiro.** Pela minha leitura dos vizinhos de cada uma, sobram cerca de 10 pares em 9 das 30 (contra "até 2" no recorte): o mesmo órgão com e sem "do Banco do Brasil" (diretoria, conselho, comitê), singular e plural, sigla e nome por extenso, nome igual em dois tipos (organização e evento), "BB Seguridade" e a razão social. A resolução precisa de uma regra de qualificador do emissor, de plural e de sigla ↔ nome. Não corrigi.
- **Teto de descrições (F5.4):** o emissor teve 39 descrições descartadas pelo teto de 300 (0 no recorte); resumido em dois níveis.
- **Entidades sem aresta (F5.5):** 824 de 2.473 (33%) ficam fora da projeção e das comunidades, a mesma fração do recorte (32%). A projeção tem 1.649 nós e 1.965 arestas.
- **Contexto omitido nos relatórios (F5.6):** 14 de 745 comunidades têm entidades ou relações cortadas do contexto (964 itens no total); o maior prompt foi de 6,4 mil tokens.
- **Revisão a mão de relatórios (F5.6), outra amostra:** 7 relatórios sorteados (semente fixa; comunidades de 4 a 12 entidades), cada um lido ao lado dos resumos das entidades de origem. 4 fiéis sem ressalva relevante, 1 com exagero leve (a autorização do Judiciário virou "requisito"), 2 com problema: um herda de um resumo de entidade a frase de que o Patrimônio de Referência é "também conhecido como Nível II" e se contradiz, outro afirma aprovação do Cade para uma operação que os resumos só atribuem a outras duas. A revisão é minha, não de uma pessoa.

## Reexecução (ressalva aprovada pelo usuário)

Rodar de novo as etapas com LLM: tabelas, extração dirigida, catálogo, extração aberta, resumos, relatórios e vetores de entidade fizeram **0 chamadas novas** (as tabelas regeraram só as 10 que estavam inválidas). O **`resolver planejar` repetiu 6 chamadas** (0,2% das 2.729 do cache): a geração de candidatos varia um pouco entre execuções (2.513 candidatos contra 2.515), e um dos pares novos virou fusão. Uma entidade a menos mudou a partição do Leiden e custou 52 relatórios novos (25 min). O critério foi aceito com essa ressalva; tornar a geração de candidatos determinística fica como melhoria.

Duas coisas que aprendi com isso: `resolver planejar` **desfaz as fusões no Neo4j** ao reconstruir o grafo (as entidades voltaram para 2.912) e exige `aplicar` depois, e as comunidades não são estáveis a mudanças pequenas na entrada (os ids vêm do conteúdo, então uma partição diferente gera relatórios novos).

## Consequências

- O grafo do documento inteiro está pronto para a F6 (recuperadores de grafo) e para a F9; o `ask` e o golden set da F3 passam a ter as respostas das 423 páginas.
- Cobertura de métricas de 88,4% e duplicatas de nome entre camadas são as duas dívidas de qualidade que a F5.8 mediu e deixou abertas; a primeira é trabalho no catálogo, a segunda na resolução.
- `data/backups/neo4j.dump` restaura o grafo do recorte, se for preciso comparar.

## Limites

- Toda auditoria (duplicatas, relatórios) é minha; nenhuma pessoa conferiu. A sonda pelo nome de `entity_vec` e a revisão de relatórios são amostras.
- Um erro HTTP 500 do llama-swap na extração dirigida não teve causa achada; hoje ele é tolerado, não explicado.
- Os tempos dependem de a máquina ficar livre; com uso do desktop (ADR-010), a execução leva mais.
