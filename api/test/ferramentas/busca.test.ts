/**
 * Buscas em TypeScript (F7.9): `buscar_trechos`, `buscar_tabelas` e `resposta_ja_dada`, com grafo e LLM falsos.
 * A paridade com o Python e o page recall no grafo real estão em `npm run avaliar:busca`. Formas de falha,
 * escritas antes do código:
 *
 *  1. A pergunta vira consulta Lucene: `AND`, aspas, parênteses, `:` e `/` quebrariam o `child_ft` ou mudariam o
 *     sentido; uma pergunta só de palavras reservadas não pode consultar o índice com texto vazio.
 *  2. A fusão por RRF e pelo máximo: um Filho que só um índice achou entra; lista vazia ou de máximo 0 não divide
 *     por zero; o desempate é pela ordem de chegada (estável), como no Python.
 *  3. Vários Filhos do mesmo Pai viram um Pai só, com o escore do melhor Filho; Filho sem Pai é ignorado; o corte
 *     em k vale depois da deduplicação.
 *  4. O reranker lê o caminho + corpo do Pai cortado em 6.000 caracteres, mas a evidência leva o Pai inteiro; nota
 *     empatada mantém a ordem da recuperação; se o reranker falha (rede, número de notas errado), a busca segue
 *     na ordem da recuperação com um aviso, em vez de perder as evidências.
 *  5. O embedding da pergunta leva o prefixo `Instruct:`; falha do embedding ou do grafo vira `erro`, nunca exceção.
 *  6. Pergunta vazia não chama LLM nem grafo. Sem Filho nenhum: lista vazia e aviso, não erro.
 *  7. Contrato: Pai vira evidência `pai` com `p. 6` ou `p. 6-7`, caminho da seção, texto inteiro, nota do rerank.
 *  8. Reescrita opcional (step-back, HyDE): resposta inválida ou LLM fora do ar descarta a reescrita e segue com
 *     a pergunta, anotando o motivo; o HyDE é embutido sem o prefixo de instrução.
 *  9. `buscar_tabelas`: perguntas hipotéticas da mesma tabela viram uma tabela só (a melhor pergunta dá o escore);
 *     o Markdown enorme é cortado com aviso; tabela sem seção não derruba a lista.
 * 10. `resposta_ja_dada`: texto vazio é erro; o trecho da conversa vira a evidência, sem página, e é aparado.
 */
import { describe, expect, it } from "vitest";
import {
  CONSULTAS_BUSCA,
  agruparPorPai,
  buscarTabelas,
  buscarTrechos,
  escaparLucene,
  fundirMax,
  fundirRrf,
  fundirVariantes,
  normalizarPeloMaximo,
  respostaJaDada,
  textoDoPai,
  validarHyde,
  validarStepback,
  type GrafoLeitura,
  type LlmDeBusca,
} from "../../src/ferramentas/index.ts";

type Linhas = Record<string, unknown>[];

function grafoFalso(respostas: Partial<Record<keyof typeof CONSULTAS_BUSCA, (p: Record<string, unknown>) => Linhas>>) {
  const chamadas: { nome: string; params: Record<string, unknown> }[] = [];
  const g: GrafoLeitura = {
    consultar: async (cypher, params = {}) => {
      const nome = Object.entries(CONSULTAS_BUSCA).find(([, c]) => c === cypher)?.[0] ?? "?";
      chamadas.push({ nome, params });
      const f = respostas[nome as keyof typeof CONSULTAS_BUSCA];
      if (!f) throw new Error(`consulta inesperada: ${nome}`);
      return f(params);
    },
  };
  return { g, chamadas };
}

function llmFalso(opcoes: { notas?: (p: string, t: string[]) => number[]; falhaEmbedding?: boolean; chat?: (m: unknown) => unknown } = {}) {
  const log = { consultas: [] as string[], embeddings: [] as string[][], rerank: [] as { p: string; t: string[] }[], chat: 0 };
  const llm: LlmDeBusca = {
    embeddingDeConsulta: async (p) => {
      if (opcoes.falhaEmbedding) throw new Error("llama-swap fora do ar");
      log.consultas.push(p);
      return [0.5, 0.5];
    },
    embeddings: async (t) => {
      log.embeddings.push(t);
      return t.map(() => [0.1, 0.9]);
    },
    rerank: async (p, t) => {
      log.rerank.push({ p, t });
      return opcoes.notas ? opcoes.notas(p, t) : t.map((_, i) => 1 - i * 0.1);
    },
    chatJson: opcoes.chat
      ? async (m) => {
          log.chat += 1;
          return { valor: opcoes.chat?.(m) };
        }
      : undefined,
  };
  return { llm, log };
}

const pai = (id: string, texto = "corpo", ini = 6, fim = 6, caminho = "Seção A") => ({
  id,
  text: texto,
  tokens: 100,
  pageStart: ini,
  pageEnd: fim,
  secaoId: "s1",
  caminho,
});

describe("escaparLucene", () => {
  it("escapa os especiais, tira AND/OR/NOT e junta com espaço", () => {
    expect(escaparLucene('Qual é o lucro (líquido) de "2025"? lucro:AND')).toBe('Qual é o lucro \\(líquido\\) de \\"2025\\"\\? lucro\\:AND');
    expect(escaparLucene("a AND b or c NOT d")).toBe("a b c d");
    expect(escaparLucene("1+1=2 a/b")).toBe("1\\+1=2 a\\/b");
  });
  it("só palavras reservadas ou só espaço dá texto vazio", () => {
    expect(escaparLucene("AND OR NOT")).toBe("");
    expect(escaparLucene("   \n ")).toBe("");
  });
});

describe("fusões", () => {
  it("normaliza pelo máximo, e lista vazia ou de máximo 0 não divide por zero", () => {
    expect(normalizarPeloMaximo([["a", 2], ["b", 1]])).toEqual(new Map([["a", 1], ["b", 0.5]]));
    expect(normalizarPeloMaximo([])).toEqual(new Map());
    expect(normalizarPeloMaximo([["a", 0]]).get("a")).toBe(0);
  });

  it("RRF: quem só um índice achou entra, e o empate segue a ordem de chegada", () => {
    const r = fundirRrf([["a", 0.9], ["b", 0.8]], [["c", 5], ["a", 4]]);
    expect(r.map(([i]) => i)).toEqual(["a", "c", "b"]); // a: 1/61 + 1/62; c: 1/61; b: 1/62
  });

  it("RRF: os dois primeiros lugares valem 1/61 cada e o empate fica com quem chegou antes", () => {
    const r = fundirRrf([["x", 1]], [["y", 1]]);
    expect(r.map(([i]) => i)).toEqual(["x", "y"]);
    expect(r[0]?.[1]).toBeCloseTo(1 / 61, 12);
  });

  it("pelo máximo: alfa pesa o vetor, o que falta numa lista conta 0", () => {
    const r = fundirMax([["a", 1], ["b", 0.5]], [["b", 10]], 0.5);
    expect(r).toEqual([["b", 0.5 * 0.5 + 0.5 * 1], ["a", 0.5]]);
  });

  it("variantes: com um só ranking a ordem é a dele; com vários, RRF", () => {
    expect(fundirVariantes([[["a", 1], ["b", 1]]]).map(([i]) => i)).toEqual(["a", "b"]);
    expect(fundirVariantes([[["a", 1], ["b", 1]], [["b", 1], ["a", 1]]]).map(([i]) => i)[0]).toBe("a"); // empate: ordem de chegada
  });
});

describe("agruparPorPai", () => {
  it("um Pai por vários Filhos, escore do melhor, Filho sem Pai ignorado, corte em k depois de agrupar", () => {
    const paiDe = new Map([["f1", "p1"], ["f2", "p1"], ["f3", "p2"], ["f4", "p3"]]);
    const r = agruparPorPai([["f1", 0.9], ["f2", 0.8], ["fx", 0.7], ["f3", 0.6], ["f4", 0.5]], paiDe, 2);
    expect(r).toEqual([
      { id: "p1", score: 0.9, filhos: ["f1", "f2"] },
      { id: "p2", score: 0.6, filhos: ["f3"] },
    ]);
  });
});

describe("textoDoPai", () => {
  it("junta caminho e corpo e corta em 6.000 caracteres, dizendo que cortou", () => {
    const [t, cortado] = textoDoPai({ caminho: "C", text: "x".repeat(7000) });
    expect(t.length).toBe(6000);
    expect(t.startsWith("C\nxxx")).toBe(true);
    expect(cortado).toBe(true);
    expect(textoDoPai({ caminho: "C", text: "curto" })).toEqual(["C\ncurto", false]);
  });
});

describe("buscarTrechos", () => {
  const grafoBase = () =>
    grafoFalso({
      vetor_filhos: () => [{ id: "f1", score: 0.9 }, { id: "f2", score: 0.8 }, { id: "f3", score: 0.7 }],
      texto_filhos: () => [{ id: "f3", score: 9 }, { id: "f1", score: 3 }],
      pai_dos_filhos: () => [{ id: "f1", pai: "p1" }, { id: "f2", pai: "p1" }, { id: "f3", pai: "p2" }],
      detalhes_pais: () => [pai("p1", "Texto do primeiro", 6, 7, "Seção A > B"), pai("p2", "Texto do segundo", 80, 80)],
    });

  it("híbrido → Pais → rerank: devolve evidências `pai` na ordem das notas, com páginas e caminho", async () => {
    const { g, chamadas } = grafoBase();
    const { llm, log } = llmFalso({ notas: () => [0.2, 0.9] });
    const r = await buscarTrechos(g, llm, "Quem é o controlador?");
    expect(r.erro).toBeNull();
    expect(r.evidencias.map((e) => e.id)).toEqual(["p2", "p1"]);
    expect(r.evidencias[0]).toEqual({ id: "p2", tipo: "pai", paginas: "p. 80", caminho: "Seção A", texto: "Texto do segundo", score: 0.9 });
    expect(r.evidencias[1]?.paginas).toBe("p. 6-7");
    expect(log.consultas[0]).toBe("Quem é o controlador?"); // o prefixo Instruct: é do cliente (embeddingDeConsulta)
    expect(log.rerank[0]?.p).toBe("Quem é o controlador?"); // o reranker lê a pergunta ORIGINAL
    expect(log.rerank[0]?.t).toEqual(["Seção A > B\nTexto do primeiro", "Seção A\nTexto do segundo"]);
    expect(chamadas.find((c) => c.nome === "vetor_filhos")?.params["k"]).toBe(96); // 24 candidatos × 4
    expect(r.pais).toEqual([
      { id: "p2", nota_rerank: 0.9, posicao_antes: 2 },
      { id: "p1", nota_rerank: 0.2, posicao_antes: 1 },
    ]);
  });

  it("nota empatada mantém a ordem da recuperação", async () => {
    const { g } = grafoBase();
    const { llm } = llmFalso({ notas: () => [0.5, 0.5] });
    const r = await buscarTrechos(g, llm, "x");
    expect(r.evidencias.map((e) => e.id)).toEqual(["p1", "p2"]);
  });

  it("o Pai inteiro vai na evidência mesmo quando o reranker só leu 6.000 caracteres", async () => {
    const longo = "y".repeat(9000);
    const { g } = grafoFalso({
      vetor_filhos: () => [{ id: "f1", score: 1 }],
      texto_filhos: () => [],
      pai_dos_filhos: () => [{ id: "f1", pai: "p1" }],
      detalhes_pais: () => [pai("p1", longo)],
    });
    const { llm, log } = llmFalso();
    const r = await buscarTrechos(g, llm, "x");
    expect(log.rerank[0]?.t[0]?.length).toBe(6000);
    expect(r.evidencias[0]?.texto).toBe(longo);
    expect(r.omitido["cortados_no_rerank"]).toBe(1);
  });

  it("devolve no máximo 6 Pais e conta o que o corte deixou de fora", async () => {
    const filhos = Array.from({ length: 10 }, (_, i) => ({ id: `f${i}`, score: 1 - i * 0.01 }));
    const { g } = grafoFalso({
      vetor_filhos: () => filhos,
      texto_filhos: () => [],
      pai_dos_filhos: () => filhos.map((f, i) => ({ id: f.id, pai: `p${i}` })),
      detalhes_pais: (p) => (p["ids"] as string[]).map((i) => pai(i)),
    });
    const { llm } = llmFalso({ notas: (_p, t) => t.map((_, i) => 1 - i * 0.01) });
    const r = await buscarTrechos(g, llm, "x");
    expect(r.evidencias).toHaveLength(6);
    expect(r.omitido["pais"]).toBe(4);
  });

  it("reranker que falha (exceção ou notas a menos) mantém a ordem da recuperação e avisa", async () => {
    for (const notas of [
      () => {
        throw new Error("rerank 500");
      },
      () => [0.1],
    ]) {
      const { g } = grafoBase();
      const { llm } = llmFalso({ notas });
      const r = await buscarTrechos(g, llm, "x");
      expect(r.erro).toBeNull();
      expect(r.evidencias.map((e) => e.id)).toEqual(["p1", "p2"]);
      expect(r.rerank).toBe("falhou");
      expect(r.aviso).toMatch(/rerank/i);
    }
  });

  it("pergunta vazia ou só reservadas: sem chamadas ao LLM; só reservadas ainda busca pelo vetor", async () => {
    const vazio = grafoFalso({});
    const l1 = llmFalso();
    const r = await buscarTrechos(vazio.g, l1.llm, "   ");
    expect(r.evidencias).toEqual([]);
    expect(r.erro).toBeNull();
    expect(vazio.chamadas).toHaveLength(0);
    expect(l1.log.consultas).toHaveLength(0);

    const { g, chamadas } = grafoBase();
    await buscarTrechos(g, llmFalso().llm, "AND OR");
    expect(chamadas.some((c) => c.nome === "texto_filhos")).toBe(false);
    expect(chamadas.some((c) => c.nome === "vetor_filhos")).toBe(true);
  });

  it("sem Filho nenhum: lista vazia e aviso, sem erro", async () => {
    const { g } = grafoFalso({ vetor_filhos: () => [], texto_filhos: () => [] });
    const r = await buscarTrechos(g, llmFalso().llm, "pergunta sem resposta");
    expect(r.erro).toBeNull();
    expect(r.evidencias).toEqual([]);
    expect(r.aviso).toMatch(/nenhum trecho/i);
  });

  it("falha do embedding ou do grafo vira erro, sem exceção", async () => {
    const a = await buscarTrechos(grafoBase().g, llmFalso({ falhaEmbedding: true }).llm, "x");
    expect(a.erro).toMatch(/^falha na busca: .*fora do ar/);
    expect(a.evidencias).toEqual([]);
    const b = await buscarTrechos(grafoFalso({ vetor_filhos: () => [{ id: "f", score: 1 }] }).g, llmFalso().llm, "x");
    expect(b.erro).toMatch(/^falha na busca/);
  });

  describe("reescrita opcional", () => {
    it("step-back válido entra na busca; as três listas se unem por RRF e o HyDE é embutido sem prefixo", async () => {
      const { g, chamadas } = grafoBase();
      const chat = (m: unknown) => {
        const texto = JSON.stringify(m);
        return texto.includes("Pergunta geral") || texto.includes("mais geral")
          ? { pergunta_geral: "Como é composta a administração da companhia?" }
          : { trecho: "A companhia é controlada pela União Federal, que detém a maioria do capital votante e indica os membros do conselho. ".repeat(3) };
      };
      const { llm, log } = llmFalso({ chat });
      const r = await buscarTrechos(g, llm, "Quem preside o conselho?", { stepback: true, hyde: true });
      expect(r.erro).toBeNull();
      expect(log.chat).toBe(2);
      expect(log.consultas).toContain("Como é composta a administração da companhia?");
      expect(log.embeddings.flat().some((t) => t.startsWith("A companhia é controlada"))).toBe(true);
      expect(chamadas.filter((c) => c.nome === "vetor_filhos").length).toBe(3); // original, step-back, HyDE
      expect(r.reescrita?.erros).toEqual({});
    });

    it("resposta inválida ou LLM fora do ar descarta a reescrita, anota o motivo e segue com a pergunta", async () => {
      const { g } = grafoBase();
      const { llm } = llmFalso({
        chat: () => {
          throw new Error("modelo fora do ar");
        },
      });
      const r = await buscarTrechos(g, llm, "x?", { stepback: true, hyde: true });
      expect(r.erro).toBeNull();
      expect(r.evidencias.length).toBeGreaterThan(0);
      expect(Object.keys(r.reescrita?.erros ?? {}).sort()).toEqual(["hyde", "stepback"]);
    });

    it("sem `chatJson` no LLM a reescrita pedida é anotada e não quebra", async () => {
      const r = await buscarTrechos(grafoBase().g, llmFalso().llm, "x?", { stepback: true });
      expect(r.erro).toBeNull();
      expect(r.reescrita?.erros["stepback"]).toBeDefined();
    });
  });
});

describe("validação das reescritas", () => {
  it("step-back: 15 a 300 caracteres, termina em '?', diferente da pergunta", () => {
    expect(validarStepback("Qual o lucro?", "Quais foram os resultados da companhia no ano?")).toBeNull();
    expect(validarStepback("a", "curta?")).not.toBeNull();
    expect(validarStepback("a", "sem interrogação aqui nesta frase")).not.toBeNull();
    expect(validarStepback("Qual foi o lucro líquido do ano?", "qual foi o LUCRO líquido do ano?")).not.toBeNull();
    expect(validarStepback("a", 42)).not.toBeNull();
  });
  it("HyDE: 200 a 1.500 caracteres", () => {
    expect(validarHyde("x".repeat(199))).not.toBeNull();
    expect(validarHyde("x".repeat(200))).toBeNull();
    expect(validarHyde("x".repeat(1501))).not.toBeNull();
    expect(validarHyde(null)).not.toBeNull();
  });
});

describe("buscarTabelas", () => {
  const linha = (id: string, tabela: string, score: number, extra: Record<string, unknown> = {}) => ({
    id,
    score,
    tabela,
    markdown: `| a | b |\n|---|---|\n| ${tabela} | 1 |`,
    descricao: `Descrição de ${tabela}`,
    pageStart: 10,
    pageEnd: 11,
    escala: "milhões",
    moeda: "BRL",
    caminho: "Demonstrações > Balanço",
    ...extra,
  });

  it("perguntas da mesma tabela viram uma tabela (melhor escore), ordenadas por escore", async () => {
    const { g, chamadas } = grafoFalso({
      tabelas_por_pergunta: () => [linha("q1", "t1", 0.9), linha("q2", "t2", 0.85), linha("q3", "t1", 0.8), linha("q4", "t3", 0.5)],
    });
    const { llm, log } = llmFalso();
    const r = await buscarTabelas(g, llm, "Qual o caixa líquido?", { tabelas: 2 });
    expect(r.erro).toBeNull();
    expect(r.evidencias.map((e) => e.id)).toEqual(["t1", "t2"]);
    expect(r.evidencias[0]).toMatchObject({ tipo: "tabela", paginas: "p. 10-11", caminho: "Demonstrações > Balanço", score: 0.9 });
    expect(r.evidencias[0]?.texto).toContain("Descrição de t1");
    expect(r.evidencias[0]?.texto).toContain("| t1 | 1 |");
    expect(r.omitido["tabelas"]).toBe(1);
    expect(log.consultas).toEqual(["Qual o caixa líquido?"]);
    expect(chamadas[0]?.params["k"]).toBe(20);
  });

  it("Markdown enorme é cortado com aviso e a tabela segue na lista", async () => {
    const { g } = grafoFalso({ tabelas_por_pergunta: () => [linha("q1", "t1", 0.9, { markdown: "| x |\n".repeat(5000) })] });
    const r = await buscarTabelas(g, llmFalso().llm, "x");
    expect(r.evidencias[0]?.texto.length).toBeLessThan(12_500);
    expect(r.evidencias[0]?.texto).toContain("tabela cortada");
    expect(r.omitido["tabelas_cortadas"]).toBe(1);
  });

  it("tabela sem seção ou sem página não derruba: caminho vazio, página vazia", async () => {
    const { g } = grafoFalso({ tabelas_por_pergunta: () => [linha("q1", "t1", 0.9, { caminho: null, pageStart: null, pageEnd: null })] });
    const r = await buscarTabelas(g, llmFalso().llm, "x");
    expect(r.erro).toBeNull();
    expect(r.evidencias[0]).toMatchObject({ caminho: "", paginas: "" });
  });

  it("sem perguntas parecidas: vazio com aviso; pergunta vazia não chama nada; falha vira erro", async () => {
    const r = await buscarTabelas(grafoFalso({ tabelas_por_pergunta: () => [] }).g, llmFalso().llm, "x");
    expect(r.evidencias).toEqual([]);
    expect(r.aviso).toMatch(/nenhuma tabela/i);
    const l = llmFalso();
    const v = await buscarTabelas(grafoFalso({}).g, l.llm, "  ");
    expect(v.evidencias).toEqual([]);
    expect(l.log.consultas).toHaveLength(0);
    const f = await buscarTabelas(grafoFalso({ tabelas_por_pergunta: () => [] }).g, llmFalso({ falhaEmbedding: true }).llm, "x");
    expect(f.erro).toMatch(/^falha na busca/);
  });
});

describe("respostaJaDada", () => {
  it("o trecho da conversa vira a evidência, sem página, aparado", () => {
    const r = respostaJaDada({ resposta: "  O lucro foi de R$ 16,8 bilhões [p. 6].  " });
    expect(r.erro).toBeNull();
    expect(r.evidencias).toEqual([{ id: "conversa", tipo: "conversa", paginas: "", caminho: "Conversa", texto: "O lucro foi de R$ 16,8 bilhões [p. 6].", score: 1 }]);
  });
  it("vazio ou só espaço é erro, sem evidência", () => {
    for (const resposta of ["", "   \n"]) {
      const r = respostaJaDada({ resposta });
      expect(r.erro).toBe("resposta_vazia");
      expect(r.evidencias).toEqual([]);
    }
  });
  it("texto enorme é cortado e o corte é contado", () => {
    const r = respostaJaDada({ resposta: "a".repeat(20_000) });
    expect(r.evidencias[0]?.texto.length).toBeLessThanOrEqual(8000);
    expect(r.omitido["caracteres"]).toBeGreaterThan(0);
  });
});
