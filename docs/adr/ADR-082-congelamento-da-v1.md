# ADR-082 · Congelamento da v1: cinco metas da §1.3 atingidas e três com desvio medido (latência de pergunta simples, rastreabilidade nas 60 e pico de RAM)

- **Estado:** aceita (13/11/2026); regras de `eval/f95-medida-congelamento.md` aplicadas como estavam, nenhum veredito trocado depois do resultado
- **Data:** 2026-11-13
- **Tarefa(s):** F9.5

## Contexto

A F9.5 pede "metas da §1.3 atingidas ou desvios justificados em ADR", com `eval/resultados/v1.md` e a tag `v1.0.0`. A medida foi escrita e commitada **antes** de rodar (a9f02d1, ferramentas em c6b9352 e db0ea64): cada meta com como medir e regra de veredito `atingida` ou `desvio`, a escada A3ts, A4 e A5 refeita com o redator da F9.4 (a F9.4 deixou isso como pendência), o A6 da v1 igual à r3 da F9.4 e o código do produto congelado no commit `5a5266d`. Uma execução de cada medida, nenhuma refeita.

## Decisão

Congela-se a v1 no código de `5a5266d` com o resultado abaixo (`eval/resultados/v1.md`, gerado por `uv run python -m indexer.f95 v1`). A tag `v1.0.0` aponta para o commit que contém o `v1.md`, este ADR e o `infra/models.lock.json` com o bloco `prompts` (22 arquivos com sha256).

| Meta (§1.3) | Veredito | Medido |
|---|---|---|
| RNF-1 Privacidade | **atingida** | 5 URLs fora de loopback no código, todas documentais (espaço de nomes do SVG, `$schema` e `$id` dos esquemas); 0 conexões remotas fora de loopback em 448 amostras (2 s) dos processos node, llama-server, llama-swap e java |
| RNF-2 Latência, pergunta simples | **desvio** | 0 de 30 com 1º token ≤ 5 s e completa ≤ 20 s (regra: ≥ 27) |
| RNF-3 Latência, busca global | **atingida** | 10 de 10 em ≤ 90 s (mediana 32,8 s, máximo 85,7 s), com 7 a 26 eventos `etapa` antes do 1º token |
| RNF-4 Fidelidade ≥ 0,90 | **atingida** | 0,97 (60) e 1,00 (24) |
| RNF-5 Correção ≥ 0,70 e ≥ +15 p.p. | **atingida** | A6 0,87 contra A3 0,54 (+33 p.p.) nas 60; 0,77 contra 0,48 (+29 p.p.) nas 24 |
| RNF-6 Rastreabilidade | **desvio** | 60: 58 de 63 afirmações numéricas citadas (92,06%); 24: 29 de 29 |
| RNF-7 Reprodutibilidade | **atingida** | `verify_models` sai com 0; todo modelo de produção do YAML tem sha256 no lock (3 do bake-off da F9.3 ficam de fora, declarados); 22 prompts com sha256; conferência na tag em "Evidência" |
| RNF-8 Memória | **desvio** | VRAM pico 11,51 GB (limite 15,2, ok); RAM usada pico 31,58 GB (limite 28) |

## Os três desvios e o que significam

- **RNF-2 (latência de pergunta simples).** No perfil `consultar` (o padrão), pela API real: o 1º token chega em **14,6 s (mediana) e 37,5 s (p95)**, nenhum em ≤ 5 s (o menor foi 5,4 s), e a resposta completa em 15,5 s e 38,9 s; 24 das 30 terminam em ≤ 20 s. **O perfil `consultar-rapido` também não cumpre** (0 de 30; 1º token mediano 13,3 s, completa 14,3 s, 25 de 30 em ≤ 20 s), porque os dois usam o mesmo Qwen e só difere o número de rodadas. Causa, igual à dos ADR-061, ADR-066 e ADR-081: o redator só começa a escrever depois do ciclo de busca (atualizador, roteador, ferramentas, crítico), e cada passo é uma chamada ao Qwen3.6 (35B, parte dos experts na RAM). O ciclo é o que levou a correção de 0,59 para 0,87; encurtá-lo custou, nas medidas anteriores, página citada e acerto numérico. **Quem usa:** a resposta vem em 15 s na mediana, com a tela mostrando o rastro das etapas enquanto isso, mas não "no primeiro token em 5 s". Para cumprir seria preciso um LLM menor no roteador e no crítico, transmitir um rascunho antes do crítico ou trocar de GPU; nada disso foi medido e fica fora da v1.
- **RNF-6 (citação das afirmações numéricas), 60 perguntas.** 58 de 63 (92,06%). As 5 frases sem citação são todas da **P01**, e olhando o texto da resposta o que a régua marcou foram os rótulos `1.` a `5.` de uma lista numerada: cada item da lista termina com `[E13]`. É defeito da régua de frases (o divisor separa o rótulo do item), **o mesmo tipo de defeito** que a F7.5 achou (ADR-061), e **não foi corrigido nem reavaliado aqui**: a regra desta medida diz que a régua é a da F7.5 como está, e a medida não troca depois de falhar. O número publicado é o 92,06%, com esta leitura ao lado; nas 24 perguntas foi 100%. A régua continua medindo se há citação válida, não se ela sustenta a frase (ADR-061).
- **RNF-8 (RAM), 31,58 GB contra 28 GB.** A medida é "total visível menos livre" do sistema inteiro, amostrada a cada 2 s durante a rodada da API com Neo4j no ar. Antes de qualquer modelo carregar já eram **8,57 GB** (Windows e aplicativos abertos, entre eles o app do Claude), e o contador "livre" do Windows não conta o cache de arquivos, em que ficam as páginas mapeadas dos GGUF: o número **superestima o uso real** do que é do projeto. Não houve medida do conjunto de trabalho dos processos do projeto, então não se sabe quanto é de fato dele; a F0.5 mediu 25,3 GB só com o Qwen no perfil `consultar` e sem o Neo4j, o que é compatível com 28 GB para o conjunto. **Quem usa:** num PC de 32 GB com navegador e outros aplicativos abertos a memória fica no limite; fechar aplicativos pesados antes de usar é o conselho do §2.4 e continua valendo. A VRAM (11,51 GB, e 14,65 GB no perfil `avaliar`) está dentro do limite de 15,2 GB.

## O que a escada final mostra (60 perguntas, `v1.md`)

- Correção: A0 0,20; A1 0,54; A2 0,53; A3 0,54; **A3ts 0,57; A4 0,61; A5 0,58; A6 0,87**. Com o redator novo A3ts, A4 e A5 sobem de 0,53, 0,54 e 0,53 (F9.1) para esses valores, **mas o acerto numérico não muda** (0,29, 0,38, 0,38). Entre degraus vizinhos a diferença fica abaixo de 0,05 (empate); o que A4 ganha sobre A3 (+0,07) é de dois passos.
- **O que separa o A6 dos outros (+0,29 sobre o A5) é o ciclo** (crítico lendo a evidência inteira, `buscar_tabelas` junto de toda rota roteada, redator com as tabelas em linhas), e não as ferramentas de grafo sozinhas: a agregação é 0,00 em A3ts e A5 e 0,05 no A4 (Text2Cypher e templates), contra 0,70 no A6; a numérica, 0,33, 0,47, 0,47 contra 0,90. A conclusão da F9.1 ("A1 a A5 empatam; o salto é ter o documento") se mantém para A1 a A5, e a leitura nova é que o ganho do A6 vem de ler a tabela certa e de não desistir cedo.
- A latência pelo A6 é a mais alta da escada (p50 17,4 s, p95 70,1 s nas 60); o A5 tem p95 de 46,8 s (o `panorama`).
- **Grupo novo (24):** A3 0,48 → A6 0,77, fidelidade 1,00.

## Alternativas consideradas

- **Trocar a regra do RNF-6 para que passe** (régua corrigida, como na F7.5): descartada; o dono não aceita pós-hoc de algo que falhou, e a regra estava escrita. O desvio é publicado com a leitura.
- **Refazer a medida de RAM com o conjunto de trabalho dos processos:** seria uma medida nova e diferente da prevista; fica como melhoria possível, não como troca de veredito.
- **Congelar só com as metas todas atingidas:** o aceite diz "ou desvios justificados"; esperar por um LLM menor ou outra GPU não cabe na v1.

## Consequências e ressalvas

- **A6 é uma execução** (a r3 da F9.4, depois de três rodadas de correção, todas contadas); a variância do Qwen a 0,2 e do juiz não foi medida. O resultado nas 60 é otimista (conjunto em que as falhas foram lidas); o grupo novo (24) é a checagem, com categorias de 3 a 6 perguntas.
- **Golden e rótulos do juiz são do Claude** (ADR-027, ADR-030); o Gemma é juiz de respostas do Qwen; só a correção foi calibrada.
- **Latência e memória** valem para esta máquina (RX 9070 16 GB, 32 GB, Windows), uma execução, e dependem do cache de prompt do servidor.
- **A amostragem de rede não prova ausência de conexões** (uma conexão curta pode escapar dos 2 s); o que sustenta o RNF-1 é a soma dela com a auditoria do código e com o fato de a API, o llama-swap e o Neo4j ouvirem só em 127.0.0.1.
- **Dívida aberta (F9.3):** o reranker com `-c 4096` devolve HTTP 500 em ~1,3% das chamadas; não foi tratada na v1.
- **Ainda falham** 12 das 60 e 7 das 24 (ADR-081), sem diagnóstico novo aqui.
- **O A3ts, A4 e A5 deste `v1.md` substituem a coluna da F9.1** como escada final, mas `eval/resultados/v1-ablacao.md` (F9.1) fica como registro, sem reescrita.

## Evidência

`eval/f95-medida-congelamento.md` (medida, execuções, resultado por item), `eval/resultados/v1.md` (gerado por `uv run python -m indexer.f95 v1`), `f95-rede.json`, `f95-recursos.json`, `f95-latencia.json`, `f95-redator.json`, `f95n-redator.json`, `f95-repro.json`, `f95-verify.json`, `f95-a3ts.json`, `f95-a4.json`, `f95-a5.json`; respostas, notas do juiz e a amostragem em `data/avaliacao/`, fora do git (ADR-009). Commits: medida a9f02d1, ferramentas c6b9352 e db0ea64, metas 5c5a990. Código do produto: `5a5266d`.

Reproduzir (Neo4j e llama-swap no ar): `.\infra\rodar-f95.ps1 -Fase metas`, depois `-Fase escada` e `-Fase tabela`. Conferir a tag: `uv run python -m indexer.f95 repro --tag v1.0.0` (a partir de `indexer/`).
