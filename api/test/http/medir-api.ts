/**
 * Medida da API no ar (F7.6): `npm run avaliar:api`, com Neo4j, llama-swap e `npm start` (ou `npm run dev`) rodando.
 *
 * Definições fixadas antes de rodar (o aceite do ETAPAS é "testes de contrato contra o contrato; primeiro evento em ≤ 1 s"):
 *
 *  - **Primeiro evento** (A): para cada uma das 60 perguntas do `eval/golden.csv`, o tempo entre enviar o POST e chegar o
 *    primeiro quadro SSE (aborta em seguida; o fluxo inteiro não é esperado). O aceite é o MÁXIMO ≤ 1000 ms nas 60.
 *  - **Fluxo inteiro** (B): perguntas escolhidas de cada categoria do golden e rodadas até o fim; cada evento é validado
 *    contra os esquemas do `contracts/api.openapi.yaml`, o fluxo tem de terminar em um único `fim` (ou `erro`), e se registra
 *    o tempo do 1º `token` e do `fim`.
 *  - **Rotas** (C): `/api/saude`, `/api/fonte/:id` para as evidências do fluxo B (cada resposta validada), `/api/grafo/vizinhanca`,
 *    `/api/documento/pdf` com `Range`, `/api/feedback`.
 *
 * Grava `eval/resultados/f76-api.json` (ids, contagens e tempos; sem texto do documento nem da resposta, ADR-009).
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { lerCsv } from "../../src/avaliacao/busca.ts";
import { esquemasDosEventos, problemas } from "./contrato.ts";

const RAIZ = new URL("../../../", import.meta.url);
const { values } = parseArgs({
  options: {
    api: { type: "string", default: process.env["API_URL"] ?? "http://127.0.0.1:3000" },
    nome: { type: "string", default: "f76-api" },
    inteiras: { type: "string", default: "T01,T05,N01,N06,G03,P02,M02,F01,F02" },
    pular: { type: "boolean", default: false },
    extras: { type: "string", default: "", description: "ids de tabela, filho, comunidade e entidade para o /api/fonte (as evidências do fluxo só trazem Pais e fatos)" },
  },
});
const API = values.api as string;
const golden = lerCsv(readFileSync(new URL("eval/golden.csv", RAIZ), "utf-8")).map((c) => ({ id: c["id"] as string, pergunta: c["pergunta"] as string }));

interface Quadro {
  evento: string;
  dados: unknown;
  ms: number;
}

async function* quadros(r: Response, t0: number): AsyncGenerator<Quadro> {
  const leitor = (r.body as ReadableStream<Uint8Array>).getReader();
  const dec = new TextDecoder();
  let resto = "";
  for (;;) {
    const { done, value } = await leitor.read();
    if (done) return;
    resto += dec.decode(value, { stream: true });
    let i: number;
    while ((i = resto.indexOf("\n\n")) >= 0) {
      const bloco = resto.slice(0, i);
      resto = resto.slice(i + 2);
      const evento = /^event: (.+)$/m.exec(bloco)?.[1];
      const dados = /^data: (.+)$/m.exec(bloco)?.[1];
      if (evento !== undefined && dados !== undefined) yield { evento, dados: JSON.parse(dados), ms: Math.round(performance.now() - t0) };
    }
  }
}
const post = (message: string, sinal?: AbortSignal) =>
  fetch(`${API}/api/chat`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ conversationId: "medida", message }), ...(sinal ? { signal: sinal } : {}) });
const mediana = (v: number[]) => {
  const o = [...v].sort((a, b) => a - b);
  return o.length === 0 ? null : (o[Math.floor(o.length / 2)] as number);
};

// ---------- A: primeiro evento nas 60 ----------
const primeiros: { id: string; ms: number; evento: string }[] = [];
if (!values.pular) {
  for (const c of golden) {
    const ac = new AbortController();
    const t0 = performance.now();
    const r = await post(c.pergunta, ac.signal);
    if (r.status !== 200) {
      primeiros.push({ id: c.id, ms: -1, evento: `HTTP ${r.status}` });
      continue;
    }
    const primeiro = await quadros(r, t0).next();
    primeiros.push({ id: c.id, ms: (primeiro.value as Quadro).ms, evento: (primeiro.value as Quadro).evento });
    ac.abort();
    await new Promise((ok) => setTimeout(ok, 400)); // dá tempo de o servidor soltar a vaga
  }
  console.log(`A: primeiro evento nas ${primeiros.length}: máx ${Math.max(...primeiros.map((p) => p.ms))} ms, mediana ${mediana(primeiros.map((p) => p.ms))} ms`);
}

// ---------- B: fluxo inteiro ----------
const esquemas = esquemasDosEventos();
const inteiras: { id: string; eventos: Record<string, number>; terminou_em: string; fins: number; invalidos: string[]; primeiro_evento_ms: number; primeiro_token_ms: number | null; fim_ms: number; estado: string | null; citacoes: number }[] = [];
const idsDeEvidencia: string[] = [];
for (const id of (values.inteiras as string).split(",").filter(Boolean)) {
  const c = golden.find((g) => g.id === id);
  if (!c) continue;
  const t0 = performance.now();
  const r = await post(c.pergunta);
  const eventos: Quadro[] = [];
  if (r.status === 200) for await (const q of quadros(r, t0)) eventos.push(q);
  const contagem: Record<string, number> = {};
  const invalidos: string[] = [];
  for (const q of eventos) {
    contagem[q.evento] = (contagem[q.evento] ?? 0) + 1;
    const esquema = esquemas[q.evento];
    const p = esquema ? problemas(esquema, q.dados) : [`evento ${q.evento} não está no contrato`];
    if (p.length > 0) invalidos.push(`${q.evento}: ${p.join("; ")}`);
  }
  const fim = eventos.find((q) => q.evento === "fim");
  for (const q of eventos) if (q.evento === "evidencia") idsDeEvidencia.push((q.dados as { id: string }).id);
  inteiras.push({
    id,
    eventos: contagem,
    terminou_em: eventos.at(-1)?.evento ?? `HTTP ${r.status}`,
    fins: eventos.filter((q) => q.evento === "fim" || q.evento === "erro").length,
    invalidos,
    primeiro_evento_ms: eventos[0]?.ms ?? -1,
    primeiro_token_ms: eventos.find((q) => q.evento === "token")?.ms ?? null,
    fim_ms: fim?.ms ?? eventos.at(-1)?.ms ?? -1,
    estado: fim ? ((fim.dados as { metricas: { estado: string } }).metricas.estado) : null,
    citacoes: fim ? (fim.dados as { citacoes: unknown[] }).citacoes.length : 0,
  });
  console.log(`B: ${id} ${inteiras.at(-1)?.terminou_em} 1º evento ${inteiras.at(-1)?.primeiro_evento_ms} ms, 1º token ${inteiras.at(-1)?.primeiro_token_ms} ms, fim ${inteiras.at(-1)?.fim_ms} ms, inválidos ${invalidos.length}`);
}

// ---------- C: rotas ----------
const medirRota = async (rota: string, init?: RequestInit) => {
  const t0 = performance.now();
  const r = await fetch(`${API}${rota}`, init);
  const corpo = r.headers.get("content-type")?.includes("json") ? await r.json() : await r.arrayBuffer();
  return { status: r.status, corpo, ms: Math.round(performance.now() - t0), cabecalhos: r.headers };
};
const saude = await medirRota("/api/saude");
const fontes: { id: string; status: number; tipo: string | null; invalido: string[] }[] = [];
for (const id of [...new Set([...idsDeEvidencia.slice(0, 30), ...(values.extras as string).split(",").filter(Boolean)])]) {
  const f = await medirRota(`/api/fonte/${encodeURIComponent(id)}`);
  fontes.push({ id, status: f.status, tipo: f.status === 200 ? (f.corpo as { tipo: string }).tipo : null, invalido: problemas(f.status === 200 ? "Fonte" : "Erro", f.corpo) });
}
const viz: Record<string, unknown> = {};
for (const [chave, rota] of [
  ["bb_1", "/api/grafo/vizinhanca?entidade=Banco%20do%20Brasil&profundidade=1"],
  ["bb_2", "/api/grafo/vizinhanca?entidade=Banco%20do%20Brasil&profundidade=2"],
  ["inexistente", "/api/grafo/vizinhanca?entidade=XyzNaoExiste"],
] as const) {
  const v = await medirRota(rota);
  viz[chave] = { status: v.status, ms: v.ms, nos: v.status === 200 ? (v.corpo as { nos: unknown[] }).nos.length : null, arestas: v.status === 200 ? (v.corpo as { arestas: unknown[] }).arestas.length : null, truncado: v.status === 200 ? (v.corpo as { truncado: boolean }).truncado : null, invalido: problemas(v.status === 200 ? "Vizinhanca" : "Erro", v.corpo) };
}
const pdfInteiro = await fetch(`${API}/api/documento/pdf`, { headers: { range: "bytes=0-1023" } });
const pdfCorpo = Buffer.from(await pdfInteiro.arrayBuffer());
const feedback = await medirRota("/api/feedback", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ mensagemId: "medida-f76", nota: 1, comentario: "teste da medida" }) });

const primeirosMs = primeiros.map((p) => p.ms);
const resumo = {
  nome: values.nome,
  data: new Date().toISOString().slice(0, 10),
  comando: "npm run avaliar:api",
  primeiro_evento: values.pular ? null : { perguntas: primeiros.length, maximo_ms: Math.max(...primeirosMs), mediana_ms: mediana(primeirosMs), acima_de_1000_ms: primeiros.filter((p) => p.ms > 1000 || p.ms < 0).map((p) => p.id), todos_etapa: primeiros.every((p) => p.evento === "etapa") },
  fluxo_inteiro: inteiras,
  saude: { status: saude.status, ms: saude.ms, invalido: problemas("Saude", saude.corpo), estado: (saude.corpo as { status: string }).status, modelos: (saude.corpo as { modelos: unknown[] }).modelos, indices: (saude.corpo as { indices: unknown[] }).indices.length },
  fontes: { pedidas: fontes.length, achadas: fontes.filter((f) => f.status === 200).length, por_tipo: fontes.reduce<Record<string, number>>((a, f) => ((a[f.tipo ?? `HTTP ${f.status}`] = (a[f.tipo ?? `HTTP ${f.status}`] ?? 0) + 1), a), {}), invalidas: fontes.filter((f) => f.invalido.length > 0).map((f) => f.id), nao_achadas: fontes.filter((f) => f.status !== 200).map((f) => f.id) },
  vizinhanca: viz,
  pdf: { status: pdfInteiro.status, bytes: pdfCorpo.length, content_range: pdfInteiro.headers.get("content-range"), comeca_com_pdf: pdfCorpo.subarray(0, 4).toString("latin1") === "%PDF" },
  feedback: { status: feedback.status, invalido: problemas("FeedbackRegistrado", feedback.corpo) },
};
mkdirSync(new URL("eval/resultados/", RAIZ), { recursive: true });
writeFileSync(new URL(`eval/resultados/${values.nome}.json`, RAIZ), JSON.stringify(resumo, null, 2) + "\n");
console.log("\n" + JSON.stringify(resumo, null, 2));
