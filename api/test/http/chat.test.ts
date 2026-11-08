/**
 * Testes do `POST /api/chat` (SSE) e da tradução dos eventos do ciclo (F7.6), escritos antes do código. Cada evento é
 * validado contra o esquema de `contracts/api.openapi.yaml`. Modos de falha:
 *
 *  1. corpo inválido, `mode` ou `profile` não implementados: 400 com o Erro do contrato e o ciclo nem roda;
 *  2. o primeiro evento tem de sair ANTES do ciclo terminar (aceite: ≤ 1 s); um servidor que só escreve no fim não passa;
 *  3. o fluxo SEMPRE termina em `fim` ou em `erro`, nunca nos dois e nunca em silêncio; falha interna não vaza mensagem de
 *     driver, caminho ou pilha;
 *  4. o cliente que desconecta cancela o ciclo e libera a vaga (senão 2 abas fechadas travam a API);
 *  5. no máximo 2 perguntas ao mesmo tempo (os 2 slots do llama-server): a 3ª recebe 429 na hora, não fica na fila; e a vaga
 *     volta quando a pergunta termina, com sucesso, com erro ou cancelada;
 *  6. os eventos refletem o que o agente fez: uma etapa por passo, `cypher` só quando houve consulta, `evidencia` com trecho
 *     curto e página `null` quando não há, `reparo` quando o redator reescreve, e os `token` somam o que o modelo escreveu;
 *  7. `fim` leva o texto com as páginas, as citações com página e as métricas somadas (ciclo + redator);
 *  8. o redator recebe o estado, o que faltou e as evidências do ciclo, e o histórico chega ao ciclo.
 */
import { afterEach, describe, expect, it } from "vitest";
import { criarApp } from "../../src/app.ts";
import type { DependenciasApp } from "../../src/http/tipos.ts";
import type { EventoCiclo, ResultadoCiclo } from "../../src/agente/ciclo.ts";
import type { EntradaRedator, OpcoesRedator, RespostaRedator } from "../../src/agente/redator.ts";
import { traduzirEvento } from "../../src/http/eventos.ts";
import { esquemasDosEventos, problemas } from "./contrato.ts";

// ---------- dublês ----------

const evidenciaDe = (id: string, paginas: string, texto = `texto de ${id}`) => ({ id, tipo: "pai", paginas, caminho: "c", texto, score: 0.9, subpergunta: 0, ferramenta: "buscar_trechos", rodada: 1 });

function resultado(extra: Partial<ResultadoCiclo> = {}): ResultadoCiclo {
  return {
    pergunta: "Qual o lucro?",
    autonoma: "Qual foi o lucro líquido de 2025?",
    estado: "suficiente",
    faltando: "",
    rodadas: [
      {
        rodada: 1,
        agente: { subperguntas: [{ execucoes: [{ ferramenta: "buscar_trechos" }, { ferramenta: "fato_financeiro" }] }, { execucoes: [{ ferramenta: "buscar_trechos" }] }] },
        critica: null,
      },
    ],
    evidencias: [evidenciaDe("p1", "p. 6"), evidenciaDe("p2", "")],
    anotacoes: [],
    etapas_ms: { atualizar: 1, rotear: 1, executar: 1, criticar: 1, total: 4 },
    uso: { entrada: 100, saida: 10 },
    erro: null,
    ...extra,
  } as unknown as ResultadoCiclo;
}

function respostaDoRedator(extra: Partial<RespostaRedator> = {}): RespostaRedator {
  return {
    estado: "suficiente",
    modo: "llm",
    texto: "O lucro foi de R$ 20 bilhões [E1].",
    textoComPaginas: "O lucro foi de R$ 20 bilhões [p. 6].",
    citacoes: [{ ref: "E1", id: "p1", tipo: "pai", paginas: "p. 6" }],
    verificacao: { afirmacoes_numericas: 1, sem_citacao: [], citacoes_invalidas: [], formato_nao_ptbr: [], numeros_sem_lastro: [], declaracoes_de_ausencia: 0 },
    reparos: 0,
    antes_do_reparo: null,
    cortada: false,
    fallback: null,
    uso: { entrada: 400, saida: 40 },
    ms: { total: 5, primeiroToken: 2 },
    ...extra,
  } as RespostaRedator;
}

interface Registro {
  perguntas: string[];
  opcoesDoCiclo: Parameters<NonNullable<DependenciasApp["ciclo"]>>[1][];
  entradasDoRedator: EntradaRedator[];
}

interface Roteiro {
  ciclo?: (pergunta: string, opcoes: Registro["opcoesDoCiclo"][number]) => Promise<ResultadoCiclo>;
  redator?: (entrada: EntradaRedator, opcoes: OpcoesRedator) => Promise<RespostaRedator>;
}

function montar(roteiro: Roteiro = {}, extra: Partial<DependenciasApp> = {}) {
  const registro: Registro = { perguntas: [], opcoesDoCiclo: [], entradasDoRedator: [] };
  const app = criarApp({
    ciclo: async (pergunta, opcoes) => {
      registro.perguntas.push(pergunta);
      registro.opcoesDoCiclo.push(opcoes);
      return roteiro.ciclo ? roteiro.ciclo(pergunta, opcoes) : resultado();
    },
    redator: async (entrada, opcoes) => {
      registro.entradasDoRedator.push(entrada);
      if (roteiro.redator) return roteiro.redator(entrada, opcoes);
      opcoes.progresso?.({ fase: "token", texto: "O lucro foi de R$ 20 bilhões " });
      opcoes.progresso?.({ fase: "token", texto: "[E1]." });
      opcoes.progresso?.({ fase: "fim", ms: 5 });
      return respostaDoRedator();
    },
    ...extra,
  });
  return { app, registro };
}

const abertos: { close(): Promise<unknown> }[] = [];
afterEach(async () => {
  for (const a of abertos.splice(0)) await a.close();
});
async function servir(roteiro: Roteiro = {}, extra: Partial<DependenciasApp> = {}) {
  const { app, registro } = montar(roteiro, extra);
  abertos.push(app);
  await app.listen({ host: "127.0.0.1", port: 0 });
  const porta = (app.server.address() as { port: number }).port;
  return { app, registro, url: `http://127.0.0.1:${porta}/api/chat` };
}

interface Evento {
  evento: string;
  dados: unknown;
  quando: number;
}

/** Lê o fluxo SSE quadro a quadro; `quando` é o instante em que o quadro chegou. */
async function* quadros(resposta: Response): AsyncGenerator<Evento> {
  const leitor = (resposta.body as ReadableStream<Uint8Array>).getReader();
  const decodificador = new TextDecoder();
  let resto = "";
  for (;;) {
    const { done, value } = await leitor.read();
    if (done) break;
    resto += decodificador.decode(value, { stream: true });
    let fim: number;
    while ((fim = resto.indexOf("\n\n")) >= 0) {
      const bloco = resto.slice(0, fim);
      resto = resto.slice(fim + 2);
      const evento = /^event: (.+)$/m.exec(bloco)?.[1];
      const dados = /^data: (.+)$/m.exec(bloco)?.[1];
      if (evento !== undefined && dados !== undefined) yield { evento, dados: JSON.parse(dados), quando: performance.now() };
    }
  }
}
const todos = async (r: Response) => {
  const lista: Evento[] = [];
  for await (const q of quadros(r)) lista.push(q);
  return lista;
};
const pedir = (url: string, corpo: unknown = { conversationId: "c-1", message: "Qual o lucro?" }, init: RequestInit = {}) =>
  fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: typeof corpo === "string" ? corpo : JSON.stringify(corpo), ...init });
const adiante = () => {
  let liberar!: () => void;
  const promessa = new Promise<void>((ok) => (liberar = ok));
  return { promessa, liberar };
};

// ---------- 1: corpo e modos ----------

describe("POST /api/chat: corpo inválido", () => {
  it.each([
    ["sem message", { conversationId: "c" }],
    ["message vazia", { conversationId: "c", message: "" }],
    ["message enorme", { conversationId: "c", message: "a".repeat(4001) }],
    ["sem conversationId", { message: "oi" }],
    ["campo a mais", { conversationId: "c", message: "oi", extra: 1 }],
    ["histórico com papel inválido", { conversationId: "c", message: "oi", historico: [{ papel: "sistema", texto: "x" }] }],
    ["histórico grande demais", { conversationId: "c", message: "oi", historico: Array.from({ length: 21 }, () => ({ papel: "usuario", texto: "x" })) }],
    ["mode desconhecido", { conversationId: "c", message: "oi", mode: "magia" }],
  ])("%s: 400 do contrato e o ciclo nem roda", async (_n, corpo) => {
    const { url, registro } = await servir();
    const r = await pedir(url, corpo);
    expect(r.status).toBe(400);
    expect(problemas("Erro", await r.json())).toEqual([]);
    expect(registro.perguntas).toEqual([]);
  });

  it("JSON quebrado: 400 do contrato", async () => {
    const { url } = await servir();
    const r = await pedir(url, "{message:");
    expect(r.status).toBe(400);
    expect(problemas("Erro", await r.json())).toEqual([]);
  });

  it.each([
    [{ mode: "trechos" }, "modo_nao_implementado"],
    [{ mode: "cypher" }, "modo_nao_implementado"],
  ])("%j ainda não é implementado: 400 %s", async (extra, codigo) => {
    const { url, registro } = await servir();
    const r = await pedir(url, { conversationId: "c", message: "oi", ...extra });
    expect(r.status).toBe(400);
    expect(((await r.json()) as { codigo: string }).codigo).toBe(codigo);
    expect(registro.perguntas).toEqual([]);
  });

  it("profile consultar-rapido é aceito e o ciclo roda em modo rápido; consultar e o padrão, não", async () => {
    const { url, registro } = await servir();
    for (const extra of [{ profile: "consultar-rapido" }, { profile: "consultar" }, {}]) {
      const r = await pedir(url, { conversationId: "c", message: "oi", ...extra });
      expect(r.status).toBe(200);
      await r.text();
    }
    expect(registro.opcoesDoCiclo.map((o) => o.rapido)).toEqual([true, false, false]);
  });

  it("profile que não existe: 400 requisicao_invalida e o ciclo nem roda", async () => {
    const { url, registro } = await servir();
    const r = await pedir(url, { conversationId: "c", message: "oi", profile: "turbo" });
    expect(r.status).toBe(400);
    expect(((await r.json()) as { codigo: string }).codigo).toBe("requisicao_invalida");
    expect(registro.perguntas).toEqual([]);
  });

  it("mode auto e profile consultar explícitos funcionam", async () => {
    const { url } = await servir();
    const r = await pedir(url, { conversationId: "c", message: "oi", mode: "auto", profile: "consultar" });
    expect(r.status).toBe(200);
    await todos(r);
  });
});

// ---------- 2 e 3: primeiro evento, fim ou erro ----------

describe("o fluxo", () => {
  it("o primeiro evento sai antes de o ciclo terminar (o ciclo está preso)", async () => {
    const trava = adiante();
    const { url } = await servir({ ciclo: async () => (await trava.promessa, resultado()) });
    const t0 = performance.now();
    const r = await pedir(url);
    expect(r.status).toBe(200);
    expect(r.headers.get("content-type")).toContain("text/event-stream");
    expect(r.headers.get("cache-control")).toContain("no-cache");
    const it = quadros(r);
    const primeiro = await it.next();
    expect(performance.now() - t0).toBeLessThan(1000);
    expect(primeiro.value).toMatchObject({ evento: "etapa" });
    expect(problemas("EventoEtapa", (primeiro.value as Evento).dados)).toEqual([]);
    trava.liberar();
    for await (const _ of it) void _;
  });

  it("fluxo feliz: cada evento confere com o contrato, termina em `fim` e só nele", async () => {
    const { url } = await servir();
    const eventos = await todos(await pedir(url));
    const esquemas = esquemasDosEventos();
    for (const e of eventos) {
      expect(esquemas[e.evento], `evento ${e.evento} não existe no contrato`).toBeDefined();
      expect(problemas(esquemas[e.evento] as string, e.dados), e.evento).toEqual([]);
    }
    const nomes = eventos.map((e) => e.evento);
    expect(nomes[0]).toBe("etapa");
    expect(nomes.at(-1)).toBe("fim");
    expect(nomes.filter((n) => n === "fim")).toHaveLength(1);
    expect(nomes).not.toContain("erro");
    // ordem: etapas, depois evidências, depois tokens, por último fim
    const ultimaEtapa = nomes.lastIndexOf("etapa");
    expect(nomes.indexOf("evidencia")).toBeGreaterThan(-1);
    expect(nomes.indexOf("token")).toBeGreaterThan(nomes.lastIndexOf("evidencia"));
    expect(ultimaEtapa).toBeLessThan(nomes.indexOf("token"));
  });

  it("os tokens somam o que o redator escreveu; `fim` traz o texto com páginas, as citações e as métricas somadas", async () => {
    const { url } = await servir();
    const eventos = await todos(await pedir(url));
    const tokens = eventos.filter((e) => e.evento === "token").map((e) => (e.dados as { t: string }).t);
    expect(tokens.join("")).toBe("O lucro foi de R$ 20 bilhões [E1].");
    const fim = eventos.at(-1)?.dados as { resposta: string; citacoes: unknown[]; metricas: Record<string, unknown> };
    expect(fim.resposta).toBe("O lucro foi de R$ 20 bilhões [p. 6].");
    expect(fim.citacoes).toEqual([{ id: "p1", pagina: "p. 6" }]);
    expect(fim.metricas).toMatchObject({ tokensEntrada: 500, tokensSaida: 50, estado: "suficiente" });
    expect(fim.metricas["rota"]).toEqual(["buscar_trechos", "fato_financeiro"]); // sem repetir
    expect(Number(fim.metricas["latenciaMs"])).toBeGreaterThanOrEqual(0);
  });

  it("citação sem página vira pagina null", async () => {
    const { url } = await servir({ redator: async () => respostaDoRedator({ citacoes: [{ ref: "E2", id: "p2", tipo: "pagina", paginas: "" }] }) });
    const fim = (await todos(await pedir(url))).at(-1)?.dados as { citacoes: unknown[] };
    expect(fim.citacoes).toEqual([{ id: "p2", pagina: null }]);
  });

  it("falha interna do ciclo: termina em `erro` (nunca em `fim`) sem vazar a mensagem do driver", async () => {
    const { url } = await servir({ ciclo: async () => Promise.reject(new Error("Neo4j: connect ECONNREFUSED 127.0.0.1:7687 at C:\\segredo\\x.ts")) });
    const eventos = await todos(await pedir(url));
    const ultimo = eventos.at(-1) as Evento;
    expect(ultimo.evento).toBe("erro");
    expect(problemas("Erro", ultimo.dados)).toEqual([]);
    expect(JSON.stringify(ultimo.dados)).not.toMatch(/7687|segredo|ECONNREFUSED/);
    expect(eventos.map((e) => e.evento)).not.toContain("fim");
  });

  it("falha do redator também termina em `erro`", async () => {
    const { url } = await servir({ redator: async () => Promise.reject(new Error("boom")) });
    const eventos = await todos(await pedir(url));
    expect(eventos.at(-1)?.evento).toBe("erro");
    expect(eventos.map((e) => e.evento)).not.toContain("fim");
  });

  it("LLM indisponível é um código próprio, para o cliente poder dizer 'tente de novo'", async () => {
    const { LlmIndisponivelError } = await import("../../src/llm/index.ts");
    const { url } = await servir({ ciclo: async () => Promise.reject(new LlmIndisponivelError("http://127.0.0.1:8080", "chat", new Error("down"))) });
    const eventos = await todos(await pedir(url));
    expect((eventos.at(-1)?.dados as { codigo: string }).codigo).toBe("llm_indisponivel");
  });
});

// ---------- 4 e 5: desconexão e limite ----------

describe("cancelamento e limite de perguntas simultâneas", () => {
  it("o cliente que desconecta cancela o ciclo (o sinal chega abortado) e libera a vaga", async () => {
    let sinal: AbortSignal | undefined;
    const trava = adiante();
    const { url } = await servir({
      ciclo: async (_p, o) => {
        sinal = o.signal;
        await trava.promessa;
        return resultado();
      },
    });
    const ac = new AbortController();
    const r = await pedir(url, undefined, { signal: ac.signal });
    const it = quadros(r);
    await it.next();
    ac.abort();
    await new Promise((ok) => setTimeout(ok, 150));
    expect(sinal?.aborted).toBe(true);
    trava.liberar();
  });

  it("2 perguntas em andamento ocupam as vagas: a 3ª leva 429 `ocupado` na hora; ao terminar, a vaga volta", async () => {
    const trava = adiante();
    const { url } = await servir({ ciclo: async () => (await trava.promessa, resultado()) });
    const a = await pedir(url);
    const b = await pedir(url);
    expect([a.status, b.status]).toEqual([200, 200]);
    const ia = quadros(a);
    const ib = quadros(b);
    await ia.next();
    await ib.next();
    const c = await pedir(url);
    expect(c.status).toBe(429);
    expect(problemas("Erro", await c.json())).toEqual([]);
    trava.liberar();
    for await (const _ of ia) void _;
    for await (const _ of ib) void _;
    await new Promise((ok) => setTimeout(ok, 50));
    const d = await pedir(url);
    expect(d.status).toBe(200);
    await todos(d);
  });

  it("a vaga volta também quando a pergunta falha", async () => {
    const { url } = await servir({ ciclo: async () => Promise.reject(new Error("x")) }, { maxPerguntas: 1 });
    for (let i = 0; i < 3; i++) {
      const r = await pedir(url);
      expect(r.status).toBe(200);
      await todos(r);
      await new Promise((ok) => setTimeout(ok, 30));
    }
  });
});

// ---------- 6, 7 e 8: o que os eventos dizem ----------

describe("conteúdo dos eventos", () => {
  it("`evidencia`: trecho curto (400), página null quando não há, uma por evidência do ciclo", async () => {
    const longa = "x".repeat(900);
    const { url } = await servir({ ciclo: async () => resultado({ evidencias: [evidenciaDe("p1", "p. 6", longa), evidenciaDe("p2", "")] as never }) });
    const evs = (await todos(await pedir(url))).filter((e) => e.evento === "evidencia").map((e) => e.dados as { id: string; trecho: string; pagina: string | null });
    expect(evs.map((e) => e.id)).toEqual(["p1", "p2"]);
    expect(evs[0]?.trecho.length).toBeLessThanOrEqual(400);
    expect(evs[1]?.pagina).toBeNull();
    expect(evs[0]?.pagina).toBe("p. 6");
  });

  it("o redator recebe a pergunta autônoma, o estado, o que faltou e as evidências do ciclo; o histórico chega ao ciclo", async () => {
    const historico = [{ papel: "usuario", texto: "Quem preside o conselho?" }, { papel: "assistente", texto: "Fulano." }];
    const { url, registro } = await servir({ ciclo: async () => resultado({ estado: "incompleta", faltando: "o valor de 2024" }) });
    const r = await pedir(url, { conversationId: "c", message: "e o de 2024?", historico });
    await todos(r);
    expect(registro.perguntas).toEqual(["e o de 2024?"]);
    expect(registro.opcoesDoCiclo[0]?.historico).toEqual(historico);
    expect(registro.entradasDoRedator[0]).toMatchObject({ pergunta: "Qual foi o lucro líquido de 2025?", estado: "incompleta", faltando: "o valor de 2024" });
    expect(registro.entradasDoRedator[0]?.evidencias.map((e) => e.id)).toEqual(["p1", "p2"]);
    expect(registro.entradasDoRedator[0]?.historico).toEqual(historico);
  });

  it("`reparo` do redator vira etapa `reparo`", async () => {
    const { url } = await servir({
      redator: async (_e, o) => {
        o.progresso?.({ fase: "token", texto: "a" });
        o.progresso?.({ fase: "reparo", frases: 2 });
        o.progresso?.({ fase: "fim", ms: 3 });
        return respostaDoRedator({ reparos: 1 });
      },
    });
    const etapas = (await todos(await pedir(url))).filter((e) => e.evento === "etapa").map((e) => e.dados as { tipo: string; detalhe: Record<string, unknown> });
    expect(etapas.find((e) => e.tipo === "reparo")?.detalhe).toMatchObject({ frases: 2 });
  });

  it("as etapas do ciclo viram eventos `etapa` e `cypher` na ordem em que chegam", async () => {
    const { url } = await servir({
      ciclo: async (_p, o) => {
        o.progresso?.({ fase: "atualizacao", subperguntas: 1, fallback: null, ms: 10, rodada: 1 });
        o.progresso?.({ fase: "roteamento", indice: 0, onda: 0, rota: "ferramentas", ferramentas: ["consultar_grafo"], fallback: null, ms: 20, rodada: 1 });
        o.progresso?.({ fase: "execucao", indice: 0, ferramentas: [{ ferramenta: "consultar_grafo", erro: null, evidencias: 1, ms: 30, cypher: { query: "MATCH (n) RETURN n", linhas: 3 } }], evidencias: 1, ms: 30, rodada: 1 });
        o.progresso?.({ fase: "critica", rodada: 1, decisao: "suficiente", perguntas: 0, faltando: "", ms: 40 });
        return resultado();
      },
    });
    const eventos = await todos(await pedir(url));
    const sequencia = eventos.filter((e) => e.evento === "etapa" || e.evento === "cypher").map((e) => (e.evento === "etapa" ? (e.dados as { tipo: string }).tipo : "cypher"));
    // o primeiro `etapa` é o aviso imediato; depois vem o que o ciclo contou
    expect(sequencia.slice(1)).toEqual(["reescrita", "rota", "ferramenta_inicio", "ferramenta_fim", "cypher", "critica"]);
    expect(eventos.find((e) => e.evento === "cypher")?.dados).toMatchObject({ query: "MATCH (n) RETURN n", linhas: 3 });
  });
});

describe("traduzirEvento", () => {
  const traduz = (e: EventoCiclo) => traduzirEvento(e);

  it("o `fim` do agente não vira evento (o fim da pergunta é do redator)", () => {
    expect(traduz({ fase: "fim", evidencias: 3, ms: 9, rodada: 1 })).toEqual([]);
  });

  it("execução sem cypher não emite `cypher`; com erro de ferramenta o erro vai no detalhe", () => {
    const q = traduz({ fase: "execucao", indice: 1, ferramentas: [{ ferramenta: "buscar_tabelas", erro: "reranker_fora", evidencias: 0, ms: 4, cypher: null }], evidencias: 0, ms: 4, rodada: 2 });
    expect(q.map((x) => x.evento)).toEqual(["etapa"]);
    expect(q[0]?.dados).toMatchObject({ tipo: "ferramenta_fim", detalhe: { ferramenta: "buscar_tabelas", erro: "reranker_fora", rodada: 2, indice: 1 } });
  });

  it("rota `nenhuma` não tem ferramenta_inicio", () => {
    const q = traduz({ fase: "roteamento", indice: 0, onda: 0, rota: "nenhuma", ferramentas: [], fallback: null, ms: 5, rodada: 1 });
    expect(q.map((x) => (x.dados as { tipo: string }).tipo)).toEqual(["rota"]);
  });

  it("toda saída confere com o contrato", () => {
    const entradas: EventoCiclo[] = [
      { fase: "atualizacao", subperguntas: 2, fallback: "llm_falhou", ms: 3, rodada: 1 },
      { fase: "roteamento", indice: 0, onda: 0, rota: "ferramentas", ferramentas: ["a", "b"], fallback: null, ms: 3, rodada: 1 },
      { fase: "execucao", indice: 0, ferramentas: [{ ferramenta: "consultar_grafo", erro: null, evidencias: 2, ms: 3, cypher: { query: "RETURN 1", linhas: 1 } }], evidencias: 2, ms: 3, rodada: 1 },
      { fase: "critica", rodada: 1, decisao: "buscar_mais", perguntas: 2, faltando: "x", ms: 3 },
    ];
    const esquemas = esquemasDosEventos();
    for (const e of entradas) for (const q of traduz(e)) expect(problemas(esquemas[q.evento] as string, q.dados), `${e.fase}/${q.evento}`).toEqual([]);
  });
});
