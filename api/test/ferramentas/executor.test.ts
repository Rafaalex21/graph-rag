/**
 * Executor de ferramentas (F7.8): recebe `{nome, argumentos}` do roteador (F7.3) e devolve o resultado da
 * ferramenta. Formas de falha, escritas antes do código:
 *
 *  1. Nunca lança: ferramenta desconhecida, ainda não portada (as das F7.9 e F7.10) e exceção do template viram
 *     `erro` no resultado, com evidências vazias, para o agente seguir.
 *  2. Os argumentos do roteador são de um LLM: `riscos(categoria: "mercado")` tem de virar `market`; categoria
 *     que não se reconhece não pode virar erro nem sumir, e sim virar tema; ano chega como número, nunca
 *     como texto de ano inválido.
 *  3. Cada ferramenta recebe só os argumentos dela (um `periodo` solto em `riscos` não vaza).
 *  4. A tabela de ferramentas portadas é a única fonte: registrar uma nova (F7.9) não mexe nas outras.
 *  5. Duas chamadas independentes rodam juntas e uma que falha não derruba a outra.
 */
import { describe, expect, it } from "vitest";
import { CATALOGO } from "../../src/agente/roteador.ts";
import {
  CONSULTAS,
  FERRAMENTAS_DE_TEMPLATE,
  NAO_PORTADAS,
  criarExecutor,
  normalizarCategoria,
  type GrafoLeitura,
  type Metrica,
} from "../../src/ferramentas/index.ts";

const CAT: Metrica[] = [{ id: "net_income", name: "Net income", name_pt: "Lucro líquido", kind: "monetary", aliases: ["lucro"] }];

function grafo(respostas: Record<string, Record<string, unknown>[]> = {}) {
  const base: Record<string, Record<string, unknown>[]> = {
    emissor: [{ emissor: "Banco do Brasil S.A.", ano_base: 2025 }],
    entidades_dos_fatos: [{ entidade: "Banco do Brasil S.A.", n: 10 }],
    ...respostas,
  };
  const chamadas: { nome: string; params: Record<string, unknown> }[] = [];
  const g: GrafoLeitura = {
    consultar: async (cypher, params = {}) => {
      const nome = Object.entries(CONSULTAS).find(([, c]) => c === cypher)?.[0] ?? "?";
      chamadas.push({ nome, params });
      if (respostas["__falha"]) throw new Error("neo4j caiu");
      return (base[nome] ?? []).map((r) => ({ ...r }));
    },
  };
  return { g, chamadas };
}

describe("consistência com o catálogo do roteador", () => {
  it("toda ferramenta que o roteador pode chamar é portada ou está declarada como não portada, sem sobra", () => {
    const doRoteador = CATALOGO.map((f) => f.nome).sort();
    const conhecidas = [...FERRAMENTAS_DE_TEMPLATE, ...NAO_PORTADAS].sort();
    expect(conhecidas).toEqual(doRoteador);
  });

  it("o executor lista as 12 ferramentas e as não portadas respondem erro, não exceção", async () => {
    const { g } = grafo();
    const ex = criarExecutor({ grafo: g, catalogo: CAT });
    expect([...ex.ferramentas].sort()).toEqual(CATALOGO.map((f) => f.nome).sort());
    for (const nome of NAO_PORTADAS) {
      const r = await ex.executar({ nome, argumentos: { pergunta: "x" } });
      expect(r.erro).toBe("ferramenta_nao_portada");
      expect(r.evidencias).toEqual([]);
    }
  });
});

describe("normalizarCategoria", () => {
  it.each([
    ["mercado", "market"],
    ["Risco de Crédito", "credit"],
    ["operacional", "operational"],
    ["regulatório", "regulatory"],
    ["regulatoria", "regulatory"],
    ["liquidez", "liquidity"],
    ["câmbio", "currency"],
    ["cambial", "currency"],
    ["sem categoria", "sem_categoria"],
    ["credit", "credit"],
  ])("%j → %s", (texto, esperado) => {
    expect(normalizarCategoria(texto)).toBe(esperado);
  });

  it.each(["climático", "", "astrologia"])("%j não se reconhece", (texto) => {
    expect(normalizarCategoria(texto)).toBeNull();
  });
});

describe("executor", () => {
  it("ferramenta desconhecida e ferramenta ainda não portada viram erro, não exceção", async () => {
    const { g } = grafo();
    const ex = criarExecutor({ grafo: g, catalogo: CAT });
    const a = await ex.executar({ nome: "pesquisar_web", argumentos: {} });
    expect(a.erro).toBe("ferramenta_desconhecida");
    expect(a.evidencias).toEqual([]);
    for (const nome of ["buscar_trechos", "buscar_tabelas", "entidade", "panorama", "consultar_grafo", "resposta_ja_dada"]) {
      const r = await ex.executar({ nome, argumentos: { pergunta: "x", nome: "x", resposta: "x" } });
      expect(r.erro, nome).toBe("ferramenta_nao_portada");
      expect(r.evidencias, nome).toEqual([]);
    }
  });

  it("despacha as seis ferramentas de template com os argumentos delas", async () => {
    const { g, chamadas } = grafo({
      fatos: [{ id: "f1", valor: 5, unidade: "currency", moeda: null, escala: 1_000_000, periodo: "2025-FY", fim: "2025-12-31", tipo_periodo: "fiscal_year", entidade: "Banco do Brasil S.A.", qualificador: "nenhum", dimensao: null, rotulo: "Lucro", pagina: 3, pagina_fim: 3 }],
      riscos: [],
      eventos: [],
      pessoas: [],
    });
    const ex = criarExecutor({ grafo: g, catalogo: CAT });
    const fato = await ex.executar({ nome: "fato_financeiro", argumentos: { metrica: "lucro", periodo: "2025" } });
    expect(fato.erro).toBeNull();
    expect(fato.evidencias).toHaveLength(1);
    expect((await ex.executar({ nome: "serie_metrica", argumentos: { metrica: "lucro" } })).ferramenta).toBe("serie_metrica");
    expect((await ex.executar({ nome: "comparar_segmentos", argumentos: { metrica: "lucro", segmentos: ["A"], periodo: "2025" } })).ferramenta).toBe("comparar_segmentos");
    expect((await ex.executar({ nome: "riscos", argumentos: { tema: "crédito" } })).ferramenta).toBe("riscos");
    expect((await ex.executar({ nome: "eventos", argumentos: { ano: 2024 } })).ferramenta).toBe("eventos");
    expect((await ex.executar({ nome: "pessoas_cargos", argumentos: { cargo: "presidente" } })).ferramenta).toBe("pessoas_cargos");
    expect(chamadas.some((c) => c.nome === "riscos")).toBe(true);
  });

  it("a categoria em português vira o código do grafo", async () => {
    const { g, chamadas } = grafo({ riscos: [] });
    await criarExecutor({ grafo: g, catalogo: CAT }).executar({ nome: "riscos", argumentos: { categoria: "mercado" } });
    expect(chamadas.find((c) => c.nome === "riscos")?.params["categoria"]).toBe("market");
  });

  it("categoria que não se reconhece vira tema, sem erro e sem sumir", async () => {
    const { g, chamadas } = grafo({
      riscos: [{ id: "r1", nome: "Risco climático", categoria: null, resumo: "Eventos climáticos", camadas: [], ini: [1], fim: [1], apelidos: null }],
    });
    const r = await criarExecutor({ grafo: g, catalogo: CAT }).executar({ nome: "riscos", argumentos: { categoria: "climático" } });
    expect(r.erro).toBeNull();
    expect(chamadas.find((c) => c.nome === "riscos")?.params["categoria"]).toBeNull();
    expect(r.evidencias.map((e) => e.id)).toEqual(["r1"]); // o tema "climático" achou o risco
  });

  it("categoria desconhecida não sobrescreve um tema que já veio", async () => {
    const { g } = grafo({
      riscos: [
        { id: "r1", nome: "Risco de crédito", categoria: "credit", resumo: "", camadas: [], ini: [1], fim: [1], apelidos: null },
        { id: "r2", nome: "Risco climático", categoria: null, resumo: "", camadas: [], ini: [2], fim: [2], apelidos: null },
      ],
    });
    const r = await criarExecutor({ grafo: g, catalogo: CAT }).executar({ nome: "riscos", argumentos: { tema: "crédito", categoria: "climático" } });
    expect(r.evidencias.map((e) => e.id)).toEqual(["r1"]);
  });

  it("não vazam argumentos de uma ferramenta para outra", async () => {
    const { g, chamadas } = grafo({ riscos: [] });
    await criarExecutor({ grafo: g, catalogo: CAT }).executar({ nome: "riscos", argumentos: { tema: "x", periodo: "2025", ano: 2020 } });
    expect(Object.keys(chamadas.find((c) => c.nome === "riscos")?.params ?? {}).sort()).toEqual(["categoria", "sem_categoria", "teto"]);
  });

  it("uma exceção inesperada vira erro no resultado", async () => {
    const { g } = grafo({ __falha: [] });
    const r = await criarExecutor({ grafo: g, catalogo: CAT }).executar({ nome: "eventos", argumentos: {} });
    expect(r.erro).toContain("neo4j caiu");
    expect(r.evidencias).toEqual([]);
  });

  it("argumentos de tipo errado (que a validação do roteador deixaria passar) não derrubam", async () => {
    const { g } = grafo({ eventos: [] });
    const ex = criarExecutor({ grafo: g, catalogo: CAT });
    const r = await ex.executar({ nome: "eventos", argumentos: { ano: "abc", tema: 5 } });
    expect(r.erro).toBeTruthy();
    const s = await ex.executar({ nome: "comparar_segmentos", argumentos: { metrica: "lucro", segmentos: "Rurais" } });
    expect(s.erro).toBeNull(); // texto único é tratado como uma lista de um segmento
  });

  it("registrar uma ferramenta nova não mexe nas portadas", async () => {
    const { g } = grafo({ riscos: [] });
    const ex = criarExecutor({
      grafo: g,
      catalogo: CAT,
      extras: {
        buscar_trechos: async () => ({
          ferramenta: "buscar_trechos", parametros: {}, evidencias: [], aviso: null, erro: null, sugestoes: [], omitido: {}, latencia_ms: 0,
        }),
      },
    });
    expect((await ex.executar({ nome: "buscar_trechos", argumentos: { pergunta: "x" } })).erro).toBeNull();
    expect((await ex.executar({ nome: "panorama", argumentos: { pergunta: "x" } })).erro).toBe("ferramenta_nao_portada");
    expect((await ex.executar({ nome: "riscos", argumentos: {} })).ferramenta).toBe("riscos");
  });

  it("executa várias chamadas juntas, na ordem pedida, e uma que falha não derruba a outra", async () => {
    const { g } = grafo({ riscos: [], eventos: [] });
    const ex = criarExecutor({ grafo: g, catalogo: CAT });
    const rs = await ex.executarTodas([
      { nome: "riscos", argumentos: {} },
      { nome: "pesquisar_web", argumentos: {} },
      { nome: "eventos", argumentos: {} },
    ]);
    expect(rs.map((r) => r.ferramenta)).toEqual(["riscos", "pesquisar_web", "eventos"]);
    expect(rs.map((r) => r.erro === null)).toEqual([true, false, true]);
  });
});
