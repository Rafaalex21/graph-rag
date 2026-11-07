/**
 * Agente (F7.11, ARQUITETURA §7.1): atualizador → roteador → executor em ondas, com `evidencias[]` por subpergunta. O LLM
 * e o executor são dublês; o que se prova aqui é a cola entre as três peças. Formas de falha, escritas antes do código:
 *
 *  1. Uma ferramenta que devolve `erro`, ou que lança, derruba o agente ou some sem rastro: tem de virar evidência vazia
 *     anotada (qual subpergunta, qual ferramenta, qual erro), e as outras ferramentas e subperguntas seguem.
 *  2. O atualizador ou o roteador caem no caminho seguro e ninguém fica sabendo: o motivo tem de aparecer nas anotações.
 *  3. A dependente não recebe a resposta de que precisa (ou recebe um despejo de 20 mil caracteres); uma subpergunta sem
 *     evidência não pode virar "resposta anterior" vazia no prompt.
 *  4. As independentes passam de 2 ao mesmo tempo (o Qwen roda com `-np 2`), ou o resultado depende de quem terminou primeiro.
 *  5. A mesma evidência chega por duas subperguntas ou duas ferramentas e aparece duas vezes; a ordem da lista plana muda
 *     entre execuções.
 *  6. A rota `nenhuma` (saudação, fora do escopo) chama ferramenta, ou perde o texto do roteador.
 *  7. Pergunta vazia chega ao LLM; o cancelamento do chamador é engolido; um `progresso` que falha derruba a busca.
 *  8. Sem tempo por etapa não há como saber onde a pergunta demorou (aceite: rota e tempo de cada etapa registrados).
 *  9. O histórico não chega ao atualizador e ao roteador (a pergunta "e o de pessoas jurídicas?" perde o sentido).
 */
import { describe, expect, it } from "vitest";
import { executarAgente, resumirEvidencias, type EventoAgente, type ExecutorDoAgente, type LlmDoAgente } from "../../src/agente/agente.ts";
import { LlmAbortadoError, LlmIndisponivelError, type Mensagem } from "../../src/llm/index.ts";
import type { Envelope, Evidencia } from "../../src/ferramentas/contrato.ts";

// ---------- dublês ----------

type Bruta = { nome: string; argumentos: Record<string, unknown> };
type Rota = Bruta[] | { texto: string } | Error;
interface Sub {
  pergunta: string;
  depende_de?: number[];
}

function llmFalso(opcoes: { subs: Sub[] | Error; rotas: Record<string, Rota>; espera?: number }) {
  const mensagensDoAtualizador: Mensagem[][] = [];
  const mensagensDoRoteador: Mensagem[][] = [];
  const ferramentasOferecidas: string[][] = [];
  const registro = { simultaneas: 0, maximo: 0 };
  const llm: LlmDoAgente = {
    chatJson: async (mensagens, o) => {
      mensagensDoAtualizador.push(mensagens);
      if (opcoes.subs instanceof Error) throw opcoes.subs;
      const bruto = { autonoma: opcoes.subs[0]?.pergunta ?? "x", subperguntas: opcoes.subs.map((s) => ({ pergunta: s.pergunta, depende_de: s.depende_de ?? [] })) };
      return { valor: o?.validar ? o.validar(bruto) : bruto, texto: "", raciocinio: "", fim: "stop", uso: { entrada: 100, saida: 20 }, modelo: "q", ms: 5 } as never;
    },
    chamarFerramentas: async (mensagens, ferramentas) => {
      mensagensDoRoteador.push(mensagens);
      ferramentasOferecidas.push(ferramentas.map((f) => f.nome));
      registro.simultaneas++;
      registro.maximo = Math.max(registro.maximo, registro.simultaneas);
      try {
        if (opcoes.espera) await new Promise((ok) => setTimeout(ok, opcoes.espera));
        const usuario = String(mensagens[1]?.content ?? "");
        const pergunta = /Pergunta atual: (.*)$/m.exec(usuario)?.[1] ?? "";
        const r = opcoes.rotas[pergunta] ?? [{ nome: "buscar_trechos", argumentos: { pergunta } }];
        if (r instanceof Error) throw r;
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
      } finally {
        registro.simultaneas--;
      }
    },
  };
  return { llm, mensagensDoAtualizador, mensagensDoRoteador, ferramentasOferecidas, registro };
}

const ev = (id: string, paginas: string, texto = `texto de ${id}`): Evidencia => ({ id, tipo: "trecho", paginas, caminho: "c", texto, score: 1 });
const env = (ferramenta: string, evidencias: Evidencia[], extra: Partial<Envelope> = {}): Envelope => ({
  ferramenta, parametros: {}, evidencias, aviso: null, erro: null, sugestoes: [], omitido: {}, latencia_ms: 3, ...extra,
}); // prettier-ignore

function executorFalso(respostas: Record<string, (a: Record<string, unknown>) => Envelope | Error>) {
  const chamadas: { nome: string; argumentos: Record<string, unknown> }[] = [];
  const executor: ExecutorDoAgente = {
    executar: async (c) => {
      chamadas.push(c);
      const f = respostas[c.nome];
      if (!f) return env(c.nome, [], { erro: "ferramenta_desconhecida" });
      const r = f(c.argumentos);
      if (r instanceof Error) throw r;
      return r;
    },
  };
  return { executor, chamadas };
}
const P1 = "Qual foi o lucro líquido do Banco em 2025?";
const P2 = "Quantas agências o Banco tinha em 2025?";
const P3 = "Quem preside o Conselho de Administração?";
const P4 = "Há quanto tempo essa pessoa ocupa o cargo de presidente?";

// ---------- 1 e 5: falhas de ferramenta, dedup ----------

describe("ferramenta que falha", () => {
  it("erro devolvido vira evidência vazia anotada, e as outras ferramentas e subperguntas seguem", async () => {
    const f = llmFalso({
      subs: [{ pergunta: P1 }, { pergunta: P2 }],
      rotas: { [P1]: [{ nome: "fato_financeiro", argumentos: { metrica: "lucro" } }, { nome: "buscar_trechos", argumentos: { pergunta: P1 } }], [P2]: [{ nome: "buscar_tabelas", argumentos: { pergunta: P2 } }] },
    });
    const { executor } = executorFalso({
      fato_financeiro: () => env("fato_financeiro", [], { erro: "metrica_nao_encontrada", aviso: "Não achei a métrica." }),
      buscar_trechos: () => env("buscar_trechos", [ev("t1", "p. 6")]),
      buscar_tabelas: () => env("buscar_tabelas", [ev("b1", "p. 80")]),
    });
    const r = await executarAgente(f.llm, executor, "x");
    expect(r.evidencias.map((e) => e.id)).toEqual(["t1", "b1"]);
    expect(r.anotacoes).toContainEqual({ subpergunta: 0, ferramenta: "fato_financeiro", tipo: "erro_da_ferramenta", detalhe: "metrica_nao_encontrada" });
    const exec = r.subperguntas[0]?.execucoes.find((e) => e.ferramenta === "fato_financeiro");
    expect(exec).toMatchObject({ erro: "metrica_nao_encontrada", evidencias: 0 });
    expect(r.erro).toBeNull();
  });

  it("exceção do executor também vira anotação, não exceção do agente", async () => {
    const f = llmFalso({ subs: [{ pergunta: P1 }], rotas: { [P1]: [{ nome: "fato_financeiro", argumentos: { metrica: "lucro" } }, { nome: "buscar_trechos", argumentos: { pergunta: P1 } }] } });
    const { executor } = executorFalso({ fato_financeiro: () => new Error("neo4j caiu"), buscar_trechos: () => env("buscar_trechos", [ev("t1", "p. 6")]) });
    const r = await executarAgente(f.llm, executor, "x");
    expect(r.evidencias.map((e) => e.id)).toEqual(["t1"]);
    expect(r.anotacoes).toContainEqual({ subpergunta: 0, ferramenta: "fato_financeiro", tipo: "excecao", detalhe: "neo4j caiu" });
  });

  it("ferramenta com aviso mas sem erro não é anotada como falha", async () => {
    const f = llmFalso({ subs: [{ pergunta: P1 }], rotas: {} });
    const { executor } = executorFalso({ buscar_trechos: () => env("buscar_trechos", [ev("t1", "p. 6")], { aviso: "reranker fora do ar" }) });
    const r = await executarAgente(f.llm, executor, "x");
    expect(r.anotacoes).toEqual([]);
    expect(r.subperguntas[0]?.execucoes[0]?.aviso).toBe("reranker fora do ar");
  });
});

describe("lista plana de evidências", () => {
  it("não repete a mesma evidência e leva a subpergunta e a ferramenta de origem", async () => {
    const f = llmFalso({ subs: [{ pergunta: P1 }, { pergunta: P2 }], rotas: {} });
    const { executor } = executorFalso({ buscar_trechos: (a) => env("buscar_trechos", [ev("comum", "p. 6"), ev(`so-${String(a["pergunta"]).slice(0, 8)}`, "p. 7")]) });
    const r = await executarAgente(f.llm, executor, "x");
    expect(r.evidencias.map((e) => e.id)).toEqual(["comum", "so-Qual foi", "so-Quantas "]);
    expect(r.evidencias[0]).toMatchObject({ subpergunta: 0, ferramenta: "buscar_trechos" });
    expect(r.evidencias[2]).toMatchObject({ subpergunta: 1 });
    expect(r.subperguntas[1]?.evidencias.map((e) => e.id)).toEqual(["comum", "so-Quantas "]); // a subpergunta guarda as suas
  });

  it("a ordem é a das subperguntas e das chamadas, não a de quem terminou primeiro", async () => {
    const f = llmFalso({ subs: [{ pergunta: P1 }, { pergunta: P2 }, { pergunta: P3 }], rotas: {}, espera: 1 });
    const demora: Record<string, number> = { [P1]: 30, [P2]: 1, [P3]: 10 };
    const executor: ExecutorDoAgente = {
      executar: async (c) => {
        await new Promise((ok) => setTimeout(ok, demora[String(c.argumentos["pergunta"])] ?? 0));
        return env("buscar_trechos", [ev(`e-${String(c.argumentos["pergunta"]).slice(0, 5)}`, "p. 1")]);
      },
    };
    const a = await executarAgente(f.llm, executor, "x", { concorrencia: 2 });
    const b = await executarAgente(llmFalso({ subs: [{ pergunta: P1 }, { pergunta: P2 }, { pergunta: P3 }], rotas: {} }).llm, executor, "x", { concorrencia: 1 });
    expect(a.evidencias.map((e) => e.id)).toEqual(["e-Qual ", "e-Quant", "e-Quem "]);
    expect(b.evidencias.map((e) => e.id)).toEqual(a.evidencias.map((e) => e.id));
    expect(a.subperguntas.map((s) => s.indice)).toEqual([0, 1, 2]);
  });
});

// ---------- 2: caminhos seguros ----------

describe("caminho seguro", () => {
  it("atualizador que falha: a pergunta segue inteira, com o motivo anotado", async () => {
    const f = llmFalso({ subs: new LlmIndisponivelError("sem llama-swap", "chatJson"), rotas: {} });
    const { executor, chamadas } = executorFalso({ buscar_trechos: () => env("buscar_trechos", [ev("t1", "p. 6")]) });
    const r = await executarAgente(f.llm, executor, P1);
    expect(r.atualizacao.fallback).toBe("llm_falhou");
    expect(r.anotacoes).toContainEqual(expect.objectContaining({ tipo: "fallback_do_atualizador", detalhe: "llm_falhou" }));
    expect(chamadas).toHaveLength(1);
    expect(r.subperguntas).toHaveLength(1);
    expect(r.evidencias).toHaveLength(1);
  });

  it("roteador que falha: busca_trechos com a pergunta, anotada; chamada descartada também é anotada", async () => {
    const f = llmFalso({ subs: [{ pergunta: P1 }, { pergunta: P2 }], rotas: { [P1]: new LlmIndisponivelError("fora", "chamarFerramentas"), [P2]: [{ nome: "pesquisar_web", argumentos: {} }, { nome: "buscar_tabelas", argumentos: { pergunta: P2 } }] } });
    const { executor, chamadas } = executorFalso({ buscar_trechos: () => env("buscar_trechos", [ev("t1", "p. 6")]), buscar_tabelas: () => env("buscar_tabelas", [ev("b1", "p. 80")]) });
    const r = await executarAgente(f.llm, executor, "x", { complementar: false });
    expect(chamadas.map((c) => c.nome).sort()).toEqual(["buscar_tabelas", "buscar_trechos"]);
    expect(r.anotacoes).toContainEqual(expect.objectContaining({ subpergunta: 0, tipo: "fallback_do_roteador", detalhe: "llm_falhou" }));
    expect(r.anotacoes).toContainEqual(expect.objectContaining({ subpergunta: 1, ferramenta: "pesquisar_web", tipo: "chamada_descartada" }));
  });
});

// ---------- 3: dependentes ----------

describe("subperguntas dependentes", () => {
  const subs: Sub[] = [{ pergunta: P3 }, { pergunta: P4, depende_de: [0] }];

  it("a dependente roda na onda seguinte e o roteador recebe o resumo da resposta de que precisa", async () => {
    const f = llmFalso({ subs, rotas: {} });
    const { executor } = executorFalso({ buscar_trechos: (a) => env("buscar_trechos", [ev(String(a["pergunta"]).startsWith("Quem") ? "presidente" : "tempo", "p. 12", "A presidente do Conselho é Fulana de Tal.")]) });
    const r = await executarAgente(f.llm, executor, "x");
    expect(r.subperguntas.map((s) => s.onda)).toEqual([0, 1]);
    const prompt = String(f.mensagensDoRoteador[1]?.[1]?.content);
    expect(prompt).toContain("<respostas_anteriores>");
    expect(prompt).toContain("A presidente do Conselho é Fulana de Tal.");
    expect(prompt).toContain("p. 12");
    expect(String(f.mensagensDoRoteador[0]?.[1]?.content)).not.toContain("<respostas_anteriores>");
  });

  it("subpergunta sem evidência não vira 'resposta anterior' vazia", async () => {
    const f = llmFalso({ subs, rotas: {} });
    const { executor } = executorFalso({ buscar_trechos: () => env("buscar_trechos", []) });
    const r = await executarAgente(f.llm, executor, "x");
    expect(String(f.mensagensDoRoteador[1]?.[1]?.content)).not.toContain("<respostas_anteriores>");
    expect(r.subperguntas[0]?.resumo).toBeNull();
  });

  it("falha da ferramenta da primeira não impede a segunda", async () => {
    const f = llmFalso({ subs, rotas: {} });
    const { executor } = executorFalso({ buscar_trechos: (a) => (String(a["pergunta"]).startsWith("Quem") ? new Error("caiu") : env("buscar_trechos", [ev("t2", "p. 3")])) });
    const r = await executarAgente(f.llm, executor, "x");
    expect(r.evidencias.map((e) => e.id)).toEqual(["t2"]);
  });
});

describe("resumirEvidencias", () => {
  it("usa no máximo 3 evidências com texto, com a página, e corta o total", () => {
    const evs = [ev("a", "p. 1", "x".repeat(500)), ev("b", "", "sem página"), ev("c", "p. 3", "   "), ev("d", "p. 4", "quarta"), ev("e", "p. 5", "quinta")];
    const r = resumirEvidencias(evs) ?? "";
    expect(r).toContain("[p. 1]");
    expect(r).toContain("sem página");
    expect(r).toContain("quarta");
    expect(r).not.toContain("quinta");
    expect(r.length).toBeLessThanOrEqual(600);
  });
  it("sem evidência com texto não há resumo", () => {
    expect(resumirEvidencias([])).toBeNull();
    expect(resumirEvidencias([ev("a", "p. 1", "  ")])).toBeNull();
  });
});

// ---------- 4: concorrência ----------

describe("concorrência", () => {
  it("no máximo 2 subperguntas ao mesmo tempo, e 1 se pedido", async () => {
    const tres: Sub[] = [{ pergunta: P1 }, { pergunta: P2 }, { pergunta: P3 }];
    const { executor } = executorFalso({ buscar_trechos: () => env("buscar_trechos", [ev("x", "p. 1")]) });
    const dois = llmFalso({ subs: tres, rotas: {}, espera: 5 });
    await executarAgente(dois.llm, executor, "x");
    expect(dois.registro.maximo).toBe(2);
    const um = llmFalso({ subs: tres, rotas: {}, espera: 5 });
    await executarAgente(um.llm, executor, "x", { concorrencia: 1 });
    expect(um.registro.maximo).toBe(1);
  });
});

// ---------- 6: rota nenhuma, 7: entrada, cancelamento, progresso ----------

describe("rota nenhuma", () => {
  it("não chama ferramenta e guarda o texto do roteador", async () => {
    const f = llmFalso({ subs: [{ pergunta: "Olá, tudo bem com você?" }], rotas: { "Olá, tudo bem com você?": { texto: "Olá! Só respondo sobre o Formulário de Referência." } } });
    const { executor, chamadas } = executorFalso({});
    const r = await executarAgente(f.llm, executor, "Olá, tudo bem com você?");
    expect(chamadas).toEqual([]);
    expect(r.rota).toBe("nenhuma");
    expect(r.texto).toBe("Olá! Só respondo sobre o Formulário de Referência.");
    expect(r.evidencias).toEqual([]);
  });

  it("se só uma subpergunta é 'nenhuma', a rota geral é 'ferramentas'", async () => {
    const f = llmFalso({ subs: [{ pergunta: P1 }, { pergunta: P2 }], rotas: { [P2]: { texto: "Não sei." } } });
    const { executor } = executorFalso({ buscar_trechos: () => env("buscar_trechos", [ev("t", "p. 1")]) });
    const r = await executarAgente(f.llm, executor, "x");
    expect(r.rota).toBe("ferramentas");
    expect(r.subperguntas[1]?.rota).toBe("nenhuma");
  });
});

describe("entrada, cancelamento e progresso", () => {
  it.each(["", "  \n "])("pergunta vazia (%j) não chega ao LLM nem ao executor", async (vazia) => {
    const f = llmFalso({ subs: [{ pergunta: P1 }], rotas: {} });
    const { executor, chamadas } = executorFalso({});
    const r = await executarAgente(f.llm, executor, vazia);
    expect(f.mensagensDoAtualizador).toEqual([]);
    expect(chamadas).toEqual([]);
    expect(r.erro).toBe("pergunta_vazia");
    expect(r.evidencias).toEqual([]);
  });

  it("o cancelamento do chamador sobe como erro", async () => {
    const f = llmFalso({ subs: [{ pergunta: P1 }], rotas: { [P1]: new LlmAbortadoError("chamarFerramentas") } });
    const { executor } = executorFalso({});
    await expect(executarAgente(f.llm, executor, "x")).rejects.toBeInstanceOf(LlmAbortadoError);
  });

  it("os eventos chegam em ordem, e um progresso que falha não derruba o agente", async () => {
    const f = llmFalso({ subs: [{ pergunta: P3 }, { pergunta: P4, depende_de: [0] }], rotas: {} });
    const { executor } = executorFalso({ buscar_trechos: () => env("buscar_trechos", [ev("t", "p. 1")]) });
    const eventos: EventoAgente[] = [];
    await executarAgente(f.llm, executor, "x", { progresso: (e) => eventos.push(e) });
    expect(eventos.map((e) => e.fase)).toEqual(["atualizacao", "roteamento", "execucao", "roteamento", "execucao", "fim"]);
    expect(eventos[0]).toMatchObject({ fase: "atualizacao", subperguntas: 2 });
    const unico = executorFalso({ buscar_trechos: (a) => env("buscar_trechos", [ev(String(a["pergunta"]).slice(0, 6), "p. 1")]) }).executor;
    const r = await executarAgente(f.llm, unico, "x", { progresso: () => { throw new Error("cliente SSE caiu"); } });
    expect(r.evidencias).toHaveLength(2);
  });
});

// ---------- 8 e 9: tempo por etapa, histórico ----------

describe("registro", () => {
  it("guarda o tempo de cada etapa, de cada subpergunta e de cada ferramenta", async () => {
    const f = llmFalso({ subs: [{ pergunta: P1 }], rotas: {}, espera: 3 });
    const { executor } = executorFalso({ buscar_trechos: () => env("buscar_trechos", [ev("t", "p. 1")]) });
    const r = await executarAgente(f.llm, executor, "x");
    const { atualizar, rotear, executar, total } = r.etapas_ms;
    for (const n of [atualizar, rotear, executar, total]) expect(Number.isFinite(n) && n >= 0).toBe(true);
    // o roteador arredonda o tempo dele para o milissegundo inteiro, o agente para 0,1 ms: a conta tem 1 ms de folga
    expect(total + 1).toBeGreaterThanOrEqual(rotear);
    expect(r.subperguntas[0]?.ms.rotear).toBeGreaterThan(0);
    expect(r.subperguntas[0]?.execucoes[0]?.ms).toBeGreaterThanOrEqual(0);
    expect(r.subperguntas[0]?.chamadas).toEqual([{ nome: "buscar_trechos", argumentos: { pergunta: P1 } }]);
  });

  it("o histórico chega ao atualizador e ao roteador (que passa a oferecer resposta_ja_dada)", async () => {
    const f = llmFalso({ subs: [{ pergunta: P2 }], rotas: {} });
    const { executor } = executorFalso({ buscar_trechos: () => env("buscar_trechos", []) });
    const historico = [
      { papel: "usuario" as const, texto: "Qual o lucro de 2025?" },
      { papel: "assistente" as const, texto: "R$ 20 bilhões (p. 6)." },
    ];
    await executarAgente(f.llm, executor, "E as agências?", { historico });
    expect(String(f.mensagensDoAtualizador[0]?.[1]?.content)).toContain("R$ 20 bilhões");
    expect(f.ferramentasOferecidas[0]).toContain("resposta_ja_dada");
    const sem = llmFalso({ subs: [{ pergunta: P2 }], rotas: {} });
    await executarAgente(sem.llm, executor, "E as agências?");
    expect(sem.ferramentasOferecidas[0]).not.toContain("resposta_ja_dada");
  });
});

// ---------- 10: complemento com buscar_trechos (opção pós-hoc, ADR-059) ----------

describe("complementar", () => {
  const panorama = (a: Record<string, unknown>) => env("panorama", [{ ...ev("pn1", ""), tipo: "pagina" }], { parametros: a });
  const rotaPanorama = { [P1]: [{ nome: "panorama", argumentos: { pergunta: P1 } }] };

  it("complementar: false: só roda o que o roteador escolheu", async () => {
    const f = llmFalso({ subs: [{ pergunta: P1 }], rotas: rotaPanorama });
    const { executor, chamadas } = executorFalso({ panorama, buscar_trechos: () => env("buscar_trechos", [ev("t1", "p. 6")]) });
    const r = await executarAgente(f.llm, executor, "x", { complementar: false });
    expect(chamadas.map((c) => c.nome)).toEqual(["panorama"]);
    expect(r.evidencias.map((e) => e.id)).toEqual(["pn1"]);
  });

  it("ligada (e na ordem de origem): acrescenta buscar_trechos à rota especializada, com as evidências dele depois, marcado e sem mexer nas chamadas do roteador", async () => {
    const f = llmFalso({ subs: [{ pergunta: P1 }], rotas: rotaPanorama });
    const { executor, chamadas } = executorFalso({ panorama, buscar_trechos: () => env("buscar_trechos", [ev("t1", "p. 6")]) });
    const r = await executarAgente(f.llm, executor, "x", { complementar: true, paginasPrimeiro: false });
    expect(chamadas).toContainEqual({ nome: "buscar_trechos", argumentos: { pergunta: P1 } });
    expect(r.evidencias.map((e) => [e.id, e.ferramenta])).toEqual([["pn1", "panorama"], ["t1", "buscar_trechos"]]);
    expect(r.subperguntas[0]?.chamadas.map((c) => c.nome)).toEqual(["panorama"]);
    expect(r.subperguntas[0]?.execucoes.map((e) => [e.ferramenta, e.complemento])).toEqual([["panorama", false], ["buscar_trechos", true]]);
  });

  it("não acrescenta se a rota já tem buscar_trechos, se é resposta_ja_dada ou se não há ferramenta", async () => {
    const f = llmFalso({
      subs: [{ pergunta: P1 }, { pergunta: P2 }, { pergunta: P3 }],
      rotas: { [P1]: [{ nome: "buscar_trechos", argumentos: { pergunta: P1 } }], [P2]: [{ nome: "resposta_ja_dada", argumentos: { resposta: "R$ 20 bilhões (p. 6)." } }], [P3]: { texto: "Olá!" } },
    });
    const { executor, chamadas } = executorFalso({ buscar_trechos: () => env("buscar_trechos", [ev("t1", "p. 6")]), resposta_ja_dada: () => env("resposta_ja_dada", []) });
    await executarAgente(f.llm, executor, "x", { complementar: true, historico: [{ papel: "usuario", texto: "a" }, { papel: "assistente", texto: "b" }] });
    expect(chamadas.map((c) => c.nome).sort()).toEqual(["buscar_trechos", "resposta_ja_dada"]);
  });

  it("falha do complemento é anotada e não derruba a ferramenta escolhida", async () => {
    const f = llmFalso({ subs: [{ pergunta: P1 }], rotas: rotaPanorama });
    const { executor } = executorFalso({ panorama, buscar_trechos: () => env("buscar_trechos", [], { erro: "falha na ferramenta: reranker" }) });
    const r = await executarAgente(f.llm, executor, "x", { complementar: true });
    expect(r.evidencias.map((e) => e.id)).toEqual(["pn1"]);
    expect(r.anotacoes).toContainEqual({ subpergunta: 0, ferramenta: "buscar_trechos", tipo: "erro_da_ferramenta", detalhe: "falha na ferramenta: reranker" });
  });

  it("o resumo para a subpergunta dependente sai das evidências na mesma ordem (ferramenta escolhida primeiro)", async () => {
    const f = llmFalso({ subs: [{ pergunta: P3 }, { pergunta: P4, depende_de: [0] }], rotas: { [P3]: [{ nome: "pessoas_cargos", argumentos: { cargo: "Presidente do Conselho" } }] } });
    const { executor } = executorFalso({
      pessoas_cargos: () => env("pessoas_cargos", [ev("pe1", "p. 300", "Fulano preside o Conselho")]),
      buscar_trechos: () => env("buscar_trechos", [ev("t1", "p. 301", "outro trecho")]),
    });
    const r = await executarAgente(f.llm, executor, "x", { complementar: true });
    expect(r.subperguntas[0]?.resumo?.split("\n")[0]).toContain("Fulano preside");
  });
});

// ---------- 11: padrões e ordem da lista plana (pós-hoc, v3 do ADR-059) ----------

describe("padrões e páginas primeiro", () => {
  const semPagina = { ...ev("pn1", ""), tipo: "pagina" as const };
  const rota = { [P1]: [{ nome: "panorama", argumentos: { pergunta: P1 } }] };
  const feitos = () => ({ panorama: () => env("panorama", [semPagina]), buscar_trechos: () => env("buscar_trechos", [ev("t1", "p. 6")]) });

  it("sem opções, o complemento está ligado e as evidências com página vêm antes das sem página", async () => {
    const f = llmFalso({ subs: [{ pergunta: P1 }], rotas: rota });
    const { executor, chamadas } = executorFalso(feitos());
    const r = await executarAgente(f.llm, executor, "x");
    expect(chamadas.map((c) => c.nome).sort()).toEqual(["buscar_trechos", "panorama"]);
    expect(r.evidencias.map((e) => e.id)).toEqual(["t1", "pn1"]);
  });

  it("a ordem é estável: dentro de cada grupo, subpergunta e chamada como antes", async () => {
    const f = llmFalso({ subs: [{ pergunta: P1 }, { pergunta: P2 }], rotas: { ...rota, [P2]: [{ nome: "panorama", argumentos: { pergunta: P2 } }] } });
    let n = 0;
    const { executor } = executorFalso({
      panorama: () => env("panorama", [{ ...ev(`pn${++n}`, ""), tipo: "pagina" as const }]),
      buscar_trechos: (a) => env("buscar_trechos", [ev(`t-${String(a["pergunta"]).slice(0, 8)}`, "p. 6")]),
    });
    const r = await executarAgente(f.llm, executor, "x");
    expect(r.evidencias.map((e) => e.id)).toEqual(["t-Qual foi", "t-Quantas ", "pn1", "pn2"]);
  });

  it("paginasPrimeiro: false mantém a ordem de origem e complementar: false desliga o complemento", async () => {
    const f = llmFalso({ subs: [{ pergunta: P1 }], rotas: rota });
    const { executor, chamadas } = executorFalso(feitos());
    const r = await executarAgente(f.llm, executor, "x", { complementar: false, paginasPrimeiro: false });
    expect(chamadas.map((c) => c.nome)).toEqual(["panorama"]);
    const g = llmFalso({ subs: [{ pergunta: P1 }], rotas: rota });
    const outro = executorFalso(feitos());
    const r2 = await executarAgente(g.llm, outro.executor, "x", { paginasPrimeiro: false });
    expect(r.evidencias.map((e) => e.id)).toEqual(["pn1"]);
    expect(r2.evidencias.map((e) => e.id)).toEqual(["pn1", "t1"]);
  });

  it("a evidência por subpergunta não é reordenada (só a lista plana)", async () => {
    const f = llmFalso({ subs: [{ pergunta: P1 }], rotas: rota });
    const { executor } = executorFalso(feitos());
    const r = await executarAgente(f.llm, executor, "x");
    expect(r.subperguntas[0]?.evidencias.map((e) => e.id)).toEqual(["pn1", "t1"]);
  });
});
