/**
 * Testes do relatório diário (F7.7), escritos antes do código. É o aceite da tarefa ("relatório diário gerado a partir dos
 * logs"), então os erros dele enganam quem lê. Modos de falha:
 *
 *  1. percentis errados (nearest-rank: p50 de [1,2,3,4] é 2; p95 de 20 valores é o 19º; um valor só vale para todos);
 *  2. linha ruim no log (JSON quebrado, última linha cortada pela queda, versão desconhecida, linha vazia) derruba o relatório
 *     inteiro em vez de ser contada e ignorada;
 *  3. dia sem requisição vira divisão por zero / NaN / "null%" em vez de um relatório vazio legível;
 *  4. a taxa de erro por ferramenta soma chamadas e erros de verdade (e uma ferramenta que só falhou aparece);
 *  5. requisições recusadas (400/429) e canceladas misturadas com as respondidas distorcem a latência: a latência é só das
 *     que terminaram em `fim`;
 *  6. rotas `http` agrupadas pelo padrão (`/api/fonte/:id`), nunca pelo id, e códigos de status contados;
 *  7. as notas do feedback (+1/-1) entram na contagem do dia, e linha de feedback ruim é ignorada;
 *  8. o Markdown tem os números do JSON (não é um segundo cálculo) e sai igual para a mesma entrada.
 *
 * Notas ligadas às perguntas (F7.14). Modos de falha:
 *  9. a nota é ligada ao registro de `chat` de mesmo `id` (= `mensagemId`), com estado, ferramentas, tempo e a impressão
 *     digital da pergunta; nota sem registro aparece como tal, não some nem derruba o relatório;
 * 10. a pergunta é do dia anterior e a nota do dia seguinte: o registro do dia anterior (`registrosAnteriores`) também liga;
 * 11. duas notas para a mesma mensagem aparecem as duas; uma nota para uma pergunta recusada/com erro aparece com o resultado;
 * 12. o comentário (texto livre, com `|`, quebra de linha e aspas) não quebra a tabela do Markdown e vem cortado;
 * 13. o texto da pergunta só aparece se estava no registro (`TELEMETRIA_TEXTO=1`); o relatório não o inventa;
 * 14. um `id` de registro `http` igual ao `mensagemId` não liga (só `chat` tem pergunta).
 */
import { describe, expect, it } from "vitest";
import { gerarRelatorio, lerRegistros, paraMarkdown, percentil } from "../../src/telemetria/relatorio.ts";
import type { RegistroChat, RegistroHttp } from "../../src/telemetria/tipos.ts";

const chat = (extra: Partial<RegistroChat> = {}): RegistroChat => ({
  v: 1,
  tipo: "chat",
  ts: "2026-11-07T15:00:00.000Z",
  id: "c1",
  conversationId: "conv",
  resultado: "fim",
  codigo: null,
  pergunta: { caracteres: 30, hash: "0123456789abcdef" },
  estado: "suficiente",
  rodadas: 1,
  ferramentas: [{ nome: "buscar_trechos", chamadas: 1, erros: 0, evidencias: 5, ms: 800 }],
  evidencias: 5,
  anotacoes: {},
  tokens: { entrada: 1000, saida: 100 },
  redator: { modo: "llm", reparos: 0, cortada: false, fallback: null },
  latencia_ms: { total: 10_000, primeiro_evento: 2, primeiro_token: 6_000, atualizar: 500, rotear: 700, executar: 800, criticar: 900, redator: 4_000 },
  ...extra,
});
const http = (extra: Partial<RegistroHttp> = {}): RegistroHttp => ({ v: 1, tipo: "http", ts: "2026-11-07T15:00:00.000Z", id: "h1", metodo: "GET", rota: "/api/saude", status: 200, ms: 5, ...extra });
const jsonl = (...itens: unknown[]) => itens.map((i) => (typeof i === "string" ? i : JSON.stringify(i))).join("\n") + "\n";

describe("percentil (nearest-rank)", () => {
  it.each([
    [[1, 2, 3, 4], 0.5, 2],
    [[4, 3, 2, 1], 0.5, 2], // não depende da ordem de entrada
    [[7], 0.5, 7],
    [[7], 0.95, 7],
    [Array.from({ length: 20 }, (_, i) => i + 1), 0.95, 19],
    [Array.from({ length: 100 }, (_, i) => i + 1), 0.95, 95],
    [[1, 2, 3], 1, 3],
  ])("%j p%d = %d", (v, p, esperado) => expect(percentil(v as number[], p as number)).toBe(esperado));
  it("lista vazia: null, não NaN", () => expect(percentil([], 0.5)).toBeNull());
});

describe("lerRegistros", () => {
  it("lê as linhas boas e conta as ruins (JSON quebrado, versão desconhecida, tipo desconhecido, vazia sem contar)", () => {
    const texto = jsonl(chat(), "{isto não é json", { ...chat(), v: 2 }, { v: 1, tipo: "outro" }, "", http(), '{"v":1,"tipo":"chat","ts":"2026-11-07T15:00:00.000Z","id":"corta');
    const { registros, invalidas } = lerRegistros(texto);
    expect(registros.map((r) => r.tipo)).toEqual(["chat", "http"]);
    expect(invalidas).toBe(4);
  });

  it("registro de chat sem campos obrigatórios é inválido, não vira NaN no relatório", () => {
    const { registros, invalidas } = lerRegistros(jsonl({ v: 1, tipo: "chat", ts: "2026-11-07T15:00:00.000Z", id: "x" }));
    expect(registros).toEqual([]);
    expect(invalidas).toBe(1);
  });

  it("aceita CRLF e arquivo vazio", () => {
    expect(lerRegistros("").registros).toEqual([]);
    expect(lerRegistros(jsonl(chat()).replaceAll("\n", "\r\n")).registros).toHaveLength(1);
  });
});

describe("gerarRelatorio", () => {
  it("dia sem requisição: relatório vazio, sem NaN nem divisão por zero", () => {
    const r = gerarRelatorio([], { dia: "2026-11-07" });
    expect(r.dia).toBe("2026-11-07");
    expect(r.chat.total).toBe(0);
    expect(r.chat.latencia_ms.total).toEqual({ n: 0, p50: null, p95: null, max: null });
    expect(JSON.stringify(r)).not.toMatch(/NaN|Infinity/);
    expect(paraMarkdown(r)).toContain("Nenhuma requisição");
  });

  it("conta os resultados e os estados; a latência é só das que terminaram em `fim`", () => {
    const registros = [
      chat({ id: "1", latencia_ms: { ...chat().latencia_ms, total: 1_000 } }),
      chat({ id: "2", latencia_ms: { ...chat().latencia_ms, total: 3_000 } }),
      chat({ id: "3", latencia_ms: { ...chat().latencia_ms, total: 2_000 } }),
      chat({ id: "4", resultado: "erro", codigo: "llm_indisponivel", estado: null, latencia_ms: { ...chat().latencia_ms, total: 99_000 } }),
      chat({ id: "5", resultado: "cancelada", codigo: null, estado: null, latencia_ms: { ...chat().latencia_ms, total: 88_000 } }),
      chat({ id: "6", resultado: "recusada", codigo: "ocupado", estado: null, latencia_ms: { ...chat().latencia_ms, total: 1 } }),
      chat({ id: "7", estado: "incompleta", latencia_ms: { ...chat().latencia_ms, total: 4_000 } }),
    ];
    const r = gerarRelatorio(registros, { dia: "2026-11-07" });
    expect(r.chat.total).toBe(7);
    expect(r.chat.resultados).toEqual({ fim: 4, erro: 1, cancelada: 1, recusada: 1 });
    expect(r.chat.estados).toEqual({ suficiente: 3, incompleta: 1 });
    expect(r.chat.codigos).toEqual({ llm_indisponivel: 1, ocupado: 1 });
    expect(r.chat.latencia_ms.total).toEqual({ n: 4, p50: 2_000, p95: 4_000, max: 4_000 });
  });

  it("soma os tokens só das que terminaram em `fim` e mostra o primeiro token e o redator", () => {
    const r = gerarRelatorio(
      [chat({ id: "1", tokens: { entrada: 1000, saida: 100 } }), chat({ id: "2", tokens: { entrada: 500, saida: 50 } }), chat({ id: "3", resultado: "erro", codigo: "x", tokens: { entrada: 9999, saida: 9999 } })],
      { dia: "2026-11-07" },
    );
    expect(r.chat.tokens).toEqual({ entrada: 1500, saida: 150 });
    expect(r.chat.latencia_ms.primeiro_token.n).toBe(2);
    expect(r.chat.latencia_ms.redator.p50).toBe(4_000);
  });

  it("por ferramenta: chamadas, erros e taxa de erro, mesmo a que só falhou", () => {
    const f = (nome: string, chamadas: number, erros: number, ms: number) => ({ nome, chamadas, erros, evidencias: 1, ms });
    const r = gerarRelatorio(
      [
        chat({ id: "1", ferramentas: [f("buscar_trechos", 2, 0, 400), f("consultar_grafo", 1, 1, 2_000)] }),
        chat({ id: "2", ferramentas: [f("buscar_trechos", 1, 1, 600), f("consultar_grafo", 1, 1, 4_000)] }),
      ],
      { dia: "2026-11-07" },
    );
    const por = Object.fromEntries(r.chat.ferramentas.map((x) => [x.nome, x]));
    expect(por["buscar_trechos"]).toMatchObject({ chamadas: 3, erros: 1, requisicoes: 2 });
    expect(por["buscar_trechos"]?.taxa_de_erro).toBeCloseTo(1 / 3);
    expect(por["consultar_grafo"]).toMatchObject({ chamadas: 2, erros: 2, taxa_de_erro: 1 });
    expect(por["consultar_grafo"]?.ms_por_chamada).toEqual({ n: 2, p50: 2_000, p95: 4_000, max: 4_000 });
    // a mais chamada primeiro
    expect(r.chat.ferramentas.map((x) => x.nome)).toEqual(["buscar_trechos", "consultar_grafo"]);
  });

  it("conta as respostas que precisaram de reparo, as cortadas e os fallbacks do redator", () => {
    const r = gerarRelatorio(
      [
        chat({ id: "1", redator: { modo: "llm", reparos: 1, cortada: false, fallback: null } }),
        chat({ id: "2", redator: { modo: "llm", reparos: 0, cortada: true, fallback: null } }),
        chat({ id: "3", redator: { modo: "modelo_fixo", reparos: 0, cortada: false, fallback: "llm_indisponivel" } }),
        chat({ id: "4", redator: null, resultado: "erro", codigo: "falha_interna" }),
      ],
      { dia: "2026-11-07" },
    );
    expect(r.chat.redator).toEqual({ com_reparo: 1, cortadas: 1, modelo_fixo: 1, fallbacks: { llm_indisponivel: 1 } });
  });

  it("http: agrupa por padrão de rota e status, com a latência de cada rota", () => {
    const r = gerarRelatorio(
      [
        http({ id: "1", rota: "/api/fonte/:id", status: 200, ms: 10 }),
        http({ id: "2", rota: "/api/fonte/:id", status: 404, ms: 30 }),
        http({ id: "3", rota: "/api/fonte/:id", status: 200, ms: 20 }),
        http({ id: "4", rota: "/api/saude", status: 200, ms: 5 }),
      ],
      { dia: "2026-11-07" },
    );
    const fonte = r.http.find((x) => x.rota === "/api/fonte/:id");
    expect(fonte).toMatchObject({ total: 3, status: { "200": 2, "404": 1 } });
    expect(fonte?.ms).toEqual({ n: 3, p50: 20, p95: 30, max: 30 });
    expect(r.http.map((x) => x.rota)).toEqual(["/api/fonte/:id", "/api/saude"]);
  });

  it("feedback: conta positivas e negativas e ignora linha ruim", () => {
    const r = gerarRelatorio([], { dia: "2026-11-07", feedback: jsonl({ ts: "2026-11-07T10:00:00.000Z", mensagemId: "a", nota: 1 }, { ts: "2026-11-07T11:00:00.000Z", mensagemId: "b", nota: -1 }, { ts: "2026-11-07T12:00:00.000Z", mensagemId: "c", nota: -1 }, "quebrada", { mensagemId: "d", nota: 7 }, { ts: "2026-11-06T12:00:00.000Z", mensagemId: "e", nota: 1 }) });
    expect(r.feedback).toMatchObject({ positivas: 1, negativas: 2, invalidas: 2 });
    expect(r.feedback?.notas.map((n) => n.mensagemId)).toEqual(["a", "b", "c"]);
  });

  it("repassa as linhas inválidas do log para o relatório", () => {
    expect(gerarRelatorio([], { dia: "2026-11-07", linhasInvalidas: 3 }).linhas_invalidas).toBe(3);
  });
});

describe("paraMarkdown", () => {
  const registros = [chat({ id: "1" }), chat({ id: "2", resultado: "erro", codigo: "llm_indisponivel", estado: null }), http()];

  it("traz os números do JSON e é igual para a mesma entrada", () => {
    const rel = gerarRelatorio(registros, { dia: "2026-11-07" });
    const md = paraMarkdown(rel);
    expect(md).toBe(paraMarkdown(gerarRelatorio(registros, { dia: "2026-11-07" })));
    expect(md).toContain("# Telemetria de 2026-11-07");
    expect(md).toContain("buscar_trechos");
    expect(md).toContain("llm_indisponivel");
    expect(md).toContain("10.000"); // latência total (p50) em ms, com separador de milhar
    expect(md).not.toMatch(/NaN|undefined|null/);
  });
});

// ---------- 9 a 14: notas ligadas às perguntas (F7.14) ----------

describe("notas ligadas às perguntas", () => {
  const nota = (mensagemId: string, n: 1 | -1, extra: Record<string, unknown> = {}, ts = "2026-11-07T16:00:00.000Z") => ({ ts, mensagemId, nota: n, ...extra });
  const pergunta = chat({
    id: "m1",
    estado: "incompleta",
    rodadas: 2,
    ferramentas: [
      { nome: "fato_financeiro", chamadas: 1, erros: 0, evidencias: 1, ms: 300 },
      { nome: "buscar_trechos", chamadas: 2, erros: 0, evidencias: 8, ms: 900 },
    ],
    pergunta: { caracteres: 42, hash: "abcdef0123456789" },
    latencia_ms: { total: 21_500, primeiro_evento: 3, primeiro_token: 9_000, atualizar: 1, rotear: 1, executar: 1, criticar: 1, redator: 1 },
  });

  it("liga a nota ao registro de mesmo id, com estado, ferramentas, tempo e impressão digital", () => {
    const r = gerarRelatorio([pergunta], { dia: "2026-11-07", feedback: jsonl(nota("m1", -1, { comentario: "faltou o número" })) });
    expect(r.feedback?.notas).toHaveLength(1);
    expect(r.feedback?.notas[0]).toMatchObject({
      mensagemId: "m1",
      nota: -1,
      comentario: "faltou o número",
      registro: { resultado: "fim", estado: "incompleta", rodadas: 2, ferramentas: ["fato_financeiro", "buscar_trechos"], total_ms: 21_500, pergunta: { caracteres: 42, hash: "abcdef0123456789" } },
    });
  });

  it("nota sem registro: aparece com registro nulo, sem derrubar nada", () => {
    const r = gerarRelatorio([pergunta], { dia: "2026-11-07", feedback: jsonl(nota("fantasma", 1)) });
    expect(r.feedback?.notas[0]).toMatchObject({ mensagemId: "fantasma", registro: null });
    const md = paraMarkdown(r);
    expect(md).toContain("fantasma");
    expect(md).toContain("sem registro");
    expect(md).not.toMatch(/NaN|undefined|null/);
  });

  it("a pergunta de ontem recebe a nota de hoje, pelos registros anteriores", () => {
    const ontem = chat({ id: "velha", ts: "2026-11-06T22:00:00.000Z" });
    const r = gerarRelatorio([], { dia: "2026-11-07", registrosAnteriores: [ontem], feedback: jsonl(nota("velha", 1)) });
    expect(r.feedback?.notas[0]?.registro).toMatchObject({ resultado: "fim" });
    // os registros anteriores só servem para ligar: não entram nas contagens do dia
    expect(r.chat.total).toBe(0);
  });

  it("duas notas para a mesma mensagem aparecem as duas, na ordem do arquivo", () => {
    const r = gerarRelatorio([pergunta], { dia: "2026-11-07", feedback: jsonl(nota("m1", 1), nota("m1", -1, {}, "2026-11-07T17:00:00.000Z")) });
    expect(r.feedback?.notas.map((n) => n.nota)).toEqual([1, -1]);
    expect(r.feedback).toMatchObject({ positivas: 1, negativas: 1 });
  });

  it("nota de pergunta recusada ou com erro mostra o resultado", () => {
    const r = gerarRelatorio([chat({ id: "e1", resultado: "erro", codigo: "llm_timeout", estado: null, ferramentas: [] })], { dia: "2026-11-07", feedback: jsonl(nota("e1", -1)) });
    expect(r.feedback?.notas[0]?.registro).toMatchObject({ resultado: "erro", codigo: "llm_timeout", estado: null, ferramentas: [] });
  });

  it("comentário com |, quebra de linha e aspas não quebra a tabela e vem cortado em 200 caracteres", () => {
    const longo = `a | b\nlinha "dois" ${"x".repeat(400)}`;
    const r = gerarRelatorio([pergunta], { dia: "2026-11-07", feedback: jsonl(nota("m1", -1, { comentario: longo })) });
    const md = paraMarkdown(r);
    const linhas = md.split("\n").filter((l) => l.includes("abcdef0123456789"));
    expect(linhas).toHaveLength(1); // uma só linha de tabela: a quebra de linha do comentário não a parte
    expect(linhas[0]).toContain("a \\| b linha");
    expect((r.feedback?.notas[0]?.comentario ?? "").length).toBeLessThanOrEqual(200);
  });

  it("o texto da pergunta só aparece quando o registro o guardou", () => {
    const comTexto = chat({ id: "t1", pergunta: { caracteres: 20, hash: "1111111111111111", texto: "Qual o lucro de 2025?" } });
    const r = gerarRelatorio([comTexto, pergunta], { dia: "2026-11-07", feedback: jsonl(nota("t1", 1), nota("m1", 1)) });
    const md = paraMarkdown(r);
    expect(md).toContain("Qual o lucro de 2025?");
    expect(r.feedback?.notas[1]?.registro?.pergunta).not.toHaveProperty("texto");
  });

  it("registro http com o mesmo id não liga", () => {
    const r = gerarRelatorio([http({ id: "m9" })], { dia: "2026-11-07", feedback: jsonl(nota("m9", 1)) });
    expect(r.feedback?.notas[0]?.registro).toBeNull();
  });

  it("sem feedback.jsonl o relatório segue sem a seção de notas", () => {
    expect(gerarRelatorio([pergunta], { dia: "2026-11-07" }).feedback).toBeNull();
  });
});
