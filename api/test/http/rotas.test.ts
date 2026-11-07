/**
 * Testes de contrato das rotas que não são o chat (F7.6), escritos antes do código. Cada resposta é validada contra
 * `contracts/api.openapi.yaml`. Modos de falha:
 *
 *  1. /api/saude: Neo4j ou llama-swap fora do ar, ou lento, NÃO derruba a rota (sempre 200, `status: degradado`), e uma
 *     sonda que não responde não pode pendurar a resposta;
 *  2. /api/fonte/:id: id que não existe é 404 (não 200 vazio), banco fora do ar é 503, e o id nunca entra no texto da consulta
 *     (injeção de Cypher); id enorme é 400; item sem página devolve `pagina: null`, nunca uma página inventada;
 *  3. /api/documento/pdf: o pdf.js pede faixas (`Range`): início, meio, sufixo e faixa depois do fim (416); cabeçalho
 *     malformado vale como sem cabeçalho; arquivo ausente é 404 sem mostrar o caminho do disco;
 *  4. /api/grafo/vizinhanca: parâmetro ausente ou fora da faixa é 400, entidade desconhecida é 404, o teto de 100 nós
 *     avisa em `truncado`, a aresta nunca aponta para um nó que não foi devolvido, o nome nunca entra no texto da consulta;
 *  5. /api/feedback: nota fora de {1, -1}, campo a mais, comentário enorme ou JSON quebrado são 400 e nada é gravado; o que
 *     é gravado é uma linha JSON por registro, mesmo com quebra de linha e aspas no comentário.
 */
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { criarApp } from "../../src/app.ts";
import type { DependenciasApp } from "../../src/http/tipos.ts";
import type { GrafoLeitura } from "../../src/ferramentas/index.ts";
import { problemas, statusDeclarados } from "./contrato.ts";

type Linhas = Record<string, unknown>[];
type Resposta = Linhas | Error;

function grafoFalso(responde: (cypher: string, parametros: Record<string, unknown>) => Resposta) {
  const chamadas: { cypher: string; parametros: Record<string, unknown> }[] = [];
  const grafo: GrafoLeitura = {
    consultar: async (cypher, parametros = {}) => {
      chamadas.push({ cypher, parametros });
      const r = responde(cypher, parametros);
      if (r instanceof Error) throw r;
      return r;
    },
  };
  return { grafo, chamadas };
}

const abertos: { close(): Promise<unknown> }[] = [];
afterEach(async () => {
  for (const a of abertos.splice(0)) await a.close();
});
const montar = (deps: DependenciasApp = {}) => {
  const app = criarApp(deps);
  abertos.push(app);
  return app;
};
const pasta = () => mkdtempSync(join(tmpdir(), "graphrag-http-"));

// ---------- 1: saúde ----------

describe("GET /api/saude", () => {
  const llmOk = { modelos: async () => ["qwen", "embedding", "reranker"], carregados: async () => ["qwen"] };
  const grafoOk = grafoFalso((c) => (c.includes("SHOW INDEXES") ? [{ nome: "child_vec", estado: "ONLINE" }, { nome: "child_ft", estado: "ONLINE" }] : [{ ok: 1 }]));

  it("tudo no ar: ok, com os modelos (carregado ou não) e os índices", async () => {
    const r = await montar({ llm: llmOk, grafo: grafoOk.grafo }).inject({ method: "GET", url: "/api/saude" });
    expect(r.statusCode).toBe(200);
    const corpo = r.json();
    expect(problemas("Saude", corpo)).toEqual([]);
    expect(corpo.status).toBe("ok");
    expect(corpo.modelos).toEqual([
      { nome: "qwen", carregado: true },
      { nome: "embedding", carregado: false },
      { nome: "reranker", carregado: false },
    ]);
    expect(corpo.indices).toEqual([
      { nome: "child_vec", estado: "ONLINE" },
      { nome: "child_ft", estado: "ONLINE" },
    ]);
  });

  it("Neo4j fora do ar: 200, degradado, sem índices", async () => {
    const g = grafoFalso(() => new Error("ECONNREFUSED"));
    const r = await montar({ llm: llmOk, grafo: g.grafo }).inject({ method: "GET", url: "/api/saude" });
    expect(r.statusCode).toBe(200);
    expect(problemas("Saude", r.json())).toEqual([]);
    expect(r.json()).toMatchObject({ status: "degradado", neo4j: { estado: "indisponivel" }, indices: [], llm: { estado: "ok" } });
    expect(r.body).not.toContain("ECONNREFUSED");
  });

  it("llama-swap fora do ar: 200, degradado, sem modelos", async () => {
    const llm = { modelos: async () => Promise.reject(new Error("fetch failed")), carregados: async () => [] };
    const r = await montar({ llm, grafo: grafoOk.grafo }).inject({ method: "GET", url: "/api/saude" });
    expect(problemas("Saude", r.json())).toEqual([]);
    expect(r.json()).toMatchObject({ status: "degradado", llm: { estado: "indisponivel" }, modelos: [], neo4j: { estado: "ok" } });
  });

  it("só /running falhou: lista os modelos como não carregados, o llama-swap segue ok", async () => {
    const llm = { modelos: async () => ["qwen"], carregados: async () => Promise.reject(new Error("404")) };
    const r = await montar({ llm, grafo: grafoOk.grafo }).inject({ method: "GET", url: "/api/saude" });
    expect(r.json()).toMatchObject({ status: "ok", modelos: [{ nome: "qwen", carregado: false }] });
  });

  it("sem dependências configuradas: nao_configurado e degradado (e ainda 200)", async () => {
    const r = await montar().inject({ method: "GET", url: "/api/saude" });
    expect(r.statusCode).toBe(200);
    expect(problemas("Saude", r.json())).toEqual([]);
    expect(r.json()).toMatchObject({ status: "degradado", servico: "graphrag-api", llm: { estado: "nao_configurado" }, neo4j: { estado: "nao_configurado" } });
  });

  it("sonda que nunca responde não pendura a rota: estoura o tempo e marca indisponível", async () => {
    const pendurado = new Promise<never>(() => {});
    const t0 = performance.now();
    const r = await montar({ llm: { modelos: () => pendurado, carregados: () => pendurado }, grafo: grafoFalso(() => pendurado as never).grafo, tempoDaSondaMs: 60 }).inject({ method: "GET", url: "/api/saude" });
    expect(performance.now() - t0).toBeLessThan(1500);
    expect(r.json()).toMatchObject({ status: "degradado", llm: { estado: "indisponivel" }, neo4j: { estado: "indisponivel" } });
  });
});

// ---------- 2: fonte ----------

describe("GET /api/fonte/:id", () => {
  const ler = async (rows: Resposta, id = "pai:1", extra: DependenciasApp = {}) => {
    const g = grafoFalso(() => rows);
    const r = await montar({ grafo: g.grafo, ...extra }).inject({ method: "GET", url: `/api/fonte/${encodeURIComponent(id)}` });
    return { r, g };
  };

  it("Pai: texto, faixa de páginas e a seção", async () => {
    const { r } = await ler([{ tipo: "pai", texto: "O Banco tem 3.900 agências.", ini: 6, fim: 7, secao: "1. Atividades do emissor" }]);
    expect(r.statusCode).toBe(200);
    expect(problemas("Fonte", r.json())).toEqual([]);
    expect(r.json()).toEqual({ tipo: "pai", pagina: "p. 6-7", texto: "O Banco tem 3.900 agências.", secao: "1. Atividades do emissor" });
  });

  it("uma página só, e tabela: 'p. 12'", async () => {
    const { r } = await ler([{ tipo: "tabela", texto: "| a | b |", ini: 12, fim: 12, secao: null }]);
    expect(r.json()).toEqual({ tipo: "tabela", pagina: "p. 12", texto: "| a | b |", secao: null });
  });

  it("entidade e comunidade não têm página: null, não uma página inventada", async () => {
    const { r } = await ler([{ tipo: "entidade", texto: "Banco do Brasil S.A.", ini: null, fim: null, secao: null }]);
    expect(r.statusCode).toBe(200);
    expect(r.json().pagina).toBeNull();
    expect(problemas("Fonte", r.json())).toEqual([]);
  });

  it("tipo que o contrato não conhece vira 404, não resposta fora do contrato", async () => {
    const { r } = await ler([{ tipo: "outra_coisa", texto: "x", ini: 1, fim: 1, secao: null }]);
    expect(r.statusCode).toBe(404);
  });

  it("id que não existe: 404 com o Erro do contrato", async () => {
    const { r } = await ler([], "pai:999");
    expect(r.statusCode).toBe(404);
    expect(problemas("Erro", r.json())).toEqual([]);
    expect(r.json().codigo).toBe("fonte_nao_encontrada");
  });

  it("banco fora do ar: 503, sem a mensagem do driver", async () => {
    const { r } = await ler(new Error("Neo4j: connect ECONNREFUSED 127.0.0.1:7687"));
    expect(r.statusCode).toBe(503);
    expect(problemas("Erro", r.json())).toEqual([]);
    expect(r.body).not.toContain("7687");
  });

  it("o id vai como parâmetro e nunca no texto da consulta (injeção)", async () => {
    const id = "x' OR 1=1 //";
    const { r, g } = await ler([], id);
    expect(r.statusCode).toBe(404);
    expect(g.chamadas).toHaveLength(1);
    expect(g.chamadas[0]?.parametros).toEqual({ id });
    expect(g.chamadas[0]?.cypher).not.toContain("OR 1=1");
  });

  it("id enorme é 400 e nem chega ao banco", async () => {
    const { r, g } = await ler([], "a".repeat(201));
    expect(r.statusCode).toBe(400);
    expect(problemas("Erro", r.json())).toEqual([]);
    expect(g.chamadas).toHaveLength(0);
  });

  it("sem Neo4j configurado: 503", async () => {
    const r = await montar().inject({ method: "GET", url: "/api/fonte/pai:1" });
    expect(r.statusCode).toBe(503);
  });

  it("o contrato declara os status que a rota devolve", () => {
    expect(statusDeclarados("/api/fonte/{id}", "get")).toEqual(expect.arrayContaining(["200", "404", "503"]));
  });
});

// ---------- 3: pdf ----------

describe("GET /api/documento/pdf", () => {
  const conteudo = Buffer.from("%PDF-1.7 0123456789 conteudo do arquivo de teste %%EOF");
  const arquivo = () => {
    const caminho = join(pasta(), "fre.pdf");
    writeFileSync(caminho, conteudo);
    return caminho;
  };
  const pedir = (pdf: string, range?: string) => montar({ pdf }).inject({ method: "GET", url: "/api/documento/pdf", ...(range ? { headers: { range } } : {}) });

  it("inteiro: 200, application/pdf, tamanho e aceita faixas", async () => {
    const r = await pedir(arquivo());
    expect(r.statusCode).toBe(200);
    expect(r.headers["content-type"]).toBe("application/pdf");
    expect(r.headers["accept-ranges"]).toBe("bytes");
    expect(Number(r.headers["content-length"])).toBe(conteudo.length);
    expect(r.rawPayload.equals(conteudo)).toBe(true);
  });

  it.each([
    ["bytes=0-4", 0, 4],
    ["bytes=10-19", 10, 19],
    ["bytes=-5", conteudo.length - 5, conteudo.length - 1],
    [`bytes=${conteudo.length - 3}-`, conteudo.length - 3, conteudo.length - 1],
    [`bytes=0-${conteudo.length + 500}`, 0, conteudo.length - 1], // fim além do arquivo: corta no fim
  ])("faixa %s: 206 com Content-Range e só esses bytes", async (range, ini, fim) => {
    const r = await pedir(arquivo(), range as string);
    expect(r.statusCode).toBe(206);
    expect(r.headers["content-range"]).toBe(`bytes ${ini}-${fim}/${conteudo.length}`);
    expect(r.rawPayload.equals(conteudo.subarray(ini as number, (fim as number) + 1))).toBe(true);
  });

  it("faixa que começa depois do fim: 416 com 'bytes */tamanho'", async () => {
    const r = await pedir(arquivo(), `bytes=${conteudo.length + 10}-`);
    expect(r.statusCode).toBe(416);
    expect(r.headers["content-range"]).toBe(`bytes */${conteudo.length}`);
    expect(problemas("Erro", r.json())).toEqual([]);
  });

  it.each(["bytes=a-b", "bytes=5-2", "items=0-4", "bytes=0-1,3-4", "bytes=-"])("cabeçalho %s: ignora e manda o arquivo inteiro", async (range) => {
    const r = await pedir(arquivo(), range);
    expect(r.statusCode).toBe(200);
    expect(r.rawPayload.equals(conteudo)).toBe(true);
  });

  it("arquivo ausente: 404 do contrato, sem o caminho do disco", async () => {
    const caminho = join(pasta(), "nao-existe.pdf");
    const r = await pedir(caminho);
    expect(r.statusCode).toBe(404);
    expect(problemas("Erro", r.json())).toEqual([]);
    expect(r.body).not.toContain("nao-existe");
  });

  it("sem caminho configurado: 404", async () => {
    expect((await montar().inject({ method: "GET", url: "/api/documento/pdf" })).statusCode).toBe(404);
  });
});

// ---------- 4: vizinhança ----------

describe("GET /api/grafo/vizinhanca", () => {
  const BB = { id: "org:bb", rotulo: "Banco do Brasil S.A.", tipo: "Organization" };
  const vizinhos = (n: number) => Array.from({ length: n }, (_, i) => ({ id: `v${i}`, rotulo: `Vizinho ${i}`, tipo: "Organization" }));

  /** Distingue as três consultas pelos parâmetros: `q` (resolver), `id` (vizinhos) e `ids` (arestas). */
  const grafoDeVizinhanca = (opcoes: { entidade?: Linhas; vizinhos?: Linhas; arestas?: Linhas } = {}) =>
    grafoFalso((_c, p) => {
      if ("q" in p) return opcoes.entidade ?? [BB];
      if ("ids" in p) return opcoes.arestas ?? [];
      return opcoes.vizinhos ?? [];
    });
  const pedir = (g: ReturnType<typeof grafoDeVizinhanca>, query: string) => montar({ grafo: g.grafo }).inject({ method: "GET", url: `/api/grafo/vizinhanca?${query}` });

  it("devolve a entidade, os vizinhos e as arestas entre eles", async () => {
    const g = grafoDeVizinhanca({
      vizinhos: vizinhos(2),
      arestas: [
        { origem: "org:bb", destino: "v0", tipo: "SUBSIDIARY_OF" },
        { origem: "v1", destino: "org:bb", tipo: "RELATED_TO" },
      ],
    });
    const r = await pedir(g, "entidade=Banco%20do%20Brasil");
    expect(r.statusCode).toBe(200);
    const corpo = r.json();
    expect(problemas("Vizinhanca", corpo)).toEqual([]);
    expect(corpo.entidade).toEqual({ id: "org:bb", rotulo: "Banco do Brasil S.A.", tipo: "Organization" });
    expect(corpo.nos.map((n: { id: string }) => n.id)).toEqual(["org:bb", "v0", "v1"]);
    expect(corpo.arestas).toHaveLength(2);
    expect(corpo.truncado).toBe(false);
  });

  it("profundidade 2 muda a consulta; a padrão é 1", async () => {
    const g1 = grafoDeVizinhanca();
    await pedir(g1, "entidade=bb");
    expect(g1.chamadas.find((c) => "id" in c.parametros && !("ids" in c.parametros))?.cypher).toContain("*1..1");
    const g2 = grafoDeVizinhanca();
    await pedir(g2, "entidade=bb&profundidade=2");
    expect(g2.chamadas.find((c) => "id" in c.parametros && !("ids" in c.parametros))?.cypher).toContain("*1..2");
  });

  it.each(["", "profundidade=1", "entidade=", "entidade=bb&profundidade=3", "entidade=bb&profundidade=0", "entidade=bb&profundidade=abc", `entidade=${"a".repeat(201)}`])("parâmetro inválido (%s): 400 e nem consulta", async (query) => {
    const g = grafoDeVizinhanca();
    const r = await pedir(g, query);
    expect(r.statusCode).toBe(400);
    expect(problemas("Erro", r.json())).toEqual([]);
    expect(g.chamadas).toHaveLength(0);
  });

  it("entidade desconhecida: 404", async () => {
    const r = await pedir(grafoDeVizinhanca({ entidade: [] }), "entidade=Inexistente");
    expect(r.statusCode).toBe(404);
    expect(r.json().codigo).toBe("entidade_nao_encontrada");
  });

  it("o teto é 100 nós contando a entidade: 99 vizinhos cabem, 100 viram truncado", async () => {
    const cabe = await pedir(grafoDeVizinhanca({ vizinhos: vizinhos(99) }), "entidade=bb");
    expect(cabe.json().nos).toHaveLength(100);
    expect(cabe.json().truncado).toBe(false);
    const sobra = await pedir(grafoDeVizinhanca({ vizinhos: vizinhos(100) }), "entidade=bb");
    expect(problemas("Vizinhanca", sobra.json())).toEqual([]);
    expect(sobra.json().nos).toHaveLength(100);
    expect(sobra.json().truncado).toBe(true);
  });

  it("aresta para nó que não foi devolvido é descartada, e a duplicada também", async () => {
    const g = grafoDeVizinhanca({
      vizinhos: vizinhos(1),
      arestas: [
        { origem: "org:bb", destino: "v0", tipo: "RELATED_TO" },
        { origem: "org:bb", destino: "v0", tipo: "RELATED_TO" },
        { origem: "org:bb", destino: "fora", tipo: "RELATED_TO" },
      ],
    });
    const r = await pedir(g, "entidade=bb");
    expect(r.json().arestas).toEqual([{ origem: "org:bb", destino: "v0", tipo: "RELATED_TO" }]);
  });

  it("a entidade fora dos vizinhos não aparece duas vezes (laço e profundidade 2 trazem ela de volta)", async () => {
    const r = await pedir(grafoDeVizinhanca({ vizinhos: [{ id: "org:bb", rotulo: "Banco do Brasil S.A.", tipo: "Organization" }, ...vizinhos(1)] }), "entidade=bb&profundidade=2");
    expect(r.json().nos.map((n: { id: string }) => n.id)).toEqual(["org:bb", "v0"]);
  });

  it("o nome vai como parâmetro, nunca no texto da consulta; banco fora do ar é 503", async () => {
    const g = grafoDeVizinhanca();
    await pedir(g, `entidade=${encodeURIComponent("x' OR 1=1 //")}`);
    expect(g.chamadas[0]?.parametros["q"]).toBe("x' OR 1=1 //");
    expect(g.chamadas.every((c) => !c.cypher.includes("OR 1=1"))).toBe(true);
    const fora = await pedir(grafoFalso(() => new Error("down")), "entidade=bb");
    expect(fora.statusCode).toBe(503);
    expect(problemas("Erro", fora.json())).toEqual([]);
  });
});

// ---------- 5: feedback ----------

describe("POST /api/feedback", () => {
  const enviar = (app: ReturnType<typeof montar>, payload: unknown, bruto = false) =>
    app.inject({ method: "POST", url: "/api/feedback", headers: { "content-type": "application/json" }, payload: bruto ? (payload as string) : JSON.stringify(payload) });
  const linhas = (arquivo: string) => readFileSync(arquivo, "utf-8").split("\n").filter(Boolean);

  it("grava uma linha JSON por registro, com data, e responde 201", async () => {
    const arquivo = join(pasta(), "sub", "feedback.jsonl"); // a pasta ainda não existe
    const app = montar({ arquivoDeFeedback: arquivo });
    const r1 = await enviar(app, { mensagemId: "m-1", nota: 1 });
    expect(r1.statusCode).toBe(201);
    expect(problemas("FeedbackRegistrado", r1.json())).toEqual([]);
    const r2 = await enviar(app, { mensagemId: "m-2", nota: -1, comentario: 'errou o "lucro"\ne a página' });
    expect(r2.statusCode).toBe(201);
    const l = linhas(arquivo);
    expect(l).toHaveLength(2);
    expect(JSON.parse(l[0] as string)).toMatchObject({ mensagemId: "m-1", nota: 1 });
    expect(JSON.parse(l[0] as string).ts).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(JSON.parse(l[1] as string)).toMatchObject({ mensagemId: "m-2", nota: -1, comentario: 'errou o "lucro"\ne a página' });
  });

  it.each([
    ["nota fora de {1,-1}", { mensagemId: "m", nota: 5 }],
    ["nota 0", { mensagemId: "m", nota: 0 }],
    ["nota como texto", { mensagemId: "m", nota: "1" }],
    ["sem mensagemId", { nota: 1 }],
    ["mensagemId vazio", { mensagemId: "", nota: 1 }],
    ["campo a mais", { mensagemId: "m", nota: 1, extra: true }],
    ["comentário enorme", { mensagemId: "m", nota: 1, comentario: "a".repeat(1001) }],
    ["corpo que não é objeto", [1, 2]],
  ])("%s: 400 do contrato e nada gravado", async (_nome, payload) => {
    const arquivo = join(pasta(), "feedback.jsonl");
    const r = await enviar(montar({ arquivoDeFeedback: arquivo }), payload);
    expect(r.statusCode).toBe(400);
    expect(problemas("Erro", r.json())).toEqual([]);
    expect(() => readFileSync(arquivo)).toThrow();
  });

  it("JSON quebrado: 400 do contrato (não o erro padrão do Fastify)", async () => {
    const r = await enviar(montar({ arquivoDeFeedback: join(pasta(), "f.jsonl") }), "{nota:", true);
    expect(r.statusCode).toBe(400);
    expect(problemas("Erro", r.json())).toEqual([]);
  });

  it("não consegue gravar: 500 do contrato, sem o caminho do disco", async () => {
    const arquivo = join(pasta(), "uma-pasta");
    writeFileSync(arquivo, "x"); // o pai do arquivo é um arquivo comum: mkdir e append falham
    const r = await enviar(montar({ arquivoDeFeedback: join(arquivo, "feedback.jsonl") }), { mensagemId: "m", nota: 1 });
    expect(r.statusCode).toBe(500);
    expect(problemas("Erro", r.json())).toEqual([]);
    expect(r.body).not.toContain("uma-pasta");
  });
});
