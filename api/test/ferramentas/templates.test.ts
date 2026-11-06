/**
 * Templates Cypher em TypeScript (F7.8, ARQUITETURA §7.2): `fato_financeiro`, `serie_metrica`,
 * `comparar_segmentos`, `riscos`, `eventos` e `pessoas_cargos`. É o porte de `indexer/tests/test_templates_cypher.py`
 * (F6.3): as mesmas formas de falha, com o mesmo grafo falso, e o resultado com as mesmas chaves do Python, para
 * que a paridade contra o grafo real (`npm run avaliar:paridade`) compare JSON com JSON.
 *
 * Formas de falhar, escritas antes do código (cada uma tem um teste abaixo):
 *
 * Comum
 *  1. um template escreve no grafo, não tem LIMIT ou concatena texto do usuário na consulta (injeção);
 *  2. a entidade ou o tema com aspas, chaves ou `;` vira parte do Cypher em vez de parâmetro;
 *  3. o driver falha e a exceção sobe até o roteador, em vez de um `erro` no resultado;
 *  4. nada encontrado vira resposta inventada: o resultado tem de vir vazio e dizer por quê.
 * fato_financeiro
 *  5. métrica fora do catálogo chama o grafo mesmo assim, ou "lucro"/"faturamento" não achem a canônica;
 *  6. período em formato do usuário ("2025", "4T25", "31/12/2025") não vira o id do grafo, ou um período
 *     inválido passa em silêncio (inclusive 29/02 de ano comum);
 *  7. sem período, o "mais recente" é um período de projeção, posterior ao ano-base do documento;
 *  8. entidade com outra caixa/acento não casa; entidade desconhecida devolve os fatos do emissor sem avisar;
 *  9. a escala é ignorada (16.782 × 10⁶ ≠ 16.782) ou o texto sai fora do padrão pt-BR;
 * 10. o mesmo valor, em duas escalas ou em duas páginas, aparece como dois fatos, ou valores que divergem de
 *     verdade aparecem como um só sem aviso;
 * 11. fato de unidade incompatível com a métrica (percentual de crescimento sob uma métrica monetária) volta;
 * 12. só há recortes e o total é inventado; o pedido de um recorte devolve o total.
 * serie_metrica
 * 13. a série sai fora de ordem cronológica, preenche lacunas ou mistura trimestre com ano;
 * 14. períodos com valores conflitantes viram um ponto sem aviso; a variação cruza unidades ou lacunas.
 * comparar_segmentos
 * 15. um segmento pedido que não existe some em silêncio; "pessoas fisicas" não casa "Pessoas Físicas";
 * 16. sem lista de segmentos, devolve todos os recortes sem teto, ou sem ordem.
 * riscos / eventos / pessoas_cargos
 * 17. categoria inexistente é aceita; tema sem resultado devolve riscos quaisquer;
 * 18. o filtro por ano descarta evento sem data sem contar, ou o devolve como se fosse do ano;
 * 19. "diretora presidente" não casa "Diretor Presidente"; sem nenhum filtro devolve todas as pessoas;
 * 20. nome de pessoa que é um cargo (defeito conhecido da extração) sai sem aviso.
 * Só do TypeScript
 * 21. o JSON do resultado perde campo (`undefined` some) onde o Python tinha `None`: as chaves têm de existir;
 * 22. ordenação por tupla do Python (booleanos, textos, número negativo) trocada pela de `Array.sort` sem chave.
 */
import { describe, expect, it } from "vitest";
import {
  CONSULTAS,
  compararSegmentos,
  consolidarFatos,
  eventos,
  fatoFinanceiro,
  formatarValor,
  normalizarPeriodo,
  pessoasCargos,
  resolverEntidade,
  resolverMetrica,
  riscos,
  serieMetrica,
  type GrafoLeitura,
  type Metrica,
} from "../../src/ferramentas/index.ts";

const CAT: Metrica[] = [
  { id: "net_income", name: "Net income", name_pt: "Lucro líquido", kind: "monetary", aliases: ["lucro", "lucro líquido do exercício", "profit"] },
  { id: "net_interest_income", name: "Net interest income", name_pt: "Receita líquida de juros", kind: "monetary", aliases: ["margem financeira líquida"] },
  { id: "credit_portfolio", name: "Credit portfolio", name_pt: "Carteira de crédito", kind: "monetary", aliases: ["carteira"] },
  { id: "employee_headcount", name: "Employee headcount", name_pt: "Quantidade de empregados", kind: "count", aliases: ["empregados"] },
];

const BB = "Banco do Brasil S.A.";

type Linha = Record<string, unknown>;

function fato(sobre: Linha = {}): Linha {
  const base: Linha = {
    valor: 16782.0,
    unidade: "currency",
    moeda: null,
    escala: 1_000_000,
    periodo: "2025-FY",
    fim: "2025-12-31",
    tipo_periodo: "fiscal_year",
    entidade: BB,
    qualificador: "nenhum",
    dimensao: null,
    rotulo: "Lucro líquido",
    pagina: 93,
    ...sobre,
  };
  base["pagina_fim"] = sobre["pagina_fim"] ?? base["pagina"];
  base["id"] = sobre["id"] ?? `fact:${String(base["valor"])}-${String(base["escala"])}-${String(base["pagina"])}-${String(base["periodo"])}`;
  return base;
}

class GrafoFalso implements GrafoLeitura {
  respostas: Record<string, Linha[]>;
  chamadas: { nome: string; params: Record<string, unknown>; cypher: string }[] = [];
  falha: Error | undefined;

  constructor(respostas: Record<string, Linha[]> = {}) {
    this.respostas = {
      emissor: [{ emissor: BB, ano_base: 2025 }],
      entidades_dos_fatos: [
        { entidade: BB, n: 1106 },
        { entidade: "BB Consórcios", n: 10 },
        { entidade: "Banco Votorantim S.A.", n: 9 },
      ],
      ...respostas,
    };
  }

  async consultar(cypher: string, params: Record<string, unknown> = {}): Promise<Linha[]> {
    if (this.falha) throw this.falha;
    const nome = Object.entries(CONSULTAS).find(([, c]) => c === cypher)?.[0];
    if (!nome) throw new Error(`consulta fora de CONSULTAS: ${cypher}`);
    this.chamadas.push({ nome, params, cypher });
    return (this.respostas[nome] ?? []).map((r) => ({ ...r }));
  }

  nomes(): string[] {
    return this.chamadas.map((c) => c.nome);
  }

  params(nome: string): Record<string, unknown> {
    const c = this.chamadas.find((x) => x.nome === nome);
    if (!c) throw new Error(`consulta ${nome} não foi feita (${this.nomes().join(", ")})`);
    return c.params;
  }
}

// ---------- 1-4: segurança e envelope comum ----------

describe("segurança e envelope comum", () => {
  it.each(Object.keys(CONSULTAS).sort())("a consulta %s é somente leitura e limitada", (nome) => {
    const c = CONSULTAS[nome as keyof typeof CONSULTAS].toUpperCase();
    for (const proibido of ["CREATE ", "MERGE ", "DELETE ", " SET ", "REMOVE ", "DROP ", "LOAD CSV", "CALL APOC"]) {
      expect(c, `${nome}: ${proibido}`).not.toContain(proibido);
    }
    expect(c, nome).toContain("LIMIT");
  });

  it("o texto do usuário vai como parâmetro, nunca na consulta", async () => {
    const perigoso = "x'}) DETACH DELETE n //";
    const g = new GrafoFalso({ riscos: [], eventos: [], pessoas: [] });
    await riscos(g, { tema: perigoso });
    await eventos(g, { tema: perigoso });
    await pessoasCargos(g, { cargo: perigoso });
    expect(g.chamadas).toHaveLength(3);
    for (const { params, cypher } of g.chamadas) {
      expect(cypher).not.toContain("DETACH");
      expect(cypher).not.toContain(perigoso);
      for (const v of Object.values(params)) {
        expect(["string", "number", "boolean", "object"]).toContain(typeof v);
      }
    }
  });

  it.each([
    ["fato_financeiro", (g: GrafoLeitura) => fatoFinanceiro(g, { metrica: "lucro", periodo: "2025", catalogo: CAT })],
    ["serie_metrica", (g: GrafoLeitura) => serieMetrica(g, { metrica: "lucro", catalogo: CAT })],
    ["comparar_segmentos", (g: GrafoLeitura) => compararSegmentos(g, { metrica: "carteira de crédito", catalogo: CAT })],
    ["riscos", (g: GrafoLeitura) => riscos(g, {})],
    ["eventos", (g: GrafoLeitura) => eventos(g, {})],
    ["pessoas_cargos", (g: GrafoLeitura) => pessoasCargos(g, { cargo: "presidente" })],
  ])("%s: a falha do driver vira erro no resultado e não exceção", async (_nome, chamada) => {
    const g = new GrafoFalso();
    g.falha = new Error("Neo4j fora do ar");
    const r = await chamada(g);
    expect(r.erro).toContain("Neo4j fora do ar");
    expect(r.evidencias).toEqual([]);
  });

  it("nada encontrado volta vazio com aviso", async () => {
    const r = await fatoFinanceiro(new GrafoFalso({ fatos: [] }), { metrica: "lucro", periodo: "2019", catalogo: CAT });
    expect(r.evidencias).toEqual([]);
    expect(r.fatos).toEqual([]);
    expect(r.erro).toBeNull();
    expect(r.aviso).toBeTruthy();
  });

  it("o envelope sempre traz as chaves do Python, com null onde lá era None", async () => {
    const r = await fatoFinanceiro(new GrafoFalso({ fatos: [fato()] }), { metrica: "lucro", periodo: "2025", catalogo: CAT });
    for (const k of ["ferramenta", "parametros", "evidencias", "aviso", "erro", "sugestoes", "omitido", "latencia_ms", "fatos", "periodo_assumido", "conflito"]) {
      expect(Object.keys(r), k).toContain(k);
    }
    expect(JSON.parse(JSON.stringify(r)).aviso).toBeNull();
    expect(JSON.parse(JSON.stringify(r)).erro).toBeNull();
    expect(typeof r.latencia_ms).toBe("number");
    const f = JSON.parse(JSON.stringify(r)).fatos[0];
    expect(f.moeda).toBeNull();
    expect(f.dimensao).toBeNull();
    expect(f.qualificador).toBe("nenhum");
  });
});

// ---------- 5-12: fato_financeiro ----------

describe("fato_financeiro", () => {
  it("métrica desconhecida não chama o grafo e sugere", async () => {
    const g = new GrafoFalso();
    const r = await fatoFinanceiro(g, { metrica: "índice de felicidade", catalogo: CAT });
    expect(r.erro).toBe("metrica_desconhecida");
    expect(r.evidencias).toEqual([]);
    expect(g.chamadas).toEqual([]);
    const r2 = await fatoFinanceiro(g, { metrica: "lucro bruto", catalogo: CAT });
    expect(r2.sugestoes).toContain("Net income");
  });

  it.each([
    ["lucro", "net_income"],
    ["Lucro Líquido", "net_income"],
    ["profit", "net_income"],
    ["o lucro líquido do exercício de 2025", "net_income"],
    ["receita liquida de juros", "net_interest_income"],
    ["Carteira", "credit_portfolio"],
  ])("resolverMetrica(%j) usa o catálogo com sinônimos", (texto, esperado) => {
    expect(resolverMetrica(texto, CAT)[0]?.id).toBe(esperado);
  });

  it("resolverMetrica prefere o termo mais longo e texto vazio não adivinha", () => {
    expect(resolverMetrica("receita líquida de juros", CAT)[0]?.id).toBe("net_interest_income");
    expect(resolverMetrica("", CAT)[0]).toBeNull();
    expect(resolverMetrica(null, CAT)[0]).toBeNull();
  });

  it.each([
    ["2025", "2025-FY"],
    ["FY2025", "2025-FY"],
    ["exercício de 2025", "2025-FY"],
    ["2025-FY", "2025-FY"],
    ["4T25", "2025-Q4"],
    ["4T2025", "2025-Q4"],
    ["4º trimestre de 2025", "2025-Q4"],
    ["Q4 2025", "2025-Q4"],
    ["2025-Q4", "2025-Q4"],
    ["31/12/2025", "2025-12-31"],
    ["2025-12-31", "2025-12-31"],
    ["31 de dezembro de 2025", "2025-12-31"],
    ["29/02/2024", "2024-02-29"],
    ["  1T 24 ", "2024-Q1"],
  ])("normalizarPeriodo(%j) = %s", (texto, esperado) => {
    expect(normalizarPeriodo(texto)).toBe(esperado);
  });

  it.each(["ontem", "5T25", "13/13/2025", "99", "", "29/02/2025", "31/04/2025", "0/1/2025"])(
    "normalizarPeriodo(%j) levanta erro",
    (texto) => {
      expect(() => normalizarPeriodo(texto)).toThrow();
    },
  );

  it("período inválido vira erro sem consultar fatos", async () => {
    const g = new GrafoFalso();
    const r = await fatoFinanceiro(g, { metrica: "lucro", periodo: "ontem", catalogo: CAT });
    expect(r.erro).toBe("periodo_invalido");
    expect(g.nomes()).not.toContain("fatos");
  });

  it("a consulta leva métrica, período, entidade e unidade certos", async () => {
    const g = new GrafoFalso({ fatos: [fato()] });
    await fatoFinanceiro(g, { metrica: "lucro", periodo: "2025", catalogo: CAT });
    const p = g.params("fatos");
    expect(p["metrica"]).toBe("metric:net_income");
    expect(p["periodos"]).toEqual(["2025-FY"]);
    expect(p["entidades"]).toEqual([BB]);
    expect(p["qualificador"]).toBe("nenhum");
    expect(p["unidade"]).toBe("currency");
    expect(p["modo"]).toBe("total");
    expect(p["tipo_periodo"]).toBeNull();
    expect(p["limite"] as number).toBeGreaterThan(0);
  });

  it("a unidade vem do tipo da métrica", async () => {
    const g = new GrafoFalso({ fatos: [] });
    await fatoFinanceiro(g, { metrica: "empregados", periodo: "2025", catalogo: CAT });
    expect(g.params("fatos")["unidade"]).toBe("count");
  });

  it("sem período usa o mais recente até o ano-base e avisa", async () => {
    const g = new GrafoFalso({
      fatos: [
        fato({ valor: 999.0, periodo: "2026-FY", fim: "2026-12-31", pagina: 7 }), // projeção, depois do ano-base
        fato({}),
        fato({ valor: 12000.0, periodo: "2024-FY", fim: "2024-12-31" }),
      ],
    });
    const r = await fatoFinanceiro(g, { metrica: "lucro", catalogo: CAT });
    expect(r.periodo_assumido).toBe(true);
    expect(r.fatos.map((f) => f.periodo)).toEqual(["2025-FY"]);
    expect(r.parametros["periodo"]).toBe("2025-FY");
  });

  it("com período informado o ano-base não corta", async () => {
    const g = new GrafoFalso({ fatos: [fato({ valor: 999.0, periodo: "2026-FY", fim: "2026-12-31" })] });
    const r = await fatoFinanceiro(g, { metrica: "lucro", periodo: "2026", catalogo: CAT });
    expect(r.fatos.map((f) => f.periodo)).toEqual(["2026-FY"]);
    expect(r.periodo_assumido).toBe(false);
  });

  it("o contrato vale mesmo que o grafo devolva outro período", async () => {
    const g = new GrafoFalso({ fatos: [fato({}), fato({ valor: 1.0, periodo: "2024-FY", fim: "2024-12-31" })] });
    const r = await fatoFinanceiro(g, { metrica: "lucro", periodo: "2025", catalogo: CAT });
    expect(r.fatos.map((f) => f.periodo)).toEqual(["2025-FY"]);
  });

  it("entidade casa sem caixa nem acento e vai ao grafo com o nome exato", async () => {
    const g = new GrafoFalso({ fatos: [fato({ entidade: "BB Consórcios" })] });
    await fatoFinanceiro(g, { metrica: "lucro", entidade: "bb consorcios", periodo: "2025", catalogo: CAT });
    expect(g.params("fatos")["entidades"]).toEqual(["BB Consórcios"]);
  });

  it("entidade desconhecida é erro com sugestões e não cai no emissor", async () => {
    const g = new GrafoFalso();
    const r = await fatoFinanceiro(g, { metrica: "lucro", entidade: "BB Consorcios Imaginária", catalogo: CAT });
    expect(r.erro).toBe("entidade_desconhecida");
    expect(r.sugestoes).toContain("BB Consórcios");
    expect(g.nomes()).not.toContain("fatos");
  });

  it("resolverEntidade: exata, depois contida e única; ambígua não adivinha", () => {
    const conhecidas = [BB, "BB Consórcios", "BB Seguridade", "BB Seguros Participações"];
    expect(resolverEntidade("banco do brasil", conhecidas, BB)[0]).toBe(BB);
    expect(resolverEntidade(null, conhecidas, BB)[0]).toBe(BB);
    expect(resolverEntidade("  ", conhecidas, BB)[0]).toBe(BB);
    expect(resolverEntidade("BB", conhecidas, BB)[0]).toBeNull();
    expect(resolverEntidade("BB Seguridade", conhecidas, BB)[0]).toBe("BB Seguridade");
    expect(resolverEntidade("seguros", conhecidas, BB)[0]).toBe("BB Seguros Participações");
  });

  it.each([
    [16782.0, "currency", 1_000_000, null, "R$ 16.782 milhões"],
    [16.8, "currency", 1_000_000_000, "BRL", "R$ 16,8 bilhões"],
    [1.76, "currency", 1_000_000_000, "BRL", "R$ 1,76 bilhão"],
    [5500008083.77, "currency", 1, "BRL", "R$ 5.500.008.083,77"],
    [35.0, "currency", 1000, null, "R$ 35 mil"],
    [23.9, "percent", 1, null, "23,9%"],
    [130.0, "count", 1, null, "130"],
    [85.2, "count", 1000, null, "85,2 mil"],
    [31.75, "currency", 1, "BRL", "R$ 31,75"],
    [-1250.5, "currency", 1_000_000, null, "R$ -1.250,5 milhões"], // o sinal vem depois do R$, como no Python
    [1234.0, "currency", 1_000_000, "USD", "USD 1.234 milhões"],
    [0.0, "currency", 1, null, "R$ 0"],
    [1500.0, "percent", 1, null, "1.500%"],
  ])("formatarValor(%f, %s, %s, %s) = %s", (valor, unidade, escala, moeda, esperado) => {
    expect(formatarValor(valor, unidade, escala, moeda)).toBe(esperado);
  });

  it("o valor absoluto aplica a escala e a evidência cita a página", async () => {
    const g = new GrafoFalso({ fatos: [fato()] });
    const r = await fatoFinanceiro(g, { metrica: "lucro", periodo: "2025", catalogo: CAT });
    const f = r.fatos[0]!;
    expect(f.valor_absoluto).toBe(16_782_000_000.0);
    expect(f.texto_valor).toBe("R$ 16.782 milhões");
    const ev = r.evidencias[0]!;
    expect(ev.tipo).toBe("fato");
    expect(ev.paginas).toBe("p. 93");
    expect(ev.texto).toContain("16.782 milhões");
    expect(ev.id.startsWith("fact:")).toBe(true);
    expect(ev.score).toBe(1.0);
  });

  it("o mesmo valor em duas escalas e duas páginas vira um fato com as duas páginas", () => {
    const out = consolidarFatos([
      fato({ valor: 16.8, escala: 1_000_000_000, pagina: 22 }),
      fato({ valor: 16782.0, pagina: 93 }),
      fato({ valor: 16782.0, pagina: 80 }),
    ] as never);
    expect(out).toHaveLength(1);
    expect(out[0]?.escala).toBe(1_000_000); // fica a escala mais fina
    expect(out[0]?.paginas).toEqual([22, 80, 93]);
    expect(out[0]?.conflito).toBe(false);
  });

  it("valores que divergem de verdade ficam separados e marcam conflito", () => {
    const out = consolidarFatos([fato({ valor: 1229907.0, pagina: 84 }), fato({ valor: 175442.0, pagina: 94 })] as never);
    expect(out).toHaveLength(2);
    expect(out.every((f) => f.conflito)).toBe(true);
  });

  it("o conflito só vale dentro do mesmo período e recorte", () => {
    const out = consolidarFatos([fato({}), fato({ valor: 12000.0, periodo: "2024-FY", fim: "2024-12-31" })] as never);
    expect(out).toHaveLength(2);
    expect(out.some((f) => f.conflito)).toBe(false);
  });

  it("escala nula conta como 1", () => {
    const out = consolidarFatos([fato({ valor: 5.5, escala: null })] as never);
    expect(out[0]?.escala).toBe(1);
    expect(out[0]?.valor_absoluto).toBe(5.5);
  });

  it("só recortes sem total não inventa total", async () => {
    const r = await fatoFinanceiro(new GrafoFalso({ fatos: [] }), { metrica: "carteira de crédito", periodo: "2025", catalogo: CAT });
    expect(r.fatos).toEqual([]);
    expect(r.aviso ?? "").toContain("recorte");
  });

  it("a dimensão pedida muda o modo e casa o recorte", async () => {
    const g = new GrafoFalso({
      fatos: [fato({ valor: 373579.0, dimensao: "Rurais", pagina: 84 }), fato({ valor: 61834.0, dimensao: "Imobiliário" })],
    });
    const r = await fatoFinanceiro(g, { metrica: "carteira de crédito", periodo: "2025", dimensao: "imobiliario", catalogo: CAT });
    expect(g.params("fatos")["modo"]).toBe("recortes");
    expect(r.fatos.map((f) => f.dimensao)).toEqual(["Imobiliário"]);
  });

  it("qualificador inválido é erro", async () => {
    const r = await fatoFinanceiro(new GrafoFalso(), { metrica: "lucro", qualificador: "dobro", catalogo: CAT });
    expect(r.erro).toBe("qualificador_invalido");
  });

  it("o limite corta e conta o que sobrou", async () => {
    const g = new GrafoFalso({ fatos: [fato({ valor: 1.0, pagina: 1 }), fato({ valor: 500.0, pagina: 2 }), fato({ valor: 9000.0, pagina: 3 })] });
    const r = await fatoFinanceiro(g, { metrica: "lucro", periodo: "2025", limite: 2, catalogo: CAT });
    expect(r.fatos).toHaveLength(2);
    expect(r.omitido["fatos"]).toBe(1);
    expect(r.conflito).toBe(true);
    expect(r.aviso).toContain("valores diferentes");
  });
});

// ---------- 13-14: serie_metrica ----------

describe("serie_metrica", () => {
  it("em ordem cronológica, sem preencher lacunas e sem variação através da lacuna", async () => {
    const g = new GrafoFalso({
      fatos: [
        fato({ valor: 1229907.0, periodo: "2025-FY", fim: "2025-12-31" }),
        fato({ valor: 964043.0, periodo: "2023-FY", fim: "2023-12-31" }), // 2024 não existe
      ],
    });
    const r = await serieMetrica(g, { metrica: "carteira de crédito", catalogo: CAT });
    expect(r.pontos.map((p) => p.periodo)).toEqual(["2023-FY", "2025-FY"]);
    expect(r.periodos_ausentes).toEqual(["2024-FY"]);
    expect(r.aviso).toContain("2024-FY");
    expect(r.pontos.map((p) => p.variacao_pct)).toEqual([null, null]);
    expect(r.evidencias).toHaveLength(2);
  });

  it("calcula a variação entre anos vizinhos", async () => {
    const g = new GrafoFalso({
      fatos: [
        fato({ valor: 1229907.0, periodo: "2025-FY", fim: "2025-12-31" }),
        fato({ valor: 1099725.0, periodo: "2024-FY", fim: "2024-12-31" }),
      ],
    });
    const r = await serieMetrica(g, { metrica: "carteira de crédito", catalogo: CAT });
    expect(r.pontos[1]?.variacao_pct).toBeCloseTo(11.8, 1);
    expect(r.periodos_ausentes).toEqual([]);
  });

  it("trimestres vizinhos entre anos (4T24 e 1T25) também têm variação, e a lacuna usa ids de trimestre", async () => {
    const g = new GrafoFalso({
      fatos: [
        fato({ valor: 110.0, periodo: "2025-Q1", fim: "2025-03-31", tipo_periodo: "quarter" }),
        fato({ valor: 100.0, periodo: "2024-Q4", fim: "2024-12-31", tipo_periodo: "quarter" }),
        fato({ valor: 90.0, periodo: "2024-Q2", fim: "2024-06-30", tipo_periodo: "quarter" }),
      ],
    });
    const r = await serieMetrica(g, { metrica: "lucro", tipoPeriodo: "quarter", catalogo: CAT });
    expect(r.pontos.map((p) => p.periodo)).toEqual(["2024-Q2", "2024-Q4", "2025-Q1"]);
    expect(r.pontos[2]?.variacao_pct).toBe(10);
    expect(r.pontos[1]?.variacao_pct).toBeNull();
    expect(r.periodos_ausentes).toEqual(["2024-Q3"]);
  });

  it("não mistura trimestre com ano por padrão", async () => {
    const g = new GrafoFalso({ fatos: [] });
    await serieMetrica(g, { metrica: "lucro", catalogo: CAT });
    expect(g.params("fatos")["tipo_periodo"]).toBe("fiscal_year");
    const g2 = new GrafoFalso({ fatos: [] });
    await serieMetrica(g2, { metrica: "lucro", tipoPeriodo: "quarter", catalogo: CAT });
    expect(g2.params("fatos")["tipo_periodo"]).toBe("quarter");
    expect((await serieMetrica(g2, { metrica: "lucro", tipoPeriodo: "semana", catalogo: CAT })).erro).toBe("tipo_periodo_invalido");
    const g3 = new GrafoFalso({ fatos: [] });
    await serieMetrica(g3, { metrica: "lucro", tipoPeriodo: null, catalogo: CAT });
    expect(g3.params("fatos")["tipo_periodo"]).toBeNull();
  });

  it("com conflito no período escolhe o mais sustentado e lista as alternativas", async () => {
    const g = new GrafoFalso({
      fatos: [fato({ valor: 1229907.0, pagina: 84 }), fato({ valor: 1229907.0, pagina: 83 }), fato({ valor: 175442.0, pagina: 94 })],
    });
    const p = (await serieMetrica(g, { metrica: "carteira de crédito", catalogo: CAT })).pontos[0]!;
    expect(p.valor).toBe(1229907.0);
    expect(p.conflito).toBe(true);
    expect(p.alternativas.map((a) => a.valor)).toEqual([175442.0]);
  });

  it("não calcula variação de valor conflitante nem de base zero", async () => {
    const g = new GrafoFalso({
      fatos: [fato({ valor: 0.0, periodo: "2023-FY", fim: "2023-12-31" }), fato({ valor: 5.0, periodo: "2024-FY", fim: "2024-12-31" })],
    });
    const pts = (await serieMetrica(g, { metrica: "lucro", catalogo: CAT })).pontos;
    expect(pts[1]?.variacao_pct).toBeNull();
  });

  it("o limite fica com os períodos mais recentes e conta o resto", async () => {
    const fatos = [2021, 2022, 2023, 2024, 2025].map((a) => fato({ valor: a, periodo: `${a}-FY`, fim: `${a}-12-31` }));
    const r = await serieMetrica(new GrafoFalso({ fatos }), { metrica: "lucro", limite: 3, catalogo: CAT });
    expect(r.pontos.map((p) => p.periodo)).toEqual(["2023-FY", "2024-FY", "2025-FY"]);
    expect(r.omitido["pontos"]).toBe(2);
  });
});

// ---------- 15-16: comparar_segmentos ----------

describe("comparar_segmentos", () => {
  const LINHAS_SEG = [
    fato({ valor: 373579.0, dimensao: "Rurais", pagina: 84 }),
    fato({ valor: 61834.0, dimensao: "Imobiliário", pagina: 84 }),
    fato({ valor: 198693.0, dimensao: "Financiamentos", pagina: 84 }),
    fato({ valor: 100.0, dimensao: "Pessoas Físicas" }),
    fato({ valor: 388276.0, dimensao: "Rurais", pagina: 84 }), // outro valor para o mesmo recorte: conflito
  ];

  it("casa segmentos sem caixa e acento e ordena do maior ao menor", async () => {
    const g = new GrafoFalso({ fatos: LINHAS_SEG });
    const r = await compararSegmentos(g, {
      metrica: "carteira de crédito",
      segmentos: ["imobiliario", "pessoas fisicas", "financiamentos"],
      periodo: "2025",
      catalogo: CAT,
    });
    expect(r.segmentos.map((s) => s.segmento)).toEqual(["Financiamentos", "Imobiliário", "Pessoas Físicas"]);
    expect(g.params("fatos")["modo"]).toBe("recortes");
  });

  it("o segmento pedido que não existe é listado e não some", async () => {
    const g = new GrafoFalso({ fatos: LINHAS_SEG });
    const r = await compararSegmentos(g, { metrica: "carteira de crédito", segmentos: ["Rurais", "Aeroespacial"], periodo: "2025", catalogo: CAT });
    expect(r.nao_encontrados).toEqual(["Aeroespacial"]);
    expect(r.aviso).toBeTruthy();
    expect(r.segmentos.map((s) => s.segmento)).toEqual(["Rurais"]);
    expect(r.segmentos[0]?.conflito).toBe(true); // 373.579 e 388.276 no mesmo recorte
  });

  it("pedir o mesmo segmento duas vezes devolve uma linha só", async () => {
    const g = new GrafoFalso({ fatos: LINHAS_SEG });
    const r = await compararSegmentos(g, { metrica: "carteira de crédito", segmentos: ["rurais", "Rurais"], periodo: "2025", catalogo: CAT });
    expect(r.segmentos).toHaveLength(1);
    expect(r.nao_encontrados).toEqual([]);
  });

  it("sem lista devolve os maiores recortes com teto e conta o resto", async () => {
    const g = new GrafoFalso({ fatos: Array.from({ length: 30 }, (_, i) => fato({ valor: i + 1.0, dimensao: `Recorte ${i + 1}` })) });
    const r = await compararSegmentos(g, { metrica: "carteira de crédito", periodo: "2025", limite: 5, catalogo: CAT });
    expect(r.segmentos.map((s) => s.valor)).toEqual([30, 29, 28, 27, 26]);
    expect(r.omitido["segmentos"]).toBe(25);
  });

  it("sem período usa o mais recente que tem recortes", async () => {
    const g = new GrafoFalso({
      fatos: [
        fato({ valor: 1.0, dimensao: "A", periodo: "2024-FY", fim: "2024-12-31" }),
        fato({ valor: 2.0, dimensao: "A", periodo: "2026-FY", fim: "2026-12-31" }), // depois do ano-base
      ],
    });
    const r = await compararSegmentos(g, { metrica: "carteira de crédito", catalogo: CAT });
    expect(r.periodo).toBe("2024-FY");
    expect(r.periodo_assumido).toBe(true);
  });

  it("sem nenhum recorte volta vazio com aviso e período nulo", async () => {
    const r = await compararSegmentos(new GrafoFalso({ fatos: [] }), { metrica: "carteira de crédito", periodo: "2025", catalogo: CAT });
    expect(r.segmentos).toEqual([]);
    expect(r.periodo).toBeNull();
    expect(r.aviso).toContain("Nenhum recorte");
  });
});

// ---------- 17: riscos ----------

const RISCOS: Linha[] = [
  { id: "r1", nome: "Risco de crédito da carteira rural", categoria: "credit", resumo: "Inadimplência no agro.", camadas: ["dirigida"], ini: [100, 101], fim: [100, 101], apelidos: null },
  { id: "r2", nome: "Vulnerabilidade da economia brasileira", categoria: "market", resumo: "Eventos externos.", camadas: ["dirigida"], ini: [60], fim: [61], apelidos: null },
  { id: "r3", nome: "perdas financeiras", categoria: null, resumo: "Decisões contrárias ao Banco.", camadas: ["aberta"], ini: [], fim: [], apelidos: null },
];

describe("riscos", () => {
  it("filtra por tema com acento e ordena por relevância", async () => {
    const r = await riscos(new GrafoFalso({ riscos: RISCOS }), { tema: "inadimplencia agro" });
    expect(r.evidencias.map((e) => e.id)).toEqual(["r1"]);
    expect(r.evidencias[0]?.paginas).toBe("p. 100-101");
    expect(r.evidencias[0]?.tipo).toBe("risco");
  });

  it("tema sem resultado volta vazio e não qualquer risco", async () => {
    const r = await riscos(new GrafoFalso({ riscos: RISCOS }), { tema: "criptomoedas" });
    expect(r.evidencias).toEqual([]);
    expect(r.aviso).toBeTruthy();
  });

  it("categoria válida vai ao grafo e inválida é erro", async () => {
    const g = new GrafoFalso({ riscos: RISCOS });
    await riscos(g, { categoria: "credit" });
    expect(g.params("riscos")["categoria"]).toBe("credit");
    expect((await riscos(g, { categoria: "astrologico" })).erro).toBe("categoria_invalida");
    const g2 = new GrafoFalso({ riscos: RISCOS });
    await riscos(g2, { categoria: "sem_categoria" });
    expect(g2.params("riscos")["sem_categoria"]).toBe(true);
    expect(g2.params("riscos")["categoria"]).toBeNull();
  });

  it("sem tema prioriza a extração dirigida e quem tem página, e respeita o limite", async () => {
    const r = await riscos(new GrafoFalso({ riscos: RISCOS }), { limite: 2 });
    expect(r.evidencias.map((e) => e.id)).toEqual(["r1", "r2"]);
    expect(r.omitido["riscos"]).toBe(1);
  });

  it("a ordem sem tema desempata por nome e põe 'sem página' depois", async () => {
    const mais: Linha[] = [
      { id: "a", nome: "Beta", categoria: "credit", resumo: "", camadas: ["aberta"], ini: [3], fim: [3], apelidos: null },
      { id: "b", nome: "Alfa", categoria: "credit", resumo: "", camadas: ["aberta"], ini: [], fim: [], apelidos: null },
      { id: "c", nome: "Gama", categoria: "credit", resumo: "", camadas: ["aberta"], ini: [4], fim: [4], apelidos: null },
    ];
    const r = await riscos(new GrafoFalso({ riscos: mais }), {});
    expect(r.evidencias.map((e) => e.id)).toEqual(["a", "c", "b"]);
  });
});

// ---------- 18: eventos ----------

const EVENTOS: Linha[] = [
  { id: "e1", nome: "BB-BI passou a atuar com quadro próprio", data: "2023-08", tipo: "acquisition", resumo: "Autonomia do BB-BI.", paginas: [30], envolvidos: ["BB-Banco de Investimentos"] },
  { id: "e2", nome: "Publicação da Resolução BCB 512", data: "2025-10-10", tipo: null, resumo: "Compulsório.", paginas: [55, 56], envolvidos: ["Banco Central do Brasil"] },
  { id: "e3", nome: "revisão dos Compromissos BB 2030", data: null, tipo: null, resumo: "Revisão.", paginas: [12], envolvidos: [] },
];

describe("eventos", () => {
  it("com ano filtra pela data e conta os sem data", async () => {
    const r = await eventos(new GrafoFalso({ eventos: EVENTOS }), { ano: 2025 });
    expect(r.evidencias.map((e) => e.id)).toEqual(["e2"]);
    expect(r.omitido["sem_data"]).toBe(1);
    expect(r.aviso).toBeTruthy();
  });

  it("sem filtro ordena datados do mais recente e depois os sem data", async () => {
    const r = await eventos(new GrafoFalso({ eventos: EVENTOS }), {});
    expect(r.evidencias.map((e) => e.id)).toEqual(["e2", "e1", "e3"]);
    expect(r.evidencias[0]?.paginas).toBe("p. 55-56");
    expect(r.evidencias[0]?.texto).toContain("2025-10-10");
  });

  it("tema e ano inválido", async () => {
    const r = await eventos(new GrafoFalso({ eventos: EVENTOS }), { tema: "resolução compulsório" });
    expect(r.evidencias.map((e) => e.id)).toEqual(["e2"]);
    expect((await eventos(new GrafoFalso({ eventos: EVENTOS }), { ano: 1800 })).erro).toBe("ano_invalido");
  });

  it("a ordem de datas desempata pelo nome; a data mais curta vem antes da mais específica (quirk do Python, preservado pela paridade)", async () => {
    const mesmos: Linha[] = [
      { id: "x1", nome: "B", data: "2024", tipo: null, resumo: null, paginas: [], envolvidos: [] },
      { id: "x2", nome: "A", data: "2024", tipo: null, resumo: null, paginas: [], envolvidos: [] },
      { id: "x3", nome: "C", data: "2024-05", tipo: null, resumo: null, paginas: [], envolvidos: [] },
    ];
    const r = await eventos(new GrafoFalso({ eventos: mesmos }), {});
    expect(r.evidencias.map((e) => e.id)).toEqual(["x2", "x1", "x3"]);
  });
});

// ---------- 19-20: pessoas_cargos ----------

const PESSOAS: Linha[] = [
  { id: "p1", nome: "Tarciana Paula Gomes Medeiros", cargo_no_no: null, cargo: "Presidente", orgao: BB, paginas: [270, 271], resumo: null },
  { id: "p2", nome: "Diretoria Executiva", cargo_no_no: null, cargo: "Diretor Presidente do Banco", orgao: BB, paginas: [], resumo: null },
  { id: "p3", nome: "Euler Antonio Luz Mathias", cargo_no_no: null, cargo: "Diretor de Finanças", orgao: BB, paginas: [272], resumo: null },
];

describe("pessoas_cargos", () => {
  it("casa o cargo com flexão de gênero", async () => {
    const r = await pessoasCargos(new GrafoFalso({ pessoas: PESSOAS }), { cargo: "diretora presidente" });
    expect(r.evidencias.map((e) => e.id)).toEqual(["p2"]);
  });

  it("por cargo simples traz a pessoa com nome de gente primeiro", async () => {
    const r = await pessoasCargos(new GrafoFalso({ pessoas: PESSOAS }), { cargo: "presidente" });
    expect(r.evidencias.map((e) => e.id)).toEqual(["p1", "p2"]);
    expect(r.pessoas[0]?.nome_parece_cargo).toBe(false);
    expect(r.pessoas[1]?.nome_parece_cargo).toBe(true);
    expect(r.evidencias[1]?.texto.toLowerCase()).toContain("cargo");
  });

  it("sem nenhum filtro é erro e não lista todo mundo", async () => {
    const g = new GrafoFalso({ pessoas: PESSOAS });
    const r = await pessoasCargos(g, {});
    expect(r.erro).toBe("filtro_obrigatorio");
    expect(g.chamadas).toEqual([]);
    expect((await pessoasCargos(g, { cargo: "  ", nome: "" })).erro).toBe("filtro_obrigatorio");
  });

  it("por nome e por órgão", async () => {
    const g = new GrafoFalso({ pessoas: PESSOAS });
    expect((await pessoasCargos(g, { nome: "euler mathias" })).evidencias.map((e) => e.id)).toEqual(["p3"]);
    expect((await pessoasCargos(g, { orgao: "banco do brasil" })).evidencias).toHaveLength(3);
  });

  it("a mesma pessoa e o mesmo cargo em duas linhas une as páginas", async () => {
    const dup = [{ ...PESSOAS[0]! }, { ...PESSOAS[0]!, paginas: [300] }];
    const r = await pessoasCargos(new GrafoFalso({ pessoas: dup }), { cargo: "presidente" });
    expect(r.evidencias).toHaveLength(1);
    expect(r.evidencias[0]?.paginas).toBe("p. 270-271, 300");
  });

  it("o cargo não junta palavras de títulos diferentes", async () => {
    const p: Linha = { id: "p9", nome: "Felipe Prince", cargo_no_no: "Diretor Executivo; Vice-presidente de Riscos", cargo: "Diretor Executivo", orgao: BB, paginas: [303], resumo: null };
    const r = await pessoasCargos(new GrafoFalso({ pessoas: [p] }), { cargo: "diretor presidente" });
    expect(r.evidencias).toEqual([]); // "diretor" vem de um título e "presidente" de outro
  });

  it("cargo só no resumo entra depois dos títulos e diz a fonte", async () => {
    const tarciana: Linha = {
      id: "p8", nome: "Tarciana Medeiros", cargo_no_no: "Membro do Conselho", cargo: "Membro do Conselho", orgao: "Brasilprev", paginas: [315],
      resumo: "Tarciana Medeiros atua como Diretora Presidente, responsável pelo conteúdo do formulário.",
    };
    const cargoComoNome: Linha = {
      id: "p7", nome: "Presidente do Banco", cargo_no_no: null, cargo: null, orgao: null, paginas: [],
      resumo: "Cargo de Diretor Presidente indicado pelo governo.",
    };
    const r = await pessoasCargos(new GrafoFalso({ pessoas: [...PESSOAS, tarciana, cargoComoNome] }), { cargo: "diretora presidente" });
    expect(r.evidencias.map((e) => e.id)).toEqual(["p2", "p8"]); // o nó que é cargo não entra pelo resumo
    expect(r.pessoas.map((p) => p.fonte)).toEqual(["cargo", "resumo"]);
    expect(r.evidencias[1]?.texto).toContain("Diretora Presidente");
  });

  it.each(["A Presidente do BB", "Diretores", "Diretoria Executiva", "Presidente do Banco"])(
    "o nome %j, com artigo ou plural de cargo, também é marcado",
    async (nome) => {
      const p: Linha = { id: "x", nome, cargo_no_no: null, cargo: "Presidente", orgao: null, paginas: [], resumo: null };
      const r = await pessoasCargos(new GrafoFalso({ pessoas: [p] }), { cargo: "presidente" });
      expect(r.pessoas[0]?.nome_parece_cargo).toBe(true);
    },
  );

  it("a mesma pessoa com dois cargos tem ids de evidência distintos", async () => {
    const duas: Linha[] = [
      { ...PESSOAS[2]!, cargo: "Diretor de Finanças", paginas: [272] },
      { ...PESSOAS[2]!, cargo: "Diretor de Riscos", paginas: [273] },
    ];
    const r = await pessoasCargos(new GrafoFalso({ pessoas: duas }), { nome: "euler" });
    expect(r.evidencias.map((e) => e.id)).toEqual(["p3", "p3#2"]);
  });
});
