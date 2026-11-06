/**
 * Busca global map-reduce em TypeScript (F7.10, porte de `busca_global.py` e `test_busca_global.py`, F6.2; ferramenta
 * `panorama`, §7.2).
 *
 * Formas de falhar, escritas antes do código:
 *  1. a escolha das comunidades ignora o nível ou o limiar de rating, ou deixa passar mais que o teto;
 *  2. nenhuma comunidade passa nos filtros e o código chama o LLM mesmo assim;
 *  3. o lote estoura o contexto (relatório gigante) ou deixa uma comunidade de fora / repete uma em dois lotes;
 *  4. o mapa devolve nota fora de 0 a 10, etiqueta que não existe ou texto vazio, e isso entra no contexto;
 *  5. a resposta do mapa não é o objeto esperado e o lote some sem aviso (ou derruba a busca);
 *  6. um lote que falha derruba os outros; todos falharem passa por "nada encontrado";
 *  7. o mesmo ponto vem de duas comunidades e aparece duas vezes; a ordem muda entre execuções;
 *  8. o orçamento de tempo estoura e a busca continua chamando o LLM (o aceite é ≤ 60 s);
 *  9. o progresso não chega, chega fora de ordem, ou um callback que falha derruba a busca;
 * 10. o reduce falha e a busca inteira falha junto, em vez de devolver os pontos;
 * 11. a pergunta vazia chama o grafo e o LLM;
 * 12. o paralelismo muda o resultado, ou passa do número de vagas do servidor;
 * 13. o vetor da pergunta não vem de `embeddingDeConsulta` (o prefixo `Instruct:` do Qwen3-Embedding, igual ao Python);
 * 14. a consulta ao índice não manda o nível, o limiar e o limite como parâmetros (a pergunta nunca entra no Cypher).
 */
import { describe, expect, it } from "vitest";
import type { GrafoLeitura } from "../../src/ferramentas/grafo.ts";
import {
  escolherComunidades,
  LIMITES_PANORAMA,
  montarLotes,
  panorama,
  selecionarPontos,
  textoDoRelatorio,
  validarPontos,
  type Comunidade,
  type LlmDePanorama,
  type Ponto,
} from "../../src/ferramentas/panorama.ts";

function com(i: string, extra: Partial<Comunidade> & { texto?: string; titulo?: string } = {}): Comunidade {
  const relatorio = { title: extra.titulo ?? `Tema ${i}`, summary: `Resumo ${i}.`, findings: [{ summary: `Achado ${i}`, explanation: extra.texto ?? "Texto do relatório." }] };
  return {
    id: i,
    title: relatorio.title,
    summary: relatorio.summary,
    report: JSON.stringify(relatorio),
    level: 1,
    rating: 7,
    score: 0.5,
    ...extra,
  };
}

describe("escolherComunidades", () => {
  const cs = [com("a", { level: 0, score: 0.9 }), com("b", { level: 1, score: 0.8 }), com("c", { level: 1, rating: 4, score: 0.95 }), com("d", { level: 1, score: 0.7 }), com("e", { level: 1, score: 0.6 })];
  const ids = (r: Comunidade[]) => r.map((c) => c.id);
  it("filtra nível e rating, ordena por similaridade e corta no teto", () => {
    expect(ids(escolherComunidades(cs, 1, 5, 10))).toEqual(["b", "d", "e"]);
    expect(ids(escolherComunidades(cs, 1, 5, 2))).toEqual(["b", "d"]);
    expect(ids(escolherComunidades(cs, null, 5, 10))).toEqual(["a", "b", "d", "e"]);
    expect(ids(escolherComunidades(cs, 1, 4, 10))[0]).toBe("c"); // o limiar é ">="
    expect(escolherComunidades([], 1, 5, 3)).toEqual([]);
    expect(escolherComunidades(cs, 2, 5, 3)).toEqual([]);
  });
  it("empate de similaridade se desfaz pelo id, não pela ordem de chegada", () => {
    const a = [com("z", { score: 0.5 }), com("m", { score: 0.5 })];
    expect(ids(escolherComunidades(a, 1, 5, 10))).toEqual(["m", "z"]);
    expect(ids(escolherComunidades([...a].reverse(), 1, 5, 10))).toEqual(["m", "z"]);
  });
  it("rating ausente conta como zero", () => {
    expect(escolherComunidades([com("x", { rating: null })], 1, 0, 5)).toHaveLength(1);
    expect(escolherComunidades([com("x", { rating: null })], 1, 1, 5)).toHaveLength(0);
  });
});

describe("textoDoRelatorio", () => {
  it("junta título, resumo e achados, e aguenta JSON quebrado", () => {
    const t = textoDoRelatorio(com("a", { texto: "Explicação longa." }));
    for (const s of ["Tema a", "Resumo a.", "Achado a", "Explicação longa."]) expect(t).toContain(s);
    const quebrado = { ...com("b"), report: "{não é json" };
    expect(textoDoRelatorio(quebrado)).toContain("Tema b");
    expect(textoDoRelatorio(quebrado)).toContain("Resumo b.");
    expect(textoDoRelatorio({ ...com("c"), report: null }).startsWith("Tema c")).toBe(true);
  });
  it("relatório sem os campos esperados cai para título e resumo, não para 'undefined'", () => {
    const t = textoDoRelatorio({ ...com("d"), report: JSON.stringify({ title: "só título" }) });
    expect(t).not.toContain("undefined");
    expect(t).toContain("Tema d");
  });
});

describe("montarLotes", () => {
  it("não perde nem repete comunidade; relatório gigante é cortado, não descartado", () => {
    const cs = Array.from({ length: 7 }, (_, i) => com(String(i), { texto: "x".repeat(1000) }));
    const lotes = montarLotes(cs, 2500, 1500);
    expect(lotes.flat().map((c) => c.id)).toEqual(cs.map((c) => c.id));
    expect(lotes.length).toBeGreaterThan(1);
    expect(lotes.every((l) => l.length >= 1)).toBe(true);
    const enorme = montarLotes([com("g", { texto: "y".repeat(50000) })], 2500, 1500);
    expect(enorme).toHaveLength(1);
    expect(enorme[0]).toHaveLength(1);
    expect(montarLotes([], 2500, 1500)).toEqual([]);
  });
});

describe("validarPontos", () => {
  const etiquetas = { C1: com("a"), C2: com("b", { level: 2 }) };
  it("descarta o inválido e conta", () => {
    const { pontos, descartados } = validarPontos(
      {
        pontos: [
          { comunidade: "C1", ponto: "  Risco de crédito.  ", nota: 8 },
          { comunidade: "C2", ponto: "Risco de mercado.", nota: 8.0 },
          { comunidade: "C9", ponto: "Etiqueta inventada.", nota: 9 },
          { comunidade: "C1", ponto: "   ", nota: 9 },
          { comunidade: "C1", ponto: "Nota alta demais.", nota: 11 },
          { comunidade: "C1", ponto: "Nota negativa.", nota: -1 },
          { comunidade: "C1", ponto: "Nota texto.", nota: "alta" },
          { comunidade: "C1", ponto: "Nota booleana.", nota: true },
          { comunidade: "C1", ponto: "Nota fracionária.", nota: 7.5 },
          "lixo",
        ],
      },
      etiquetas,
    );
    expect(pontos.map((p) => [p.comunidade, p.texto, p.nota])).toEqual([
      ["a", "Risco de crédito.", 8],
      ["b", "Risco de mercado.", 8],
    ]);
    expect(pontos[1]?.nivel).toBe(2);
    expect(pontos[0]?.titulo).toBe("Tema a");
    expect(descartados).toBe(8);
  });
  it.each([null, "texto", [], {}, { pontos: "x" }, { pontos: null }])("resposta fora do esquema (%j) é erro, para o lote tentar de novo", (ruim) => {
    expect(() => validarPontos(ruim, etiquetas)).toThrow();
  });
  it("lista vazia de pontos é resposta válida: a comunidade não tinha nada a dizer", () => {
    expect(validarPontos({ pontos: [] }, etiquetas)).toEqual({ pontos: [], descartados: 0 });
  });
});

describe("selecionarPontos", () => {
  const ponto = (c: string, texto: string, nota: number, similaridade = 0.5): Ponto => ({ comunidade: c, titulo: `T${c}`, nivel: 1, texto, nota, similaridade });
  it("deduplica, filtra por nota, ordena de forma estável e corta", () => {
    const pontos = [
      ponto("a", "Risco de crédito é o principal.", 6),
      ponto("b", "risco de crédito é o principal", 9), // mesmo texto (caixa e pontuação): fica o de nota maior
      ponto("c", "Risco de mercado.", 9, 0.9),
      ponto("d", "Risco de liquidez.", 9, 0.1),
      ponto("e", "Nota zero.", 0),
      ponto("f", "Risco cibernético.", 3),
    ];
    const { escolhidos, omitido } = selecionarPontos(pontos, 1, 3, 10_000);
    expect(new Set(escolhidos.map((p) => p.comunidade))).toEqual(new Set(["b", "c", "d"]));
    expect(escolhidos.map((p) => p.comunidade)).toEqual(["c", "b", "d"]); // nota 9: maior similaridade antes
    expect(selecionarPontos([...pontos].reverse(), 1, 3, 10_000).escolhidos).toEqual(escolhidos); // independe da chegada
    expect(omitido).toEqual({ abaixo_da_nota: 1, duplicados: 1, acima_do_teto: 1, por_orcamento: 0 });
  });
  it("acento e pontuação não evitam a deduplicação", () => {
    const { escolhidos } = selecionarPontos([ponto("a", "Crédito: risco!", 5), ponto("b", "CREDITO risco", 7)], 1, 5, 1000);
    expect(escolhidos).toHaveLength(1);
    expect(escolhidos[0]?.comunidade).toBe("b");
  });
  it("respeita o orçamento de tokens, mas mantém o melhor ponto", () => {
    const pontos = [ponto("a", "x".repeat(3000), 9), ponto("b", "y".repeat(3000), 8)];
    const a = selecionarPontos(pontos, 1, 5, 1200);
    expect(a.escolhidos.map((p) => p.comunidade)).toEqual(["a"]);
    expect(a.omitido.por_orcamento).toBe(1);
    expect(selecionarPontos(pontos, 1, 5, 10).escolhidos.map((p) => p.comunidade)).toEqual(["a"]); // o melhor entra estourando
  });
});

// ---------- a busca inteira, com dublês ----------

function grafoCom(comunidades: Comunidade[]) {
  const pedidos: { cypher: string; parametros: Record<string, unknown> }[] = [];
  const grafo: GrafoLeitura = {
    async consultar(cypher, parametros = {}) {
      pedidos.push({ cypher, parametros });
      expect(cypher).toContain("community_vec");
      return comunidades.map((c) => ({ ...c }));
    },
  };
  return { grafo, pedidos };
}

/** LLM falso: um ponto por etiqueta do lote, com nota fixa; `falharEm` são os números das chamadas do mapa que dão erro. */
function llmFalso(opcoes: { nota?: number; falharEm?: Iterable<number>; reduce?: string | Error | null; aoMapa?: () => void } = {}) {
  const falhar = new Set(opcoes.falharEm ?? []);
  const pedidos: unknown[] = [];
  const textos: string[][] = [];
  const registro: { simultaneas: number; maximo: number } = { simultaneas: 0, maximo: 0 };
  const llm: LlmDePanorama = {
    async embeddingDeConsulta(pergunta) {
      textos.push([pergunta]);
      return [1, 0];
    },
    async chatJson(mensagens, o) {
      const n = pedidos.length;
      pedidos.push(mensagens);
      registro.simultaneas++;
      registro.maximo = Math.max(registro.maximo, registro.simultaneas);
      try {
        opcoes.aoMapa?.();
        await new Promise((ok) => setTimeout(ok, 2));
        if (falhar.has(n)) throw new Error("llama-swap fora do ar");
        const etiquetas = (o.esquema as { properties: { pontos: { items: { properties: { comunidade: { enum: string[] } } } } } }).properties.pontos.items.properties.comunidade.enum;
        return { valor: { pontos: etiquetas.map((e) => ({ comunidade: e, ponto: `Ponto ${n}-${e}.`, nota: opcoes.nota ?? 8 })) } };
      } finally {
        registro.simultaneas--;
      }
    },
    async chat() {
      const r = opcoes.reduce === undefined ? "Síntese dos riscos." : opcoes.reduce;
      if (r instanceof Error) throw r;
      return { texto: r ?? "" };
    },
  };
  return { llm, pedidos, textos, registro };
}
const seis = () => Array.from({ length: 6 }, (_, i) => com(String(i), { score: 1 - i / 10, texto: "z".repeat(800) }));

describe("panorama", () => {
  it("ponta a ponta: pontos, síntese e progresso em ordem", async () => {
    const eventos: { fase: string; comunidades_feitas?: number; comunidades_total?: number }[] = [];
    const { grafo } = grafoCom(seis());
    const f = llmFalso();
    const r = await panorama(grafo, f.llm, "Quais os riscos?", { limites: { lote_chars: 2000, paralelismo: 1 }, progresso: (e) => eventos.push(e) });
    expect(r.ferramenta).toBe("panorama");
    expect(r.sintese).toBe("Síntese dos riscos.");
    expect(r.reduce).toBe("ok");
    expect(r.evidencias).toHaveLength(6);
    expect(r.evidencias.every((p) => p.tipo === "ponto" && p.paginas === "")).toBe(true);
    expect(Object.keys(r.evidencias[0] ?? {}).sort()).toEqual(["caminho", "id", "paginas", "score", "texto", "tipo"]);
    const fases = eventos.map((e) => e.fase);
    expect(fases[0]).toBe("selecao");
    expect(fases.at(-1)).toBe("fim");
    expect(fases).toContain("sintese");
    const feitas = eventos.filter((e) => e.fase === "mapa").map((e) => e.comunidades_feitas as number);
    expect(feitas).toEqual([...feitas].sort((a, b) => a - b));
    expect(feitas.at(-1)).toBe(6);
    expect(eventos.filter((e) => e.fase === "selecao" || e.fase === "mapa").every((e) => e.comunidades_total === 6)).toBe(true);
    expect(r.comunidades).toEqual({ consideradas: 6, lotes: f.pedidos.length, lotes_falhos: 0 });
    expect(r.erro).toBeNull();
  });

  it("a pergunta vai ao índice só como vetor, junto com nível, limiar e limite como parâmetros", async () => {
    const { grafo, pedidos } = grafoCom(seis());
    const f = llmFalso();
    await panorama(grafo, f.llm, "Quais os riscos? '; MATCH (n) DETACH DELETE n", { limites: { lote_chars: 20000 } });
    const p = pedidos[0] as { cypher: string; parametros: Record<string, unknown> };
    expect(p.cypher).not.toContain("DETACH");
    expect(p.parametros).toMatchObject({ k: 1000, nivel: LIMITES_PANORAMA.nivel, rating: LIMITES_PANORAMA.rating, limite: LIMITES_PANORAMA.candidatas, v: [1, 0] });
    expect(f.textos[0]).toEqual(["Quais os riscos? '; MATCH (n) DETACH DELETE n"]);
  });

  it("sem comunidade que passe nos filtros não chama o LLM do mapa nem o reduce", async () => {
    const f = llmFalso();
    const r = await panorama(grafoCom([com("a", { rating: 2 })]).grafo, f.llm, "Pergunta?");
    expect(f.pedidos).toEqual([]);
    expect(r.evidencias).toEqual([]);
    expect(r.reduce).toBe("sem_pontos");
    expect(r.sintese).toBeNull();
  });

  it("pergunta vazia não toca no grafo nem no LLM", async () => {
    const { grafo, pedidos } = grafoCom(seis());
    const f = llmFalso();
    const r = await panorama(grafo, f.llm, "  ");
    expect(pedidos).toEqual([]);
    expect(f.pedidos).toEqual([]);
    expect(f.textos).toEqual([]);
    expect(r.evidencias).toEqual([]);
    expect(r.erro).toBe("pergunta_vazia");
  });

  it("lote que falha não derruba os outros e é contado (duas tentativas)", async () => {
    const f = llmFalso({ falharEm: [0, 1] });
    const r = await panorama(grafoCom(seis()).grafo, f.llm, "Pergunta?", { limites: { lote_chars: 2000, paralelismo: 1 }, reduce: false });
    expect(r.comunidades.lotes_falhos).toBe(1);
    expect(r.evidencias.length).toBeGreaterThan(0);
    expect(f.pedidos).toHaveLength(r.comunidades.lotes + 1);
  });

  it("todos os lotes falhando não passa por 'nada encontrado'", async () => {
    const f = llmFalso({ falharEm: Array.from({ length: 100 }, (_, i) => i) });
    const r = await panorama(grafoCom(seis()).grafo, f.llm, "Pergunta?", { limites: { lote_chars: 2000 }, reduce: false });
    expect(r.evidencias).toEqual([]);
    expect(r.comunidades.lotes_falhos).toBe(r.comunidades.lotes);
    expect(r.comunidades.lotes).toBeGreaterThan(0);
    expect(r.reduce).toBe("sem_pontos");
    expect(r.erro).toBe("todos os lotes do mapa falharam");
  });

  it("o orçamento de tempo para de chamar o LLM, e o reduce ainda roda", async () => {
    let relogio = 0;
    const f = llmFalso({ aoMapa: () => { relogio += 10; } }); // cada lote "demora" 10 s
    const r = await panorama(grafoCom(seis()).grafo, f.llm, "Pergunta?", { limites: { lote_chars: 1000, paralelismo: 1, orcamento_s: 25 }, agora: () => relogio, reduce: true });
    expect(f.pedidos).toHaveLength(3); // aos 0 s, 10 s e 20 s começam; aos 30 s o orçamento de 25 s já passou
    expect(r.omitido["comunidades_por_tempo"]).toBe(3);
    expect(r.truncado_por_tempo).toBe(true);
    expect(r.sintese).toBe("Síntese dos riscos.");
    expect(r.evidencias).toHaveLength(3);
  });

  it("callback de progresso que falha não derruba a busca", async () => {
    const f = llmFalso();
    const r = await panorama(grafoCom(seis()).grafo, f.llm, "Pergunta?", { progresso: () => { throw new Error("cliente SSE caiu"); }, reduce: false });
    expect(r.evidencias).toHaveLength(6);
  });

  it("reduce que falha devolve os pontos sem síntese", async () => {
    const f = llmFalso({ reduce: new Error("timeout") });
    const r = await panorama(grafoCom(seis()).grafo, f.llm, "Pergunta?");
    expect(r.reduce).toBe("falhou");
    expect(r.sintese).toBeNull();
    expect(r.evidencias).toHaveLength(6);
  });

  it("síntese vazia conta como falha do reduce", async () => {
    const r = await panorama(grafoCom(seis()).grafo, llmFalso({ reduce: "   " }).llm, "Pergunta?");
    expect(r.reduce).toBe("falhou");
    expect(r.sintese).toBeNull();
  });

  it("falha ao embutir a pergunta ou ao consultar o índice volta como erro, não como exceção", async () => {
    const f = llmFalso();
    f.llm.embeddingDeConsulta = async () => {
      throw new Error("servidor de embeddings fora do ar");
    };
    const r = await panorama(grafoCom(seis()).grafo, f.llm, "Pergunta?");
    expect(r.erro).toMatch(/^falha_na_selecao: /);
    expect(f.pedidos).toEqual([]);
    const quebrado: GrafoLeitura = {
      async consultar() {
        throw new Error("índice community_vec não existe");
      },
    };
    expect((await panorama(quebrado, llmFalso().llm, "Pergunta?")).erro).toMatch(/^falha_na_selecao: /);
  });

  it("sem reduce (desligado) só devolve os pontos", async () => {
    const f = llmFalso();
    const r = await panorama(grafoCom(seis()).grafo, f.llm, "Pergunta?", { reduce: false });
    expect(r.reduce).toBe("desligado");
    expect(r.sintese).toBeNull();
  });

  it("o resultado é o mesmo com paralelismo 1 ou 2, e o 2 não passa de duas chamadas ao mesmo tempo", async () => {
    const um = await panorama(grafoCom(seis()).grafo, llmFalso().llm, "P?", { limites: { lote_chars: 2000, paralelismo: 1 }, reduce: false });
    const f2 = llmFalso();
    const dois = await panorama(grafoCom(seis()).grafo, f2.llm, "P?", { limites: { lote_chars: 2000, paralelismo: 2 }, reduce: false });
    expect(dois.evidencias.map((p) => p.texto).sort()).toEqual(um.evidencias.map((p) => p.texto).sort());
    expect(f2.registro.maximo).toBeLessThanOrEqual(2);
    expect(f2.registro.maximo).toBeGreaterThan(1);
  });

  it("o limiar de rating padrão é 5 (§5)", () => {
    expect(LIMITES_PANORAMA.rating).toBe(5);
  });
});
