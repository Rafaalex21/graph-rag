/**
 * Contrato dos templates contra o grafo real (F7.8; porte de `indexer/tests/test_templates_grafo.py`). Roda só com o
 * Neo4j no ar e o grafo da F5.8 carregado; sem ele (CI, máquina sem o banco) é pulado. Os valores esperados vêm do
 * golden set (N01, N02, T15), não do código: se o grafo mudar, o teste diz.
 *
 * Formas de falhar (além das de `templates.test.ts`, que usa um grafo falso):
 *  1. uma consulta tem erro de sintaxe ou usa propriedade que o grafo não tem (o falso não pega);
 *  2. o driver devolve `Integer` ou manda parâmetro como FLOAT e o `LIMIT` falha;
 *  3. a escala/unidade do fato real faz o lucro sair errado (N01) ou o valor trocar de página (N02);
 *  4. a resposta de qualquer ferramenta foge do contrato `evidencias[]` (campos, ids repetidos);
 *  5. um template escreve no grafo;
 *  6. a presidente não é achada pelo cargo (T15) ou o cargo gravado como nome some do aviso.
 */
import { readFileSync } from "node:fs";
import { connect } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  CONSULTAS,
  GrafoNeo4j,
  compararSegmentos,
  criarExecutor,
  eventos,
  fatoFinanceiro,
  pessoasCargos,
  riscos,
  serieMetrica,
  type Envelope,
} from "../../src/ferramentas/index.ts";

const RAIZ = new URL("../../../", import.meta.url);
const CAMPOS = ["id", "tipo", "paginas", "caminho", "texto", "score"];

const no_ar = await new Promise<boolean>((resolver) => {
  const s = connect({ host: "127.0.0.1", port: 7687, timeout: 1000 });
  s.on("connect", () => {
    s.destroy();
    resolver(true);
  });
  s.on("error", () => resolver(false));
  s.on("timeout", () => {
    s.destroy();
    resolver(false);
  });
});

/** CSV com aspas (RFC 4180): campos com vírgula, aspas duplicadas e quebras de linha. */
function lerCsv(texto: string): Record<string, string>[] {
  const linhas: string[][] = [];
  let campo = "";
  let linha: string[] = [];
  let aspas = false;
  const t = texto.replace(/^\uFEFF/, "");
  for (let i = 0; i < t.length; i++) {
    const c = t[i] as string;
    if (aspas) {
      if (c === '"' && t[i + 1] === '"') {
        campo += '"';
        i++;
      } else if (c === '"') aspas = false;
      else campo += c;
    } else if (c === '"') aspas = true;
    else if (c === ",") {
      linha.push(campo);
      campo = "";
    } else if (c === "\n" || c === "\r") {
      if (c === "\r" && t[i + 1] === "\n") i++;
      linha.push(campo);
      linhas.push(linha);
      campo = "";
      linha = [];
    } else campo += c;
  }
  if (campo !== "" || linha.length > 0) {
    linha.push(campo);
    linhas.push(linha);
  }
  const [cab, ...resto] = linhas;
  return resto.filter((l) => l.length > 1).map((l) => Object.fromEntries((cab as string[]).map((k, j) => [k, l[j] ?? ""])));
}

const golden = (id: string) => {
  const r = lerCsv(readFileSync(new URL("eval/golden.csv", RAIZ), "utf-8")).find((x) => x["id"] === id);
  if (!r) throw new Error(`golden sem ${id}`);
  return r;
};

function confereContrato(r: Envelope): void {
  expect(r.erro, JSON.stringify(r.aviso)).toBeNull();
  const ids = r.evidencias.map((e) => e.id);
  expect(new Set(ids).size).toBe(ids.length);
  for (const e of r.evidencias) {
    expect(Object.keys(e).sort()).toEqual([...CAMPOS].sort());
    expect(e.texto).not.toBe("");
    expect(typeof e.score).toBe("number");
    expect(e.paginas === "" || e.paginas.startsWith("p. ")).toBe(true);
  }
  expect(r.latencia_ms).toBeLessThan(10_000);
}

describe.skipIf(!no_ar)("templates contra o grafo real", () => {
  let grafo: GrafoNeo4j;
  beforeAll(async () => {
    grafo = GrafoNeo4j.conectar();
    const n = await grafo.consultar("MATCH (f:FinancialFact) RETURN count(f) AS n");
    if (!n[0]?.["n"]) throw new Error("grafo sem fatos financeiros: rode a importação (F5.8)");
  }, 30_000);
  afterAll(async () => {
    await grafo?.fechar();
  });

  const contar = async () => {
    const a = await grafo.consultar("MATCH (n) RETURN count(n) AS n");
    const b = await grafo.consultar("MATCH ()-[r]->() RETURN count(r) AS n");
    return [a[0]?.["n"], b[0]?.["n"]];
  };

  it("toda consulta executa no EXPLAIN", async () => {
    const parametros: Record<keyof typeof CONSULTAS, Record<string, unknown>> = {
      emissor: {},
      entidades_dos_fatos: {},
      fatos: { metrica: "metric:net_income", entidades: ["x"], qualificador: "nenhum", unidade: "currency", periodos: null, tipo_periodo: null, modo: "total", limite: 5 },
      riscos: { categoria: null, sem_categoria: false, teto: 5 },
      eventos: { teto: 5 },
      pessoas: { teto: 5 },
    };
    expect(Object.keys(parametros).sort()).toEqual(Object.keys(CONSULTAS).sort());
    for (const [nome, cypher] of Object.entries(CONSULTAS)) {
      await grafo.consultar("EXPLAIN " + cypher, parametros[nome as keyof typeof CONSULTAS]);
    }
  });

  it("N01: o lucro líquido de 2025 bate com o golden (valor, escala e página)", async () => {
    const g = golden("N01");
    const r = await fatoFinanceiro(grafo, { metrica: "lucro líquido do exercício", periodo: "2025" });
    confereContrato(r);
    expect(r.fatos).toHaveLength(1);
    expect(r.conflito).toBe(false);
    const f = r.fatos[0]!;
    expect(f.valor_absoluto).toBe(Number(g["valor"]) * 1_000_000);
    expect(f.paginas.map(String)).toContain(String(g["paginas"]));
    expect(r.evidencias[0]!.texto).toContain("R$ 16.782 milhões");
  });

  it("N02: a receita líquida de juros de 2025 bate com o golden", async () => {
    const g = golden("N02");
    const r = await fatoFinanceiro(grafo, { metrica: "receita líquida de juros", periodo: "2025" });
    confereContrato(r);
    expect(r.fatos.map((f) => f.valor_absoluto)).toEqual([Number(g["valor"]) * 1_000_000]);
    expect(r.fatos[0]!.paginas.map(String)).toContain(String(g["paginas"]));
  });

  it("sem período vale o ano-base, não a projeção", async () => {
    const r = await fatoFinanceiro(grafo, { metrica: "lucro" });
    confereContrato(r);
    expect(r.periodo_assumido).toBe(true);
    expect(new Set(r.fatos.map((f) => f.periodo))).toEqual(new Set(["2025-FY"]));
  });

  it("entidade do grupo resolve e a desconhecida dá erro", async () => {
    const sub = await fatoFinanceiro(grafo, { metrica: "lucro", entidade: "bb consorcios", periodo: "2025" });
    confereContrato(sub);
    expect(sub.fatos.length).toBeGreaterThan(0);
    expect(sub.fatos.every((f) => f.entidade === "BB Consórcios")).toBe(true);
    const ruim = await fatoFinanceiro(grafo, { metrica: "lucro", entidade: "Empresa Que Nao Existe", periodo: "2025" });
    expect(ruim.erro).toBe("entidade_desconhecida");
    expect(ruim.evidencias).toEqual([]);
  });

  it("a série não inventa o que o grafo não tem", async () => {
    const r = await serieMetrica(grafo, { metrica: "carteira de crédito" });
    confereContrato(r);
    const anos = r.pontos.map((p) => p.periodo);
    expect(anos).toEqual([...anos].sort());
    for (const a of ["2023-FY", "2024-FY", "2025-FY"]) expect(anos).toContain(a);
    const lucro = await serieMetrica(grafo, { metrica: "lucro líquido" });
    confereContrato(lucro);
    expect(lucro.pontos.length).toBeLessThan(3);
  });

  it("compara segmentos da carteira em 2025", async () => {
    const r = await compararSegmentos(grafo, { metrica: "carteira de crédito", segmentos: ["Rurais", "Imobiliário", "Aeroespacial"], periodo: "2025" });
    confereContrato(r);
    expect(new Set(r.segmentos.map((s) => s.segmento))).toEqual(new Set(["Rurais", "Imobiliário"]));
    expect(r.nao_encontrados).toEqual(["Aeroespacial"]);
    const valores = r.segmentos.map((s) => s.valor_absoluto);
    expect(valores).toEqual([...valores].sort((a, b) => b - a));
    const todos = await compararSegmentos(grafo, { metrica: "carteira de crédito", periodo: "2025", limite: 5 });
    expect(todos.segmentos).toHaveLength(5);
    expect(todos.omitido?.["segmentos"]).toBeGreaterThan(0);
  });

  it("riscos por categoria e por tema", async () => {
    const r = await riscos(grafo, { categoria: "credit", limite: 5 });
    confereContrato(r);
    expect(r.evidencias.length).toBeGreaterThan(0);
    expect(r.evidencias.every((e) => e.texto.includes("[credit]") && e.tipo === "risco")).toBe(true);
    const t = await riscos(grafo, { tema: "risco cibernético", limite: 5 });
    confereContrato(t);
    expect(t.evidencias.some((e) => e.texto.toLowerCase().includes("ciber"))).toBe(true);
    expect((await riscos(grafo, { tema: "criptomoedas de gato" })).evidencias).toEqual([]);
  });

  it("eventos de 2025 só trazem datas de 2025 e contam os sem data", async () => {
    const r = await eventos(grafo, { ano: 2025 });
    confereContrato(r);
    expect(r.evidencias.length).toBeGreaterThan(0);
    expect(r.evidencias.every((e) => e.texto.startsWith("2025"))).toBe(true);
    expect(r.omitido?.["sem_data"]).toBeGreaterThan(0);
    expect(r.aviso).toContain("sem data");
  });

  it("T15: a diretora presidente é achada pelo cargo", async () => {
    const g = golden("T15");
    const r = await pessoasCargos(grafo, { cargo: "diretora presidente" });
    confereContrato(r);
    const esperado = (g["gabarito"] ?? "").replace(/\.+$/, "");
    const achadas = r.pessoas.filter((p) => p.nome === esperado);
    expect(achadas.length).toBeGreaterThan(0);
    expect(achadas[0]!.fonte).toBe("resumo");
    expect(achadas[0]!.paginas.length).toBeGreaterThan(0);
    expect(r.pessoas.every((p) => !p.nome_parece_cargo || p.fonte === "cargo")).toBe(true);
  });

  it("cargo gravado como nome sai marcado", async () => {
    const r = await pessoasCargos(grafo, { nome: "Diretoria Executiva" });
    confereContrato(r);
    expect(r.pessoas.length).toBeGreaterThan(0);
    expect(r.pessoas.every((p) => p.nome_parece_cargo)).toBe(true);
    expect(r.aviso).toBeTruthy();
  });

  it("o executor roda uma chamada do roteador no grafo real", async () => {
    const ex = criarExecutor({ grafo });
    const r = await ex.executar({ nome: "fato_financeiro", argumentos: { metrica: "lucro líquido", periodo: "2025" } });
    confereContrato(r);
    expect(r.evidencias).toHaveLength(1);
  });

  it("nenhum template escreveu no grafo", async () => {
    const antes = await contar();
    await fatoFinanceiro(grafo, { metrica: "lucro", periodo: "2025" });
    await serieMetrica(grafo, { metrica: "carteira de crédito" });
    await compararSegmentos(grafo, { metrica: "carteira de crédito", periodo: "2025" });
    await riscos(grafo, {});
    await eventos(grafo, {});
    await pessoasCargos(grafo, { cargo: "presidente" });
    expect(await contar()).toEqual(antes);
  });
});
