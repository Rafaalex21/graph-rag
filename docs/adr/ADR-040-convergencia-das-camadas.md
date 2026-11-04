# ADR-040 · Convergência das entidades abertas e de domínio

- **Estado:** proposta (04/11/2026). A extração e a convergência estão feitas e medidas, mas o aceite da F5.3 ("nenhum par duplicado entre camadas na amostra de 30 entidades mais citadas") **não foi atendido à risca**: sobram 2 pares na amostra (ver "Amostra das 30"). A tarefa fica em `[~]` até o critério ser aceito como está, ajustado ou refeito.
- **Data:** 2026-11-04
- **Tarefa(s):** F5.3

## Contexto

A F5.1 fixou os 11 tipos e o prompt `v3`; a F5.2 mediu o *gleaning* e o deixou desligado ([ADR-038](./ADR-038-extracao-aberta.md), [ADR-039](./ADR-039-gleaning.md)). A F5.3 roda a extração aberta no recorte inteiro e faz as entidades abertas e as da extração dirigida convergirem pela resolução da F4.5 ([ADR-036](./ADR-036-resolucao-de-entidades.md)). Evidência numérica: `ADR-040-bruto/resumo.json` (contagens e nomes curtos de entidades; sem descrições nem trechos do documento).

## A extração aberta do recorte (116 Pais)

Prompt `v3`, *gleaning* 0, paralelismo 2, comando `uv run python -m indexer.extracao_aberta executar ../data/parsed/bb_fre_2026_recorte --saida aberta_f53`.

| | |
|---|---|
| Pais válidos | 116 de 116 (114 de primeira) |
| Entidades / relações | 658 / 536 |
| Por tipo | ORGANIZATION 240, PRODUCT_OR_SERVICE 82, FINANCIAL_METRIC 74, RISK 59, POLICY_OR_PROGRAM 52, EVENT 45, SEGMENT 33, FINANCIAL_INSTRUMENT 23, REGULATION 22, PERSON 15, LOCATION 13 |
| Força das relações | nenhuma abaixo de 4; 67% com 7 ou mais (a escala continua sem discriminar) |
| LLM | 93 chamadas (25 Pais vieram do cache da F5.1 e F5.2), 195 mil tokens de prompt, 47 mil de saída, **2.041 s de LLM e 17 min de relógio**; a estimativa do [ADR-039](./ADR-039-gleaning.md) (≈ 1 h) estava alta, a do ADR-038 (1,5 a 3 h), mais ainda |

## Decisão

**Como as entidades abertas entram no grafo** (`indexer.importar`, o mesmo importador idempotente da F4.4):

- Os cinco tipos que a extração dirigida não tem ganham rótulo: `Product`, `FinancialMetric`, `Regulation`, `Policy`, `Location`, todos também `__Entity__` com `type`. Os seis anteriores mantêm o rótulo.
- O id é o mesmo da dirigida (rótulo + nome normalizado). Quem tem o mesmo tipo e o mesmo nome normalizado já cai no mesmo nó antes de qualquer resolução: das 106 entidades da dirigida, **63 apareceram também na aberta com o mesmo id**. Eventos levam o Pai na chave (dois Pais com o mesmo nome de evento são dois eventos); riscos e segmentos da dirigida têm categoria e organização na chave, e a aberta não, então são justamente os que a resolução une.
- Cada nó guarda `layers` (`dirigida`, `aberta` ou as duas) e, vindo da aberta, `descriptions`, a lista de descrições (uma por Pai, sem repetição). A `description` em texto continua sendo da dirigida; a §6.2 passa a ter as duas.
- As relações da aberta viram `(:__Entity__)-[:RELATED_TO {descriptions, strength, parents}]->(:__Entity__)`: um par de entidades que se repete em outro Pai acumula descrições, força máxima e origens. É a matéria-prima da F5.4, que produz a `SUMMARIZED_RELATIONSHIP`. Relação que vira laço depois de uma fusão sai. `MENTIONED_IN` liga ao Pai; `RISK` usa `DESCRIBED_IN`, como na dirigida.
- Tipo desconhecido é erro, não nó silencioso.

**O que mudou na resolução** (`indexer.resolver`), porque a primeira rodada deixou o emissor duplicado:

1. **Conflitos deixam de bloquear o grupo inteiro.** Na versão da F4.5 um par julgado "não" dentro de um grupo ligado por pares "sim" desfazia o grupo. Com a extração aberta isso deixou "Banco do Brasil" e "Banco do Brasil S.A." separados, porque o "Conglomerado Banco do Brasil" também estava no grupo; era a entidade mais citada do grafo (886). Agora os pares aceitos entram do mais parecido para o menos e dois grupos só se unem se nenhum par entre eles foi julgado "não" (ligação completa). O que sobra de contraditório sai em `conflitos` no plano.
2. **Fechamento.** Antes disso, para que uma ponte não una o que o juiz separou, se a~b e b~c foram aceitos e a,c nunca foram julgados, o par a,c vai ao juiz (razão `fechamento`; 25 pares). Foi o que impediu a Procuradoria-Geral e a Secretaria do Tesouro de virarem um nó só pelo CNPJ comum.
3. **Nota entre parênteses funde sem juiz** ("Comitê de Auditoria" e "Comitê de Auditoria (Coaud)"): o juiz havia dito "não" lendo "órgão interno, não entidade jurídica". Só vale se exatamente um dos dois tem parênteses; 3 pares.
4. **Contração** como razão de candidato: "Bacen" é "Ba" + "cen" de "Banco Central", que a regra das iniciais não pega; 2 pares, o juiz confirma.
5. **Tipos diferentes só pelo nome igual** (8 pares: "Ministério da Fazenda" como organização e como pessoa, "carteira de negociação" como política, produto e segmento…). O juiz vê os dois tipos; ao fundir, o nó fica com o rótulo, o `type` e o id do sobrevivente (o rótulo do outro é removido, e o `rotulo` do importador vem do id). **Nome contido entre tipos ficou de fora:** dos 50 pares do recorte o juiz aceitou 7, e 4 estavam errados ou duvidosos (um indicador de juros com o risco de sua mudança; "valor justo" com ativos a valor justo; dois órgãos com o ministério pelo CNPJ), contra 3 plausíveis.
6. `fundir` apaga os laços que a fusão cria; as descrições entram no pedido ao juiz e no embedding (`descricao_de`), sem mudar o texto do pedido das entidades da dirigida (o cache da F4.5 continua valendo).

## Resultado

| | |
|---|---|
| Entidades antes da resolução | 513 (43 só da dirigida, 407 só da aberta, 63 nas duas) |
| Candidatos | 303, 25 deles do fechamento; juiz: 114 "sim", 186 "não"; regra: 3 "sim" |
| Fusões / absorvidos | **61 / 80**, 34 delas com nós das duas camadas; grupos de 2 (45), 3 (13) e 4 (3) |
| Entidades depois | **433** (-80); `RELATED_TO` 512 → 481 |
| Idempotência | reimportar depois de `aplicar` não muda nada (impressão digital `2a8d665dd20cebd9`); 0 laços; 0 nós com rótulo de tipo diferente do `type`; consultas de sanidade da F4.4 em 0 |
| Testes | 409 → 443 (34 novos: importador da aberta, fechamento, conflitos, regras de candidato, fusão entre tipos) |

**Precisão das fusões, por leitura minha** (não de uma pessoa; leitura estrita, uma a uma, dos 61 grupos): cerca de 53 de 61 corretas (87%). As 8 duvidosas ou erradas: "letras financeiras subordinadas" fundida com as "perpétuas" (instrumentos diferentes; o juiz as aceitou e isso bloqueou o par certo, ver abaixo), "depósitos" com "depósitos à vista", "comissões" com "receitas de tarifas e comissões", "administração de fundos" e "administração de consórcios" com as respectivas receitas, "emissões de títulos e valores mobiliários" com "recursos de emissões…", e o grupo do Ministério da Fazenda, que absorveu a Secretaria do Tesouro composta e a Procuradoria composta pelo CNPJ comum do documento (a região é ambígua no próprio texto).

## Amostra das 30 entidades mais citadas

Ordenadas por fatos + menções depois da resolução. Para cada uma listei todo vizinho com nome contido, sigla ou embedding ≥ 0,65 (133 vizinhos) e li os pares. O banco emissor lidera com 886; a 30ª tem 2 citações. Os sobreviventes da amostra absorveram 26 nós. **Pares que sobram (2):**

1. "Programa de Compliance e Integridade" e "Programa de Compliance e Integridade do Banco do Brasil": o mesmo programa; o juiz disse "não" a um terceiro nome do grupo ("Programa de Integridade") e a ligação completa impediu a fusão.
2. "letras financeiras subordinadas" e "LFS", o mesmo instrumento; o grupo do primeiro absorveu as "perpétuas" (erro do juiz) e o "não" entre "LFS" e as perpétuas vetou "LFS".

**Região incerta, não contada como duplicata:** o Ministério da Fazenda, a Secretaria do Tesouro e a Procuradoria-Geral usam o mesmo CNPJ no documento; o grafo ficou com o Ministério (3 absorvidos), a Secretaria (1) e a Procuradoria separadas. Decidir isso é questão de domínio, não de método.

**Não são duplicatas, e o juiz acertou:** Banco do Brasil S.A. e Conglomerado Banco do Brasil (entidade e grupo consolidado), Conselho de Administração e Conselho Diretor (embedding 0,92), "taxa de câmbio" e "câmbio", Novo Mercado e B3.

A leitura é minha. Para dar a medida do que a resolução já resolveu: os 26 nós que ela fundiu nos sobreviventes da amostra eram duplicatas dela (o emissor em duas grafias, o Banco Central em quatro, a Cielo em três, o Comitê de Auditoria e o Bacen…). O critério não diz de onde partir, então este é o único "antes" que tenho.

## Por que não fechei a tarefa

O critério é "nenhum par". Dois pares sobram, e os dois vêm de erro do juiz dentro de um grupo, que a regra de conflito evita propagar ao custo de perder o par certo. Cada correção que fiz depois da primeira rodada (conflito, fechamento, parênteses, contração, tipos) nasceu de um caso que a amostra mostrou; consertar mais dois casos com regra nova seria ajustar a regra à amostra, e o próximo caso apareceria na F5.8. Duas saídas honestas: (a) aceitar o critério como "≤ 2 pares na amostra, todos documentados aqui"; (b) mais uma rodada: correlação ponderada sobre o grupo (resolve o primeiro par, não o segundo) e/ou uma segunda opinião do juiz nos pares do grupo que decidem o corte.

## Questão em aberto da F5.3: `FINANCIAL_METRIC` e o catálogo

62 entidades abertas são `FinancialMetric`; só 4 têm nome ou alias igual a uma métrica do catálogo da F4.6 (6%). A maioria são componentes e linhas de demonstração ("despesas com pessoal", "Demonstração Consolidada do Resultado"), não as 97 métricas canônicas. Ficam como nós separados de `Metric`, sem vínculo; a ligação entre os dois, se valer a pena, é decisão da F5.8 (cobertura do catálogo) ou da F6.

## Limitações

- A auditoria, a leitura dos 61 grupos e a lista de vizinhos são minhas. Nenhuma pessoa conferiu.
- Recorte de 79 páginas (116 Pais): 30 entidades mais citadas no recorte não são as 30 do documento de 423 páginas.
- O juiz erra em ambos os sentidos (aceitou "letras financeiras subordinadas" = "perpétuas"; negou "Comitê de Auditoria" = "(Coaud)", agora coberto por regra). Segunda opinião e calibração do juiz de resolução contra rótulos não foram feitas.
- Os defeitos do prompt `v3` (apelidos como entidades, `PERSON` para cargo, moedas e mercadorias sem tipo, força de relação sem discriminar) continuam; esta tarefa os mediu em escala (por exemplo, 15 `PERSON` em 658) mas não corrigiu. O prompt `v4` segue sem tarefa.

## Alternativas

- **Fundir só pelo id, sem resolução:** resolve 63 de 106 da dirigida e nada do que a aberta nomeia de outro jeito.
- **Embedding mais baixo para gerar mais candidatos:** o ADR-036 já mediu que o embedding não separa duplicata de não duplicata.
- **Deixar o conflito bloquear o grupo:** manteve o banco emissor duplicado.
- **Fundir nome contido entre tipos:** 4 de 7 errados (acima).
- **Segunda extração com tipos revistos antes de resolver:** mais correto, custa a F5.1 de novo.

## Verificação

A partir de `indexer/`, com Neo4j e llama-swap no ar:

```
uv run python -m indexer.extracao_aberta executar ../data/parsed/bb_fre_2026_recorte --saida aberta_f53
copy ..\data\parsed\bb_fre_2026_recorte.aberta_f53.json ..\data\parsed\bb_fre_2026_recorte.aberta.json
uv run python -m indexer.resolver planejar ../data/parsed/bb_fre_2026_recorte --doc-id bb-fre-2026-v7
uv run python -m indexer.resolver aplicar  ../data/parsed/bb_fre_2026_recorte --doc-id bb-fre-2026-v7
```

`aplicar` imprime as contagens antes e depois, `reimportar_nao_muda` e a impressão digital. Dados e planos ficam em `data/parsed/` (fora do git).
