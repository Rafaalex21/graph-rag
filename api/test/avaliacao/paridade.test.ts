/**
 * Comparador de paridade Python x TypeScript (F7.8). Formas de falha:
 *  1. Um comparador que perdoa demais esconde divergência: `null` x ausente, 1 x "1", lista menor e valor diferente
 *     têm de aparecer, cada um com o caminho.
 *  2. `latencia_ms` muda sempre e não conta.
 *  3. Ordem diferente com o mesmo conteúdo é um veredito à parte (`so_ordem`), nunca "igual" e nunca "diferente".
 *  4. Conteúdo diferente numa lista também reordenada continua `diferente`.
 */
import { describe, expect, it } from "vitest";
import { canonico, comoJson, comparar, diferencas, semListasVaziasExtras } from "../../src/avaliacao/paridade.ts";

describe("diferencas", () => {
  it("idênticos, ignorando latencia_ms em qualquer nível", () => {
    expect(diferencas({ a: 1, latencia_ms: 3, x: { latencia_ms: 1, b: [1, 2] } }, { a: 1, latencia_ms: 99, x: { latencia_ms: 2, b: [1, 2] } })).toEqual([]);
  });

  it("aponta o caminho de cada tipo de diferença", () => {
    const d = diferencas(
      { a: 1, b: null, c: [1, 2], d: "x", so_py: 1, e: { f: 1 } },
      { a: 2, b: 0, c: [1], d: 1, so_ts: 1, e: { f: 1 } },
    );
    expect(d).toEqual(
      expect.arrayContaining([
        { caminho: "$.a", tipo: "valor" },
        { caminho: "$.b", tipo: "tipo" },
        { caminho: "$.c", tipo: "tamanho" },
        { caminho: "$.d", tipo: "tipo" },
        { caminho: "$.so_py", tipo: "chave_so_no_python" },
        { caminho: "$.so_ts", tipo: "chave_so_no_ts" },
      ]),
    );
    expect(d.some((x) => x.caminho.startsWith("$.e"))).toBe(false);
  });

  it("null explícito não é o mesmo que chave ausente", () => {
    expect(diferencas({ a: null }, {})).toEqual([{ caminho: "$.a", tipo: "chave_so_no_python" }]);
  });
});

describe("comparar", () => {
  it("igual, só ordem e diferente", () => {
    expect(comparar({ l: [1, 2, 3] }, { l: [1, 2, 3] }).veredito).toBe("igual");
    expect(comparar({ l: [{ id: "a" }, { id: "b" }] }, { l: [{ id: "b" }, { id: "a" }] }).veredito).toBe("so_ordem");
    expect(comparar({ l: [1, 2, 3] }, { l: [1, 2, 4] }).veredito).toBe("diferente");
    expect(comparar({ l: [1, 2, 3] }, { l: [3, 1, 5] }).veredito).toBe("diferente");
  });

  it("valor escalar diferente nunca é só ordem", () => {
    expect(comparar({ v: 1.5 }, { v: 1.6 }).veredito).toBe("diferente");
  });
});

describe("semListasVaziasExtras", () => {
  it("tira só a lista vazia que o Python não tem e conta o que tirou", () => {
    const r = semListasVaziasExtras({ erro: "x" }, { erro: "x", riscos: [] });
    expect(r.ts).toEqual({ erro: "x" });
    expect(r.tiradas).toEqual(["$.riscos"]);
    expect(comparar({ erro: "x" }, r.ts).veredito).toBe("igual");
  });

  it("não perdoa lista com conteúdo, valor nulo nem lista vazia que o Python também tem", () => {
    expect(semListasVaziasExtras({ erro: "x" }, { erro: "x", riscos: [1] }).tiradas).toEqual([]);
    expect(semListasVaziasExtras({ erro: "x" }, { erro: "x", riscos: null }).tiradas).toEqual([]);
    expect(semListasVaziasExtras({ riscos: [] }, { riscos: [] }).tiradas).toEqual([]);
    expect(comparar({ erro: "x" }, semListasVaziasExtras({ erro: "x" }, { erro: "x", riscos: [1] }).ts).veredito).toBe("diferente");
  });
});

describe("canonico e comoJson", () => {
  it("ordena listas e chaves", () => {
    expect(JSON.stringify(canonico({ b: [3, 1], a: 1 }))).toBe('{"a":1,"b":[1,3]}');
  });
  it("comoJson tira undefined, como o JSON de verdade", () => {
    expect(comoJson({ a: undefined, b: null, c: 1 })).toEqual({ b: null, c: 1 });
  });
});
