# ADR-039 · *Gleaning* da extração aberta: ganho medido em 20 Pais e padrão 0

- **Estado:** aceita (04/11/2026): o *gleaning* fica configurável (`--gleaning 0|1`) e **desligado por padrão**
- **Data:** 2026-11-04
- **Tarefa(s):** F5.2

## Contexto

O MS GraphRAG pede, depois da primeira extração, "faltaram entidades?" e funde o que vier (*gleaning*, passadas extras). A ARQUITETURA §5 I-6 deixou 0 ou 1 rodada como configuração e mandou medir o ganho em 20 Pais antes de ligar no corpus inteiro, porque a rodada extra dobra o custo na teoria. O aceite da F5.2 é esse ganho medido e decidido em ADR. O esquema e o prompt `v3` vêm do [ADR-038](./ADR-038-extracao-aberta.md).

## Decisão

**Padrão 0.** A rodada extra acrescenta muito (60% de entidades, 69% de relações), mas só cerca de metade do que acrescenta está certo, contra ~94% da primeira passada nos mesmos Pais; e custa 62% a mais de tempo de LLM. A opção segue no código para ser religada se o prompt mudar (ver "Quando rever").

**Implementação** (`indexer.extracao_aberta`): com `--gleaning 1`, depois da primeira resposta válida o mesmo diálogo continua com `CONTINUAR` ("faltaram entidades ou relações; devolva só o que ainda não está na resposta, com as mesmas regras; se nada faltou, listas vazias"). O acréscimo é fundido à primeira resposta por `fundir`: entidade de nome já existente (sem caixa nem espaços) e relação do mesmo par origem-destino não entram de novo, os tetos de 30 entidades e 40 relações valem, e relações que citam nome fora da lista fundida são descartadas e contadas. A fusão passa pelo mesmo validador do esquema (nome que é data ou valor, relação só entre entidades da resposta) com até 2 tentativas e a mensagem de erro na segunda; se não der fusão válida, vale a primeira passada. A primeira resposta fica em `resposta` e a fundida em `gleaning.resposta`, então o ganho é medido nos mesmos Pais sem rodar a primeira passada duas vezes; o cache da rodada extra é separado (`g1_<hash>`), e rodar sem *gleaning* reaproveita a primeira passada. O contrato é 0 ou 1; outro valor é erro.

## Medição

**Amostra:** 20 Pais sorteados com semente 2 entre os 62 de pelo menos 100 tokens do recorte, **sem os 5 da F5.1** (nos quais o prompt foi ajustado); o corte de 100 tokens é a mediana dos Pais (a de 300 da F5.1 deixava só 13 elegíveis). São 4.181 tokens de texto no total (100 a 624 por Pai), das seções de segmentos, comentários dos Diretores, projeções, riscos de mercado, integridade, relações de subordinação e auditores. Comando e parâmetros: `python -m indexer.extracao_aberta executar ../data/parsed/bb_fre_2026_recorte --amostra 20 --minimo 100 --semente 2 --gleaning 1 --saida aberta_f52 --excluir <os 5 ids da F5.1>`. Números completos em `ADR-039-bruto/resumo.json`.

**Regra de decisão**, definida por mim antes de rodar (sem registro externo além deste ADR): ligar se o ganho for de pelo menos 15% em entidades e em relações, se pelo menos 90% dos nomes acrescentados tiverem lastro no texto e se pelo menos 80% dos acréscimos estiverem corretos na leitura.

| | Primeira passada | Rodada extra | Regra |
|---|---|---|---|
| Entidades (20 Pais) | 120 | +72 (**+60%**) | ≥ 15%: atende |
| Relações | 96 | +66 (**+69%**) | ≥ 15%: atende |
| Pais que ganharam algo | | 13 de 20 (7 sem nada) | |
| Nome sem lastro no texto | 5% | 16,7% (12 de 72) | ≥ 90% com lastro: **não atende** |
| Acréscimos corretos na leitura | | **37 de 72 (51%)** | ≥ 80%: **não atende** |
| Tempo de LLM | 532 s | +329 s (**+62%**) | |
| Tokens de prompt / saída | 43,4 mil / 12,9 mil | +66,4 mil / +7,5 mil | |
| Chamadas | 20 | 23 (3 retentativas) | |

O lastro mede se o nome aparece, sem acento nem caixa, no que o LLM leu (documento, seção e trecho), sem sufixo societário ou sem o que vem entre parênteses. Os 12 acréscimos sem lastro são nomes que o modelo compôs a partir do texto ("variação da PCLD Ampliada em 2023", "risco de inflação"), não invenção; por isso a leitura vale mais que o teste mecânico.

**Leitura dos 72 acréscimos** (todos, por mim, contra o texto de cada Pai; não é uma pessoa). 37 corretos. Os 35 com defeito:

- **11 são entidades reais que nenhum tipo acomoda:** cinco mercadorias (arroz, soja…) como `PRODUCT_OR_SERVICE`, quatro moedas e dois índices de preços como `FINANCIAL_INSTRUMENT`, todos citados como exemplo de risco de mercado.
- **12 `PERSON` que são cargo ou grupo:** seis públicos do programa de integridade (funcionários, estagiários, terceiros…) e seis cargos do Ministério da Fazenda. O prompt proíbe isso e o modelo repete, na primeira passada também (um cargo).
- **12 genéricas ou que não são entidade:** "melhores práticas de mercado", "normas internacionais", uma meta de crescimento como `EVENT`, "apetite" e "competição" como `RISK`, "sanção de multa" como `RISK`, um exercício encerrado como `EVENT`, um pagamento com o valor no nome (passa pela validação, que só barra nome que é *só* valor), "mercados primário e secundário" como `LOCATION`.

**A primeira passada, nesses 20 Pais novos** (a medida que o ADR-038 prometeu): 20 de 20 válidos de primeira, 120 entidades e 96 relações. Pelos nomes e tipos, sem reler as descrições, uns 7 em 120 (~6%) estão errados ("Controle Direto" como `EVENT`, um cargo como `PERSON`, "payout" como `POLICY_OR_PROGRAM`, "Dívida Pública" como `ORGANIZATION`, "mercado doméstico de capitais" como `LOCATION`); 5% dos nomes sem lastro, quase todos o emissor, que está no cabeçalho do pedido. A força das relações continua sem discriminar: mínimo 4, 72% com 7 ou mais.

## Por que não ligar

O ganho é concentrado onde o valor é menor: listas de exemplos (as cinco commodities, as quatro moedas) e enumerações de públicos e pilares do programa de integridade, que viram nós soltos de baixo grau. Em 7 dos 20 Pais a rodada extra não achou nada, o que é o que se espera de um Pai que a primeira passada já esgotou. Nos Pais com entidades relevantes que escaparam (o cargo do administrador, o pagamento ao auditor) o ganho existe, mas é pequeno perto do ruído. O custo de +62% de LLM é aceitável se o acréscimo fosse bom; com ~50% de acerto, ele só aumentaria o trabalho da resolução de entidades (F5.3) e dos resumos (F5.4).

## Quando rever

- Se o prompt `v4` fechar as duas causas dos defeitos acima (moedas, índices e mercadorias com tipo próprio ou dentro de `FINANCIAL_INSTRUMENT`; `PERSON` só com nome próprio, imposto por validação), repetir esta medição, em Pais novos, antes de religar. A mudança de definição vale para a primeira passada também.
- A F5.8 mede o ganho de novo no documento inteiro, com o prompt que estiver valendo.

## Alternativas

- **Ligar com um filtro depois** (descartar acréscimo de `PERSON` ou sem lastro): tiraria 12 `PERSON` e 12 sem lastro, mas não as mercadorias, moedas e genéricas, e esconderia a causa no prompt.
- **Pedir a rodada extra só para Pais acima de N tokens:** o tamanho não prediz o ganho. Dos três Pais acima de 400 tokens, o de 422 não ganhou nada e os de 581 e 624 ganharam 7 e 14; o que mais ganhou (18) tem 225 tokens, e a maior parte dos acréscimos ruins está nele e no de 624.
- **Gleaning na F5.8 sem medir antes:** contraria a ARQUITETURA.

## Consequências

- A extração aberta do recorte (116 Pais) não foi rodada nesta tarefa; é o primeiro passo da F5.3. Pelo custo medido (27 s de LLM por Pai nesta amostra, de Pais pequenos), da ordem de uma hora sem *gleaning*; a estimativa de 1,5 a 3 horas do ADR-038 vinha dos 5 Pais grandes e fica superada.
- ARQUITETURA §5 I-6 registra o padrão 0 e a medida.
- Os defeitos de tipo (moedas, índices, mercadorias, `PERSON` para cargo, valor no nome) entram na lista de ajustes do prompt `v4`, a decidir com a F5.3, quando houver as 116 saídas para olhar.
