/**
 * Escada de ablações, degraus A3ts, A4, A5 e A6 (F9.1, `eval/f91-medida-ablacao.md`): responde as perguntas do `eval/golden.csv`
 * com o agente em TypeScript e grava `data/avaliacao/<nome>/respostas.jsonl` no MESMO formato do harness do Python
 * (`indexer.avaliar.gerar`), para o juiz e as métricas mecânicas de lá lerem sem mudança.
 *
 *   npm run avaliar:ablacao -- --degrau a4 --nome v1-a4
 *
 * Os degraus (definidos e commitados ANTES da primeira rodada; ferramentas = as 12 da ARQUITETURA §7.2):
 *  - **a3ts** (controle): só `buscar_trechos` (o mesmo método de A3), com o pipeline do agente (atualizador, roteador, executor)
 *    e o redator da F7.5. Separa o que a troca de pipeline faz do que as ferramentas novas fazem.
 *  - **a4**: a3ts + os 6 templates de fatos (`fato_financeiro`, `serie_metrica`, `comparar_segmentos`, `riscos`, `eventos`,
 *    `pessoas_cargos`) + `consultar_grafo` (templates e Text2Cypher).
 *  - **a5**: a4 + `entidade` (busca local) + `panorama` (busca global).
 *  - **a6**: o agente completo: as 12 ferramentas (inclui `buscar_tabelas`) e o ciclo com o crítico (até 2 rodadas).
 *
 * a3ts, a4 e a5 NÃO têm crítico: uma rodada do agente; o estado entregue ao redator é `sem_consulta` (rota `nenhuma`),
 * `suficiente` (há evidência) ou `ausente` (rota com ferramenta e zero evidência). O complemento de trechos do agente (ADR-059,
 * v3) fica ligado em todos os degraus, porque é o padrão do agente. Em todos, o redator é o mesmo.
 *
 * O contexto entregue ao juiz é o que o redator viu: as evidências de `selecionar` (até 10, cada uma cortada como o redator as
 * corta). A resposta julgada é o texto com as páginas no lugar dos marcadores `[E#]`.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { executarAgente } from "../agente/agente.ts";
import { executarCiclo } from "../agente/ciclo.ts";
import { redigir, selecionar, type EntradaRedator } from "../agente/redator.ts";
import { GrafoNeo4j, criarExecutor } from "../ferramentas/index.ts";
import { ClienteLlm } from "../llm/index.ts";
import { lerCsv } from "./busca.ts";

const RAIZ = new URL("../../../", import.meta.url);

const TEMPLATES = ["fato_financeiro", "serie_metrica", "comparar_segmentos", "riscos", "eventos", "pessoas_cargos"];
export const FERRAMENTAS_DO_DEGRAU: Record<string, readonly string[] | null> = {
  a3ts: ["buscar_trechos"],
  a4: ["buscar_trechos", ...TEMPLATES, "consultar_grafo"],
  a5: ["buscar_trechos", ...TEMPLATES, "consultar_grafo", "entidade", "panorama"],
  a6: null, // todas
};

const { values } = parseArgs({
  options: {
    degrau: { type: "string" },
    nome: { type: "string" },
    swap: { type: "string", default: process.env["LLAMA_SWAP_URL"] ?? "http://127.0.0.1:8080" },
    golden: { type: "string", default: "eval/golden.csv" },
    limite: { type: "string" },
    somente: { type: "string", description: "ids separados por vírgula" },
  },
});
const degrau = values.degrau ?? "";
if (!(degrau in FERRAMENTAS_DO_DEGRAU) || !values.nome) {
  console.error("Uso: npm run avaliar:ablacao -- --degrau a3ts|a4|a5|a6 --nome <nome> [--limite N] [--somente T01,T02]");
  process.exit(2);
}
const ferramentas = FERRAMENTAS_DO_DEGRAU[degrau];
const pasta = new URL(`data/avaliacao/${values.nome}/`, RAIZ);
const arquivo = new URL("respostas.jsonl", pasta);
mkdirSync(pasta, { recursive: true });

const casos = lerCsv(readFileSync(new URL(values.golden as string, RAIZ), "utf-8"))
  .filter((c) => !values.somente || values.somente.split(",").includes(c["id"] as string))
  .slice(0, values.limite ? Number(values.limite) : undefined);
const feitas = new Set(existsSync(arquivo) ? readFileSync(arquivo, "utf-8").split("\n").filter(Boolean).map((l) => (JSON.parse(l) as { id: string }).id) : []);

const grafo = GrafoNeo4j.conectar();
const llm = new ClienteLlm({ baseUrl: values.swap as string });
const executor = criarExecutor({ grafo, llm });

interface Resultado {
  autonoma: string;
  entrada: EntradaRedator;
  ferramentasUsadas: string[];
  estado: string;
  rodadas: number;
}

async function responder(pergunta: string): Promise<{ r: Resultado; resposta: Awaited<ReturnType<typeof redigir>> }> {
  let r: Resultado;
  if (degrau === "a6") {
    const ciclo = await executarCiclo(llm, executor, pergunta);
    r = {
      autonoma: ciclo.autonoma,
      entrada: { pergunta: ciclo.autonoma, estado: ciclo.estado, faltando: ciclo.faltando, evidencias: ciclo.evidencias },
      ferramentasUsadas: [...new Set(ciclo.evidencias.map((e) => e.ferramenta))],
      estado: ciclo.estado,
      rodadas: ciclo.rodadas.length,
    };
  } else {
    const ag = await executarAgente(llm, executor, pergunta, { ferramentas: ferramentas as readonly string[] });
    if (ag.erro) throw new Error(`agente: ${ag.erro}`);
    const estado = ag.rota === "nenhuma" ? "sem_consulta" : ag.evidencias.length > 0 ? "suficiente" : "ausente";
    r = {
      autonoma: ag.autonoma,
      entrada: { pergunta: ag.autonoma, estado, faltando: "", evidencias: ag.evidencias },
      ferramentasUsadas: [...new Set(ag.evidencias.map((e) => e.ferramenta))],
      estado,
      rodadas: 1,
    };
  }
  return { r, resposta: await redigir(llm, r.entrada) };
}

if (feitas.size === 0 && casos[0]) {
  await responder(casos[0].pergunta as string).catch(() => undefined); // aquece os modelos: a latência não inclui a carga fria
}

for (const c of casos) {
  const id = c["id"] as string;
  if (feitas.has(id)) continue;
  const t0 = performance.now();
  let linha: Record<string, unknown>;
  try {
    const { r, resposta } = await responder(c["pergunta"] as string);
    const vistas = selecionar(r.entrada.evidencias);
    linha = {
      id,
      pergunta: c["pergunta"],
      resposta: resposta.textoComPaginas,
      contexto: vistas.map((v) => ({ paginas: v.ev.paginas, caminho: v.ev.tipo, texto: v.texto })),
      citacoes: resposta.citacoes.map((x) => x.paginas),
      citacoes_invalidas: resposta.verificacao.citacoes_invalidas.length,
      erro: null,
      estado: r.estado,
      rodadas: r.rodadas,
      ferramentas: r.ferramentasUsadas,
      modo_do_redator: resposta.modo,
    };
  } catch (e) {
    linha = { id, pergunta: c["pergunta"], resposta: "", contexto: [], citacoes: [], citacoes_invalidas: 0, erro: `${e instanceof Error ? e.constructor.name : "Erro"}: ${e instanceof Error ? e.message : String(e)}`.slice(0, 300) };
  }
  linha["segundos"] = Math.round((performance.now() - t0) / 100) / 10;
  appendFileSync(arquivo, `${JSON.stringify(linha)}\n`);
  console.log(`${id.padEnd(4)} ${String(linha["estado"] ?? "ERRO").padEnd(12)} ${String(linha["segundos"]).padStart(6)} s  ${(linha["ferramentas"] as string[] | undefined)?.join(",") ?? linha["erro"]}`);
}
await grafo.fechar();
