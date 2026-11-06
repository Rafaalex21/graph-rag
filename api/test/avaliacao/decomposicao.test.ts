/**
 * O avaliador da decomposição (F7.2) e o conjunto `eval/golden_decomposicao.json`.
 *
 * Formas de a medida mentir, escritas antes do código:
 *  1. Acertar o número de subperguntas com o conteúdo errado (duas perguntas sobre o mesmo assunto);
 *  2. acertar o conteúdo com a conta errada: quebrar uma soma ou uma lista em partes é erro, e juntar duas
 *     perguntas em uma também;
 *  3. ordem: subperguntas independentes valem em qualquer ordem, mas a dependência tem de apontar para a
 *     subpergunta certa e uma dependência inventada (que impede paralelizar) é erro;
 *  4. sobrar pronome ("ele", "ela") na pergunta autônoma ou vazar assunto do histórico para uma pergunta nova;
 *  5. acento, caixa e pontuação não podem decidir o acerto; palavra curta ("ele") não pode casar dentro de
 *     outra ("elegante").
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  avaliarDecomposicao,
  casaTermos,
  normalizar,
  resumirAvaliacao,
  type CasoDecomposicao,
} from "../../src/avaliacao/decomposicao.ts";

const caso = (esperado: CasoDecomposicao["esperado"], extra: Partial<CasoDecomposicao> = {}): CasoDecomposicao => ({
  id: "X",
  grupo: "teste",
  tipo: "composta",
  historico: [],
  pergunta: "p",
  esperado,
  ...extra,
});
const sub = (pergunta: string, dependeDe: number[] = []) => ({ pergunta, dependeDe });

describe("normalizar e casar termos", () => {
  it("tira acento, caixa e pontuação", () => {
    expect(normalizar("Qual é o Lucro Líquido, em 2025?")).toBe("qual e o lucro liquido em 2025");
  });

  it("todos os termos precisam aparecer; `a|b` aceita qualquer uma das alternativas", () => {
    expect(casaTermos("Quantos funcionários havia em 2025?", ["empregados|funcionarios", "2025"])).toBe(true);
    expect(casaTermos("Quantos funcionários havia?", ["empregados|funcionarios", "2025"])).toBe(false);
  });

  it("termo com espaço é frase; o termo é procurado como prefixo de palavra (mitig casa mitigá-los)", () => {
    expect(casaTermos("Qual o conselho de administração?", ["conselho de administracao"])).toBe(true);
    expect(casaTermos("como mitigá-los?", ["mitig"])).toBe(true);
  });
});

describe("avaliarDecomposicao", () => {
  const dois = caso({ subperguntas: [["lucro", "2025"], ["empregados"]], dependencias: {} });

  it("acerta quando as duas subperguntas casam, em qualquer ordem", () => {
    const a = avaliarDecomposicao(dois, {
      autonoma: "x",
      subperguntas: [sub("Quantos empregados havia?"), sub("Qual o lucro de 2025?")],
    });
    expect(a).toEqual({ ok: true, motivos: [] });
  });

  it("número errado de subperguntas é erro, para mais (quebrou demais) e para menos (juntou)", () => {
    const mais = avaliarDecomposicao(dois, {
      autonoma: "x",
      subperguntas: [sub("lucro 2025"), sub("empregados"), sub("outra coisa")],
    });
    const menos = avaliarDecomposicao(dois, { autonoma: "x", subperguntas: [sub("lucro 2025 e empregados")] });
    expect(mais.ok).toBe(false);
    expect(mais.motivos[0]).toMatch(/quantidade/);
    expect(menos.ok).toBe(false);
  });

  it("duas perguntas sobre o mesmo assunto não cobrem as duas esperadas", () => {
    const a = avaliarDecomposicao(dois, {
      autonoma: "x",
      subperguntas: [sub("lucro de 2025"), sub("lucro líquido de 2025")],
    });
    expect(a.ok).toBe(false);
    expect(a.motivos.join(" ")).toMatch(/sem_correspondencia/);
  });

  it("uma soma ou lista que deveria ficar inteira vira erro se for quebrada", () => {
    const simples = caso({ subperguntas: [["pretos", "pardos"]], dependencias: {} }, { tipo: "simples" });
    const quebrada = avaliarDecomposicao(simples, {
      autonoma: "x",
      subperguntas: [sub("quantos pretos?"), sub("quantos pardos?")],
    });
    expect(quebrada.ok).toBe(false);
    expect(avaliarDecomposicao(simples, { autonoma: "x", subperguntas: [sub("soma de pretos e pardos")] }).ok).toBe(true);
  });

  describe("dependências", () => {
    const sequencial = caso({ subperguntas: [["empresa"], ["desde"]], dependencias: { "1": [0] } });

    it("a dependência esperada tem de estar declarada, apontando para a subpergunta certa", () => {
      const certa = avaliarDecomposicao(sequencial, {
        autonoma: "x",
        subperguntas: [sub("qual empresa?"), sub("desde quando?", [0])],
      });
      expect(certa.ok).toBe(true);
      const falta = avaliarDecomposicao(sequencial, {
        autonoma: "x",
        subperguntas: [sub("qual empresa?"), sub("desde quando?")],
      });
      expect(falta.ok).toBe(false);
      expect(falta.motivos.join(" ")).toMatch(/dependencias/);
    });

    it("a ordem trocada vale se a dependência acompanha a troca", () => {
      const trocada = avaliarDecomposicao(sequencial, {
        autonoma: "x",
        subperguntas: [sub("desde quando?", [1]), sub("qual empresa?")],
      });
      expect(trocada.ok).toBe(true);
    });

    it("dependência inventada entre subperguntas independentes é erro (impede paralelizar)", () => {
      const a = avaliarDecomposicao(dois, {
        autonoma: "x",
        subperguntas: [sub("lucro 2025"), sub("empregados", [0])],
      });
      expect(a.ok).toBe(false);
      expect(a.motivos.join(" ")).toMatch(/dependencias/);
    });
  });

  describe("termos proibidos", () => {
    const seg = caso(
      { subperguntas: [["membros"]], dependencias: {}, proibido: ["ele", "lucro"] },
      { tipo: "seguimento" },
    );

    it("pronome que sobrou na subpergunta ou na autônoma é erro", () => {
      expect(
        avaliarDecomposicao(seg, { autonoma: "Quantos membros ele tem?", subperguntas: [sub("quantos membros tem o conselho?")] })
          .motivos.join(" "),
      ).toMatch(/proibido:ele/);
      expect(
        avaliarDecomposicao(seg, { autonoma: "ok", subperguntas: [sub("quantos membros ele tem?")] }).ok,
      ).toBe(false);
    });

    it("assunto do histórico que vazou para uma pergunta nova é erro", () => {
      const a = avaliarDecomposicao(seg, {
        autonoma: "ok",
        subperguntas: [sub("quantos membros tem o conselho no ano do lucro?")],
      });
      expect(a.motivos.join(" ")).toMatch(/proibido:lucro/);
    });

    it("a palavra curta só casa inteira: 'elegante' não é 'ele'", () => {
      const a = avaliarDecomposicao(seg, { autonoma: "ok", subperguntas: [sub("quantos membros tem o elegante conselho?")] });
      expect(a.ok).toBe(true);
    });
  });
});

describe("resumirAvaliacao", () => {
  it("conta acertos por grupo e por tipo", () => {
    const r = resumirAvaliacao([
      { id: "A", grupo: "ajuste", tipo: "composta", ok: true },
      { id: "B", grupo: "teste", tipo: "composta", ok: true },
      { id: "C", grupo: "teste", tipo: "composta", ok: false },
      { id: "D", grupo: "teste", tipo: "simples", ok: true },
    ]);
    expect(r.teste).toEqual({ n: 3, acertos: 2, taxa: 0.667 });
    expect(r.ajuste).toEqual({ n: 1, acertos: 1, taxa: 1 });
    expect(r.teste_composta).toEqual({ n: 2, acertos: 1, taxa: 0.5 });
    expect(r.teste_simples).toEqual({ n: 1, acertos: 1, taxa: 1 });
    expect(r.geral.n).toBe(4);
  });

  it("conjunto vazio não divide por zero", () => {
    expect(resumirAvaliacao([]).geral).toEqual({ n: 0, acertos: 0, taxa: 0 });
  });
});

describe("eval/golden_decomposicao.json", () => {
  const casos = JSON.parse(
    readFileSync(new URL("../../../eval/golden_decomposicao.json", import.meta.url), "utf-8"),
  ) as CasoDecomposicao[];

  it("ids únicos e campos válidos", () => {
    expect(new Set(casos.map((c) => c.id)).size).toBe(casos.length);
    for (const c of casos) {
      expect(["ajuste", "teste", "teste2"]).toContain(c.grupo);
      expect(["composta", "simples", "seguimento"]).toContain(c.tipo);
      expect(c.pergunta.trim().length).toBeGreaterThan(5);
      for (const [i, deps] of Object.entries(c.esperado.dependencias)) {
        for (const d of deps) expect(d).toBeLessThan(Number(i));
      }
    }
  });

  it("o aceite: pelo menos 10 perguntas compostas no teste, e todas esperam 2 a 4 subperguntas", () => {
    const compostas = casos.filter((c) => c.grupo === "teste" && c.tipo === "composta");
    expect(compostas.length).toBeGreaterThanOrEqual(10);
    for (const c of compostas) {
      expect(c.esperado.subperguntas.length).toBeGreaterThanOrEqual(2);
      expect(c.esperado.subperguntas.length).toBeLessThanOrEqual(4);
    }
  });

  it("simples esperam exatamente 1 subpergunta; seguimentos trazem histórico", () => {
    for (const c of casos.filter((x) => x.tipo === "simples")) expect(c.esperado.subperguntas).toHaveLength(1);
    for (const c of casos.filter((x) => x.tipo === "seguimento")) expect(c.historico.length).toBeGreaterThan(0);
    for (const c of casos.filter((x) => x.tipo !== "seguimento")) expect(c.historico).toHaveLength(0);
  });

  it("o gabarito de cada caso passa no próprio avaliador quando a decomposição é a esperada", () => {
    for (const c of casos) {
      const palavras = c.esperado.subperguntas.map((termos) => termos.map((t) => t.split("|")[0]).join(" "));
      const subs = palavras.map((p, i) => sub(p, c.esperado.dependencias[String(i)] ?? []));
      expect(avaliarDecomposicao(c, { autonoma: "pergunta", subperguntas: subs }), c.id).toEqual({ ok: true, motivos: [] });
    }
  });
});
