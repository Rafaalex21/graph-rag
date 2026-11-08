/**
 * Testes do registro de cada requisição (F7.7), escritos antes do código: o `montarRegistroChat` e a ligação no `/api/chat` e
 * nas demais rotas. Modos de falha:
 *
 *  1. UM registro por requisição (nem zero nem dois), seja `fim`, `erro`, cancelada ou recusada (400/429);
 *  2. o registro conta o que o agente fez: ferramentas agrupadas, tokens somados (ciclo + redator), tempo por etapa, estado;
 *  3. o texto da pergunta e da resposta NÃO vai para o log; nem a mensagem do erro real (pode trazer trecho do documento);
 *  4. um registrador que quebra ou pendura não atrasa nem derruba a resposta;
 *  5. o `mensagemId` do `fim` é o `id` do registro (o feedback e a telemetria se ligam por ele);
 *  6. as rotas comuns são registradas pelo PADRÃO (`/api/fonte/:id`), sem o id nem a query.
 */
import { afterEach, describe, expect, it } from "vitest";
import { criarApp } from "../../src/app.ts";
import type { ResultadoCiclo } from "../../src/agente/ciclo.ts";
import type { RespostaRedator } from "../../src/agente/redator.ts";
import type { DependenciasApp } from "../../src/http/tipos.ts";
import { montarRegistroChat } from "../../src/telemetria/chat.ts";
import type { Registrador } from "../../src/telemetria/registro.ts";
import type { Registro, RegistroChat, RegistroHttp } from "../../src/telemetria/tipos.ts";
import { problemas } from "../http/contrato.ts";

const exec = (ferramenta: string, ms: number, erro: string | null = null, evidencias = 2) => ({ ferramenta, erro, evidencias, ms, argumentos: {}, aviso: null, omitido: {}, latencia_ms: null, complemento: false, cypher: null });

function ciclo(extra: Partial<ResultadoCiclo> = {}): ResultadoCiclo {
  return {
    pergunta: "Qual o lucro? (texto sigiloso da pergunta)",
    autonoma: "Qual foi o lucro líquido de 2025?",
    estado: "suficiente",
    faltando: "",
    rodadas: [
      { rodada: 1, agente: { subperguntas: [{ execucoes: [exec("buscar_trechos", 100), exec("fato_financeiro", 50, "sem_dado", 0)] }, { execucoes: [exec("buscar_trechos", 300)] }] }, critica: null },
      { rodada: 2, agente: { subperguntas: [{ execucoes: [exec("buscar_trechos", 200)] }] }, critica: null },
    ],
    evidencias: [{ id: "p1", tipo: "pai", paginas: "p. 6", caminho: "c", texto: "texto sigiloso do documento", score: 1, subpergunta: 0, ferramenta: "buscar_trechos", rodada: 1 }],
    anotacoes: [{ tipo: "ferramenta_falhou", rodada: 1 }, { tipo: "ferramenta_falhou", rodada: 2 }, { tipo: "fallback_do_critico", rodada: 1 }],
    etapas_ms: { atualizar: 400, rotear: 600, executar: 800, criticar: 900, total: 2_700 },
    uso: { entrada: 3_000, saida: 200 },
    erro: null,
    ...extra,
  } as unknown as ResultadoCiclo;
}
const redator = (extra: Partial<RespostaRedator> = {}): RespostaRedator =>
  ({ estado: "suficiente", modo: "llm", texto: "O lucro foi R$ 20 bilhões [E1]. (texto sigiloso da resposta)", textoComPaginas: "x", citacoes: [], reparos: 1, cortada: false, fallback: null, uso: { entrada: 500, saida: 80 }, ms: { total: 4_100, primeiroToken: 2_000 }, ...extra }) as unknown as RespostaRedator;

const base = { id: "req-1", inicio: new Date("2026-11-07T15:00:00.000Z"), conversationId: "conv-9", mensagem: "Qual o lucro? (texto sigiloso da pergunta)", comTexto: false, ms: { total: 9_000, primeiroEvento: 3, primeiroToken: 5_500 } };

describe("montarRegistroChat", () => {
  it("fim: estado, rodadas, tokens somados do ciclo e do redator, tempo por etapa e do redator", () => {
    const r = montarRegistroChat({ ...base, resultado: "fim", codigo: null, ciclo: ciclo(), resposta: redator() });
    expect(r).toMatchObject({ v: 1, tipo: "chat", id: "req-1", ts: "2026-11-07T15:00:00.000Z", conversationId: "conv-9", resultado: "fim", codigo: null, estado: "suficiente", rodadas: 2, evidencias: 1 });
    expect(r.tokens).toEqual({ entrada: 3_500, saida: 280 });
    expect(r.latencia_ms).toEqual({ total: 9_000, primeiro_evento: 3, primeiro_token: 5_500, atualizar: 400, rotear: 600, executar: 800, criticar: 900, redator: 4_100 });
    expect(r.redator).toEqual({ modo: "llm", reparos: 1, cortada: false, fallback: null });
  });

  it("agrupa as ferramentas das duas rodadas: chamadas, erros, evidências e tempo somado; a mais chamada primeiro", () => {
    const r = montarRegistroChat({ ...base, resultado: "fim", codigo: null, ciclo: ciclo(), resposta: redator() });
    expect(r.ferramentas).toEqual([
      { nome: "buscar_trechos", chamadas: 3, erros: 0, evidencias: 6, ms: 600 },
      { nome: "fato_financeiro", chamadas: 1, erros: 1, evidencias: 0, ms: 50 },
    ]);
  });

  it("conta as anotações por tipo", () => {
    const r = montarRegistroChat({ ...base, resultado: "fim", codigo: null, ciclo: ciclo(), resposta: redator() });
    expect(r.anotacoes).toEqual({ ferramenta_falhou: 2, fallback_do_critico: 1 });
  });

  it("sem ciclo (recusada ou erro cedo): sem estado nem ferramentas, tempos nulos, tokens zero", () => {
    const r = montarRegistroChat({ ...base, resultado: "recusada", codigo: "ocupado", ciclo: null, resposta: null, ms: { total: 1, primeiroEvento: null, primeiroToken: null } });
    expect(r).toMatchObject({ resultado: "recusada", codigo: "ocupado", estado: null, rodadas: 0, ferramentas: [], evidencias: 0, redator: null, tokens: { entrada: 0, saida: 0 } });
    expect(r.latencia_ms).toEqual({ total: 1, primeiro_evento: null, primeiro_token: null, atualizar: null, rotear: null, executar: null, criticar: null, redator: null });
  });

  it("ciclo pronto mas redator que falhou: guarda o que o ciclo fez e deixa o redator nulo", () => {
    const r = montarRegistroChat({ ...base, resultado: "erro", codigo: "falha_interna", ciclo: ciclo(), resposta: null });
    expect(r.estado).toBe("suficiente");
    expect(r.tokens).toEqual({ entrada: 3_000, saida: 200 });
    expect(r.redator).toBeNull();
    expect(r.latencia_ms.redator).toBeNull();
  });

  it("não leva o texto da pergunta, da resposta nem das evidências; só tamanho e impressão digital", () => {
    const r = montarRegistroChat({ ...base, resultado: "fim", codigo: null, ciclo: ciclo(), resposta: redator() });
    const texto = JSON.stringify(r);
    expect(texto).not.toContain("sigiloso");
    expect(r.pergunta.caracteres).toBe(base.mensagem.length);
    expect(r.pergunta.hash).toMatch(/^[0-9a-f]{16}$/);
  });

  it("com a opção de texto ligada, a pergunta (e só ela) vai", () => {
    const r = montarRegistroChat({ ...base, comTexto: true, resultado: "fim", codigo: null, ciclo: ciclo(), resposta: redator() });
    expect(r.pergunta.texto).toBe(base.mensagem);
    expect(JSON.stringify(r)).not.toContain("sigiloso do documento");
  });
});

// ---------- ligação nas rotas ----------

function registradorFalso(): Registrador & { itens: Registro[] } {
  const itens: Registro[] = [];
  return { itens, registrar: (r) => void itens.push(r), aguardar: async () => {} };
}

const abertos: { close(): Promise<unknown> }[] = [];
afterEach(async () => {
  for (const a of abertos.splice(0)) await a.close();
});
async function servir(extra: Partial<DependenciasApp> = {}, reg = registradorFalso()) {
  const app = criarApp({
    ciclo: async () => ciclo(),
    redator: async (_e, o) => {
      o.progresso?.({ fase: "token", texto: "O lucro" });
      return redator();
    },
    telemetria: reg,
    ...extra,
  });
  abertos.push(app);
  await app.listen({ host: "127.0.0.1", port: 0 });
  return { url: `http://127.0.0.1:${(app.server.address() as { port: number }).port}`, reg, app };
}
const pedir = (url: string, corpo: unknown = { conversationId: "c", message: "Qual o lucro?" }, init: RequestInit = {}) => fetch(`${url}/api/chat`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(corpo), ...init });
const ler = async (r: Response) => (await r.text()).split("\n\n").filter(Boolean).map((b) => ({ evento: /^event: (.+)$/m.exec(b)?.[1] ?? "", dados: JSON.parse(/^data: (.+)$/m.exec(b)?.[1] ?? "null") as Record<string, unknown> }));
const doChat = (reg: { itens: Registro[] }) => reg.itens.filter((r): r is RegistroChat => r.tipo === "chat");
const dasRotas = (reg: { itens: Registro[] }) => reg.itens.filter((r): r is RegistroHttp => r.tipo === "http");
const esperar = (ms = 80) => new Promise((ok) => setTimeout(ok, ms));

describe("/api/chat registra", () => {
  it("uma pergunta respondida: um registro `fim`, com o mesmo id do `mensagemId` do evento `fim`", async () => {
    const { url, reg } = await servir();
    const eventos = await ler(await pedir(url));
    const fim = eventos.at(-1);
    expect(fim?.evento).toBe("fim");
    expect(problemas("EventoFim", fim?.dados)).toEqual([]);
    await esperar();
    expect(doChat(reg)).toHaveLength(1);
    expect(doChat(reg)[0]).toMatchObject({ resultado: "fim", conversationId: "c", estado: "suficiente" });
    expect(doChat(reg)[0]?.id).toBe(fim?.dados["mensagemId"]);
    expect(doChat(reg)[0]?.latencia_ms.primeiro_token).not.toBeNull();
  });

  it("falha do ciclo: um registro `erro` com o código, sem a mensagem real do erro", async () => {
    const { url, reg } = await servir({ ciclo: async () => Promise.reject(new Error("trecho do documento no erro")) });
    const eventos = await ler(await pedir(url));
    expect(eventos.at(-1)?.evento).toBe("erro");
    await esperar();
    expect(doChat(reg)).toHaveLength(1);
    expect(doChat(reg)[0]).toMatchObject({ resultado: "erro", codigo: "falha_interna", estado: null });
    expect(JSON.stringify(reg.itens)).not.toContain("trecho do documento");
  });

  it("cliente que desconecta: um registro `cancelada`", async () => {
    let solta!: () => void;
    const trava = new Promise<void>((ok) => (solta = ok));
    const { url, reg } = await servir({ ciclo: async () => (await trava, ciclo()) });
    const ac = new AbortController();
    const r = await pedir(url, undefined, { signal: ac.signal });
    await (r.body as ReadableStream<Uint8Array>).getReader().read();
    ac.abort();
    await esperar(150);
    solta();
    await esperar(150);
    expect(doChat(reg)).toHaveLength(1);
    expect(doChat(reg)[0]?.resultado).toBe("cancelada");
  });

  it.each([
    [{ conversationId: "c", message: "" }, 400, "requisicao_invalida"],
    [{ conversationId: "c", message: "oi", mode: "global" }, 400, "modo_nao_implementado"],
    [{ conversationId: "c", message: "oi", profile: "turbo" }, 400, "requisicao_invalida"],
  ])("recusa %j: um registro `recusada` com o código", async (corpo, status, codigo) => {
    const { url, reg } = await servir();
    const r = await pedir(url, corpo);
    expect(r.status).toBe(status);
    await esperar();
    expect(doChat(reg)).toHaveLength(1);
    expect(doChat(reg)[0]).toMatchObject({ resultado: "recusada", codigo });
  });

  it("429: registrada como `recusada` `ocupado`, além das duas em andamento", async () => {
    let solta!: () => void;
    const trava = new Promise<void>((ok) => (solta = ok));
    const { url, reg } = await servir({ ciclo: async () => (await trava, ciclo()) });
    const leitores = [await pedir(url), await pedir(url)].map((r) => (r.body as ReadableStream<Uint8Array>).getReader());
    for (const l of leitores) await l.read();
    const c = await pedir(url);
    expect(c.status).toBe(429);
    await esperar();
    expect(doChat(reg).map((x) => x.resultado)).toEqual(["recusada"]);
    solta();
    for (const l of leitores) while (!(await l.read()).done);
    await esperar();
    expect(doChat(reg).map((x) => x.resultado).sort()).toEqual(["fim", "fim", "recusada"]);
  });

  it("registrador que lança não derruba a resposta", async () => {
    const reg: Registrador = { registrar: () => { throw new Error("log quebrou"); }, aguardar: async () => {} }; // prettier-ignore
    const { url } = await servir({}, reg as never);
    const eventos = await ler(await pedir(url));
    expect(eventos.at(-1)?.evento).toBe("fim");
  });
});

describe("rotas comuns registram o padrão da rota", () => {
  it("fonte: `/api/fonte/:id`, sem o id, com o status e o tempo", async () => {
    const { url, reg } = await servir({ grafo: { consultar: async () => [] } });
    await fetch(`${url}/api/fonte/segredo-123`);
    await esperar();
    const h = dasRotas(reg);
    expect(h).toHaveLength(1);
    expect(h[0]).toMatchObject({ metodo: "GET", rota: "/api/fonte/:id", status: 404 });
    expect(h[0]?.ms).toBeGreaterThanOrEqual(0);
    expect(JSON.stringify(reg.itens)).not.toContain("segredo-123");
  });

  it("vizinhança: sem a query (o nome da entidade) no registro", async () => {
    const { url, reg } = await servir({ grafo: { consultar: async () => [] } });
    await fetch(`${url}/api/grafo/vizinhanca?entidade=Nome%20Reservado`);
    await esperar();
    expect(dasRotas(reg)[0]).toMatchObject({ rota: "/api/grafo/vizinhanca", status: 404 });
    expect(JSON.stringify(reg.itens)).not.toContain("Reservado");
  });

  it("rota que não existe vira `desconhecida`, não a URL pedida (senão cada URL inventada é uma linha do relatório)", async () => {
    const { url, reg } = await servir();
    await fetch(`${url}/api/qualquer-coisa-123`);
    await esperar();
    expect(dasRotas(reg)[0]).toMatchObject({ rota: "desconhecida", status: 404 });
  });

  it("o /api/chat não gera registro `http` além do `chat`", async () => {
    const { url, reg } = await servir();
    await (await pedir(url)).text();
    await esperar();
    expect(dasRotas(reg)).toEqual([]);
  });
});
