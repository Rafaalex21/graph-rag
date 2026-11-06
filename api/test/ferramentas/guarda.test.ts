/**
 * Guarda-corpos do Text2Cypher em TypeScript (F7.10, porte de `test_guarda_cypher.py`, F6.5). O Cypher vem de um LLM
 * que lê a pergunta do usuário: é entrada não confiável. Aceite: 26 entradas maliciosas ou malformadas bloqueadas.
 *
 * Formas de falhar, escritas antes do código:
 *  1. uma cláusula de escrita passa por caixa misturada, quebra de linha, comentário no meio da cláusula (DETACH,
 *     comentário, DELETE) ou por vir depois de um `;`;
 *  2. um procedimento escreve ou lê de fora (`apoc.cypher.runWrite`, `apoc.load.json`, `dbms.*`, `LOAD CSV`);
 *  3. comando de administração (`SHOW USERS`, `USE system`, `CREATE USER`);
 *  4. o filtro é ingênuo e bloqueia consulta legítima: `'Set up'` em string, `n.set`, nome entre crases, `createdAt`;
 *     os exemplos few-shot têm de passar;
 *  5. caractere de controle ou NUL escondendo parte da consulta; consulta de 50 mil caracteres;
 *  6. `LIMIT` ausente, gigante ou calculado deixa o banco devolver milhões de linhas;
 *  7. o texto passa pelo filtro mas o plano do `EXPLAIN` tem operador de escrita (a segunda barreira);
 *  8. diferenças de regex entre Python e JavaScript: `\w` do JS não vê letra acentuada, a bandeira `g` guarda
 *     estado entre chamadas (`lastIndex`), a ordem das barreiras muda o motivo registrado.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { avisosDoPlano, LIMITE_PADRAO, planoComEscrita, preparar } from "../../src/ferramentas/guarda.ts";
import { LEGITIMAS, MALICIOSAS } from "./guarda.casos.ts";

describe("entradas maliciosas ou malformadas", () => {
  it.each(MALICIOSAS)("%s é bloqueada antes do banco", (nome, cypher) => {
    const r = preparar(cypher);
    expect(r.cypher, `${nome} passou: ${r.cypher}`).toBeNull();
    expect(r.motivo).toBeTruthy();
  });

  it("a lista cumpre o aceite de 26, sem nomes repetidos", () => {
    expect(MALICIOSAS.length).toBeGreaterThanOrEqual(26);
    expect(new Set(MALICIOSAS.map(([n]) => n)).size).toBe(MALICIOSAS.length);
  });

  it.each(["", "   \n ", "Não consigo ajudar com isso.", "RETURN"])("vazia ou sem consulta (%j) é bloqueada", (texto) => {
    const r = preparar(texto);
    expect(r.cypher).toBeNull();
    expect(r.motivo).toBeTruthy();
  });

  it("o motivo registrado é o perigo, não o sintoma", () => {
    expect(preparar("MATCH (n) DETACH DELETE n").motivo).toBe("clausula_proibida:DETACH");
    expect(preparar("CALL apoc.cypher.runWrite('CREATE (n)', {}) YIELD value RETURN value").motivo).toBe("procedimento_proibido");
    expect(preparar("CALL dbms.security.createUser('x', 'y', false)").motivo).toBe("procedimento_proibido");
    expect(preparar("MATCH (n) RETURN n LIMIT 1; MATCH (m) RETURN m").motivo).toBe("varios_comandos");
    expect(preparar("MATCH (n) RETURN 'aberta").motivo).toBe("string_aberta");
    expect(preparar("MATCH (n) /* aberto RETURN n").motivo).toBe("comentario_aberto");
    expect(preparar("MATCH (n) RETURN n LIMIT toInteger('9')").motivo).toBe("limit_invalido");
    expect(preparar("x".repeat(4001)).motivo).toBe("muito_longa");
  });

  it("SET depois de nome com letra acentuada (o \\w do JavaScript não a vê) continua bloqueado", () => {
    expect(preparar("MATCH (ação) SET ação.x = 1 RETURN ação").cypher).toBeNull();
    expect(preparar("MATCH (n) WHERE n.nação = 1 SET n.x = 2 RETURN n").cypher).toBeNull();
    expect(preparar("MATCH (n) WHERE n.nação = 1 RETURN n.nação AS nação LIMIT 3").motivo).toBeNull(); // identificador acentuado não é palavra proibida
  });

  it("chamadas repetidas dão o mesmo resultado (nenhuma regex guarda estado entre elas)", () => {
    for (let i = 0; i < 4; i++) {
      expect(preparar("MATCH (n) DELETE n").cypher).toBeNull();
      expect(preparar("MATCH (n) RETURN n AS n").cypher).not.toBeNull();
    }
  });
});

describe("consultas legítimas passam", () => {
  it.each(LEGITIMAS)("%s", (cypher) => {
    const r = preparar(cypher);
    expect(r.motivo).toBeNull();
    expect(r.cypher).toBeTruthy();
  });

  it("os exemplos few-shot do prompt passam pela guarda", () => {
    const exemplos = JSON.parse(readFileSync(new URL("../../prompts/cypher-examples.json", import.meta.url), "utf-8").trim()) as {
      pergunta: string;
      cypher: string;
    }[];
    expect(exemplos.length).toBeGreaterThan(5);
    for (const e of exemplos) expect(preparar(e.cypher).motivo, e.pergunta).toBeNull();
  });

  it("os comentários saem da consulta que vai ao banco", () => {
    const r = preparar("MATCH (f:FinancialFact) /* oi */ RETURN f.value AS v // fim\nLIMIT 3");
    expect(r.cypher).not.toContain("/*");
    expect(r.cypher).not.toContain("//");
    expect(r.cypher?.endsWith("LIMIT 3")).toBe(true);
  });

  it("ponto e vírgula final é tirado", () => {
    expect(preparar("MATCH (n) RETURN n AS n LIMIT 2;").cypher).toBe("MATCH (n) RETURN n AS n LIMIT 2");
  });
});

describe("LIMIT", () => {
  it("ausente é injetado, e o de dentro de subconsulta não conta", () => {
    expect(preparar("MATCH (f:FinancialFact) RETURN f.value AS v").cypher?.endsWith(`LIMIT ${LIMITE_PADRAO}`)).toBe(true);
    expect(preparar("CALL { MATCH (f:FinancialFact) RETURN f LIMIT 5 } RETURN f.value AS v").cypher?.endsWith(`LIMIT ${LIMITE_PADRAO}`)).toBe(true);
  });

  it("pequeno fica e grande é reduzido", () => {
    expect(preparar("MATCH (f:FinancialFact) RETURN f.value AS v LIMIT 7").cypher?.endsWith("LIMIT 7")).toBe(true);
    expect(preparar("MATCH (f:FinancialFact) RETURN f.value AS v LIMIT 5000000").cypher?.endsWith(`LIMIT ${LIMITE_PADRAO}`)).toBe(true);
  });

  it("o limite é configurável", () => {
    expect(preparar("MATCH (n) RETURN n AS n", 10).cypher?.endsWith("LIMIT 10")).toBe(true);
    expect(preparar("MATCH (n) RETURN n AS n LIMIT 30", 10).cypher?.endsWith("LIMIT 10")).toBe(true);
  });
});

describe("plano do EXPLAIN", () => {
  type No = { operatorType: string; children: No[] };
  const plano = (...operadores: string[]): No => {
    const raiz: No = { operatorType: "ProduceResults@neo4j", children: [] };
    let atual = raiz;
    for (const op of operadores) {
      const filho: No = { operatorType: `${op}@neo4j`, children: [] };
      atual.children.push(filho);
      atual = filho;
    }
    return raiz;
  };

  it.each(["Create", "Merge", "DetachDelete", "Delete", "SetProperty", "SetLabels", "RemoveLabels", "Foreach", "ProcedureCall", "LoadCSV", "EmptyResult"])(
    "operador %s no meio do plano bloqueia",
    (operador) => {
      expect(planoComEscrita(plano("Filter", operador, "NodeByLabelScan"))).toBe(`plano_com_escrita:${operador}`);
    },
  );

  it("plano de leitura passa, e plano ausente também", () => {
    expect(planoComEscrita(plano("EagerAggregation", "Filter", "NodeByLabelScan"))).toBeNull();
    expect(planoComEscrita(null)).toBeNull();
    expect(planoComEscrita(undefined)).toBeNull();
  });

  it("operador sem filhos ou com `children` ausente não quebra", () => {
    expect(planoComEscrita({ operatorType: "NodeByLabelScan@neo4j" })).toBeNull();
    expect(planoComEscrita({ operatorType: "Create@neo4j" })).toBe("plano_com_escrita:Create");
  });
});

describe("avisos do plano", () => {
  it("separa nome desconhecido de produto cartesiano", () => {
    const { desconhecidos, outros } = avisosDoPlano([
      { code: "Neo.ClientNotification.Statement.UnknownPropertyKeyWarning", description: "valorX" },
      { code: "Neo.ClientNotification.Statement.UnknownLabelWarning", description: "Rotulo" },
      { code: "Neo.ClientNotification.Statement.CartesianProduct", description: "produto" },
    ]);
    expect(desconhecidos).toEqual(["valorX", "Rotulo"]);
    expect(outros).toEqual(["produto"]);
  });

  it("sem notificações, listas vazias; texto longo é cortado", () => {
    expect(avisosDoPlano(undefined)).toEqual({ desconhecidos: [], outros: [] });
    expect(avisosDoPlano([{ code: "X", description: "a".repeat(500) }]).outros[0]).toHaveLength(240);
  });
});
