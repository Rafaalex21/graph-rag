/** `GET /api/saude`: o serviço, o llama-swap (modelos e quais estão carregados), o Neo4j e os índices. Sempre responde 200. */
import type { FastifyInstance } from "fastify";
import type { DependenciasApp, SondaLlm } from "./tipos.ts";

const TEMPO_PADRAO_MS = 2_000;

type Estado = "ok" | "indisponivel" | "nao_configurado";

/** Resolve com o valor, ou rejeita se passar do tempo (a sonda que pendura não pendura a rota). */
function comTempo<T>(promessa: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((ok, falha) => {
    const t = setTimeout(() => falha(new Error("tempo esgotado")), ms);
    promessa.then(
      (v) => {
        clearTimeout(t);
        ok(v);
      },
      (e: unknown) => {
        clearTimeout(t);
        falha(e instanceof Error ? e : new Error(String(e)));
      },
    );
  });
}

const medir = async <T>(f: () => Promise<T>): Promise<{ valor: T | null; ok: boolean; ms: number }> => {
  const t = performance.now();
  try {
    const valor = await f();
    return { valor, ok: true, ms: Math.round(performance.now() - t) };
  } catch {
    return { valor: null, ok: false, ms: Math.round(performance.now() - t) };
  }
};

async function sondarLlm(llm: SondaLlm | undefined, tempo: number) {
  if (!llm) return { llm: { estado: "nao_configurado" as Estado, ms: 0 }, modelos: [] as { nome: string; carregado: boolean }[] };
  const lista = await medir(() => comTempo(llm.modelos(), tempo));
  if (!lista.ok) return { llm: { estado: "indisponivel" as Estado, ms: lista.ms }, modelos: [] };
  // quais estão carregados é um detalhe: se falhar, o llama-swap continua "ok"
  const carregados = await medir(() => comTempo(llm.carregados(), tempo));
  const na = new Set(carregados.valor ?? []);
  return { llm: { estado: "ok" as Estado, ms: lista.ms + carregados.ms }, modelos: (lista.valor ?? []).map((nome) => ({ nome, carregado: na.has(nome) })) };
}

async function sondarNeo4j(grafo: DependenciasApp["grafo"], tempo: number) {
  if (!grafo) return { neo4j: { estado: "nao_configurado" as Estado, ms: 0 }, indices: [] as { nome: string; estado: string }[] };
  const ping = await medir(() => comTempo(grafo.consultar("RETURN 1 AS ok"), tempo));
  if (!ping.ok) return { neo4j: { estado: "indisponivel" as Estado, ms: ping.ms }, indices: [] };
  const indices = await medir(() => comTempo(grafo.consultar("SHOW INDEXES YIELD name, state, type WHERE type <> 'LOOKUP' RETURN name AS nome, state AS estado ORDER BY name"), tempo));
  return {
    neo4j: { estado: "ok" as Estado, ms: ping.ms },
    indices: (indices.valor ?? []).map((l) => ({ nome: String(l["nome"]), estado: String(l["estado"]) })),
  };
}

export function registrarSaude(app: FastifyInstance, deps: DependenciasApp, versao: string): void {
  app.get("/api/saude", async () => {
    const tempo = deps.tempoDaSondaMs ?? TEMPO_PADRAO_MS;
    const [a, b] = await Promise.all([sondarLlm(deps.llm, tempo), sondarNeo4j(deps.grafo, tempo)]);
    return {
      status: a.llm.estado === "ok" && b.neo4j.estado === "ok" ? "ok" : "degradado",
      servico: "graphrag-api",
      versao,
      llm: a.llm,
      modelos: a.modelos,
      neo4j: b.neo4j,
      indices: b.indices,
    };
  });
}

/** A sonda do llama-swap: `/v1/models` (o que serve) e `/running` (o que está na memória). */
export function sondaLlamaSwap(baseUrl: string, tempoMs = TEMPO_PADRAO_MS): SondaLlm {
  const raiz = baseUrl.replace(/\/+$/, "").replace(/\/v1$/, "");
  const ler = async (caminho: string): Promise<unknown> => {
    const r = await fetch(`${raiz}${caminho}`, { signal: AbortSignal.timeout(tempoMs) });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return r.json();
  };
  return {
    modelos: async () => {
      const c = (await ler("/v1/models")) as { data?: { id?: unknown }[] };
      return (c.data ?? []).map((m) => String(m.id));
    },
    carregados: async () => {
      const c = (await ler("/running")) as { running?: { model?: unknown; state?: unknown }[] };
      return (c.running ?? []).filter((m) => m.state === undefined || m.state === "ready").map((m) => String(m.model));
    },
  };
}
