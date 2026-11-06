/**
 * Medidas da paridade das buscas (F7.9): leitura do golden, páginas de um rótulo e page recall@k. Formas de falha:
 *  1. O golden é CSV com aspas, vírgulas e quebras de linha dentro do campo e BOM no começo; uma linha de
 *     `paginas` vazia (fora do escopo) não entra na medida.
 *  2. O rótulo `p. 6-7, 9` vira {6, 7, 9}; rótulo vazio vira conjunto vazio; faixa absurda não vira milhares de
 *     páginas.
 *  3. Page recall é por k trechos: o k-ésimo só conta as páginas dos k primeiros, na ordem; gabarito com
 *     várias páginas dá recall fracionário e `acerto` vale 1 se alguma aparece.
 */
import { describe, expect, it } from "vitest";
import { lerCsv, pageRecall, paginasDoGabarito, paginasDoRotulo } from "../../src/avaliacao/busca.ts";

describe("lerCsv", () => {
  it("campos com vírgula, aspas duplicadas, quebra de linha, BOM e CRLF", () => {
    const csv = '﻿id,pergunta,paginas\r\nA,"Quanto, em R$?",6\r\nB,"Ele disse ""oi""\nlinha 2",80|81\r\nC,sem aspas,\r\n';
    expect(lerCsv(csv)).toEqual([
      { id: "A", pergunta: "Quanto, em R$?", paginas: "6" },
      { id: "B", pergunta: 'Ele disse "oi"\nlinha 2', paginas: "80|81" },
      { id: "C", pergunta: "sem aspas", paginas: "" },
    ]);
  });
  it("arquivo sem quebra de linha final e linhas em branco", () => {
    expect(lerCsv("a,b\n1,2\n\n")).toEqual([{ a: "1", b: "2" }]);
    expect(lerCsv("a,b\n1,2")).toEqual([{ a: "1", b: "2" }]);
  });
});

describe("paginas", () => {
  it("rótulo do contrato", () => {
    expect([...paginasDoRotulo("p. 6")]).toEqual([6]);
    expect([...paginasDoRotulo("p. 6-7, 9")].sort((a, b) => a - b)).toEqual([6, 7, 9]);
    expect(paginasDoRotulo("").size).toBe(0);
    expect(paginasDoRotulo("p. 1-9999").size).toBeLessThanOrEqual(2);
  });
  it("gabarito do golden", () => {
    expect(paginasDoGabarito("80|81")).toEqual([80, 81]);
    expect(paginasDoGabarito(" 6 ")).toEqual([6]);
    expect(paginasDoGabarito("")).toEqual([]);
  });
});

describe("pageRecall", () => {
  const rotulos = ["p. 5", "p. 6-7", "p. 80"];
  it("conta só os k primeiros trechos", () => {
    const r = pageRecall([6, 80], rotulos.map((l) => paginasDoRotulo(l)), [1, 2, 3]);
    expect(r[1]).toEqual({ recall: 0, acerto: 0 });
    expect(r[2]).toEqual({ recall: 0.5, acerto: 1 });
    expect(r[3]).toEqual({ recall: 1, acerto: 1 });
  });
  it("sem trechos ou k maior que a lista", () => {
    expect(pageRecall([6], [], [1, 6])).toEqual({ 1: { recall: 0, acerto: 0 }, 6: { recall: 0, acerto: 0 } });
    expect(pageRecall([5], [new Set([5])], [6])[6]).toEqual({ recall: 1, acerto: 1 });
  });
});
