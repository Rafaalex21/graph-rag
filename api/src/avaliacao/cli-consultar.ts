/**
 * Medida de `consultar_grafo` e `panorama` em TypeScript (F7.10), no Neo4j e no llama-swap reais.
 *
 *   npm run avaliar:consultar
 *
 * Precisa do Neo4j (`.\infra\neo4j.ps1 iniciar`), do llama-swap (`.\infra\swap.ps1`) e do `uv` no PATH. Mede, em partes:
 *  - `prompt`: o prompt que o TypeScript monta para cada pergunta de `eval/golden_agregacao.csv` (as 23, nos três grupos)
 *    é idêntico, caractere a caractere, ao do Python (`indexer.text2cypher prompt`)? É a condição para a acurácia do
 *    Python valer para o TypeScript;
 *  - `cypher`: a execução certa (`acerto`, F6.4) de `consultarGrafo` nas 15 perguntas dos grupos `ajuste` e `teste`. O
 *    número do aceite é o do grupo `teste` (10 perguntas, ≥ 90%); o `ajuste` serve só para ver que nada regrediu;
 *  - `panorama`: o tempo de `panorama` (com síntese) em cada uma das 10 perguntas temáticas do golden (aceite: ≤ 60 s).
 *
 * Grava `eval/resultados/<nome>.json` (ids, números e motivos, sem texto do documento) e as saídas completas
 * (Cypher gerado, linhas, pontos) em `data/avaliacao/<nome>-detalhes.json`, fora do repositório (ADR-009).
 */
import { spawn } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import {
  acerto,
  carregarExemplos,
  consultarGrafo,
  descobrirEsquema,
  formatarEsquema,
  GrafoNeo4j,
  lerCatalogo,
  montarPrompt,
  panorama,
  rotulosCandidatos,
  terminologia,
} from "../ferramentas/index.ts";
import { ClienteLlm } from "../llm/index.ts";
import { lerCsv } from "./busca.ts";

const RAIZ = new URL("../../../", import.meta.url);

const { values } = parseArgs({
  options: {
    nome: { type: "string", default: "f710-consultar" },
    swap: { type: "string", default: process.env["LLAMA_SWAP_URL"] ?? "http://127.0.0.1:8080" },
    somente: { type: "string", description: "prompt,cypher,panorama" },
    limite: { type: "string", description: "só as N primeiras perguntas de cada parte (teste rápido)" },
  },
});
const fazer = (parte: string) => !values.somente || values.somente.split(",").includes(parte);
const limite = values.limite ? Number(values.limite) : undefined;

const grafo = GrafoNeo4j.conectar();
const llm = new ClienteLlm({ baseUrl: values.swap as string });
const detalhes: Record<string, unknown> = {};

const mediana = (v: number[]): number | null => {
  if (v.length === 0) return null;
  const o = [...v].sort((a, b) => a - b);
  const m = Math.floor(o.length / 2);
  return o.length % 2 ? (o[m] as number) : ((o[m - 1] as number) + (o[m] as number)) / 2;
};

const lerGoldenAgregacao = () => lerCsv(readFileSync(new URL("eval/golden_agregacao.csv", RAIZ), "utf-8"));

// ---------- o prompt é o do Python? ----------
interface LinhaPrompt {
  id: string;
  grupo: string;
  igual: boolean;
  candidatos_iguais: boolean;
  chars_ts: number;
  chars_python: number | null;
  primeira_diferenca: number | null;
}
const prompts: LinhaPrompt[] = [];
if (fazer("prompt")) {
  const casos = lerGoldenAgregacao().slice(0, limite);
  const perguntas = casos.map((c) => c["pergunta"] as string);
  const py = await new Promise<{ json: { pergunta: string; candidatos: string[]; mensagens: { role: string; content: string }[] }[] | null; erro: string | null }>((resolver) => {
    const filho = spawn("uv", ["run", "python", "-m", "indexer.text2cypher", "prompt", ...perguntas, "--swap", values.swap as string], {
      cwd: fileURLToPath(new URL("indexer/", RAIZ)),
      env: { ...process.env, PYTHONIOENCODING: "utf-8", PYTHONUTF8: "1" },
    });
    const saida: Buffer[] = [];
    const erro: Buffer[] = [];
    filho.stdout.on("data", (d: Buffer) => saida.push(d));
    filho.stderr.on("data", (d: Buffer) => erro.push(d));
    filho.on("error", (e) => resolver({ json: null, erro: `não iniciou: ${e.message}` }));
    filho.on("close", (codigo) => {
      try {
        resolver({ json: JSON.parse(Buffer.concat(saida).toString("utf-8")), erro: null });
      } catch {
        resolver({ json: null, erro: `saída não é JSON (código ${codigo}): ${Buffer.concat(erro).toString("utf-8").slice(-300)}` });
      }
    });
  });
  const { esquema } = await descobrirEsquema(grafo);
  const esquemaTxt = formatarEsquema(esquema);
  const termos = terminologia(lerCatalogo());
  const exemplos = carregarExemplos();
  for (const [i, c] of casos.entries()) {
    const pergunta = c["pergunta"] as string;
    const candidatos = rotulosCandidatos(pergunta, esquema.rotulos_todos ?? []);
    const ts = montarPrompt(pergunta, esquemaTxt, termos, exemplos, candidatos);
    const p = py.json?.[i];
    const textoTs = ts.map((m) => `${m.role}\n${m.content}`).join("\n\0\n");
    const textoPy = p ? p.mensagens.map((m) => `${m.role}\n${m.content}`).join("\n\0\n") : null;
    let primeira: number | null = null;
    if (textoPy !== null && textoPy !== textoTs) {
      primeira = 0;
      while (primeira < textoTs.length && primeira < textoPy.length && textoTs[primeira] === textoPy[primeira]) primeira++;
    }
    prompts.push({
      id: c["id"] as string,
      grupo: c["grupo"] as string,
      igual: textoPy === textoTs,
      candidatos_iguais: p ? JSON.stringify(p.candidatos) === JSON.stringify(candidatos) : false,
      chars_ts: textoTs.length,
      chars_python: textoPy?.length ?? null,
      primeira_diferenca: primeira,
    });
    if (primeira !== null) detalhes[`prompt:${c["id"]}`] = { ts: ts, python: p?.mensagens ?? null };
    console.log(`prompt   ${textoPy === null ? "falha_python" : textoPy === textoTs ? "igual" : `diferente (caractere ${primeira})`}  ${c["id"]}${py.erro ? ` ${py.erro}` : ""}`);
  }
}

// ---------- consultar_grafo ----------
interface LinhaCypher {
  id: string;
  grupo: string;
  ok: boolean;
  erro: string | null;
  linhas: number;
  ms: number;
  bloqueada: string | null;
  corrigida: boolean;
}
const cypher: LinhaCypher[] = [];
if (fazer("cypher")) {
  const casos = lerGoldenAgregacao()
    .filter((c) => c["grupo"] === "ajuste" || c["grupo"] === "teste")
    .slice(0, limite);
  for (const c of casos) {
    const r = await consultarGrafo(grafo, llm, c["pergunta"] as string);
    const tipo = c["tipo"] === "texto" ? "texto" : "numero";
    const esperado = tipo === "texto" ? (c["valor"] as string) : Number(c["valor"]);
    const ok = r.erro === null && acerto(esperado, tipo, r.linhas);
    cypher.push({ id: c["id"] as string, grupo: c["grupo"] as string, ok, erro: r.erro, linhas: r.linhas.length, ms: r.latencia_ms, bloqueada: r.guarda.bloqueada, corrigida: r.guarda.corrigida });
    detalhes[`cypher:${c["id"]}`] = { cypher: r.cypher, linhas: r.linhas.slice(0, 5), erro: r.erro, aviso: r.aviso, guarda: r.guarda, etapas_ms: r.etapas_ms };
    console.log(`cypher   ${ok ? "certo " : "errado"} ${c["grupo"]} ${c["id"]} ${r.latencia_ms} ms${r.erro ? `  (${r.erro.slice(0, 80)})` : ""}`);
  }
}

// ---------- panorama ----------
interface LinhaPanorama {
  id: string;
  segundos: number;
  pontos: number;
  reduce: string;
  comunidades: number;
  lotes: number;
  lotes_falhos: number;
  truncado_por_tempo: boolean;
  eventos: number;
  erro: string | null;
}
const panoramas: LinhaPanorama[] = [];
if (fazer("panorama")) {
  const golden = lerCsv(readFileSync(new URL("eval/golden.csv", RAIZ), "utf-8"))
    .filter((c) => c["rota_esperada"] === "panorama")
    .slice(0, limite);
  for (const c of golden) {
    let eventos = 0;
    const t = performance.now();
    const r = await panorama(grafo, llm, c["pergunta"] as string, { progresso: () => eventos++ });
    const segundos = Math.round((performance.now() - t) / 100) / 10;
    panoramas.push({
      id: c["id"] as string,
      segundos,
      pontos: r.evidencias.length,
      reduce: r.reduce,
      comunidades: r.comunidades.consideradas,
      lotes: r.comunidades.lotes,
      lotes_falhos: r.comunidades.lotes_falhos,
      truncado_por_tempo: r.truncado_por_tempo,
      eventos,
      erro: r.erro,
    });
    detalhes[`panorama:${c["id"]}`] = { sintese: r.sintese, pontos: r.evidencias, omitido: r.omitido, etapas_ms: r.etapas_ms };
    console.log(`panorama ${String(segundos).padStart(5)} s  ${r.evidencias.length} pontos  reduce=${r.reduce}  ${c["id"]}${r.erro ? `  (${r.erro})` : ""}`);
  }
}

await grafo.fechar();

const taxa = (l: LinhaCypher[]) => {
  const acertos = l.filter((x) => x.ok).length;
  return { n: l.length, acertos, acuracia: l.length ? Math.round((acertos / l.length) * 1000) / 1000 : null, rodaram: l.filter((x) => x.erro === null).length };
};
const erros: Record<string, number> = {};
for (const x of cypher) if (x.erro) erros[x.erro.split(":")[0] as string] = (erros[x.erro.split(":")[0] as string] ?? 0) + 1;
const demais = cypher.slice(1).length ? cypher.slice(1) : cypher;
const segundos = panoramas.map((p) => p.segundos);
const resumo = {
  nome: values.nome,
  data: new Date().toISOString().slice(0, 10),
  comando: "npm run avaliar:consultar",
  prompt: {
    perguntas: prompts.length,
    iguais: prompts.filter((p) => p.igual).length,
    candidatos_iguais: prompts.filter((p) => p.candidatos_iguais).length,
    diferentes: prompts.filter((p) => !p.igual).map((p) => ({ id: p.id, primeira_diferenca: p.primeira_diferenca })),
  },
  consultar_grafo: {
    teste: taxa(cypher.filter((x) => x.grupo === "teste")),
    ajuste: taxa(cypher.filter((x) => x.grupo === "ajuste")),
    geral: taxa(cypher),
    erros,
    latencia_ms: { primeira: cypher[0]?.ms ?? null, mediana: mediana(demais.map((x) => x.ms)), maximo: Math.max(0, ...demais.map((x) => x.ms)) },
  },
  panorama: {
    perguntas: panoramas.length,
    segundos_p50: mediana(segundos),
    segundos_max: segundos.length ? Math.max(...segundos) : null,
    dentro_de_60_s: segundos.length ? Math.max(...segundos) <= 60 : null,
    truncadas_por_tempo: panoramas.filter((p) => p.truncado_por_tempo).length,
    com_erro: panoramas.filter((p) => p.erro !== null).length,
    reduce_falhou: panoramas.filter((p) => p.reduce === "falhou").length,
  },
  itens: { prompt: prompts, consultar_grafo: cypher, panorama: panoramas },
};
mkdirSync(new URL("eval/resultados/", RAIZ), { recursive: true });
mkdirSync(new URL("data/avaliacao/", RAIZ), { recursive: true });
writeFileSync(new URL(`eval/resultados/${values.nome}.json`, RAIZ), JSON.stringify(resumo, null, 2) + "\n");
writeFileSync(new URL(`data/avaliacao/${values.nome}-detalhes.json`, RAIZ), JSON.stringify(detalhes, null, 2) + "\n");
console.log("\n" + JSON.stringify({ ...resumo, itens: undefined }, null, 2));
const reprovou =
  (fazer("cypher") && (resumo.consultar_grafo.teste.acuracia ?? 0) < 0.9) || (fazer("panorama") && resumo.panorama.dentro_de_60_s === false);
process.exitCode = reprovou ? 1 : 0;
