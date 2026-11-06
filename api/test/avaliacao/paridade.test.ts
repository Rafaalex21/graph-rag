/**
 * Comparador de paridade Python x TypeScript (F7.8). Formas de falha:
 *  1. Um comparador que perdoa demais esconde divergência: `null` x ausente, 1 x "1", lista menor e valor diferente
 *     têm de aparecer, cada um com o caminho.
 *  2. `latencia_ms` muda sempre e não conta.
 *  3. Ordem diferente com o mesmo conteúdo é um veredito à parte (`so_ordem`), nunca "igual" e nunca "diferente".
 *  4. Conteúdo diferente numa lista também reordenada continua `diferente`.
 */
import { describe, expect, it } from "vitest";
import { canonico, comoJson, comparar, compararItens, diferencas, semListasVaziasExtras } from "../../src/avaliacao/paridade.ts";

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

describe("tolerância numérica (ruído do reranker)", () => {
  it("números dentro da tolerância são iguais; fora, não", () => {
    expect(diferencas({ s: 0.999992 }, { s: 0.99999 }, "$", 1e-3)).toEqual([]);
    expect(diferencas({ s: 0.5 }, { s: 0.52 }, "$", 1e-3)).toEqual([{ caminho: "$.s", tipo: "valor" }]);
  });
  it("sem tolerância continua exato", () => {
    expect(diferencas({ s: 0.999992 }, { s: 0.99999 })).toEqual([{ caminho: "$.s", tipo: "valor" }]);
  });
  it("a tolerância vale só para número com número: texto, tipo e chave continuam exatos", () => {
    expect(diferencas({ s: "a" }, { s: "b" }, "$", 1)).toEqual([{ caminho: "$.s", tipo: "valor" }]);
    expect(diferencas({ s: 1 }, { s: "1" }, "$", 1)).toEqual([{ caminho: "$.s", tipo: "tipo" }]);
    expect(diferencas({ s: 1 }, {}, "$", 1)).toEqual([{ caminho: "$.s", tipo: "chave_so_no_python" }]);
  });
  it("comparar repassa a tolerância", () => {
    expect(comparar({ l: [{ s: 0.1 }] }, { l: [{ s: 0.1004 }] }, 1e-3).veredito).toBe("igual");
    expect(comparar({ l: [{ s: 0.1 }] }, { l: [{ s: 0.2 }] }, 1e-3).veredito).toBe("diferente");
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

describe("compararItens (listas com nota ruidosa)", () => {
  const base = [
    { id: "a", score: 0.9, texto: "A" },
    { id: "b", score: 0.8, texto: "B" },
  ];
  it("mesma lista com nota levemente diferente: mesmo conjunto, mesma ordem, conteúdo igual", () => {
    const r = compararItens(base, [{ id: "a", score: 0.9003, texto: "A" }, { id: "b", score: 0.8, texto: "B" }]);
    expect(r).toMatchObject({ mesmo_conjunto: true, mesma_ordem: true, conteudo_igual: true, max_dif_score: 0.0003 });
  });
  it("quase empatados que trocam de lugar: mesmo conjunto, ordem diferente", () => {
    const r = compararItens(base, [{ id: "b", score: 0.8, texto: "B" }, { id: "a", score: 0.8001, texto: "A" }]);
    expect(r.mesmo_conjunto).toBe(true);
    expect(r.mesma_ordem).toBe(false);
  });
  it("item que só um lado tem aparece em so_em_a / so_em_b", () => {
    const r = compararItens(base, [{ id: "a", score: 0.9, texto: "A" }, { id: "c", score: 0.7, texto: "C" }]);
    expect(r).toMatchObject({ mesmo_conjunto: false, so_em_a: ["b"], so_em_b: ["c"] });
  });
  it("texto diferente num item comum NÃO é ruído", () => {
    expect(compararItens(base, [{ id: "a", score: 0.9, texto: "A!" }, base[1] as never]).conteudo_igual).toBe(false);
  });
  it("nota ausente de um lado só é diferença infinita; os dois sem nota não", () => {
    expect(compararItens([{ id: "a", score: 1 }], [{ id: "a", score: null }]).max_dif_score).toBe(Number.POSITIVE_INFINITY);
    expect(compararItens([{ id: "a" }], [{ id: "a", score: null }]).max_dif_score).toBe(0);
  });
  it("listas vazias são iguais", () => {
    expect(compararItens([], [])).toMatchObject({ mesmo_conjunto: true, mesma_ordem: true, conteudo_igual: true, max_dif_score: 0 });
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
