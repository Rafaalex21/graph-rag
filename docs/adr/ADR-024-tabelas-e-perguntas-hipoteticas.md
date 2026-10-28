# ADR-024 · Tabelas: descrição, perguntas hipotéticas e `question_vec`

- **Estado:** aceita (28/10/2026)
- **Data:** 2026-10-28
- **Tarefa(s):** F2.7

## Contexto

A tabela é um nó atômico (ADR-018) e a busca vetorial sobre Filhos não enxerga seu conteúdo. A estratégia do cap. 3 (ARQUITETURA §5 I-3) é pedir ao LLM uma descrição e 3 a 5 perguntas hipotéticas por tabela e embutir as perguntas, que passam a representar a tabela na busca. O aceite da F2.7 é "100% das tabelas com perguntas; 10 revisadas à mão".

## Decisão

Módulos `indexer/src/indexer/tabelas.py` (geração) e `tabelas_grafo.py` (Neo4j), em duas fases por usarem perfis diferentes do llama-swap.

1. **Tabela em Markdown** a partir da grade do Docling: célula mesclada só aparece na posição de origem; linhas de cabeçalho (`column_header`) antes do separador. Cada tabela leva a seção, as páginas, as notas (ADR-015), até 2 parágrafos que a antecedem (o título costuma ficar fora da tabela) e a escala/moeda detectadas pelo normalizador numérico (ADR-017).
2. **Geração** pelo Qwen3.6 (`indexar`), temperatura 0,3, sem raciocínio (`enable_thinking: false`), `response_format: json_schema` estrito (`descricao` ≥ 30 caracteres; `perguntas` de 3 a 5). Cache por hash do pedido e da versão do prompt (retomável), 2 chamadas em paralelo (`-np 2`).
3. **Validação e retentativa:** a resposta é rejeitada se tiver número errado de perguntas, perguntas repetidas ou sem `?`, a expressão "a tabela", **valor numérico na pergunta** (vírgula decimal ou milhar com ponto; anos, datas e números de seção passam) ou a palavra "fator" na descrição. Em caso de erro, os erros são anexados e o modelo responde de novo, até 3 respostas; entradas de cache inválidas são refeitas.
4. **Prompt v2** (depois da revisão manual, ver abaixo): pede o qualificador que distingue a tabela de outras parecidas (cenário, segmento, exercício) em todas as perguntas, afirmar unidade só se declarada, e perguntas respondíveis só com a tabela.
5. **Grafo** (§6.1): `Section -[:HAS_TABLE]-> Table -[:HAS_QUESTION]-> HypotheticalQuestion`. `Table` guarda Markdown, descrição, páginas, linhas, colunas, `scale`, `currency` e notas; `HypotheticalQuestion`, texto, ordem e vetor. Carga idempotente (`MERGE` por id determinístico). Nova *constraint* `question_id` (a §6.3 foi ampliada, passando a 11) e índice `question_vec` (1024 dims, cosseno).
6. **Embeddings:** as perguntas entram **sem instrução** (lado do documento), em lote pela GPU (perfil `vetorizar`, ADR-020); a consulta do usuário levará o prefixo de instrução.
7. **A descrição fica na Tabela e não é embutida**: o que representa a tabela na busca são as perguntas (cap. 3). Se a F3 mostrar que a descrição ajuda, ela vira mais um vetor.

## Alternativas consideradas

- **Embutir o Markdown da tabela:** números em texto corrido embutem mal e a tabela some entre perguntas em linguagem natural; é justamente o que a estratégia evita.
- **Um prompt só, sem validação:** a rodada 1 mostrou defeitos que o texto livre não pega (valor vazado, jargão); as regras mecânicas viraram validação.
- **Pedir ao LLM o qualificador por regra fixa (anexar o título da seção à pergunta):** concatenar o caminho da seção às perguntas pioraria o português e repetiria texto; pedir no prompt e conferir na revisão funcionou.

## Consequências

- A F2.9 e a F3 podem buscar tabelas por `question_vec` (pergunta → `HypotheticalQuestion` → `Table`) e entregar o Markdown como evidência.
- A F4 (fatos) extrai por Tabela usando o mesmo Markdown e as notas.
- Gerar as tabelas do documento inteiro (F5.8) leva a ordem de 7,5 min por 62 tabelas, ou seja, ~1 h para ~500 tabelas, no perfil `indexar`.

## Verificação do aceite da F2.7

| Critério | Resultado |
|---|---|
| 100% das tabelas com perguntas | **62 de 62** tabelas com 3 a 5 perguntas (28 com 5, 33 com 4, 1 com 3), 275 perguntas, 62 de 62 válidas; sanidade no banco: 0 tabelas sem pergunta, sem descrição, sem seção, 0 perguntas órfãs ou sem vetor |
| `question_vec` | `ONLINE`, 100% populado, 1024 dims, cosseno |
| 10 revisadas à mão | Duas rodadas sobre as mesmas 10 tabelas sorteadas, em [`docs/revisao-tabelas-f2-7.md`](../revisao-tabelas-f2-7.md): v1 com 3 tabelas defeituosas (sem qualificador de cenário, valor vazado, jargão), v2 com 6 sem defeito, 4 com defeito leve e 42 de 44 perguntas corretas. **Revisão feita por Claude, não por humano independente.** |
| Idempotência | segunda carga: `embutidas_agora = 0` e mesmas contagens (`carga.json`, `carga2.json`); camada léxica intacta com as 11 *constraints* |
| Testes | 10 testes novos em `test_tabelas.py` (e ajuste em `test_grafo.py` para 11 *constraints*); 161 no indexador, ruff limpo |

**Efeito do prompt v2 (62 tabelas):** de v1 para v2, descrições com "fator" 9 → 0; perguntas com valor numérico 2 → 0 (nas 294 da v1, pela regra nova); total de perguntas 294 → 275 (a v2 e as regras geram menos perguntas por tabela). Tentativas: v1 sempre 1 (não havia as regras mecânicas); na v2, 3 tabelas precisaram de nova resposta e 2 terminaram inválidas, uma por falso positivo do meu validador ("seções 7.3 e 7.4" lido como valor) e outra por violação real ("a tabela" em 3 de 5 perguntas); com o validador corrigido e até 3 respostas, as 62 ficaram válidas.

**Sondas informativas** (`autoteste`, em [`ADR-024-bruto/`](ADR-024-bruto/)):

| Sonda | Resultado |
|---|---|
| cada pergunta re-embutida pela CPU é a vizinha nº 1 de si mesma | **1,00** (275/275) |
| a vizinha mais próxima, *excluindo a própria pergunta*, é de outra pergunta da mesma tabela | **0,444** |
| alguma das 3 vizinhas mais próximas (sem a própria) é da mesma tabela | **0,669** |

## Ressalvas

1. **A sonda de vizinhança é baixa e precisa de leitura cuidadosa:** perguntas de tabelas parecidas (as de empregados por raça e por faixa etária, os cenários de risco, as várias tabelas de captação) são naturalmente vizinhas entre si, então "a vizinha é da mesma tabela" subestima a utilidade; mas também indica que as perguntas **não separam bem tabelas da mesma família**. Quem decide se isso importa é a F3 (a tabela certa entre as recuperadas).
2. **A revisão é minha, de 10 tabelas (16%), feita por quem escreveu o prompt;** ela encontrou e corrigiu defeitos sistemáticos, mas não prova a qualidade das outras 52. O sorteio e a lista estão no documento de revisão para uma conferência humana.
3. **Um apontamento da rodada 1 estava errado** (a unidade "milhões de reais" tinha lastro no título da seção, que eu só tinha visto truncado) e foi retirado; fica registrado.
4. **Tabelas com estrutura imperfeita** (4, 9 e 12 da auditoria F1.6) geram perguntas razoáveis, mas herdam o cabeçalho achatado; a melhoria de estrutura continua em aberto.
5. **A descrição e as perguntas inferem o ano-base e o nome do emissor** a partir do cabeçalho do pedido ("Documento: … Banco do Brasil … ano-base 2025"), que não faz parte da tabela; isso é intencional (autossuficiência), mas é informação do contexto, não da célula.
6. Esta etapa não tem teste automático contra o banco real, só a sanidade e as sondas dos comandos `carregar` e `autoteste`.

## Evidência

`indexer/src/indexer/tabelas.py`, `indexer/src/indexer/tabelas_grafo.py`, `indexer/tests/test_tabelas.py`, `docs/revisao-tabelas-f2-7.md`, `docs/adr/ADR-024-bruto/`. As saídas com o texto gerado ficam em `data/parsed/` (ignorado pelo git).
