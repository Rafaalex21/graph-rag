/**
 * Conexão com o Neo4j e catálogo (F7.8). O driver de verdade é coberto pela integração; aqui estão as peças que
 * quebram em silêncio. Formas de falha, escritas antes do código:
 *
 *  1. Inteiros do Neo4j chegam como objetos `Integer` (e não como número): página, contagem e ano virariam
 *     `{low, high}` no JSON e as ordenações e comparações do template falhariam sem erro.
 *  2. O `.env` tem BOM (armadilha já vista no Windows), aspas, comentário, linha em branco, CRLF e `=` dentro do
 *     valor; a senha não pode ser cortada nem aparecer no erro.
 *  3. Variável `NEO4J_*` do ambiente tem de vencer o arquivo; variável que não começa por `NEO4J_` é ignorada.
 *  4. Sem senha, o erro diz o que falta, sem imprimir segredo.
 *  5. O catálogo de métricas é o `contracts/metricas.json` do repositório (97 métricas, cada uma com `kind`
 *     conhecido): um `kind` novo sem unidade no template daria `undefined` na consulta.
 */
import { describe, expect, it } from "vitest";
import neo4j from "neo4j-driver";
import { lerCatalogo } from "../../src/ferramentas/catalogo.ts";
import { configuracaoDoGrafo, lerEnv, paraJs, paraNeo4j } from "../../src/ferramentas/grafo.ts";
import { UNIDADE_DO_TIPO } from "../../src/ferramentas/templates.ts";

describe("paraNeo4j", () => {
  it("manda inteiro de JS como INTEGER (senão `LIMIT $n` falha por FLOAT) e deixa o resto como está", () => {
    const r = paraNeo4j(500) as unknown;
    expect(neo4j.isInt(r)).toBe(true);
    const lista = paraNeo4j([1, 2]) as unknown[];
    expect(lista.every((x) => neo4j.isInt(x))).toBe(true);
    expect(paraNeo4j(16.5)).toBe(16.5);
    expect(paraNeo4j("2025-FY")).toBe("2025-FY");
    expect(paraNeo4j(null)).toBeNull();
    expect(paraNeo4j(false)).toBe(false);
  });

  it("vetor de embedding (floats, com um 0 no meio) continua lista de floats", () => {
    const v = [0.12, 0, -0.5, 1];
    const r = paraNeo4j(v) as unknown[];
    expect(r).toEqual(v);
    expect(r.some((x) => neo4j.isInt(x))).toBe(false);
  });
});

describe("paraJs", () => {
  it("converte Integer do Neo4j em número, em qualquer profundidade", () => {
    const r = paraJs({ pagina: neo4j.int(93), paginas: [neo4j.int(1), neo4j.int(2)], aninhado: { n: neo4j.int(7) }, valor: 16.5, nome: "x", nulo: null });
    expect(r).toEqual({ pagina: 93, paginas: [1, 2], aninhado: { n: 7 }, valor: 16.5, nome: "x", nulo: null });
    expect(JSON.stringify(r)).not.toContain("low");
  });

  it("um inteiro grande demais para número seguro vira erro e não valor errado", () => {
    expect(() => paraJs(neo4j.int("9007199254740993"))).toThrow(/seguro|safe|grande/i);
  });

  it("deixa texto, booleano e lista vazia como estão", () => {
    expect(paraJs([])).toEqual([]);
    expect(paraJs(true)).toBe(true);
    expect(paraJs("2023-08")).toBe("2023-08");
  });
});

describe("lerEnv", () => {
  it("lê chave=valor, ignora comentário e linha em branco, tira aspas e BOM", () => {
    const e = lerEnv('﻿# comentário\nNEO4J_USER=neo4j\n\nNEO4J_PASSWORD="se=gredo#1"\r\nOUTRA=\'x\'\r\n  \nSEM_IGUAL\n');
    expect(e).toEqual({ NEO4J_USER: "neo4j", NEO4J_PASSWORD: "se=gredo#1", OUTRA: "x" });
  });

  it("não corta valor com igual dentro nem espaços internos", () => {
    expect(lerEnv("A=b=c d")).toEqual({ A: "b=c d" });
  });
});

describe("configuracaoDoGrafo", () => {
  it("o ambiente vence o arquivo e só variáveis NEO4J_ entram", () => {
    const c = configuracaoDoGrafo({ NEO4J_URI: "bolt://arquivo:7687", NEO4J_PASSWORD: "arq" }, { NEO4J_PASSWORD: "amb", PATH: "x", NEO4J_USER: "outro" });
    expect(c).toEqual({ uri: "bolt://arquivo:7687", usuario: "outro", senha: "amb", banco: "neo4j" });
  });

  it("usa o endereço local e o usuário neo4j por padrão, e aceita o banco", () => {
    expect(configuracaoDoGrafo({ NEO4J_PASSWORD: "s" }, {})).toEqual({ uri: "bolt://127.0.0.1:7687", usuario: "neo4j", senha: "s", banco: "neo4j" });
    expect(configuracaoDoGrafo({ NEO4J_PASSWORD: "s", NEO4J_DATABASE: "doc" }, {}).banco).toBe("doc");
  });

  it("sem senha o erro diz o que falta e não imprime segredo", () => {
    expect(() => configuracaoDoGrafo({ NEO4J_USER: "neo4j" }, {})).toThrow(/NEO4J_PASSWORD/);
  });
});

describe("catálogo de métricas", () => {
  const catalogo = lerCatalogo();

  it("é o contracts/metricas.json do repositório", () => {
    expect(catalogo.length).toBeGreaterThanOrEqual(90);
    expect(catalogo.find((m) => m.id === "net_income")?.name).toBe("Net income");
  });

  it("toda métrica tem id, nomes, aliases em lista e um tipo com unidade definida", () => {
    for (const m of catalogo) {
      expect(m.id, JSON.stringify(m)).toBeTruthy();
      expect(m.name).toBeTruthy();
      expect(m.name_pt).toBeTruthy();
      expect(Array.isArray(m.aliases), m.id).toBe(true);
      expect(UNIDADE_DO_TIPO[m.kind], `${m.id}: kind ${m.kind}`).toBeTruthy();
    }
  });

  it("os ids são únicos", () => {
    expect(new Set(catalogo.map((m) => m.id)).size).toBe(catalogo.length);
  });
});
