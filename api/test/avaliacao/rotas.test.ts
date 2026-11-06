/**
 * Avaliador de rotas (F7.3). Formas de falha do avaliador, escritas antes do código:
 *
 *  1. Rota "nenhuma": nenhuma chamada é o certo; chamar ferramenta é erro no critério estrito e só vale no
 *     aceito quando o conjunto aceito a inclui (ex.: buscar_trechos para uma pergunta fora do escopo).
 *  2. Rota única: o estrito exige que TODAS as chamadas sejam a esperada (chamar uma a mais é errar, porque
 *     custa tempo); o aceito exige que todas estejam no conjunto aceito, fixado antes da medição.
 *  3. Nenhuma chamada onde era esperada uma: erro nos dois critérios (o modelo desistiu).
 *  4. "varias": precisa de duas subperguntas ou mais e de ao menos uma ferramenta em cada uma; uma
 *     subpergunta sem ferramenta, ou uma só subpergunta, é erro nos dois critérios.
 *  5. O resumo separa estrito e aceito, grupo e rota esperada, e não divide por zero com grupo vazio.
 *  6. O arquivo `eval/golden_rotas.json` é consistente: 60 casos, ids únicos, `aceitas` contém a esperada,
 *     `varias` e `nenhuma` tratadas, grupos só `ajuste` e `teste`, nomes de ferramenta existentes no catálogo.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { CATALOGO } from "../../src/agente/roteador.ts";
import { avaliarRota, resumirRotas, type CasoRota } from "../../src/avaliacao/rotas.ts";

const caso = (rota_esperada: string, aceitas: string[], extra: Partial<CasoRota> = {}): CasoRota => ({
  id: "X01",
  grupo: "teste",
  pergunta: "?",
  rota_esperada,
  aceitas,
  ...extra,
});

describe("rota única", () => {
  const c = caso("buscar_trechos", ["buscar_trechos", "panorama"]);
  it("a esperada passa nos dois critérios", () => {
    expect(avaliarRota(c, { rotas: [["buscar_trechos"]] })).toMatchObject({ estrito: true, aceito: true });
  });
  it("uma aceita mas não a esperada só passa no aceito", () => {
    expect(avaliarRota(c, { rotas: [["panorama"]] })).toMatchObject({ estrito: false, aceito: true });
  });
  it("uma chamada a mais, ainda que aceita, quebra o estrito", () => {
    expect(avaliarRota(c, { rotas: [["buscar_trechos", "panorama"]] })).toMatchObject({ estrito: false, aceito: true });
  });
  it("chamar a mesma ferramenta duas vezes ainda é a esperada", () => {
    expect(avaliarRota(c, { rotas: [["buscar_trechos", "buscar_trechos"]] })).toMatchObject({ estrito: true, aceito: true });
  });
  it("uma chamada fora do conjunto aceito erra nos dois, mesmo com a esperada junto", () => {
    expect(avaliarRota(c, { rotas: [["buscar_trechos", "consultar_grafo"]] })).toMatchObject({ estrito: false, aceito: false });
    expect(avaliarRota(c, { rotas: [["consultar_grafo"]] })).toMatchObject({ estrito: false, aceito: false });
  });
  it("nenhuma chamada onde era esperada uma é erro", () => {
    const r = avaliarRota(c, { rotas: [[]] });
    expect(r).toMatchObject({ estrito: false, aceito: false });
    expect(r.motivo).toMatch(/nenhuma/i);
  });
});

describe("rota nenhuma", () => {
  it("sem chamada é certo; chamar é errado no estrito e no aceito se nenhuma não está no conjunto", () => {
    const c = caso("nenhuma", ["nenhuma"]);
    expect(avaliarRota(c, { rotas: [[]] })).toMatchObject({ estrito: true, aceito: true });
    expect(avaliarRota(c, { rotas: [["buscar_trechos"]] })).toMatchObject({ estrito: false, aceito: false });
  });
  it("quando buscar_trechos também é aceita, chamá-la só vale no aceito", () => {
    const c = caso("nenhuma", ["nenhuma", "buscar_trechos"]);
    expect(avaliarRota(c, { rotas: [["buscar_trechos"]] })).toMatchObject({ estrito: false, aceito: true });
    expect(avaliarRota(c, { rotas: [["buscar_trechos", "panorama"]] })).toMatchObject({ aceito: false });
  });
});

describe("rota varias", () => {
  const c = caso("varias", []);
  it("duas subperguntas, cada uma com ferramenta", () => {
    expect(avaliarRota(c, { rotas: [["buscar_trechos"], ["fato_financeiro"]] })).toMatchObject({ estrito: true, aceito: true });
  });
  it("uma só subpergunta não é 'varias'", () => {
    const r = avaliarRota(c, { rotas: [["buscar_trechos", "buscar_tabelas"]] });
    expect(r).toMatchObject({ estrito: false, aceito: false });
    expect(r.motivo).toMatch(/subperguntas/);
  });
  it("uma subpergunta sem ferramenta é erro", () => {
    expect(avaliarRota(c, { rotas: [["buscar_trechos"], []] })).toMatchObject({ estrito: false, aceito: false });
  });
  it("sem nenhuma subpergunta é erro", () => {
    expect(avaliarRota(c, { rotas: [] })).toMatchObject({ estrito: false, aceito: false });
  });
});

describe("resumo", () => {
  const itens = [
    { id: "A", grupo: "ajuste", rota_esperada: "buscar_trechos", estrito: true, aceito: true },
    { id: "B", grupo: "ajuste", rota_esperada: "buscar_trechos", estrito: false, aceito: true },
    { id: "C", grupo: "teste", rota_esperada: "panorama", estrito: false, aceito: false },
    { id: "D", grupo: "teste", rota_esperada: "panorama", estrito: true, aceito: true },
  ];
  it("conta estrito e aceito no geral, por grupo e por rota esperada", () => {
    const r = resumirRotas(itens);
    expect(r.geral).toEqual({ n: 4, estrito: { ok: 2, taxa: 0.5 }, aceito: { ok: 3, taxa: 0.75 } });
    expect(r.por_grupo["ajuste"]).toEqual({ n: 2, estrito: { ok: 1, taxa: 0.5 }, aceito: { ok: 2, taxa: 1 } });
    expect(r.por_grupo["teste"]).toEqual({ n: 2, estrito: { ok: 1, taxa: 0.5 }, aceito: { ok: 1, taxa: 0.5 } });
    expect(r.por_rota["panorama"]).toEqual({ n: 2, estrito: { ok: 1, taxa: 0.5 }, aceito: { ok: 1, taxa: 0.5 } });
  });
  it("lista vazia não divide por zero", () => {
    expect(resumirRotas([]).geral).toEqual({ n: 0, estrito: { ok: 0, taxa: 0 }, aceito: { ok: 0, taxa: 0 } });
  });
});

describe("eval/golden_rotas.json", () => {
  const casos = JSON.parse(readFileSync(new URL("../../../eval/golden_rotas.json", import.meta.url), "utf-8")) as CasoRota[];
  const nomes = new Set([...CATALOGO.map((f) => f.nome), "nenhuma"]);

  it("100 casos com ids únicos: 60 do golden (20 de ajuste, 40 de teste), 20 de teste2 e 20 de teste3, cada um escrito depois do ajuste anterior", () => {
    expect(casos).toHaveLength(100);
    expect(new Set(casos.map((c) => c.id)).size).toBe(100);
    expect(new Set(casos.map((c) => c.grupo))).toEqual(new Set(["ajuste", "teste", "teste2", "teste3"]));
    expect(casos.filter((c) => c.grupo === "ajuste")).toHaveLength(20);
    expect(casos.filter((c) => c.grupo === "teste")).toHaveLength(40);
    expect(casos.filter((c) => c.grupo === "teste2")).toHaveLength(20);
    expect(casos.filter((c) => c.grupo === "teste3")).toHaveLength(20);
  });

  it("nenhuma pergunta repete outra, de nenhum grupo", () => {
    const perguntas = casos.map((c) => c.pergunta.trim().toLowerCase());
    expect(new Set(perguntas).size).toBe(perguntas.length);
  });

  it("toda aceita é uma ferramenta do catálogo (ou nenhuma) e contém a esperada", () => {
    for (const c of casos) {
      for (const a of c.aceitas) expect(nomes.has(a), `${c.id}: ${a}`).toBe(true);
      if (c.rota_esperada === "varias") expect(c.aceitas, c.id).toEqual([]);
      else expect(c.aceitas, c.id).toContain(c.rota_esperada);
    }
  });

  it("os dois grupos têm perguntas de cada tipo de rota que o roteador distingue", () => {
    for (const g of ["ajuste", "teste", "teste2", "teste3"]) {
      const rotas = new Set(casos.filter((c) => c.grupo === g).map((c) => c.rota_esperada));
      for (const r of ["buscar_trechos", "buscar_tabelas", "consultar_grafo", "panorama", "varias", "nenhuma"]) {
        expect(rotas.has(r), `${g} sem ${r}`).toBe(true);
      }
    }
  });
});
