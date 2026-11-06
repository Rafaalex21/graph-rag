/**
 * Ferramenta `entidade` (F7.9; porte de `indexer.busca_local`, F6.1/ADR-046), com grafo e LLM falsos. A paridade
 * com o Python no grafo real está em `npm run avaliar:busca`. Formas de falha, escritas antes do código:
 *
 *  1. O nome citado na pergunta casa por palavra inteira, sem caixa nem acento ("Banco" não casa "Bancorp"); o
 *     `entity_ft` com a pergunta inteira casa palavras soltas e enche o topo de entidades genéricas, então só
 *     entra o que a pergunta cita pelo nome ou apelido (modo `ft` = 2).
 *  2. O embedding da entidade vai SEM o prefixo `Instruct:` (a busca local do Python não o usa; com ele os
 *     vizinhos mudam).
 *  3. Os Pais são ranqueados por quantas entidades escolhidas os citam e pela similaridade; quem cita o mesmo
 *     número de vezes empata na posição (senão o desempate por id esconderia o mais parecido) e o empate final
 *     é por id, então a ordem não muda entre execuções.
 *  4. Teto de tokens: a primeira evidência entra sempre; o que não cabe é pulado e contado em `por_orcamento`;
 *     o excedente de cada camada é contado em `omitido`.
 *  5. O reranker é refinamento: se falha, a busca segue na ordem do RRF e `rerank` vale "falhou".
 *  6. Consulta vazia ou sem entidade parecida devolve tudo vazio, sem erro e sem chamar o grafo (vazia).
 *  7. Relação repetida nos dois sentidos conta uma vez; o relatório de comunidade, que é síntese, não tem página.
 *  8. Falha de embedding ou de grafo vira `erro`, nunca exceção.
 */
import { describe, expect, it } from "vitest";
import {
  CONSULTAS_ENTIDADE,
  buscarEntidade,
  estimarTokens,
  fundirCandidatas,
  montarEvidencias,
  nomeNaPergunta,
  posicoesDensas,
  ranquearComunidades,
  ranquearPais,
  textoExato,
  type GrafoLeitura,
  type LlmDeBusca,
} from "../../src/ferramentas/index.ts";

describe("nomeNaPergunta e textoExato", () => {
  it("palavra inteira, sem caixa nem acento", () => {
    expect(nomeNaPergunta("Quem é a Tarciana Medeiros?", ["tarciana medeiros"])).toBe(true);
    expect(nomeNaPergunta("Fale do BB Consórcios", ["BB Consorcios"])).toBe(true);
    expect(nomeNaPergunta("O Bancorp subiu", ["Banco"])).toBe(false);
    expect(nomeNaPergunta("Fale do Banco", [null, "", "Banco"])).toBe(true);
    expect(nomeNaPergunta("x", [null, undefined as unknown as string])).toBe(false);
  });
  it("metacaracteres do nome não quebram a expressão", () => {
    expect(nomeNaPergunta("o que é a S.A. (holding)?", ["S.A. (holding)"])).toBe(true);
    expect(nomeNaPergunta("xSAy", ["S.A"])).toBe(false);
  });
  it("só fica o acerto do entity_ft cujo nome ou apelido a pergunta cita", () => {
    const acertos = [
      { id: "e1", score: 3, nomes: ["Banco do Brasil", "BB"] },
      { id: "e2", score: 2, nomes: ["Formulário"] },
      { id: "e3", score: 1, nomes: [] },
    ];
    expect(textoExato(acertos, "Qual a sede do BB?")).toEqual([["e1", 3]]);
  });
});

describe("ranqueamento", () => {
  it("posições densas: o maior valor é 1, empate empata, o próximo valor distinto é 2", () => {
    expect(posicoesDensas(new Map([["a", 3], ["b", 3], ["c", 1]]))).toEqual(new Map([["a", 1], ["b", 1], ["c", 2]]));
  });

  it("Pais: citações e similaridade se somam por RRF; quem cita o mesmo número empata e vence o mais parecido", () => {
    const mencoes = { e1: ["p1", "p2", "p3"], e2: ["p1"] };
    const sim = new Map([["p1", 0.5], ["p2", 0.9], ["p3", 0.7]]);
    // p1 cita 2x (posição 1) mas é o menos parecido (posição 3); p2 e p3 citam 1x (posição 2) e são 1º e 2º em similaridade
    expect(ranquearPais(mencoes, sim, 3)).toEqual(["p2", "p1", "p3"]);
  });

  it("Pais: empate total é por id e a ordem se repete; sem citação nenhuma, lista vazia", () => {
    const mencoes = { e1: ["pb", "pa"] };
    const sim = new Map([["pa", 0.5], ["pb", 0.5]]);
    expect(ranquearPais(mencoes, sim, 2)).toEqual(["pa", "pb"]);
    expect(ranquearPais({ e1: [] }, new Map(), 3)).toEqual([]);
  });

  it("Pai citado sem similaridade calculada ainda entra, pela citação", () => {
    expect(ranquearPais({ e1: ["p1", "p2"] }, new Map([["p1", 0.4]]), 2)).toEqual(["p1", "p2"]);
  });

  it("comunidades: mais entidades dentro, depois nível mais fino, depois rank, depois id", () => {
    const membros = { c1: ["e1"], c2: ["e1", "e2"], c3: ["e1", "e2"], c4: ["e1"] };
    const info = { c1: { level: 0, rank: 9 }, c2: { level: 1, rank: 1 }, c3: { level: 0, rank: 1 }, c4: { level: 0, rank: 9 } };
    expect(ranquearComunidades(membros, info, 4)).toEqual(["c3", "c2", "c1", "c4"]);
  });

  it("candidatas: o que só o vetor ou só o nome achou também entra; corte em n", () => {
    expect(fundirCandidatas([["a", 1], ["b", 1]], [["c", 5]], 2).map(([i]) => i)).toEqual(["a", "c"]);
  });
});

describe("montarEvidencias", () => {
  const limites = { entidades: 6, relacoes: 10, pais: 6, comunidades: 2, tokens: 6000 };
  const ent = (id: string, nome = id, resumo = "resumo") => ({ id, nome, tipo: "Organization", resumo, paginas: [6, 7, 9], score: 0.5 });

  it("ordem entidade, Pai, relação, comunidade, com o contrato de campos e as páginas só onde existem", () => {
    const { evidencias, omitido } = montarEvidencias(
      [ent("e1", "Banco do Brasil")],
      [{ de: "e1", para: "e2", de_nome: "BB", para_nome: "União", resumo: "controla", peso: 3, rank: 1, paginas: [6] }],
      [{ id: "p1", text: "corpo", tokens: 10, pageStart: 6, pageEnd: 7, caminho: "Seção", score: 0.8 }],
      [{ id: "c1", title: "Governança", summary: "síntese", level: 1, rank: 4 }],
      limites,
    );
    expect(evidencias.map((e) => e.tipo)).toEqual(["entidade", "pai", "relacao", "comunidade"]);
    expect(evidencias[0]).toEqual({ id: "e1", tipo: "entidade", paginas: "p. 6-7, 9", caminho: "Entidade", texto: "Banco do Brasil (Organization): resumo", score: 0.5 });
    expect(evidencias[1]).toMatchObject({ paginas: "p. 6-7", caminho: "Seção", texto: "corpo", score: 0.8 });
    expect(evidencias[2]).toEqual({ id: "rel:e1:e2", tipo: "relacao", paginas: "p. 6", caminho: "Relação", texto: "BB → União: controla", score: 3 });
    expect(evidencias[3]).toEqual({ id: "c1", tipo: "comunidade", paginas: "", caminho: "Comunidade (nível 1)", texto: "Governança\nsíntese", score: 4 });
    expect(omitido).toEqual({ entidades: 0, relacoes: 0, pais: 0, comunidades: 0, por_orcamento: 0 });
  });

  it("relação nos dois sentidos conta uma vez (a de maior peso) e o excedente de cada camada é contado", () => {
    const r = (de: string, para: string, peso: number) => ({ de, para, de_nome: de, para_nome: para, resumo: "x", peso, rank: 1, paginas: [] as number[] });
    const { evidencias, omitido } = montarEvidencias(
      [ent("e1"), ent("e2"), ent("e3")],
      [r("e1", "e2", 1), r("e2", "e1", 5), r("e1", "e3", 2)],
      [],
      [],
      { ...limites, entidades: 2, relacoes: 1 },
    );
    expect(evidencias.filter((e) => e.tipo === "relacao").map((e) => e.id)).toEqual(["rel:e2:e1"]);
    expect(omitido.entidades).toBe(1);
    expect(omitido.relacoes).toBe(1);
  });

  it("orçamento de tokens: a primeira entra sempre, o que não cabe é pulado e contado, e o que cabe depois segue", () => {
    const grande = "x".repeat(300); // 100 tokens
    const { evidencias, omitido } = montarEvidencias(
      [ent("e1", "A", grande)],
      [{ de: "e1", para: "e2", de_nome: "A", para_nome: "B", resumo: "curto", peso: 1, rank: 1, paginas: [] }],
      [{ id: "p1", text: grande, tokens: 500, pageStart: 1, pageEnd: 1, caminho: "S", score: 1 }],
      [],
      { ...limites, tokens: 120 },
    );
    expect(evidencias.map((e) => e.id)).toEqual(["e1", "rel:e1:e2"]);
    expect(omitido.por_orcamento).toBe(1);
  });

  it("a primeira evidência entra mesmo estourando o orçamento", () => {
    const { evidencias } = montarEvidencias([ent("e1", "A", "y".repeat(3000))], [], [], [], { ...limites, tokens: 10 });
    expect(evidencias).toHaveLength(1);
  });

  it("estimarTokens: 3 caracteres por token, no mínimo 1", () => {
    expect(estimarTokens("")).toBe(1);
    expect(estimarTokens("abcdef")).toBe(2);
  });
});

type Linhas = Record<string, unknown>[];
function grafoFalso(r: Partial<Record<keyof typeof CONSULTAS_ENTIDADE, (p: Record<string, unknown>) => Linhas>>) {
  const chamadas: { nome: string; params: Record<string, unknown> }[] = [];
  const g: GrafoLeitura = {
    consultar: async (cypher, params = {}) => {
      const nome = Object.entries(CONSULTAS_ENTIDADE).find(([, c]) => c === cypher)?.[0] ?? "?";
      chamadas.push({ nome, params });
      const f = r[nome as keyof typeof CONSULTAS_ENTIDADE];
      if (!f) throw new Error(`consulta inesperada: ${nome}`);
      return f(params);
    },
  };
  return { g, chamadas };
}

function llmFalso(o: { notas?: (p: string, t: string[]) => number[]; falhaEmbedding?: boolean } = {}) {
  const log = { embeddings: [] as string[][], consultas: 0, rerank: [] as { p: string; t: string[] }[] };
  const llm: LlmDeBusca = {
    embeddingDeConsulta: async () => {
      log.consultas += 1;
      return [1, 0];
    },
    embeddings: async (t) => {
      if (o.falhaEmbedding) throw new Error("embedding fora do ar");
      log.embeddings.push(t);
      return t.map(() => [0.6, 0.8]);
    },
    rerank: async (p, t) => {
      log.rerank.push({ p, t });
      if (!o.notas) throw new Error("rerank desligado no teste");
      return o.notas(p, t);
    },
  };
  return { llm, log };
}

const completo = () =>
  grafoFalso({
    entidades_vetor: () => [{ id: "e1", score: 0.9 }, { id: "e2", score: 0.8 }],
    entidades_texto: () => [{ id: "e2", score: 5, nome: "União Federal", apelidos: ["União"] }, { id: "e9", score: 4, nome: "Formulário", apelidos: [] }],
    detalhes_entidades: () => [
      { id: "e1", nome: "Banco do Brasil", tipo: "Organization", resumo: "Banco múltiplo", pages: [6, 7] },
      { id: "e2", nome: "União Federal", tipo: "Organization", resumo: "Acionista controlador", pages: [6, null] },
    ],
    relacoes: () => [{ de: "e2", para: "e1", de_nome: "União", para_nome: "BB", resumo: "controla", peso: 3, rank: 1, pages: [6] }],
    mencoes: () => [{ entidade: "e1", pai: "p1" }, { entidade: "e2", pai: "p1" }, { entidade: "e2", pai: "p2" }],
    similaridade: () => [{ pai: "p1", sim: 0.7 }, { pai: "p2", sim: 0.6 }],
    detalhes_pais: () => [
      { id: "p1", text: "corpo 1", tokens: 50, pageStart: 6, pageEnd: 6, caminho: "Controle" },
      { id: "p2", text: "corpo 2", tokens: 50, pageStart: 8, pageEnd: 9, caminho: "Estrutura" },
    ],
    comunidades: () => [{ entidade: "e1", id: "c1", title: "Governança", summary: "síntese", level: 1, rank: 2 }],
  });

describe("buscarEntidade", () => {
  it("vetor + nome citado → entidades, relações, Pais e comunidades, com o contrato de evidências", async () => {
    const { g, chamadas } = completo();
    const { llm, log } = llmFalso({ notas: (_p, t) => t.map((_, i) => 1 - i * 0.1) });
    const r = await buscarEntidade(g, llm, "Quem é a União Federal?");
    expect(r.erro).toBeNull();
    expect(r.rerank).toBe("ok");
    expect(r.entidades.map((e) => e.id)).toEqual(["e2", "e1"]); // e2 foi achada pelo vetor E pelo nome: RRF a põe na frente
    expect(r.evidencias.map((e) => e.tipo)).toEqual(["entidade", "entidade", "pai", "pai", "relacao", "comunidade"]);
    expect(r.evidencias.find((e) => e.id === "e2")?.paginas).toBe("p. 6");
    expect(log.embeddings[0]).toEqual(["Quem é a União Federal?"]); // SEM o prefixo Instruct:
    expect(log.consultas).toBe(0);
    // o entity_ft só deixa passar a entidade que a pergunta cita: e9 ("Formulário") ficou de fora das candidatas
    const detalhes = chamadas.find((c) => c.nome === "detalhes_entidades");
    expect(detalhes?.params["ids"]).not.toContain("e9");
    expect(chamadas.find((c) => c.nome === "entidades_vetor")?.params["k"]).toBe(25);
  });

  it("o reranker lê 'nome: resumo' e reordena as entidades; a nota vira o escore", async () => {
    const { g } = completo();
    const { llm, log } = llmFalso({ notas: () => [0.1, 0.9] });
    const r = await buscarEntidade(g, llm, "Quem é a União Federal?");
    expect(log.rerank[0]?.t).toEqual(["União Federal: Acionista controlador", "Banco do Brasil: Banco múltiplo"]);
    expect(r.entidades[0]).toMatchObject({ id: "e1", score: 0.9 });
    expect(r.entidades).toHaveLength(2);
  });

  it("reranker que falha mantém a ordem do RRF e anota", async () => {
    const { g } = completo();
    const { llm } = llmFalso(); // sem `notas`: lança
    const r = await buscarEntidade(g, llm, "Quem é a União Federal?");
    expect(r.erro).toBeNull();
    expect(r.rerank).toBe("falhou");
    expect(r.evidencias.length).toBeGreaterThan(0);
  });

  it("consulta vazia: tudo vazio, sem chamar embedding nem grafo", async () => {
    const { g, chamadas } = grafoFalso({});
    const { llm, log } = llmFalso();
    const r = await buscarEntidade(g, llm, "   ");
    expect(r).toMatchObject({ erro: null, evidencias: [], entidades: [], rerank: "desligado" });
    expect(chamadas).toHaveLength(0);
    expect(log.embeddings).toHaveLength(0);
  });

  it("nenhuma entidade parecida: vazio com aviso, sem erro", async () => {
    const { g } = grafoFalso({ entidades_vetor: () => [], entidades_texto: () => [] });
    const r = await buscarEntidade(g, llmFalso().llm, "Quem é Fulano de Tal?");
    expect(r.erro).toBeNull();
    expect(r.evidencias).toEqual([]);
    expect(r.aviso).toMatch(/nenhuma entidade/i);
  });

  it("falha do embedding ou do grafo vira erro", async () => {
    const a = await buscarEntidade(completo().g, llmFalso({ falhaEmbedding: true }).llm, "x");
    expect(a.erro).toMatch(/^falha na busca/);
    const b = await buscarEntidade(grafoFalso({ entidades_vetor: () => { throw new Error("neo4j caiu"); } }).g, llmFalso().llm, "x");
    expect(b.erro).toMatch(/neo4j caiu/);
  });
});
