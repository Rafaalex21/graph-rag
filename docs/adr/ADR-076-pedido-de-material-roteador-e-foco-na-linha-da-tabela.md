# ADR-076 · Pedido de material: dica ao roteador e foco na linha da tabela

- **Estado:** aceita (09/11/2026) como conserto de dois defeitos medidos; o aceite da F8.10 depende da medida F8.10d (ver Evidência), ainda não rodada quando este ADR foi escrito
- **Data:** 2026-11-09
- **Tarefa(s):** F8.10

## Contexto

A terceira medida da F8.10 (`eval/f810c-medida-geracao.md`) deu 3 de 5 e as duas falhas eram do sistema, não do gabarito:

1. **C3** ("Gere um documento Word com o patrimônio líquido de 2023 a 2025."): o roteador não chamou ferramenta (rota vazia, `sem_consulta`) e a resposta foi "Isso está fora do que o documento traz", embora o patrimônio líquido esteja na p. 81. O pedido não cita a companhia, e o prompt do roteador manda não chamar ferramenta quando "a pergunta não trata da companhia". Reproduzido sem o navegador, com o mesmo resultado.
2. **C4** ("…lucro antes dos impostos…"): a busca trouxe a tabela da p. 93, mas o material saiu só com 2025. A evidência de tabela leva a descrição e o Markdown inteiro, e `selecionar` corta cada evidência em 900 caracteres; a linha "Lucro Antes dos Impostos" fica depois de umas doze outras e foi cortada. O único valor que o modelo da especificação viu era o fato de 2025 do grafo.

## Decisão

- **Dica ao roteador só quando há pedido de material** (`pedidoDeMaterial`, ligado por `complementarTabelas`, que já é "a mensagem pediu gráfico, tabela, planilha, documento ou apresentação"): o prompt ganha uma linha dizendo que, **se a pergunta não nomeia outra empresa nem outro banco**, os números pedidos são da companhia do documento e o roteador deve chamar ferramenta; "pedido que nomeia outra empresa continua sem ferramenta". Perguntas comuns usam o prompt de antes, sem nenhuma mudança (a acurácia de rota de 85% da F7.3 não é tocada).
- **Foco na linha** (`api/src/artefatos/foco.ts`, `focarTabela`): para o modelo da especificação, a evidência de tabela passa a ser a descrição (cortada em 200 caracteres), o cabeçalho com os anos e as linhas cujo **primeiro campo** se parece com o que o pedido cita (palavras sem acento, sem artigos e sem as palavras do formato; comparação pelos 5 primeiros caracteres), dentro de ~880 caracteres. Sem linha parecida, o texto segue como era. **A conferência dos números continua contra a evidência original inteira** (`verificacao.ts`), então o foco só muda o que o modelo lê, nunca o que é aceito.
- **Não mexi** no redator: o texto da resposta continua usando `selecionar` com o corte de 900 caracteres, e por isso ainda pode dizer "não encontrei" ao lado de um material correto (visto em C1 e C4). É um limite aberto desta etapa.

## Alternativas consideradas

- **Mudar o prompt do roteador para todas as perguntas** ("pergunta sem empresa é da companhia"): resolveria C3, mas mexe no roteamento de tudo e exigiria refazer a medida de acurácia de rota (F7.3, F7.12). A dica só nos pedidos de material tem o mesmo efeito onde o defeito apareceu e raio de efeito pequeno.
- **Forçar a busca sempre que há pedido de material, mesmo com rota vazia:** faria "o lucro líquido do Nubank" virar uma busca no documento do Banco do Brasil, e o gerador poderia pôr os números do Banco do Brasil sob outro nome (a conferência prova que o número existe na evidência, não de quem é). A dica deixa o roteador decidir e três testes de guarda mostram que ele continua recusando outra empresa.
- **Aumentar o corte de 900 caracteres para todas as evidências:** aumentaria o custo de toda resposta (tempo de prompt no modelo local, RNF-2 já em aberto) para consertar um caso de tabela longa.

## Consequências

- Um pedido de material sobre uma métrica existente, sem o nome da companhia, deixa de ser tratado como assunto de fora; o risco é o contrário, o roteador tentar uma busca para um pedido de outra empresa que o modelo não reconheça como outra empresa. Mitigação: três guardas (Nubank, Santander, Itaú Unibanco) e o "não consta" medido em A5, B5, C5 e D5.
- O foco depende de o primeiro campo da linha parecer com as palavras do pedido. Rótulos muito diferentes do que o usuário escreve não ganham foco e voltam ao corte antigo.
- O texto do redator pode contradizer o material (ver acima).

## Evidência

**Testes E2E de desenvolvimento** (`e2e/tests/ao-vivo/material-dev.spec.ts`, escritos antes do conserto, contra a pilha real e a API por HTTP): antes do conserto **2 falharam** (patrimônio líquido sem material; lucro antes dos impostos só com 2025) e as 3 guardas passaram; depois, **5 de 5**. Esses pedidos já tinham sido vistos pela F8.10c: servem só ao desenvolvimento, não ao aceite. Contagem das chamadas de desenvolvimento: 2 diagnósticos diretos (C3 e C4), 1 rodada vermelha (5 testes) e 1 verde (5 testes).

**Aceite:** medida F8.10d (`eval/f810d-medida-geracao.md`), pedidos novos, regra de página mecânica da F8.10c, 5 de 5; o resultado entra aqui quando existir.

Reproduzir o desenvolvimento: com Neo4j, llama-swap e a API (`npm run build` em `api/` antes) no ar, `cd e2e; npx playwright test --project=ao-vivo tests/ao-vivo/material-dev.spec.ts`.
