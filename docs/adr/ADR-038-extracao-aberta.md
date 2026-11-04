# ADR-038 · Tipos de entidade e prompt da extração aberta (MS GraphRAG)

- **Estado:** aceita (04/11/2026): 11 tipos fixos, esquema `open_extraction.schema.json` 1.0.0 e prompt `v3`; 5 Pais extraídos e lidos contra o texto, com defeitos residuais listados abaixo
- **Data:** 2026-11-04
- **Tarefa(s):** F5.1

## Contexto

A F5.1 pede os tipos de entidade financeiros da §5 I-6 fixados, um prompt de extração em JSON versionado e 5 Pais extraídos e revisados à mão. É a camada que o Microsoft GraphRAG chama de extração de entidades e relações: sai uma lista de entidades `{name, type, description}` e de relações `{source, target, description, strength}` por Pai. A F5.2 a roda no corpus e mede o *gleaning*; a F5.3 a converge com as entidades da extração dirigida.

## Decisão

**Esquema** (`indexer.schemas.aberta`, `contracts/open_extraction.schema.json`, versão 1.0.0, gerado por `python -m indexer.schemas`, conferido com `--conferir` e por teste). Mesmo molde da F4.1: Pydantic com `Field(description=...)`, `extra="forbid"`, listas obrigatórias que podem vir vazias, `maxItems` (30 entidades, 40 relações) e descrição de até 300 caracteres impostos por gramática. A força é um enum de inteiros de 1 a 10, e não `minimum`/`maximum`, porque a gramática do llama-server impõe `enum` e não `pattern` (ADR-032). Três validações que a gramática não faz, com a mensagem de erro indo na retentativa:

- toda relação cita só entidades da mesma resposta (sem caixa nem espaços sobrando);
- nenhum nome de entidade é só uma data ("14 de agosto de 2024", "2025") ou só um valor ("R$ 625 milhões", "27,1%"), por expressão regular;
- a resposta é válida em JSON (a gramática já garante, a validação confere).

**Onze tipos, não dez.** A §5 I-6 tinha dez. Na primeira leitura dos 5 Pais, 8 das 9 entidades `PRODUCT_OR_SERVICE` eram políticas, programas, metodologias e instrumentos de governança dos dois Pais do programa de integridade (páginas 195–197), porque nenhum dos dez tipos os cobre. Entrou `POLICY_OR_PROGRAM` (política, programa, metodologia, processo ou instrumento interno de governança, controle e compliance), entre `REGULATION` e `LOCATION`, e a ARQUITETURA §5 I-6 foi corrigida antes do uso. Sem ele, "quem aprova a política de PLD" ficaria sem o nó certo para o Cypher da F6. Os onze: `ORGANIZATION`, `PERSON`, `SEGMENT`, `PRODUCT_OR_SERVICE`, `FINANCIAL_METRIC`, `RISK`, `EVENT`, `FINANCIAL_INSTRUMENT`, `REGULATION`, `POLICY_OR_PROGRAM`, `LOCATION`. O prompt, o esquema e a ARQUITETURA dizem os mesmos onze, e um teste confere.

**Prompt** (`indexer.extracao_aberta`, versão `v3`). Em português, com a definição de cada tipo, onze regras curtas e um exemplo fictício (uma empresa de energia inventada; nenhum trecho do documento do BB vai para o repositório, ADR-009). O pedido é o mesmo de `PEDIDO_PAI` da F4.2 (documento, seção, páginas, trecho). Só Pais entram; as Tabelas ficam com a extração dirigida. Chamada com `temperature` 0,1, `enable_thinking` falso, gramática do esquema, até 3 tentativas (a recusa de um nome que é data deixa relações soltas, que só a segunda retentativa limpa), cache por hash do pedido em `data/parsed/aberta_cache/`, resultado em `data/parsed/<prefixo>.aberta.json` (fora do git: as descrições são paráfrases do documento do BB).

**Entidades têm de ser só o que o trecho nomeia.** Valores e datas não são entidade: o valor vai na descrição da entidade a que pertence, e o acontecimento com data é um `EVENT` nomeado pelo que aconteceu ("aprovação da reorganização"), com a data na descrição. Quem consulta valores usa os `FinancialFact` da extração dirigida; a ligação entre uma métrica nomeada e o catálogo da F4.6 é questão da F5.3.

## Medição

**Amostra:** 5 Pais sorteados com semente 1 entre os 13 de pelo menos 300 tokens do recorte (`python -m indexer.extracao_aberta executar ../data/parsed/bb_fre_2026_recorte --amostra 5 --semente 1`): dois de movimentos societários (páginas 6–8), um de segmentos (10) e dois de integridade (195–197). O corte de 300 tokens só evita sortear trechos sem o que revisar. O resumo por versão está em `ADR-038-bruto/resumo.json`.

**A revisão foi minha** (Claude): li o texto de cada Pai e a saída inteira, entidade por entidade e relação por relação. Não foi uma pessoa. E o prompt foi ajustado olhando esses mesmos 5 Pais, então os números de `v3` são otimistas para Pais novos; a medida honesta vem na F5.2, em 20 Pais que o prompt não viu.

| Versão | Entidades | Relações | Defeitos achados na leitura |
|---|---|---|---|
| v1 (10 tipos) | 92 | 85 | 8 de 9 `PRODUCT_OR_SERVICE` são políticas e programas (lacuna de tipo); 3 valores soltos como `FINANCIAL_METRIC`; 2 `PERSON` errados (um grupo de acionistas, um cargo); "Novo Mercado" ora `REGULATION`, ora `SEGMENT`; fatos que o texto só anuncia contados como feitos |
| v2 (11 tipos, regras de tipo e de tempo) | 112 | 110 | fecha o `PERSON` e a lacuna de políticas, mas 13 `EVENT` saem nomeados por data ("14 de agosto de 2024") e 3 percentuais seguem como `FINANCIAL_METRIC`; um Pai bate o teto de 30 entidades |
| v3 (nome de `EVENT` pelo que aconteceu, validação de nome) | 94 | 89 | 0 valores soltos, 0 nomes que são data, 0 `PERSON`; 13 `EVENT`, todos nomeados pela ação; ver residuais |

Os 5 Pais saíram válidos de primeira nas três versões (a retentativa não foi usada), nenhum no teto de entidades em `v3`. Por tipo em `v3`: 47 `ORGANIZATION`, 13 `EVENT`, 9 `SEGMENT`, 8 `REGULATION`, 6 `RISK`, 6 `POLICY_OR_PROGRAM`, 4 `PRODUCT_OR_SERVICE`, 1 `FINANCIAL_INSTRUMENT`, 0 `PERSON`, 0 `LOCATION`, 0 `FINANCIAL_METRIC`. Custo: cerca de 2,9 mil tokens de prompt e 2,2 mil de saída por Pai e ~90 s de LLM por Pai, o que dá uma ordem de grandeza de 1,5 a 3 horas para os 116 Pais do recorte (a F5.2 mede de verdade, com o *gleaning*).

## Defeitos residuais em `v3` (para a F5.2 e a F5.3)

1. **Apelidos viram entidades.** A mesma lei saiu três vezes num Pai (o número, "Lei da Empresa Limpa" e "Lei Anticorrupção") com relações "é conhecida como"; a "Metodologia da Avaliação Interna de Risco" e a "Avaliação Interna de Risco" também. A regra do prompt contra isso não pegou. É trabalho da resolução (F5.3, mesma da F4.5), com os apelidos como candidatos; um Pai ainda repete uma entidade (a subsidiária de cartões duas vezes, com descrições diferentes).
2. **A força não discrimina.** Nas 89 relações, nenhuma tem força abaixo de 5 e 69 têm 7 ou mais, mesmo com a escala descrita e a instrução de que só três ou quatro passam de 7. A força serve para ordenar relações dentro do Pai; antes de pesar arestas na detecção de comunidades (F5.5), a F5.2 deve normalizá-la por posto dentro do Pai ou desistir do peso.
3. **Dois tipos ainda forçados.** O "Portal da Transparência" e o "Consolidado Gerencial" saíram como `PRODUCT_OR_SERVICE`; são um cadastro público e um relatório. Pouco para mudar o tipo, mas é o que a F5.2 deve contar em 20 Pais.
4. **Uma relação que o texto não sustenta.** Duas relações dizem que o Portal da Transparência traz punições pelo FCPA e pelo UK Bribery Act; o texto fala de monitorar o portal e, à parte, sites internacionais. O prompt manda ligar só o que o trecho liga, e o modelo ainda liga por proximidade.
5. **Recall.** Um Pai de integridade perdeu da `v2` para a `v3` instrumentos que a `v2` pegava (as recomendações técnicas e as entidades ligadas); em todos faltam órgãos citados de passagem (o Sest e a CVM num Pai de movimentos). Nomes de evento saíram sem acento num Pai ("aprovacao"); a normalização é da F5.3.
6. **`LOCATION` e `PERSON` quase não foram exercidos.** Nenhum dos 5 Pais cita uma pessoa pelo nome, e o único lugar citado ("Brasil", num Pai de integridade) saiu como `LOCATION` na `v1` e deixou de sair depois, sem perda de informação relevante. A F5.2, em Pais de administração e de atividades por região, é quem exercita os dois tipos.

## Alternativas

- **Manter dez tipos** e alargar `PRODUCT_OR_SERVICE` para políticas e programas: o grafo passaria a dizer que "Política de PLD" é um produto, e a consulta "quem aprova esta política?" teria de filtrar por descrição. Rejeitada pela evidência dos Pais 195–197.
- **Recusar nome que é data só no prompt:** a `v2` tinha essa regra por escrito e o modelo a ignorou em 13 eventos; a validação com retentativa é o que a faz valer.
- **Gleaning agora:** é decisão da F5.2, que mede o ganho em 20 Pais.

## Consequências

- A F5.2 herda o esquema, o prompt `v3` e a lista de defeitos residuais acima como medida a repetir em 20 Pais novos.
- A F5.3 recebe os apelidos e as repetições como candidatos de fusão, e a questão de `FINANCIAL_METRIC` aberta contra `Metric` do catálogo: em `v3` nenhuma métrica solta saiu, então o cruzamento tende a ser pequeno.
- ARQUITETURA §5 I-6 passa a listar onze tipos.
- A revisão foi do Claude e as 5 saídas não estão no repositório (parafraseiam o documento do BB). Se for preciso uma conferência humana, ela se faz rodando o comando acima e abrindo `data/parsed/bb_fre_2026_recorte.aberta.json`.
