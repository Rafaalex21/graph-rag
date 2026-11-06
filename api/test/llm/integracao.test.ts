/**
 * Integração do cliente LLM com o llama-swap de verdade (aceite da F7.1: chat, tool call, embeddings e
 * rerank). Pulado quando o llama-swap não responde em `LLAMA_SWAP_URL` (padrão http://127.0.0.1:8080):
 * suba com `infra\swap.ps1` e rode `npm test`. A primeira chamada de cada modelo inclui a carga dele
 * (14 s o Qwen), por isso o tempo-limite de cada teste é largo.
 */
import { describe, expect, it } from "vitest";
import { ClienteLlm, PERFIS } from "../../src/llm/index.ts";

const BASE = process.env["LLAMA_SWAP_URL"] ?? "http://127.0.0.1:8080";
const vivo = await fetch(`${BASE}/v1/models`, { signal: AbortSignal.timeout(1500) })
  .then((r) => r.ok)
  .catch(() => false);

const FERRAMENTAS = [
  {
    nome: "fato_financeiro",
    descricao: "Valor de uma métrica financeira (lucro, receita...) de um período.",
    parametros: {
      type: "object",
      properties: {
        metrica: { type: "string", description: "nome da métrica, como 'lucro líquido'" },
        periodo: { type: "string", description: "ano, como '2025'" },
      },
      required: ["metrica"],
    },
  },
  {
    nome: "buscar_trechos",
    descricao: "Busca trechos de texto do relatório para perguntas sobre o que o documento diz.",
    parametros: { type: "object", properties: { pergunta: { type: "string" } }, required: ["pergunta"] },
  },
];

const cos = (a: number[], b: number[]) => a.reduce((s, x, i) => s + x * (b[i] ?? 0), 0);

describe.skipIf(!vivo)("llama-swap de verdade", () => {
  const llm = new ClienteLlm({ baseUrl: BASE });
  const T = 300_000;

  it("lista os modelos dos perfis", async () => {
    const ids = await llm.modelos();
    expect(ids).toEqual(expect.arrayContaining([PERFIS.principal.modelo, PERFIS.rapido.modelo]));
  });

  it("embeddings: 1024 dimensões, norma 1, e a pergunta parecida fica mais perto", async () => {
    const [q, perto, longe] = await llm.embeddings(
      [
        "Qual foi o lucro líquido do banco em 2025?",
        "O lucro líquido ajustado de 2025 foi de R$ 20 bilhões.",
        "O auditor independente é uma empresa de auditoria.",
      ],
      { dimensoes: 1024 },
    );
    expect(q).toHaveLength(1024);
    expect(Math.abs(cos(q ?? [], q ?? []) - 1)).toBeLessThan(1e-3);
    expect(cos(q ?? [], perto ?? [])).toBeGreaterThan(cos(q ?? [], longe ?? []));
    expect((await llm.embeddingDeConsulta("Qual foi o lucro?")).length).toBe(1024);
  }, T);

  it("rerank: o texto que responde à pergunta recebe a maior nota", async () => {
    const textos = [
      "A sede do banco fica em Brasília.",
      "O lucro líquido de 2025 foi de R$ 20 bilhões.",
      "O auditor independente é uma empresa de auditoria.",
    ];
    const notas = await llm.rerank("Qual foi o lucro líquido em 2025?", textos);
    expect(notas).toHaveLength(3);
    expect(notas.indexOf(Math.max(...notas))).toBe(1);
  }, T);

  it("chat do perfil principal responde sem raciocínio e conta tokens", async () => {
    const r = await llm.chat([{ role: "user", content: "Responda só com a palavra: pronto." }], {
      maxTokens: 24,
    });
    expect(r.texto.toLowerCase()).toContain("pronto");
    expect(r.fim).toBe("stop");
    expect(r.raciocinio).toBe("");
    expect(r.uso.entrada).toBeGreaterThan(0);
    expect(r.uso.saida).toBeGreaterThan(0);
  }, T);

  it("chatJson com esquema devolve a forma pedida", async () => {
    const r = await llm.chatJson<{ perguntas: string[] }>(
      [
        {
          role: "user",
          content:
            "Decomponha em perguntas simples: 'Qual foi o lucro de 2025 e quantos empregados havia?'. " +
            'Responda {"perguntas": [...]}.',
        },
      ],
      {
        esquema: {
          type: "object",
          properties: { perguntas: { type: "array", items: { type: "string" } } },
          required: ["perguntas"],
          additionalProperties: false,
        },
        maxTokens: 300,
      },
    );
    expect(r.valor.perguntas.length).toBeGreaterThanOrEqual(2);
  }, T);

  it("tool call: o Qwen escolhe uma ferramenta declarada e manda argumentos em JSON", async () => {
    const r = await llm.chamarFerramentas(
      [
        {
          role: "system",
          content: "Use as ferramentas para responder. Não responda de memória.",
        },
        { role: "user", content: "Qual foi o lucro líquido em 2025?" },
      ],
      FERRAMENTAS,
      { escolha: "required", maxTokens: 300 },
    );
    expect(r.chamadas.length).toBeGreaterThanOrEqual(1);
    const primeira = r.chamadas[0];
    expect(FERRAMENTAS.map((f) => f.nome)).toContain(primeira?.nome);
    expect(typeof primeira?.argumentos).toBe("object");
    expect(primeira?.nome).toBe("fato_financeiro");
    expect(String(primeira?.argumentos["metrica"]).toLowerCase()).toContain("lucro");
  }, T);

  it("fluxo: tokens chegam em pedaços e o fim traz o uso", async () => {
    const eventos = [];
    for await (const e of llm.chatStream(
      [{ role: "user", content: "Conte de 1 a 5, separado por vírgulas." }],
      { maxTokens: 60 },
    )) {
      eventos.push(e);
    }
    const texto = eventos.filter((e) => e.tipo === "token").map((e) => e.texto).join("");
    expect(texto).toMatch(/1.*2.*3.*4.*5/);
    expect(eventos.filter((e) => e.tipo === "token").length).toBeGreaterThan(1);
    const fim = eventos.at(-1);
    expect(fim?.tipo).toBe("fim");
    expect(fim?.tipo === "fim" && fim.uso.saida).toBeGreaterThan(0);
  }, T);

  it("perfil rápido (gpt-oss-20b) responde, com o raciocínio fora do texto", async () => {
    const r = await llm.chat([{ role: "user", content: "Responda só com a palavra: pronto." }], {
      perfil: "rapido",
      maxTokens: 400,
    });
    expect(r.texto.toLowerCase()).toContain("pronto");
  }, T);
});
