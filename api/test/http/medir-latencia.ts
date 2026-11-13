/**
 * Medida de latência pela API real (F9.5, `eval/f95-medida-congelamento.md`, RNF-2 e RNF-3): `npm run avaliar:latencia`,
 * com Neo4j, llama-swap e a API em produção local (`npm run build; npm start`) no ar.
 *
 * Definições fixadas antes de rodar (as do documento da medida):
 *  - **RNF-2**: as 30 perguntas simples do golden (T01 a T15 e N01 a N15), uma conversa nova por pergunta, uma execução, no
 *    perfil `consultar` (o padrão) e no `consultar-rapido` (informativo), com a ORDEM ALTERNADA entre os dois perfis a cada
 *    pergunta. Um aquecimento descartado (a 1ª pergunta de `eval/perguntas_latencia.txt`). Tempo do 1º token = do envio do POST
 *    ao 1º evento `token`; completa = ao evento `fim`.
 *  - **RNF-3**: as 10 temáticas (P01 a P10), perfil `consultar`; tempo até o `fim`; progresso = eventos `etapa` que chegam
 *    antes do 1º `token`.
 *
 * Grava `eval/resultados/<nome>.json` (ids, tempos, estados; sem texto do documento nem da resposta, ADR-009).
 */
import { readFileSync, writeFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { lerCsv } from "../../src/avaliacao/busca.ts";

const RAIZ = new URL("../../../", import.meta.url);
const { values } = parseArgs({
  options: {
    api: { type: "string", default: process.env["API_URL"] ?? "http://127.0.0.1:3000" },
    nome: { type: "string", default: "f95-latencia" },
    limite: { type: "string", description: "só para teste do script: quantas perguntas de cada conjunto" },
  },
});
const API = values.api as string;
const golden = lerCsv(readFileSync(new URL("eval/golden.csv", RAIZ), "utf-8")).map((c) => ({ id: c["id"] as string, pergunta: c["pergunta"] as string }));
const porId = (id: string) => golden.find((g) => g.id === id) as { id: string; pergunta: string };
const simples = [...Array.from({ length: 15 }, (_, i) => `T${String(i + 1).padStart(2, "0")}`), ...Array.from({ length: 15 }, (_, i) => `N${String(i + 1).padStart(2, "0")}`)];
const tematicas = Array.from({ length: 10 }, (_, i) => `P${String(i + 1).padStart(2, "0")}`);
const lim = values.limite ? Number(values.limite) : Infinity;
const aquecimento = readFileSync(new URL("eval/perguntas_latencia.txt", RAIZ), "utf-8")
  .split(/\r?\n/)
  .find((l) => l.trim() !== "" && !l.startsWith("#")) as string;

type Perfil = "consultar" | "consultar-rapido";
interface Resultado {
  id: string;
  perfil: Perfil;
  http: number;
  primeiro_evento_ms: number | null;
  primeiro_token_ms: number | null;
  fim_ms: number | null;
  etapas_antes_do_token: number;
  etapas_total: number;
  estado: string | null;
  terminou_em: string;
}

async function* quadros(r: Response, t0: number): AsyncGenerator<{ evento: string; dados: unknown; ms: number }> {
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

async function perguntar(id: string, mensagem: string, perfil: Perfil): Promise<Resultado> {
  const t0 = performance.now();
  const r = await fetch(`${API}/api/chat`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ conversationId: `f95-${perfil}-${id}-${Date.now()}`, message: mensagem, profile: perfil }),
  });
  const res: Resultado = { id, perfil, http: r.status, primeiro_evento_ms: null, primeiro_token_ms: null, fim_ms: null, etapas_antes_do_token: 0, etapas_total: 0, estado: null, terminou_em: `HTTP ${r.status}` };
  if (r.status !== 200) return res;
  let ultimo = "";
  for await (const q of quadros(r, t0)) {
    ultimo = q.evento;
    res.primeiro_evento_ms ??= q.ms;
    if (q.evento === "etapa") {
      res.etapas_total++;
      if (res.primeiro_token_ms === null) res.etapas_antes_do_token++;
    }
    if (q.evento === "token") res.primeiro_token_ms ??= q.ms;
    if (q.evento === "fim") {
      res.fim_ms = q.ms;
      res.estado = (q.dados as { metricas?: { estado?: string } }).metricas?.estado ?? null;
    }
    if (q.evento === "erro") res.fim_ms = q.ms;
  }
  res.terminou_em = ultimo;
  return res;
}

const linha = (r: Resultado) =>
  `${r.id} ${r.perfil.padEnd(16)} http ${r.http} 1º token ${r.primeiro_token_ms ?? "—"} ms, fim ${r.fim_ms ?? "—"} ms, etapas antes do token ${r.etapas_antes_do_token}, estado ${r.estado ?? "—"}, terminou em ${r.terminou_em}`;

const inicio = new Date().toISOString();
console.log("aquecimento (descartado)…");
await perguntar("AQ", aquecimento, "consultar");

const rnf2: Resultado[] = [];
for (const [i, id] of simples.slice(0, lim).entries()) {
  const ordem: Perfil[] = i % 2 === 0 ? ["consultar", "consultar-rapido"] : ["consultar-rapido", "consultar"];
  for (const perfil of ordem) {
    const r = await perguntar(id, porId(id).pergunta, perfil);
    rnf2.push(r);
    console.log(`RNF-2 ${linha(r)}`);
  }
}
const rnf3: Resultado[] = [];
for (const id of tematicas.slice(0, lim)) {
  const r = await perguntar(id, porId(id).pergunta, "consultar");
  rnf3.push(r);
  console.log(`RNF-3 ${linha(r)}`);
}

writeFileSync(
  new URL(`eval/resultados/${values.nome}.json`, RAIZ),
  JSON.stringify({ nome: values.nome, inicio, fim: new Date().toISOString(), comando: "npm run avaliar:latencia", aquecimento: aquecimento.length > 0, rnf2, rnf3 }, null, 2) + "\n",
);
console.log(`gravado eval/resultados/${values.nome}.json`);
