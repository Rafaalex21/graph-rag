/**
 * F8.8: resumo reproduzível da última execução do Playwright (`npm run resumo`). Lê `test-results/results.json` e grava
 * `eval/resultados/f88-suite.json` (totais, por projeto e por etiqueta de fluxo, e os traces achados; sem texto do documento,
 * ADR-009). Sai com erro se houver teste falho, flaky, ou se algum fluxo exigido pelo aceite da F8.8 tiver menos de 2 testes
 * passando. Não é um teste: só lê o que o Playwright já gravou.
 *
 * Uso: `node resumo-da-suite.ts [nome-do-arquivo] [--smoke]`. Sem argumentos, resume a suíte `interface` em `f88-suite.json`. Com
 * `--smoke`, resume a execução do `@smoke` (ao vivo): exige 1 ou mais testes `@smoke` passando e um `trace.zip`, e não exige os fluxos.
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const AQUI = dirname(fileURLToPath(import.meta.url));
const RESULTADOS = join(AQUI, "test-results", "results.json");
const RELATORIO = join(AQUI, "playwright-report", "index.html");
const ARGUMENTOS = process.argv.slice(2);
const SO_SMOKE = ARGUMENTOS.includes("--smoke");
const NOME = ARGUMENTOS.find((a) => !a.startsWith("--")) ?? "f88-suite";
const ALVO = join(AQUI, "..", "eval", "resultados", `${NOME}.json`);
const FLUXOS = ["@fluxo-citacao", "@fluxo-modo", "@fluxo-nao-consta", "@fluxo-erro"];
const MINIMO_POR_FLUXO = 2;

interface Teste {
  projectName: string;
  status: string;
  results: { status: string; attachments?: { name: string; path?: string }[] }[];
}
interface Spec {
  title: string;
  tags?: string[];
  tests: Teste[];
}
interface Suite {
  specs?: Spec[];
  suites?: Suite[];
}
interface Relatorio {
  suites: Suite[];
  stats: { expected: number; unexpected: number; flaky: number; skipped: number; duration: number };
}

function especificacoes(s: Suite): Spec[] {
  return [...(s.specs ?? []), ...(s.suites ?? []).flatMap(especificacoes)];
}

function traces(pasta: string): string[] {
  if (!existsSync(pasta)) return [];
  return readdirSync(pasta, { withFileTypes: true }).flatMap((d) => {
    const caminho = join(pasta, d.name);
    return d.isDirectory() ? traces(caminho) : d.name === "trace.zip" ? [caminho] : [];
  });
}

if (!existsSync(RESULTADOS)) {
  console.error(`Não achei ${RESULTADOS}: rode antes \`npx playwright test\`.`);
  process.exit(2);
}
const relatorio = JSON.parse(readFileSync(RESULTADOS, "utf8")) as Relatorio;
const specs = relatorio.suites.flatMap(especificacoes);
const testes = specs.flatMap((sp) => sp.tests.map((t) => ({ titulo: sp.title, tags: sp.tags ?? [], projeto: t.projectName, status: t.status })));

const contar = (lista: typeof testes) => ({
  total: lista.length,
  passaram: lista.filter((t) => t.status === "expected").length,
  falharam: lista.filter((t) => t.status === "unexpected").length,
  flaky: lista.filter((t) => t.status === "flaky").length,
  pulados: lista.filter((t) => t.status === "skipped").length,
});

const porProjeto = Object.fromEntries([...new Set(testes.map((t) => t.projeto))].sort().map((p) => [p, contar(testes.filter((t) => t.projeto === p))]));
const porFluxo = Object.fromEntries(FLUXOS.map((f) => [f, contar(testes.filter((t) => t.tags.includes(f.replace(/^@/, "")) || t.tags.includes(f)))]));
const smoke = contar(testes.filter((t) => t.tags.includes("smoke") || t.tags.includes("@smoke")));
const arquivosDeTrace = traces(join(AQUI, "test-results"));

const geral = contar(testes);
const problemas: string[] = [];
if (geral.falharam > 0) problemas.push(`${geral.falharam} teste(s) falharam`);
if (geral.flaky > 0) problemas.push(`${geral.flaky} teste(s) flaky`);
if (SO_SMOKE) {
  if (smoke.passaram < 1) problemas.push("nenhum teste @smoke passou");
  if (arquivosDeTrace.length < 1) problemas.push("não há trace.zip do @smoke");
} else {
  for (const f of FLUXOS) if (porFluxo[f]!.passaram < MINIMO_POR_FLUXO) problemas.push(`o fluxo ${f} tem ${porFluxo[f]!.passaram} teste(s) passando (mínimo ${MINIMO_POR_FLUXO})`);
}
if (!existsSync(RELATORIO)) problemas.push("não existe playwright-report/index.html");

const resumo = {
  geral: { ...geral, duracaoMs: Math.round(relatorio.stats.duration) },
  porProjeto,
  porFluxo,
  smoke,
  relatorioHtml: existsSync(RELATORIO),
  resultsJson: true,
  traces: arquivosDeTrace.length,
  problemas,
  ok: problemas.length === 0,
};
mkdirSync(dirname(ALVO), { recursive: true });
writeFileSync(ALVO, `${JSON.stringify(resumo, null, 2)}\n`);
console.log(JSON.stringify(resumo, null, 2));
process.exit(resumo.ok ? 0 : 1);
