/**
 * Testes do ciclo agente + crítico (F7.4), escritos antes do código. Modos de falha:
 *
 *  1. teto: um crítico que pede "buscar_mais" para sempre NUNCA passa de 2 rodadas, nem de 2 chamadas ao atualizador/crítico
 *     por rodada, e a segunda rodada não repete o atualizador;
 *  2. pergunta fora do escopo (rota `nenhuma`, saudação) não chama o crítico: não há o que criticar;
 *  3. "ausente" (o documento não tem a informação) encerra na 1ª rodada, com o que faltou, sem insistir na busca;
 *  4. falha do crítico (LLM fora do ar) não vira rodada extra nem derruba a pergunta;
 *  5. falha de ferramenta na rodada extra é anotada com a rodada, como na primeira;
 *  6. as evidências das duas rodadas se juntam sem repetição, com a rodada de origem, e as com página vêm primeiro;
 *  7. o cancelamento do chamador sobe; o progresso ganha o evento `critica` e a rodada em todos os eventos;
 *  8. o tempo do crítico entra em `etapas_ms`, e o `uso` soma as duas rodadas e os dois críticos.
 */
import { describe, expect, it } from "vitest";
import { MAX_RODADAS, executarCiclo, type EventoCiclo } from "../../src/agente/ciclo.ts";
import { executarAgente, type ExecutorDoAgente, type LlmDoAgente } from "../../src/agente/agente.ts";
import type { Envelope, Evidencia } from "../../src/ferramentas/contrato.ts";
import { LlmAbortadoError, LlmIndisponivelError, type Mensagem } from "../../src/llm/index.ts";

// ---------- dublês ----------

type Bruta = { nome: string; argumentos: Record<string, unknown> };
type Rota = Bruta[] | { texto: string };
type SaidaCritico = { decisao: string; perguntas: string[]; faltando: string } | Error;

function llmFalso(opcoes: { subs: { pergunta: string }[]; rotas: Record<string, Rota>; criticos: SaidaCritico[] }) {
  const contagem = { atualizador: 0, critico: 0 };
  const mensagensDoCritico: Mensagem[][] = [];
  let ic = 0;
  const llm: LlmDoAgente = {
    chatJson: async (mensagens, o) => {
      const sistema = String(mensagens[0]?.content ?? "");
      let bruto: unknown;
      if (sistema.startsWith("Você é o crítico")) {
        contagem.critico++;
        mensagensDoCritico.push(mensagens);
        const s = opcoes.criticos[Math.min(ic++, opcoes.criticos.length - 1)] as SaidaCritico;
        if (s instanceof Error) throw s;
        bruto = s;
      } else {
        contagem.atualizador++;
        bruto = { autonoma: opcoes.subs[0]?.pergunta ?? "x", subperguntas: opcoes.subs.map((s) => ({ pergunta: s.pergunta, depende_de: [] })) };
      }
      return { valor: o?.validar ? o.validar(bruto) : bruto, texto: "", raciocinio: "", fim: "stop", uso: { entrada: 100, saida: 10 }, modelo: "q", ms: 5 } as never;
    },
    chamarFerramentas: async (mensagens) => {
      const usuario = String(mensagens[1]?.content ?? "");
      const pergunta = /Pergunta atual: (.*)$/m.exec(usuario)?.[1] ?? "";
      const r = opcoes.rotas[pergunta] ?? [{ nome: "buscar_trechos", argumentos: { pergunta } }];
      const lista = Array.isArray(r) ? r : [];
      return {
        texto: Array.isArray(r) ? "" : r.texto,
        raciocinio: "",
        fim: lista.length > 0 ? "tool_calls" : "stop",
        uso: { entrada: 300, saida: 20 },
        modelo: "q",
        ms: 5,
        chamadas: lista.map((x, i) => ({ id: `c${i}`, nome: x.nome, argumentos: x.argumentos })),
      } as never;
    },
  };
  return { llm, contagem, mensagensDoCritico };
}

const ev = (id: string, paginas: string, texto = `texto de ${id}`): Evidencia => ({ id, tipo: "trecho", paginas, caminho: "c", texto, score: 1 });
const env = (evidencias: Evidencia[], extra: Partial<Envelope> = {}): Envelope => ({
  ferramenta: "buscar_trechos", parametros: {}, evidencias, aviso: null, erro: null, sugestoes: [], omitido: {}, latencia_ms: 3, ...extra,
}); // prettier-ignore

function executorFalso(porPergunta: (pergunta: string) => Envelope | Error) {
  const chamadas: string[] = [];
  const executor: ExecutorDoAgente = {
    executar: async (c) => {
      const pergunta = String(c.argumentos["pergunta"] ?? "");
      chamadas.push(pergunta);
      const r = porPergunta(pergunta);
      if (r instanceof Error) throw r;
      return r;
    },
  };
  return { executor, chamadas };
}

const P = "Qual foi o lucro líquido do Banco em 2025 e quantas agências havia?";
const Q1 = "Qual foi o lucro líquido do Banco em 2025?";
const Q2 = "Quantas agências o Banco tinha em 2025?";
const EXTRA = "Qual o número de agências físicas do Banco em 31/12/2025?";
const mais = { decisao: "buscar_mais", perguntas: [EXTRA], faltando: "agências" };
const suficiente = { decisao: "suficiente", perguntas: [], faltando: "" };

// ---------- 1: teto de duas rodadas ----------

describe("teto de rodadas", () => {
  it("MAX_RODADAS é 2", () => expect(MAX_RODADAS).toBe(2));

  it("crítico que pede buscar_mais sempre: 2 rodadas, 2 críticos, 1 atualizador, estado incompleta", async () => {
    const f = llmFalso({ subs: [{ pergunta: Q1 }], rotas: {}, criticos: [mais] });
    const { executor, chamadas } = executorFalso((p) => env([ev(`t-${p.slice(0, 12)}`, "p. 6")]));
    const r = await executarCiclo(f.llm, executor, P);
    expect(r.rodadas).toHaveLength(2);
    expect(f.contagem).toEqual({ atualizador: 1, critico: 2 });
    expect(chamadas).toEqual([Q1, EXTRA]);
    expect(r.estado).toBe("incompleta");
    expect(r.faltando).toBe("agências");
    expect(r.rodadas[1]?.agente.subperguntas.map((s) => s.pergunta)).toEqual([EXTRA]);
    expect(String((f.mensagensDoCritico[1] as Mensagem[])[1]?.content)).toContain("Não é possível pedir nova busca");
  });

  it("crítico suficiente na 1ª: 1 rodada e 1 crítico", async () => {
    const f = llmFalso({ subs: [{ pergunta: Q1 }], rotas: {}, criticos: [suficiente] });
    const { executor } = executorFalso(() => env([ev("t1", "p. 6")]));
    const r = await executarCiclo(f.llm, executor, Q1);
    expect(r.rodadas).toHaveLength(1);
    expect(r.estado).toBe("suficiente");
    expect(f.contagem.critico).toBe(1);
  });

  it("buscar_mais na 1ª e suficiente na 2ª: 2 rodadas e estado suficiente", async () => {
    const f = llmFalso({ subs: [{ pergunta: Q1 }, { pergunta: Q2 }], rotas: {}, criticos: [mais, suficiente] });
    const { executor } = executorFalso((p) => (p === Q2 ? env([]) : env([ev(p === EXTRA ? "t-extra" : "t1", "p. 6")])));
    const r = await executarCiclo(f.llm, executor, P);
    expect(r.estado).toBe("suficiente");
    expect(r.rodadas.map((x) => x.rodada)).toEqual([1, 2]);
    expect(r.rodadas[0]?.critica?.decisao).toBe("buscar_mais");
    expect(r.rodadas[1]?.critica?.decisao).toBe("suficiente");
  });

  it("a rodada extra usa as perguntas do crítico sem passar pelo atualizador (opção subperguntas do agente)", async () => {
    const f = llmFalso({ subs: [{ pergunta: "não deveria ser usada" }], rotas: {}, criticos: [suficiente] });
    const { executor, chamadas } = executorFalso(() => env([ev("t1", "p. 6")]));
    const r = await executarAgente(f.llm, executor, P, { subperguntas: [{ pergunta: EXTRA, dependeDe: [] }] });
    expect(f.contagem.atualizador).toBe(0);
    expect(chamadas).toEqual([EXTRA]);
    expect(r.subperguntas.map((s) => s.pergunta)).toEqual([EXTRA]);
    expect(r.atualizacao).toMatchObject({ fallback: null, subperguntas: 1, ms: 0 });
  });
});

// ---------- 2 e 3: sem consulta, ausente ----------

describe("sem consulta e ausente", () => {
  it("rota nenhuma (saudação ou fora do escopo): não chama o crítico", async () => {
    const f = llmFalso({ subs: [{ pergunta: "Olá, tudo bem?" }], rotas: { "Olá, tudo bem?": { texto: "Olá! Posso ajudar com o Formulário de Referência." } }, criticos: [mais] });
    const { executor, chamadas } = executorFalso(() => env([]));
    const r = await executarCiclo(f.llm, executor, "Olá, tudo bem?");
    expect(f.contagem.critico).toBe(0);
    expect(chamadas).toEqual([]);
    expect(r.estado).toBe("sem_consulta");
    expect(r.rodadas).toHaveLength(1);
    expect(r.rodadas[0]?.critica).toBeNull();
  });

  it("pergunta vazia: sem_consulta e erro, sem nenhuma chamada", async () => {
    const f = llmFalso({ subs: [], rotas: {}, criticos: [mais] });
    const { executor } = executorFalso(() => env([]));
    const r = await executarCiclo(f.llm, executor, "  ");
    expect(r).toMatchObject({ estado: "sem_consulta", erro: "pergunta_vazia" });
    expect(f.contagem).toEqual({ atualizador: 0, critico: 0 });
  });

  it("ausente: encerra na 1ª rodada, guarda o que faltou e não busca de novo", async () => {
    const ausente = { decisao: "ausente", perguntas: [], faltando: "o lucro do Itaú não consta no documento" };
    const f = llmFalso({ subs: [{ pergunta: "Qual foi o lucro líquido do Itaú Unibanco em 2025?" }], rotas: {}, criticos: [ausente] });
    const { executor, chamadas } = executorFalso(() => env([ev("t1", "p. 6")]));
    const r = await executarCiclo(f.llm, executor, "Qual foi o lucro líquido do Itaú Unibanco em 2025?");
    expect(r.estado).toBe("ausente");
    expect(r.faltando).toBe("o lucro do Itaú não consta no documento");
    expect(r.rodadas).toHaveLength(1);
    expect(chamadas).toHaveLength(1);
  });
});

// ---------- 4 e 5: falhas ----------

describe("falhas", () => {
  it("crítico fora do ar: suficiente com o motivo anotado, sem rodada extra", async () => {
    const f = llmFalso({ subs: [{ pergunta: Q1 }], rotas: {}, criticos: [new LlmIndisponivelError("http://x", "chatJson")] });
    const { executor } = executorFalso(() => env([ev("t1", "p. 6")]));
    const r = await executarCiclo(f.llm, executor, Q1);
    expect(r.estado).toBe("suficiente");
    expect(r.rodadas).toHaveLength(1);
    expect(r.erro).toBeNull();
    expect(r.anotacoes).toContainEqual(expect.objectContaining({ rodada: 1, tipo: "fallback_do_critico", detalhe: "llm_falhou" }));
  });

  it("falha de ferramenta na rodada extra é anotada com a rodada 2 e a pergunta segue", async () => {
    const f = llmFalso({ subs: [{ pergunta: Q1 }], rotas: {}, criticos: [mais, suficiente] });
    const { executor } = executorFalso((p) => (p === EXTRA ? new Error("neo4j caiu") : env([ev("t1", "p. 6")])));
    const r = await executarCiclo(f.llm, executor, Q1);
    expect(r.rodadas).toHaveLength(2);
    expect(r.anotacoes).toContainEqual(expect.objectContaining({ rodada: 2, tipo: "excecao", detalhe: "neo4j caiu" }));
    expect(r.evidencias.map((e) => e.id)).toEqual(["t1"]);
  });

  it("os erros das ferramentas da 1ª rodada vão ao crítico", async () => {
    const f = llmFalso({ subs: [{ pergunta: Q1 }], rotas: {}, criticos: [suficiente] });
    const { executor } = executorFalso(() => env([], { ferramenta: "buscar_trechos", erro: "falha na ferramenta: reranker" }));
    await executarCiclo(f.llm, executor, Q1);
    expect(String((f.mensagensDoCritico[0] as Mensagem[])[1]?.content)).toContain("falha na ferramenta: reranker");
  });
});

// ---------- 6: evidências ----------

describe("evidências das duas rodadas", () => {
  it("juntam sem repetição, levam a rodada e põem as com página primeiro", async () => {
    const f = llmFalso({ subs: [{ pergunta: Q1 }], rotas: {}, criticos: [mais, suficiente] });
    const { executor } = executorFalso((p) =>
      p === EXTRA ? env([ev("t1", "p. 6"), { ...ev("g1", ""), tipo: "pagina" }, ev("t2", "p. 9")]) : env([{ ...ev("g0", ""), tipo: "pagina" }, ev("t1", "p. 6")]),
    );
    const r = await executarCiclo(f.llm, executor, Q1);
    expect(r.evidencias.map((e) => [e.id, e.rodada])).toEqual([["t1", 1], ["t2", 2], ["g0", 1], ["g1", 2]]);
  });

  it("paginasPrimeiro: false mantém a ordem de origem", async () => {
    const f = llmFalso({ subs: [{ pergunta: Q1 }], rotas: {}, criticos: [mais, suficiente] });
    const { executor } = executorFalso((p) => (p === EXTRA ? env([ev("t2", "p. 9")]) : env([{ ...ev("g0", ""), tipo: "pagina" }])));
    const r = await executarCiclo(f.llm, executor, Q1, { paginasPrimeiro: false });
    expect(r.evidencias.map((e) => e.id)).toEqual(["g0", "t2"]);
  });
});

// ---------- 7 e 8: cancelamento, progresso, registro ----------

describe("cancelamento, progresso e registro", () => {
  it("cancelamento no crítico sobe", async () => {
    const f = llmFalso({ subs: [{ pergunta: Q1 }], rotas: {}, criticos: [new LlmAbortadoError("chatJson")] });
    const { executor } = executorFalso(() => env([ev("t1", "p. 6")]));
    await expect(executarCiclo(f.llm, executor, Q1)).rejects.toBeInstanceOf(LlmAbortadoError);
  });

  it("o progresso traz a rodada em cada evento e um evento critica por rodada", async () => {
    const f = llmFalso({ subs: [{ pergunta: Q1 }], rotas: {}, criticos: [mais, suficiente] });
    const { executor } = executorFalso(() => env([ev("t1", "p. 6")]));
    const eventos: EventoCiclo[] = [];
    await executarCiclo(f.llm, executor, Q1, { progresso: (e) => eventos.push(e) });
    expect(eventos.map((e) => `${e.rodada}:${e.fase}`)).toEqual([
      "1:atualizacao", "1:roteamento", "1:execucao", "1:fim", "1:critica",
      "2:atualizacao", "2:roteamento", "2:execucao", "2:fim", "2:critica",
    ]); // prettier-ignore
    expect(eventos.find((e) => e.fase === "critica")).toMatchObject({ decisao: "buscar_mais", perguntas: 1, faltando: "agências" });
  });

  it("callback de progresso que lança não derruba a pergunta", async () => {
    const f = llmFalso({ subs: [{ pergunta: Q1 }], rotas: {}, criticos: [suficiente] });
    const { executor } = executorFalso(() => env([ev("t1", "p. 6")]));
    const r = await executarCiclo(f.llm, executor, Q1, { progresso: () => { throw new Error("cliente caiu"); } }); // prettier-ignore
    expect(r.estado).toBe("suficiente");
  });

  it("etapas_ms inclui o crítico; uso soma rodadas e críticos", async () => {
    const f = llmFalso({ subs: [{ pergunta: Q1 }], rotas: {}, criticos: [mais, suficiente] });
    const { executor } = executorFalso(() => env([ev("t1", "p. 6")]));
    const r = await executarCiclo(f.llm, executor, Q1);
    const { atualizar, rotear, executar, criticar, total } = r.etapas_ms;
    for (const n of [atualizar, rotear, executar, criticar, total]) expect(Number.isFinite(n) && n >= 0).toBe(true);
    expect(total + 1).toBeGreaterThanOrEqual(atualizar);
    // atualizador (100/10) + 2 roteadores (300/20 cada) + 2 críticos (100/10 cada)
    expect(r.uso).toEqual({ entrada: 100 + 600 + 200, saida: 10 + 40 + 20 });
  });

  it("anotações de cada rodada levam o número da rodada", async () => {
    const f = llmFalso({ subs: [{ pergunta: Q1 }], rotas: {}, criticos: [mais, suficiente] });
    const { executor } = executorFalso((p) => (p === EXTRA ? env([], { erro: "metrica_desconhecida" }) : env([ev("t1", "p. 6")])));
    const r = await executarCiclo(f.llm, executor, Q1);
    expect(r.anotacoes).toContainEqual(expect.objectContaining({ rodada: 2, tipo: "erro_da_ferramenta", detalhe: "metrica_desconhecida" }));
  });
});
