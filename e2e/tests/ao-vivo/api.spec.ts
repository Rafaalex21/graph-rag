/**
 * E2E da API REAL (F7.6 em diante), contra a pilha no ar: Neo4j, llama-swap e `npm start` em `api/`. Não roda no CI.
 * Reproduzir: ver `e2e/README.md`.
 */
import { expect, test } from "@playwright/test";
import { URL_API_REAL } from "../../playwright.config.ts";
import { perguntaDoGolden } from "../../paginas/golden.ts";

const corpo = (extra: Record<string, unknown> = {}) => ({ conversationId: "e2e-api", message: "ping", ...extra });

test.describe("validação do pedido (nenhuma chamada ao modelo)", () => {
  for (const [nome, pedido] of [
    ["sem message", { conversationId: "e2e" }],
    ["message vazia", corpo({ message: "" })],
    ["message com mais de 4.000 caracteres", corpo({ message: "x".repeat(4001) })],
    ["campo fora do contrato", corpo({ extra: 1 })],
    ["perfil inexistente", corpo({ profile: "turbo" })],
    ["modo inexistente", corpo({ mode: "magico" })],
    ["histórico com papel inválido", corpo({ historico: [{ papel: "sistema", texto: "x" }] })],
  ] as const) {
    test(`${nome}: 400 com o corpo Erro do contrato`, async ({ request }) => {
      const r = await request.post(`${URL_API_REAL}/api/chat`, { data: pedido });
      expect(r.status()).toBe(400);
      const j = (await r.json()) as { codigo: string; mensagem: string };
      expect(j.codigo).toBe("requisicao_invalida");
      expect(j.mensagem).not.toMatch(/stack|at .*\.ts|\/api\//);
    });
  }

  test("a API não manda cabeçalho CORS (só o proxy do ng serve a alcança)", async ({ request }) => {
    const r = await request.get(`${URL_API_REAL}/api/saude`, { headers: { origin: "http://evil.example" } });
    expect(r.headers()["access-control-allow-origin"]).toBeUndefined();
  });
});

test.describe("saúde", () => {
  test("/api/saude diz o estado do Neo4j e dos modelos", async ({ request }) => {
    const r = await request.get(`${URL_API_REAL}/api/saude`);
    expect(r.status()).toBe(200);
    expect(await r.json()).toMatchObject({ neo4j: expect.anything(), llm: expect.anything() });
  });
});

test.describe("uma pergunta de verdade, em SSE", () => {
  test("o primeiro evento chega em até 1 s e o fluxo segue o contrato até o `fim`", async () => {
    const t0 = performance.now();
    const r = await fetch(`${URL_API_REAL}/api/chat`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "text/event-stream" },
      body: JSON.stringify(corpo({ conversationId: "e2e-api-sse", message: perguntaDoGolden("T15") })),
    });
    expect(r.status).toBe(200);
    expect(r.headers.get("content-type")).toContain("text/event-stream");
    const leitor = (r.body as ReadableStream<Uint8Array>).getReader();
    const dec = new TextDecoder();
    let pendente = "";
    let primeiroMs: number | null = null;
    const eventos: string[] = [];
    const fim: { resposta?: string; citacoes?: { id: string; pagina: string | null }[]; metricas?: { estado: string; rota: string[] } }[] = [];
    for (;;) {
      const { done, value } = await leitor.read();
      if (done) break;
      pendente += dec.decode(value, { stream: true });
      let i: number;
      while ((i = pendente.indexOf("\n\n")) >= 0) {
        const q = pendente.slice(0, i);
        pendente = pendente.slice(i + 2);
        const nome = /^event: (.+)$/m.exec(q)?.[1] ?? "";
        const dados = /^data: (.+)$/m.exec(q)?.[1] ?? "{}";
        primeiroMs ??= performance.now() - t0;
        eventos.push(nome);
        if (nome === "fim") fim.push(JSON.parse(dados));
      }
    }
    expect(primeiroMs).not.toBeNull();
    expect(primeiroMs as number).toBeLessThanOrEqual(1000);
    expect(eventos[0]).toBe("etapa");
    expect(eventos.at(-1)).toBe("fim");
    expect(eventos.filter((e) => e === "fim")).toHaveLength(1);
    expect(eventos.filter((e) => !["etapa", "cypher", "evidencia", "token", "fim", "erro"].includes(e))).toEqual([]);
    expect(fim[0]?.resposta?.length).toBeGreaterThan(0);
    expect(fim[0]?.metricas?.rota.length).toBeGreaterThan(0);
  });

  test("duas perguntas ao mesmo tempo passam e a terceira recebe 429 `ocupado`", async () => {
    const pedir = (n: number) =>
      fetch(`${URL_API_REAL}/api/chat`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(corpo({ conversationId: `e2e-429-${n}`, message: perguntaDoGolden("T15") })),
      });
    const respostas = await Promise.all([pedir(1), pedir(2), pedir(3)]);
    const status = respostas.map((r) => r.status).sort();
    expect(status).toEqual([200, 200, 429]);
    const barrada = respostas.find((r) => r.status === 429) as Response;
    expect(await barrada.json()).toMatchObject({ codigo: "ocupado" });
    await Promise.all(respostas.map((r) => r.body?.cancel()));
  });
});
