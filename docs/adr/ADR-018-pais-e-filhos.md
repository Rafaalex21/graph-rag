# ADR-018 · Segmentação em Pais e Filhos

- **Estado:** aceita (28/10/2026)
- **Data:** 2026-10-28
- **Tarefa(s):** F2.1

## Contexto

A ARQUITETURA §5 (I-3) pede Pais de ≈ 1.200 tokens (máximo 1.600) que nunca atravessam seção, e Filhos de ≈ 320 tokens com 12% de sobreposição, prefixados com o caminho da seção. Os tokens devem ser contados pelo `/tokenize` do `llama-server`. A medição no recorte de 79 páginas mostrou que essas duas regras (alvo de 1.200 e "nunca atravessa seção") não se realizam juntas neste documento; a decisão sobre qual vale foi do usuário (ver abaixo).

## Decisão

Módulo `indexer/src/indexer/chunks.py`, entrada: elementos normalizados (ADR-015) + árvore de seções (ADR-016).

1. **Pai = corpo direto de uma seção** (do título até o próximo título, de qualquer nível). A seção que cabe em 1.600 tokens vira um Pai só; a maior é dividida em n = ⌈tokens/1.200⌉ partes de tamanho parecido, em fronteira de parágrafo, conferindo a contagem real depois (se passar de 1.600, tenta com mais partes). Parágrafo acima do máximo é cortado por frases e, se ainda passar, por palavras (último recurso que garante o término).
2. **Sem tabelas e figuras no texto do Pai** (a tabela é nó atômico, §5 I-3, e ganha perguntas hipotéticas na F2.7); elas saem numa lista à parte (`fora_do_texto`) com a seção, as páginas e as notas associadas. `document_index` (o sumário impresso) também fica de fora.
3. **Filho = janela de frases** do Pai, com orçamento de ≈ 320 tokens **contando o prefixo** (`Título › Subtítulo`), e 12% do corpo repetido no começo do seguinte (frases inteiras; se a última sozinha passa do alvo, só as últimas palavras, marcadas com "…"). Cada Filho carrega suas próprias páginas.
4. **Tokenizadores diferentes por unidade:** Pai com o do Qwen3.6 (quem o consome na extração), Filho com o do Qwen3-Embedding. A mesma frase em português deu 24 tokens num e 30 no outro, então um contador único erraria um dos dois em ~25%. A contagem usa `POST /upstream/<modelo>/tokenize` do llama-swap (os dois modelos coexistem no perfil `consultar`).
5. **IDs determinísticos:** hash de documento + seção + ordem + texto, para a importação idempotente da F2.2/F4.4.
6. Saída: `data/parsed/<nome>.chunks.json` (Pais, Filhos, `fora_do_texto`, seções sem texto, estatísticas).

## Decisão do usuário (28/10/2026)

No recorte, "nunca atravessa seção" e "≈ 1.200 tokens" conflitam. Duas saídas foram apresentadas: (a) manter a regra estrita e corrigir a ARQUITETURA; (b) juntar seções irmãs pequenas até ~1.200 tokens (~34 Pais no recorte, mas Pai com várias seções, relação N:N no §6 e citação menos precisa). **Escolhida: (a), regra estrita.** A ARQUITETURA foi corrigida (v0.6, §5 I-3 e §5.2).

## Alternativas consideradas

- **Juntar seções irmãs pequenas** (descartada, ver acima).
- **Contar com um tokenizador só** (descartada: vocabulários diferentes, ~25% de diferença).
- **Janela de tokens exata para o Filho** (com `/tokenize` + `/detokenize`): corta frases no meio e complica o contador; a fronteira de frase preserva sentido e a sobreposição fica em ~12,4%.
- **Tabelas dentro do Pai:** inflaria o Pai com números que já têm nó próprio e confundiria a extração dirigida (F4.2 extrai por Pai e por Tabela).

## Consequências

- Os Pais são pequenos e numerosos: o "~1.200" é teto-alvo, não tamanho típico. A estimativa de chamadas de extração (§5.2) precisa ser refeita com a medição (F5.8).
- A F2.2 carrega `Parent` com `secao_id`, `pageStart`, `pageEnd` e `HAS_CHILD`; cada Pai tem uma única Seção.
- A linha de base vetorial (F2.3, A1) **não enxerga o conteúdo das tabelas** até a F2.7 (perguntas hipotéticas) e a F4 (fatos); isso vale para a comparação A0–A3 da F3 e deve constar do relatório dela.
- Títulos que o Docling classificou como cabeçalho mas são frases longas (por exemplo, "regras, políticas, procedimentos…") viram prefixo de ~50 tokens nos Filhos (ressalva da ADR-016).

## Verificação do aceite da F2.1

| Critério | Resultado |
|---|---|
| Tokens contados via `/tokenize` | Pai com `qwen36-35b-a3b`, Filho com `qwen3-embed-0.6b`, pelo llama-swap em execução (`contador_llama`; testado com cliente falso nos testes unitários) |
| Nenhum Pai acima de 1.600 tokens | **0 de 116** (máximo medido 1.189). Como os dados reais não chegam perto do limite, o corte foi também exercitado com limites menores: alvo 300/máx. 400 → 144 Pais, máximo medido 360; alvo 150/máx. 200 → 202 Pais, máximo 196; nenhum acima do máximo |
| Pai sem cruzar seção, com páginas | 116 Pais em 112 seções (cada Pai tem uma `secao_id`); `pagina_inicio`/`pagina_fim` originais em todos; 58 das 170 seções não têm texto próprio |
| Filhos | 166 Filhos, máximo 320 tokens (média 193, mediana 176), 0 acima de 400; sobreposição média de 12,4% nos que têm sobreposição; 0 órfãos, 0 Pai sem Filho; páginas de cada Filho dentro das do Pai |
| Testes | 11 testes novos em `test_chunks.py`, 113 no indexador, ruff limpo |

Comando: `uv run python -m indexer.chunks ..\data\parsed\bb_fre_2026_recorte.normalizado.json ..\data\parsed\bb_fre_2026_recorte.secoes.json --saida ..\data\parsed`. Evidência bruta em [`ADR-018-bruto/`](ADR-018-bruto/) (`estatisticas_recorte.json`, `estresse_limites_menores.txt`).

## Ressalvas

1. 91 dos 116 Pais têm menos de 200 tokens (mediana 104, mínimo 8: seção que só tem uma frase). A qualidade desses Pais como contexto para o LLM e como unidade de extração só se mede na F3 e na F5.
2. A primeira versão do agrupador entrava em laço infinito quando um parágrafo gigante não tinha fim de frase reconhecível; o corte por palavras e um teste de regressão corrigem isso. O separador de frases só corta antes de maiúscula, parêntese ou aspas, então "p. 87" e "2025. 2026" não são cortados (preferimos um Filho um pouco maior a uma frase partida).
3. O recorte não é representativo do documento inteiro (mais narrativa de governança e tabelas do que o corpo); os números por página não devem ser extrapolados sem a F5.8.
4. Notas de rodapé sem âncora entram como texto do Pai da seção em que caíram; as ancoradas a tabelas ficam com a tabela.

## Evidência

`indexer/src/indexer/chunks.py`, `indexer/tests/test_chunks.py`, `data/parsed/bb_fre_2026_recorte.chunks.json` (ignorado pelo git; trechos do documento não são publicados, ADR-009).
