/**
 * Paridade dos templates (F7.8): roda cada chamada de `eval/paridade_templates.json` no Python (F6.3, `uv run python -m
 * indexer.templates_cypher`) e no TypeScript (`api/src/ferramentas`) contra o mesmo Neo4j e compara o JSON.
 *
 *   npm run avaliar:paridade
 *
 * Precisa do Neo4j no ar (`.\infra\neo4j.ps1 iniciar`) e do `uv` no PATH (`infra\dev-env.ps1`). Grava
 * `eval/resultados/f78-paridade.json` (ids, vereditos e caminhos das diferenças, sem texto do documento) e as duas
 * saídas completas em `data/avaliacao/f78-paridade-detalhes.json` (fora do repositório, ADR-009).
 */
import { spawn } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import {
  GrafoNeo4j,
  compararSegmentos,
  eventos,
  fatoFinanceiro,
  lerCatalogo,
  pessoasCargos,
  riscos,
  serieMetrica,
  type Envelope,
} from "../ferramentas/index.ts";
import { comoJson, comparar, semListasVaziasExtras, type Comparacao, type Json } from "./paridade.ts";

const RAIZ = new URL("../../../", import.meta.url);

interface Caso {
  id: string;
  ferramenta: "fato" | "serie" | "comparar" | "riscos" | "eventos" | "pessoas";
  consulta?: string;
  entidade?: string;
  periodo?: string;
  dimensao?: string;
  segmentos?: string[];
  tipo_periodo?: string;
  tema?: string;
  categoria?: string;
  ano?: number;
  cargo?: string;
  nome?: string;
  orgao?: string;
}

const { values } = parseArgs({
  options: {
    nome: { type: "string", default: "f78-paridade" },
    concorrencia: { type: "string", default: "3" },
    somente: { type: "string" },
  },
});

/** Os argumentos do CLI do Python para o caso. */
function argumentosPython(c: Caso): string[] {
  const a: string[] = [c.ferramenta];
  if (c.consulta !== undefined) a.push(c.consulta);
  const opcoes: [string, string | number | undefined][] = [
    ["--entidade", c.entidade],
    ["--periodo", c.periodo],
    ["--dimensao", c.dimensao],
    ["--tipo-periodo", c.tipo_periodo],
    ["--tema", c.tema],
    ["--categoria", c.categoria],
    ["--ano", c.ano],
    ["--cargo", c.cargo],
    ["--nome", c.nome],
    ["--orgao", c.orgao],
  ];
  for (const [flag, valor] of opcoes) if (valor !== undefined) a.push(flag, String(valor));
  if (c.segmentos) a.push("--segmentos", ...c.segmentos);
  return a;
}

function rodarPython(c: Caso): Promise<{ json: Json | null; erro: string | null }> {
  return new Promise((resolver) => {
    const filho = spawn("uv", ["run", "python", "-m", "indexer.templates_cypher", ...argumentosPython(c)], {
      cwd: fileURLToPath(new URL("indexer/", RAIZ)),
      env: { ...process.env, PYTHONIOENCODING: "utf-8", PYTHONUTF8: "1" },
    });
    const saida: Buffer[] = [];
    const erro: Buffer[] = [];
    filho.stdout.on("data", (d: Buffer) => saida.push(d));
    filho.stderr.on("data", (d: Buffer) => erro.push(d));
    filho.on("error", (e) => resolver({ json: null, erro: `não iniciou: ${e.message}` }));
    filho.on("close", (codigo) => {
      const texto = Buffer.concat(saida).toString("utf-8");
      try {
        resolver({ json: JSON.parse(texto) as Json, erro: null });
      } catch {
        resolver({ json: null, erro: `saída não é JSON (código ${codigo}): ${Buffer.concat(erro).toString("utf-8").slice(-300)}` });
      }
    });
  });
}

async function rodarTs(grafo: GrafoNeo4j, c: Caso): Promise<Envelope> {
  const catalogo = lerCatalogo();
  switch (c.ferramenta) {
    case "fato":
      return fatoFinanceiro(grafo, { metrica: c.consulta ?? "", entidade: c.entidade ?? null, periodo: c.periodo ?? null, dimensao: c.dimensao ?? null, catalogo });
    case "serie":
      return serieMetrica(grafo, {
        metrica: c.consulta ?? "",
        entidade: c.entidade ?? null,
        dimensao: c.dimensao ?? null,
        tipoPeriodo: c.tipo_periodo === undefined ? "fiscal_year" : c.tipo_periodo || null, // como o `or None` do CLI
        catalogo,
      });
    case "comparar":
      return compararSegmentos(grafo, { metrica: c.consulta ?? "", segmentos: c.segmentos ?? null, periodo: c.periodo ?? null, entidade: c.entidade ?? null, catalogo });
    case "riscos":
      return riscos(grafo, { tema: c.tema ?? null, categoria: c.categoria ?? null });
    case "eventos":
      return eventos(grafo, { tema: c.tema ?? null, ano: c.ano ?? null });
    case "pessoas":
      return pessoasCargos(grafo, { cargo: c.cargo ?? null, nome: c.nome ?? null, orgao: c.orgao ?? null });
  }
}

const arquivo = JSON.parse(readFileSync(new URL("eval/paridade_templates.json", RAIZ), "utf-8")) as { casos: Caso[] };
const casos = arquivo.casos.filter((c) => !values.somente || values.somente.split(",").includes(c.id));
const grafo = GrafoNeo4j.conectar();

interface Linha {
  id: string;
  ferramenta: string;
  veredito: Comparacao["veredito"] | "falha_python" | "falha_ts";
  diferencas: Comparacao["diferencas"];
  erro_python: string | null;
  erro_ts: string | null;
  n_evidencias_python: number | null;
  n_evidencias_ts: number | null;
  nota?: string;
  listas_vazias_extras_no_ts?: string[];
}
const linhas: Linha[] = new Array(casos.length);
const detalhes: Record<string, { python: Json | null; ts: Json | null }> = {};

let proximo = 0;
async function trabalhador(): Promise<void> {
  for (;;) {
    const i = proximo++;
    const c = casos[i];
    if (!c) return;
    const [py, ts] = await Promise.all([
      rodarPython(c),
      rodarTs(grafo, c).then(
        (r) => ({ json: comoJson(r), erro: null as string | null }),
        (e: unknown) => ({ json: null, erro: e instanceof Error ? e.message : String(e) }),
      ),
    ]);
    detalhes[c.id] = { python: py.json, ts: ts.json };
    const erroDe = (j: Json | null) => (j !== null && typeof j === "object" && !Array.isArray(j) && typeof j["erro"] === "string" ? (j["erro"] as string) : null);
    const nEv = (j: Json | null) => (j !== null && typeof j === "object" && !Array.isArray(j) && Array.isArray(j["evidencias"]) ? (j["evidencias"] as Json[]).length : null);
    const base = {
      id: c.id,
      ferramenta: c.ferramenta,
      erro_python: erroDe(py.json),
      erro_ts: erroDe(ts.json),
      n_evidencias_python: nEv(py.json),
      n_evidencias_ts: nEv(ts.json),
    };
    if (py.json === null || ts.json === null) {
      linhas[i] = { ...base, veredito: py.json === null ? "falha_python" : "falha_ts", diferencas: [], nota: (py.erro ?? ts.erro) ?? undefined };
    } else {
      const { ts: tsAjustado, tiradas } = semListasVaziasExtras(py.json, ts.json);
      const cmp = comparar(py.json, tsAjustado);
      linhas[i] = { ...base, veredito: cmp.veredito, diferencas: cmp.diferencas, ...(tiradas.length > 0 ? { listas_vazias_extras_no_ts: tiradas } : {}) };
    }
    console.log(`${linhas[i]?.veredito.padEnd(9)} ${c.id}${linhas[i]?.diferencas.length ? `  (${linhas[i]?.diferencas.length} diferenças)` : ""}`);
  }
}

const t0 = performance.now();
await Promise.all(Array.from({ length: Math.max(1, Number(values.concorrencia)) }, trabalhador));
await grafo.fechar();

const contar = (v: string) => linhas.filter((l) => l.veredito === v).length;
const porFerramenta: Record<string, { casos: number; iguais: number }> = {};
for (const l of linhas) {
  const p = (porFerramenta[l.ferramenta] ??= { casos: 0, iguais: 0 });
  p.casos += 1;
  if (l.veredito === "igual") p.iguais += 1;
}
const resumo = {
  nome: values.nome,
  data: new Date().toISOString().slice(0, 10),
  comando: "npm run avaliar:paridade",
  casos: linhas.length,
  iguais: contar("igual"),
  so_ordem: contar("so_ordem"),
  diferentes: contar("diferente"),
  falhas: contar("falha_python") + contar("falha_ts"),
  segundos: Math.round((performance.now() - t0) / 100) / 10,
  com_lista_vazia_extra_no_ts: linhas.filter((l) => l.listas_vazias_extras_no_ts).map((l) => l.id),
  por_ferramenta: porFerramenta,
  itens: linhas,
};
mkdirSync(new URL("eval/resultados/", RAIZ), { recursive: true });
mkdirSync(new URL("data/avaliacao/", RAIZ), { recursive: true });
writeFileSync(new URL(`eval/resultados/${values.nome}.json`, RAIZ), JSON.stringify(resumo, null, 2) + "\n");
writeFileSync(new URL(`data/avaliacao/${values.nome}-detalhes.json`, RAIZ), JSON.stringify(detalhes, null, 2) + "\n");
console.log(`\n${resumo.iguais}/${resumo.casos} iguais, ${resumo.so_ordem} só de ordem, ${resumo.diferentes} diferentes, ${resumo.falhas} falhas (${resumo.segundos} s)`);
process.exitCode = resumo.diferentes + resumo.falhas === 0 ? 0 : 1;
