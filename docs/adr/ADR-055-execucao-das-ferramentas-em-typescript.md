# ADR-055 · As ferramentas de recuperação passam a rodar no `api/`, em TypeScript, com paridade conferida contra o Python

- **Estado:** aceita (06/11/2026)
- **Data:** 2026-11-06
- **Tarefa(s):** F7.3 (decisão), F7.8 a F7.11 (execução)

## Contexto

O roteador (F7.3, [ADR-054](ADR-054-roteador-tool-calling.md)) escolhe a ferramenta e valida os argumentos, mas não executa nada. As 12 ferramentas da §7.2 existem hoje em Python (`indexer.busca`, `busca_local`, `busca_global`, `templates_cypher`, `text2cypher`, `guarda_cypher`, `reranker`), medidas nas fases 2, 5 e 6. A §3 e o ETAPAS (F7, "API TypeScript com SSE, oito ferramentas") situam o agente e suas ferramentas no `api/`, com `neo4j-driver`, mas nenhuma tarefa portava a execução. Sem ela, o crítico (F7.4: casos "ausente") e o redator (F7.5: citações) não têm evidência real para trabalhar, então a decisão vale antes da F7.4 e não só da F7.6.

## Decisão

**Portar para TypeScript**, sem serviço Python no caminho da resposta, em quatro tarefas novas:

- **F7.8** executor, contrato `evidence[]`, `neo4j-driver` em sessão `READ` e os seis templates Cypher da F6.3;
- **F7.9** `buscar_trechos`, `buscar_tabelas`, `entidade`, `resposta_ja_dada` (embedding e rerank já existem no cliente da F7.1);
- **F7.10** `consultar_grafo` (Text2Cypher e guarda-corpos) e `panorama`;
- **F7.11** ligação do atualizador, do roteador e do executor, em ondas.

A F7.4 passa a depender da F7.11.

Cada ferramenta é aceita por **paridade contra o Python no grafo real** (mesmos valores, escalas e páginas; page recall não inferior; guarda 26/26; Text2Cypher ≥ 90% no teste da F6.4). O Python continua como referência e como indexador (fase de indexação offline), mas sai do caminho de resposta. A guarda do Text2Cypher é portada primeiro dentro da F7.10 e seu teste de 26 entradas roda na integração contínua.

## Alternativas consideradas

- **Serviço Python local** chamado pelo Node: liga mais cedo e não arrisca regressão da guarda, mas deixa dois runtimes no caminho de resposta, mais um processo para subir e acompanhar, e contraria a §3, que descartou FastAPI para a API.
- **Híbrido** (portar as simples, manter `consultar_grafo` e `panorama` em Python): funciona mais cedo, porém exatamente as duas ferramentas de maior risco (segurança do Cypher gerado e o tempo do map-reduce) ficariam fora do runtime final, e a porta delas seria adiada.

## Limites

- **Custo:** é a maior parte do trabalho que falta na F7; os módulos Python somam alguns milhares de linhas, e cada porta tem de reproduzir não só o resultado mas os casos de borda já descobertos (escalas, ano-base, divergências, `
` literal, rótulos de métrica).
- **Paridade não é correção:** as medidas do Python têm as ressalvas já registradas (n pequeno, `consultar_grafo` devolve números errados sem dado). O porte herda essas ressalvas; não as resolve.
- **Duas implementações durante a transição:** até a F7.11, qualquer correção numa ferramenta precisa ser feita nas duas ou registrada como divergência.
