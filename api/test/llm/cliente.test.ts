/**
 * Cliente LLM (F7.1) contra um llama-swap de mentira. Formas de falha, escritas antes do código:
 *
 *  1. URL base com barra final, com `/v1` ou sem ele: a rota tem de ser sempre `/v1/...`.
 *  2. O perfil decide o modelo e os `chat_template_kwargs` (o Qwen sem raciocínio; o gpt-oss com esforço
 *     baixo); sem isso o Qwen gasta o orçamento de tokens pensando e devolve texto vazio.
 *  3. Tempo-limite estoura como `LlmTimeoutError`, desligar o llama-swap como `LlmIndisponivelError`,
 *     cancelar pelo `AbortSignal` como `LlmAbortadoError`: três causas, três erros, e só as duas primeiras
 *     de rede são candidatas a nova tentativa (cancelamento e 4xx nunca).
 *  4. 502/503/504 (modelo carregando) têm uma nova tentativa; 400 (contexto estourado) não, e a mensagem do
 *     servidor chega ao erro.
 *  5. Resposta truncada (`finish_reason: length`) com texto vazio não é JSON: `chatJson` recusa em vez de
 *     devolver `undefined`; JSON dentro de cerca ```json é aceito; `validar` que recusa vira erro.
 *  6. Tool calling: argumentos que não são JSON, ferramenta que não foi declarada e resposta sem chamada
 *     (o modelo respondeu em texto) são três casos distintos.
 *  7. Fluxo (SSE): tokens em ordem, o raciocínio separado do texto, uso no fim, cancelamento no meio e
 *     silêncio do servidor (tempo ocioso) sem ficar pendurado.
 *  8. Embeddings: `index` fora de ordem, quantidade, dimensão e norma erradas, lista vazia sem requisição,
 *     lotes, e o prefixo `Instruct:` igual ao do indexador Python.
 *  9. Rerank: nota por texto na ordem de entrada; índice faltando, repetido ou fora do intervalo é erro.
 */
import type { ServerResponse } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import {
  ClienteLlm,
  LlmAbortadoError,
  LlmHttpError,
  LlmIndisponivelError,
  LlmRespostaInvalidaError,
  LlmTimeoutError,
  PERFIS,
  formatarConsulta,
} from "../../src/llm/index.ts";
import {
  json,
  pedaco,
  portaFechada,
  respostaChat,
  servidor,
  sse,
  vetorUnitario,
  type ServidorFalso,
  type Tratador,
} from "../auxiliar/servidor-falso.ts";

const abertos: ServidorFalso[] = [];
async function subir(tratador: Tratador): Promise<ServidorFalso> {
  const s = await servidor(tratador);
  abertos.push(s);
  return s;
}
afterEach(async () => {
  await Promise.all(abertos.splice(0).map((s) => s.fechar()));
});

const OLA = [{ role: "user" as const, content: "olá" }];
const novo = (url: string, extra: Record<string, unknown> = {}) =>
  new ClienteLlm({ baseUrl: url, esperaRetentativaMs: 0, ...extra });

// ---------- 1: URL ----------

describe("URL base", () => {
  it.each(["", "/", "/v1", "/v1/"])("aceita o sufixo %j e chama sempre /v1/chat/completions", async (sufixo) => {
    const s = await subir((_, res) => json(res, respostaChat("oi")));
    await novo(s.url + sufixo).chat(OLA);
    expect(s.chamadas[0]?.caminho).toBe("/v1/chat/completions");
  });
});

// ---------- 2: perfis ----------

describe("chat e perfis", () => {
  it("o perfil principal manda o Qwen sem raciocínio, temperatura 0 e o teto de tokens", async () => {
    const s = await subir((_, res) => json(res, respostaChat("  resposta \n")));
    const r = await novo(s.url).chat(OLA);
    const corpo = s.chamadas[0]?.corpo;
    expect(corpo.model).toBe(PERFIS.principal.modelo);
    expect(corpo.model).toBe("qwen36-35b-a3b");
    expect(corpo.temperature).toBe(0);
    expect(corpo.max_tokens).toBe(PERFIS.principal.maxTokens);
    expect(corpo.chat_template_kwargs).toEqual({ enable_thinking: false });
    expect(corpo.stream).toBeFalsy();
    expect(corpo.messages).toEqual(OLA);
    expect(r.texto).toBe("resposta");
    expect(r.fim).toBe("stop");
    expect(r.uso).toEqual({ entrada: 10, saida: 5 });
  });

  it("o perfil rápido manda o gpt-oss-20b com esforço de raciocínio baixo", async () => {
    const s = await subir((_, res) => json(res, respostaChat("ok", { modelo: "gpt-oss-20b" })));
    await novo(s.url).chat(OLA, { perfil: "rapido" });
    const corpo = s.chamadas[0]?.corpo;
    expect(corpo.model).toBe("gpt-oss-20b");
    expect(corpo.chat_template_kwargs).toEqual({ reasoning_effort: "low" });
  });

  it("opções da chamada vencem as do perfil", async () => {
    const s = await subir((_, res) => json(res, respostaChat("ok")));
    await novo(s.url).chat(OLA, { temperatura: 0.7, maxTokens: 50, parar: ["###"] });
    const corpo = s.chamadas[0]?.corpo;
    expect([corpo.temperature, corpo.max_tokens, corpo.stop]).toEqual([0.7, 50, ["###"]]);
  });

  it("devolve o raciocínio à parte e não o mistura ao texto", async () => {
    const s = await subir((_, res) => json(res, respostaChat("42", { raciocinio: "pensando..." })));
    const r = await novo(s.url).chat(OLA);
    expect(r.texto).toBe("42");
    expect(r.raciocinio).toBe("pensando...");
  });

  it("resposta sem `usage` não quebra: uso zerado", async () => {
    const s = await subir((_, res) => {
      const c = respostaChat("ok") as Record<string, unknown>;
      delete c["usage"];
      json(res, c);
    });
    expect((await novo(s.url).chat(OLA)).uso).toEqual({ entrada: 0, saida: 0 });
  });

  it("resposta sem nenhuma escolha é resposta inválida", async () => {
    const s = await subir((_, res) => json(res, { choices: [] }));
    await expect(novo(s.url).chat(OLA)).rejects.toBeInstanceOf(LlmRespostaInvalidaError);
  });
});

// ---------- 3 e 4: tempo-limite, indisponível, cancelamento, novas tentativas ----------

describe("falhas de rede e de servidor", () => {
  it("estourar o tempo-limite vira LlmTimeoutError e não é repetido", async () => {
    const s = await subir(async (_, res) => {
      await new Promise((ok) => setTimeout(ok, 400));
      json(res, respostaChat("tarde"));
    });
    const t0 = Date.now();
    const erro = await novo(s.url).chat(OLA, { timeoutMs: 80 }).catch((e: unknown) => e);
    expect(erro).toBeInstanceOf(LlmTimeoutError);
    expect(Date.now() - t0).toBeLessThan(350);
    expect(s.chamadas).toHaveLength(1);
  });

  it("llama-swap desligado vira LlmIndisponivelError e diz como subir", async () => {
    const url = await portaFechada();
    const erro = await novo(url, { tentativas: 2 }).chat(OLA).catch((e: unknown) => e);
    expect(erro).toBeInstanceOf(LlmIndisponivelError);
    expect((erro as Error).message).toContain(url);
    expect((erro as Error).message).toContain("swap.ps1");
  });

  it("503 com o modelo carregando ganha uma nova tentativa e dá certo", async () => {
    const s = await subir((_, res, n) =>
      n === 1 ? json(res, { error: { message: "Loading model" } }, 503) : json(res, respostaChat("pronto")),
    );
    const r = await novo(s.url).chat(OLA);
    expect(r.texto).toBe("pronto");
    expect(s.chamadas).toHaveLength(2);
  });

  it("500 repetido vira LlmHttpError com o status e a mensagem do servidor", async () => {
    const s = await subir((_, res) => json(res, { error: { message: "falha interna" } }, 500));
    const erro = await novo(s.url, { tentativas: 2 }).chat(OLA).catch((e: unknown) => e);
    expect(erro).toBeInstanceOf(LlmHttpError);
    expect((erro as LlmHttpError).status).toBe(500);
    expect((erro as Error).message).toContain("falha interna");
    expect(s.chamadas).toHaveLength(2);
  });

  it("400 (contexto estourado) não é repetido e a mensagem do servidor chega ao erro", async () => {
    const s = await subir((_, res) =>
      json(res, { error: { message: "request exceeds the available context size" } }, 400),
    );
    const erro = await novo(s.url, { tentativas: 3 }).chat(OLA).catch((e: unknown) => e);
    expect(erro).toBeInstanceOf(LlmHttpError);
    expect((erro as LlmHttpError).status).toBe(400);
    expect((erro as Error).message).toContain("context size");
    expect(s.chamadas).toHaveLength(1);
  });

  it("cancelar pelo AbortSignal vira LlmAbortadoError e não é repetido", async () => {
    const s = await subir(async (_, res) => {
      await new Promise((ok) => setTimeout(ok, 500));
      json(res, respostaChat("tarde"));
    });
    const controle = new AbortController();
    setTimeout(() => controle.abort(), 60);
    const erro = await novo(s.url).chat(OLA, { signal: controle.signal }).catch((e: unknown) => e);
    expect(erro).toBeInstanceOf(LlmAbortadoError);
    expect(s.chamadas).toHaveLength(1);
  });

  it("sinal já cancelado antes da chamada nem chega ao servidor", async () => {
    const s = await subir((_, res) => json(res, respostaChat("x")));
    const erro = await novo(s.url).chat(OLA, { signal: AbortSignal.abort() }).catch((e: unknown) => e);
    expect(erro).toBeInstanceOf(LlmAbortadoError);
    expect(s.chamadas).toHaveLength(0);
  });
});

// ---------- 5: JSON ----------

describe("chatJson", () => {
  it("pede response_format json_object e devolve o valor já lido", async () => {
    const s = await subir((_, res) => json(res, respostaChat('{"perguntas":["a","b"]}')));
    const r = await novo(s.url).chatJson<{ perguntas: string[] }>(OLA);
    expect(s.chamadas[0]?.corpo.response_format).toEqual({ type: "json_object" });
    expect(r.valor.perguntas).toEqual(["a", "b"]);
  });

  it("com esquema pede json_schema (a gramática do llama.cpp força a forma)", async () => {
    const esquema = { type: "object", properties: { x: { type: "number" } }, required: ["x"] };
    const s = await subir((_, res) => json(res, respostaChat('{"x":1}')));
    await novo(s.url).chatJson(OLA, { esquema });
    expect(s.chamadas[0]?.corpo.response_format).toEqual({
      type: "json_schema",
      json_schema: { name: "resposta", strict: true, schema: esquema },
    });
  });

  it("aceita JSON dentro de cerca ```json", async () => {
    const s = await subir((_, res) => json(res, respostaChat('```json\n{"ok":true}\n```')));
    expect((await novo(s.url).chatJson<{ ok: boolean }>(OLA)).valor.ok).toBe(true);
  });

  it("texto que não é JSON vira LlmRespostaInvalidaError com o bruto", async () => {
    const s = await subir((_, res) => json(res, respostaChat("não sei")));
    const erro = await novo(s.url).chatJson(OLA).catch((e: unknown) => e);
    expect(erro).toBeInstanceOf(LlmRespostaInvalidaError);
    expect((erro as LlmRespostaInvalidaError).bruto).toBe("não sei");
  });

  it("resposta truncada e vazia explica que faltou orçamento de tokens", async () => {
    const s = await subir((_, res) => json(res, respostaChat("", { fim: "length", raciocinio: "pensei demais" })));
    const erro = await novo(s.url).chatJson(OLA).catch((e: unknown) => e);
    expect(erro).toBeInstanceOf(LlmRespostaInvalidaError);
    expect((erro as Error).message).toMatch(/length|truncad/i);
  });

  it("`validar` que recusa o valor vira erro, e o que ele devolve é o valor final", async () => {
    const s = await subir((_, res) => json(res, respostaChat('{"n":"3"}')));
    const validar = (v: unknown): number => {
      const n = Number((v as { n: unknown }).n);
      if (Number.isNaN(n)) throw new Error("n inválido");
      return n;
    };
    expect((await novo(s.url).chatJson(OLA, { validar })).valor).toBe(3);

    const ruim = await subir((_, res) => json(res, respostaChat('{"n":"x"}')));
    const erro = await novo(ruim.url).chatJson(OLA, { validar }).catch((e: unknown) => e);
    expect(erro).toBeInstanceOf(LlmRespostaInvalidaError);
    expect((erro as Error).message).toContain("n inválido");
  });
});

// ---------- 6: tool calling ----------

const FERRAMENTAS = [
  {
    nome: "buscar_trechos",
    descricao: "Busca trechos do relatório.",
    parametros: {
      type: "object",
      properties: { pergunta: { type: "string" } },
      required: ["pergunta"],
    },
  },
  {
    nome: "fato_financeiro",
    descricao: "Valor de uma métrica.",
    parametros: { type: "object", properties: { metrica: { type: "string" } }, required: ["metrica"] },
  },
];

describe("chamarFerramentas", () => {
  it("declara as ferramentas no formato da OpenAI e devolve as chamadas com argumentos lidos", async () => {
    const s = await subir((_, res) =>
      json(
        res,
        respostaChat("", {
          ferramentas: [
            { id: "c1", nome: "buscar_trechos", argumentos: '{"pergunta":"riscos"}' },
            { id: "c2", nome: "fato_financeiro", argumentos: '{"metrica":"lucro"}' },
          ],
        }),
      ),
    );
    const r = await novo(s.url).chamarFerramentas(OLA, FERRAMENTAS);
    const corpo = s.chamadas[0]?.corpo;
    expect(corpo.tools).toEqual(
      FERRAMENTAS.map((f) => ({
        type: "function",
        function: { name: f.nome, description: f.descricao, parameters: f.parametros },
      })),
    );
    expect(corpo.tool_choice).toBe("auto");
    expect(r.chamadas).toEqual([
      { id: "c1", nome: "buscar_trechos", argumentos: { pergunta: "riscos" } },
      { id: "c2", nome: "fato_financeiro", argumentos: { metrica: "lucro" } },
    ]);
  });

  it("`escolha: required` obriga o modelo a chamar alguma ferramenta", async () => {
    const s = await subir((_, res) =>
      json(res, respostaChat("", { ferramentas: [{ id: "c1", nome: "buscar_trechos", argumentos: "{}" }] })),
    );
    await novo(s.url).chamarFerramentas(OLA, FERRAMENTAS, { escolha: "required" });
    expect(s.chamadas[0]?.corpo.tool_choice).toBe("required");
  });

  it("modelo que responde em texto, sem chamar nada, volta com chamadas vazias e o texto", async () => {
    const s = await subir((_, res) => json(res, respostaChat("A resposta já está na conversa.")));
    const r = await novo(s.url).chamarFerramentas(OLA, FERRAMENTAS);
    expect(r.chamadas).toEqual([]);
    expect(r.texto).toBe("A resposta já está na conversa.");
  });

  it("argumentos que não são JSON viram LlmRespostaInvalidaError", async () => {
    const s = await subir((_, res) =>
      json(res, respostaChat("", { ferramentas: [{ id: "c1", nome: "buscar_trechos", argumentos: "{pergunta: " }] })),
    );
    const erro = await novo(s.url).chamarFerramentas(OLA, FERRAMENTAS).catch((e: unknown) => e);
    expect(erro).toBeInstanceOf(LlmRespostaInvalidaError);
    expect((erro as LlmRespostaInvalidaError).bruto).toBe("{pergunta: ");
  });

  it("ferramenta que não foi declarada é recusada pelo nome", async () => {
    const s = await subir((_, res) =>
      json(res, respostaChat("", { ferramentas: [{ id: "c1", nome: "apagar_tudo", argumentos: "{}" }] })),
    );
    const erro = await novo(s.url).chamarFerramentas(OLA, FERRAMENTAS).catch((e: unknown) => e);
    expect(erro).toBeInstanceOf(LlmRespostaInvalidaError);
    expect((erro as Error).message).toContain("apagar_tudo");
  });

  it("argumentos vazios viram objeto vazio", async () => {
    const s = await subir((_, res) =>
      json(res, respostaChat("", { ferramentas: [{ id: "c1", nome: "buscar_trechos", argumentos: "" }] })),
    );
    expect((await novo(s.url).chamarFerramentas(OLA, FERRAMENTAS)).chamadas[0]?.argumentos).toEqual({});
  });
});

// ---------- 7: fluxo ----------

async function coletar<T>(fluxo: AsyncIterable<T>): Promise<T[]> {
  const itens: T[] = [];
  for await (const i of fluxo) itens.push(i);
  return itens;
}

describe("chatStream", () => {
  it("entrega os tokens em ordem, o raciocínio à parte e o uso no fim", async () => {
    const s = await subir((_, res) =>
      sse(res, [
        pedaco({ role: "assistant", reasoning_content: "hum" }),
        pedaco({ content: "Olá" }),
        pedaco({ content: ", mundo" }),
        pedaco({}, "stop"),
        pedaco({}, null, { prompt_tokens: 12, completion_tokens: 3 }),
      ]),
    );
    const eventos = await coletar(novo(s.url).chatStream(OLA));
    expect(s.chamadas[0]?.corpo.stream).toBe(true);
    expect(s.chamadas[0]?.corpo.stream_options).toEqual({ include_usage: true });
    expect(eventos.filter((e) => e.tipo === "token").map((e) => e.texto)).toEqual(["Olá", ", mundo"]);
    expect(eventos.find((e) => e.tipo === "raciocinio")?.texto).toBe("hum");
    expect(eventos.at(-1)).toEqual({ tipo: "fim", fim: "stop", uso: { entrada: 12, saida: 3 } });
  });

  it("cancelar no meio do fluxo levanta LlmAbortadoError", async () => {
    const s = await subir((_, res) =>
      sse(res, [pedaco({ content: "a" }), pedaco({ content: "b" }), pedaco({ content: "c" })], {
        intervaloMs: 80,
      }),
    );
    const controle = new AbortController();
    const recebidos: string[] = [];
    const erro = await (async () => {
      for await (const e of novo(s.url).chatStream(OLA, { signal: controle.signal })) {
        if (e.tipo === "token") recebidos.push(e.texto);
        controle.abort();
      }
    })().catch((e: unknown) => e);
    expect(erro).toBeInstanceOf(LlmAbortadoError);
    expect(recebidos.length).toBeLessThan(3);
  });

  it("servidor calado no meio do fluxo estoura o tempo ocioso", async () => {
    const s = await subir(async (_, res: ServerResponse) => {
      await sse(res, [pedaco({ content: "a" })], { semFim: true });
    });
    const erro = await coletar(novo(s.url).chatStream(OLA, { ociosoMs: 100 })).catch((e: unknown) => e);
    expect(erro).toBeInstanceOf(LlmTimeoutError);
  });

  it("fluxo que termina sem `finish_reason` fecha com fim desconhecido, sem travar", async () => {
    const s = await subir((_, res) => sse(res, [pedaco({ content: "x" })]));
    const eventos = await coletar(novo(s.url).chatStream(OLA));
    expect(eventos.at(-1)?.tipo).toBe("fim");
  });
});

// ---------- 8: embeddings ----------

describe("embeddings", () => {
  const vetores = (dim: number) => (corpo: { input: string[] }) =>
    corpo.input.map((_, i) => ({ object: "embedding", index: i, embedding: vetorUnitario(dim, i) }));

  it("usa o modelo de consulta (CPU), devolve na ordem do `index` e confere a dimensão", async () => {
    const s = await subir((c, res) => {
      const dados = vetores(4)(c.corpo).reverse(); // o servidor devolveu fora de ordem
      json(res, { object: "list", data: dados, model: c.corpo.model });
    });
    const v = await novo(s.url).embeddings(["a", "b", "c"], { dimensoes: 4 });
    expect(s.chamadas[0]?.caminho).toBe("/v1/embeddings");
    expect(s.chamadas[0]?.corpo.model).toBe("qwen3-embed-0.6b");
    expect(v.map((x) => x.indexOf(1))).toEqual([0, 1, 2]);
  });

  it("a dimensão padrão é 1024, a do índice `child_vec`", async () => {
    const s = await subir((c, res) => json(res, { data: vetores(8)(c.corpo) }));
    const erro = await novo(s.url).embeddings(["a"]).catch((e: unknown) => e);
    expect(erro).toBeInstanceOf(LlmRespostaInvalidaError);
    expect((erro as Error).message).toMatch(/8 dimens.*1024/);
  });

  it("vetor sem norma 1 é recusado (o índice é cosseno)", async () => {
    const s = await subir((_, res) =>
      json(res, { data: [{ index: 0, embedding: [2, 0, 0, 0] }] }),
    );
    const erro = await novo(s.url).embeddings(["a"], { dimensoes: 4 }).catch((e: unknown) => e);
    expect(erro).toBeInstanceOf(LlmRespostaInvalidaError);
    expect((erro as Error).message).toMatch(/norma/);
  });

  it("menos vetores que textos é erro", async () => {
    const s = await subir((c, res) => json(res, { data: vetores(4)({ input: c.corpo.input.slice(1) }) }));
    const erro = await novo(s.url).embeddings(["a", "b"], { dimensoes: 4 }).catch((e: unknown) => e);
    expect(erro).toBeInstanceOf(LlmRespostaInvalidaError);
  });

  it("lista vazia não faz requisição", async () => {
    const s = await subir((_, res) => json(res, { data: [] }));
    expect(await novo(s.url).embeddings([])).toEqual([]);
    expect(s.chamadas).toHaveLength(0);
  });

  it("divide em lotes e junta na ordem original", async () => {
    const s = await subir((c, res) => json(res, { data: vetores(4)(c.corpo) }));
    const v = await novo(s.url).embeddings(["1", "2", "3", "4", "5"], { dimensoes: 4, lote: 2 });
    expect(s.chamadas.map((c) => c.corpo.input.length)).toEqual([2, 2, 1]);
    expect(v).toHaveLength(5);
  });

  it("o prefixo da consulta é igual ao do indexador Python", () => {
    expect(formatarConsulta("Qual a receita?")).toBe(
      "Instruct: Given a question about a company's annual report, retrieve relevant passages that answer it\nQuery: Qual a receita?",
    );
    expect(formatarConsulta("x", "tarefa")).toBe("Instruct: tarefa\nQuery: x");
  });

  it("embeddingDeConsulta manda a pergunta formatada e devolve um vetor só", async () => {
    const s = await subir((c, res) => json(res, { data: vetores(4)(c.corpo) }));
    const v = await novo(s.url).embeddingDeConsulta("Qual a receita?", { dimensoes: 4 });
    expect(s.chamadas[0]?.corpo.input).toEqual([formatarConsulta("Qual a receita?")]);
    expect(v).toHaveLength(4);
  });
});

// ---------- 9: rerank ----------

describe("rerank", () => {
  it("manda query e documents ao /v1/rerank e devolve a nota de cada texto na ordem de entrada", async () => {
    const s = await subir((_, res) =>
      json(res, {
        results: [
          { index: 2, relevance_score: 0.9 },
          { index: 0, relevance_score: 0.1 },
          { index: 1, relevance_score: 0.5 },
        ],
      }),
    );
    const notas = await novo(s.url).rerank("receita", ["a", "b", "c"]);
    expect(s.chamadas[0]?.caminho).toBe("/v1/rerank");
    expect(s.chamadas[0]?.corpo).toEqual({ model: "qwen3-rerank-0.6b", query: "receita", documents: ["a", "b", "c"] });
    expect(notas).toEqual([0.1, 0.5, 0.9]);
  });

  it.each([
    ["índice faltando", [{ index: 0, relevance_score: 1 }]],
    ["índice repetido", [{ index: 0, relevance_score: 1 }, { index: 0, relevance_score: 0.5 }]],
    ["índice fora do intervalo", [{ index: 0, relevance_score: 1 }, { index: 7, relevance_score: 0.5 }]],
  ])("%s é erro", async (_nome, results) => {
    const s = await subir((_, res) => json(res, { results }));
    const erro = await novo(s.url).rerank("q", ["a", "b"]).catch((e: unknown) => e);
    expect(erro).toBeInstanceOf(LlmRespostaInvalidaError);
  });

  it("lista vazia não faz requisição", async () => {
    const s = await subir((_, res) => json(res, { results: [] }));
    expect(await novo(s.url).rerank("q", [])).toEqual([]);
    expect(s.chamadas).toHaveLength(0);
  });
});

// ---------- modelos ----------

describe("modelos", () => {
  it("lista os ids de /v1/models", async () => {
    const s = await subir((_, res) =>
      json(res, { object: "list", data: [{ id: "qwen36-35b-a3b" }, { id: "gpt-oss-20b" }] }),
    );
    expect(await novo(s.url).modelos()).toEqual(["qwen36-35b-a3b", "gpt-oss-20b"]);
    expect(s.chamadas[0]?.metodo).toBe("GET");
  });
});
