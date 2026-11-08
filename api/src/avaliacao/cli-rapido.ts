/**
 * Medida do modo rápido (F7.13): as perguntas simples do `eval/golden.csv` rodam nos dois perfis, `consultar` (ciclo
 * completo, até 2 rodadas) e `consultar-rapido` (só a rodada 1, o crítico apenas diz o que faltou), com o pipeline inteiro
 * (atualizador → roteador → executor → crítico → redator), no Neo4j e no llama-swap reais.
 *
 *   npm run avaliar:rapido                 # as 30 perguntas simples do golden
 *   npm run avaliar:rapido -- --limite 4   # só para conferir que roda
 *
 * Definições fixadas ANTES de rodar, a partir do aceite do ETAPAS ("a parcela com resposta completa em ≤ 20 s (RNF-2) e a
 * queda do page recall @3 frente ao perfil `consultar`"):
 *
 *  - **Perguntas simples**: as 30 do golden das categorias `factual_textual` (T01–T15) e `numerica` (N01–N15). Todas têm
 *    página no gabarito. Sem escolher pergunta depois de ver o resultado.
 *  - **Tempo**: a pergunta inteira, do atualizador ao fim do texto do redator (`ciclo.etapas_ms.total` + redator), medido no
 *    mesmo processo, sem rede nem SSE (a API soma alguns ms; o ADR-062 mediu o aviso inicial em 33 ms).
 *  - **Pareamento**: cada pergunta roda nos dois perfis, um logo depois do outro, e a ORDEM alterna de pergunta em pergunta
 *    (as de índice par começam por `consultar`, as ímpares por `consultar-rapido`), para que o cache de prompt do servidor e
 *    o de embeddings não favoreçam sempre o mesmo perfil. Uma pergunta de aquecimento (descartada) roda antes, para que a
 *    carga a frio dos modelos não entre em nenhum tempo.
 *  - **Resposta completa em ≤ 20 s** (número principal): a pergunta inteira termina em ≤ 20 s **e** o estado final do
 *    ciclo é `suficiente` (o crítico deu a evidência por bastante). O número só de tempo (≤ 20 s, qualquer estado) vai ao
 *    lado, porque uma resposta `incompleta` sai tão rápida quanto qualquer outra e não é "completa".
 *  - **Queda do page recall @3**: média, nas 30, do recall @3 das evidências finais do ciclo (as com página primeiro,
 *    como a API as entrega), `consultar` menos `consultar-rapido`; também @1 e @6 e, por pergunta, quantas perderam e
 *    quantas ganharam. Pelo ADR-060 a rodada extra não mudou o recall, então a queda esperada é zero; diferença dentro de
 *    ±0,05 (uma pergunta vale 0,033) é lida como "sem diferença".
 *  - **Só informativo**: estados finais, número de rodadas, página citada pelo redator e respostas que dizem "não consta".
 *  - Não há limiar de aprovação: o aceite pede medir e registrar os dois números.
 *
 * Grava `eval/resultados/<nome>.json` (ids, contagens e tempos; sem texto do documento nem da resposta, ADR-009) e as saídas
 * completas em `data/avaliacao/<nome>-detalhes.json`, fora do repositório.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { executarCiclo, type ResultadoCiclo } from "../agente/ciclo.ts";
import { redigir, type RespostaRedator } from "../agente/redator.ts";
import { GrafoNeo4j, criarExecutor } from "../ferramentas/index.ts";
import { ClienteLlm } from "../llm/index.ts";
import { lerCsv, pageRecall, paginasDoGabarito, paginasDoRotulo } from "./busca.ts";

const RAIZ = new URL("../../../", import.meta.url);
const KS = [1, 3, 6] as const;
const LIMITE_S = 20;
const SIMPLES = new Set(["factual_textual", "numerica"]);
const INFRA = /^(falha na ferramenta|llm_nao_configurado|ferramenta_desconhecida|ferramenta_nao_portada|grafo_sem_cypher_livre|falha_na_selecao|falha_no_esquema)/;
const DIZ_QUE_NAO_CONSTA = /(n[ãa]o consta|fora d[oe]|n[ãa]o (traz|encontr|trata|h[áa]|tenho|posso)|n[ãa]o (est[áa]|faz parte))/i;

const { values } = parseArgs({
  options: {
    nome: { type: "string", default: "f713-modo-rapido" },
    swap: { type: "string", default: process.env["LLAMA_SWAP_URL"] ?? "http://127.0.0.1:8080" },
    limite: { type: "string" },
    somente: { type: "string", description: "ids separados por vírgula" },
  },
});
const nome = values.nome as string;

interface Caso {
  id: string;
  pergunta: string;
  paginas: string;
}
const casos: Caso[] = lerCsv(readFileSync(new URL("eval/golden.csv", RAIZ), "utf-8"))
  .filter((c) => SIMPLES.has(c["categoria"] as string))
  .map((c) => ({ id: c["id"] as string, pergunta: c["pergunta"] as string, paginas: c["paginas"] ?? "" }));
const selecionados = casos.filter((c) => !values.somente || values.somente.split(",").includes(c.id)).slice(0, values.limite ? Number(values.limite) : undefined);

const grafo = GrafoNeo4j.conectar();
const llm = new ClienteLlm({ baseUrl: values.swap as string });
const executor = criarExecutor({ grafo, llm });

type Perfil = "consultar" | "consultar-rapido";
interface Medida {
  estado: string;
  rodadas: number;
  ms: number;
  ms_ciclo: number;
  recall: Record<number, number>;
  pagina_citada: boolean;
  diz_que_nao_consta: boolean;
  erros_de_infra: string[];
  excecao: string | null;
}

async function rodar(c: Caso, perfil: Perfil): Promise<{ medida: Medida; ciclo: ResultadoCiclo | null; resposta: RespostaRedator | null }> {
  const t0 = performance.now();
  let ciclo: ResultadoCiclo | null = null;
  let resposta: RespostaRedator | null = null;
  let excecao: string | null = null;
  try {
    ciclo = await executarCiclo(llm, executor, c.pergunta, { rapido: perfil === "consultar-rapido" });
    resposta = await redigir(llm, { pergunta: ciclo.autonoma, estado: ciclo.estado, faltando: ciclo.faltando, evidencias: ciclo.evidencias });
  } catch (e) {
    excecao = e instanceof Error ? `${e.constructor.name}: ${e.message}` : String(e);
  }
  const ms = Math.round(performance.now() - t0);
  const gold = paginasDoGabarito(c.paginas);
  const rk = pageRecall(gold, (ciclo?.evidencias ?? []).map((e) => paginasDoRotulo(e.paginas)), KS);
  const execucoes = ciclo?.rodadas.flatMap((x) => x.agente.subperguntas.flatMap((s) => s.execucoes)) ?? [];
  const citadas = new Set((resposta?.citacoes ?? []).flatMap((x) => [...paginasDoRotulo(x.paginas)]));
  return {
    ciclo,
    resposta,
    medida: {
      estado: ciclo?.estado ?? "falhou",
      rodadas: ciclo?.rodadas.length ?? 0,
      ms,
      ms_ciclo: Math.round(ciclo?.etapas_ms.total ?? 0),
      recall: Object.fromEntries(KS.map((k) => [k, (rk[k] as { recall: number }).recall])) as Record<number, number>,
      pagina_citada: gold.some((p) => citadas.has(p)),
      diz_que_nao_consta: resposta ? DIZ_QUE_NAO_CONSTA.test(resposta.texto) : false,
      erros_de_infra: [
        ...execucoes.filter((e) => e.erro && INFRA.test(e.erro)).map((e) => `${e.ferramenta}:${e.erro}`),
        ...(ciclo?.anotacoes.filter((a) => a.tipo === "excecao").map((a) => `${a.ferramenta}:excecao`) ?? []),
      ],
      excecao,
    },
  };
}

const arredonda = (x: number) => Math.round(x * 10_000) / 10_000;
const media = (v: number[]) => (v.length ? Math.round((v.reduce((a, b) => a + b, 0) / v.length) * 10_000) / 10_000 : null);
const mediana = (v: number[]): number | null => {
  if (v.length === 0) return null;
  const o = [...v].sort((a, b) => a - b);
  const m = Math.floor(o.length / 2);
  return o.length % 2 ? (o[m] as number) : ((o[m - 1] as number) + (o[m] as number)) / 2;
};
const percentil = (v: number[], p: number): number | null => {
  if (v.length === 0) return null;
  const o = [...v].sort((a, b) => a - b);
  return o[Math.min(o.length - 1, Math.ceil(p * o.length) - 1)] as number;
};
const contar = (itens: string[]) => {
  const c: Record<string, number> = {};
  for (const i of itens) c[i] = (c[i] ?? 0) + 1;
  return c;
};

// aquecimento: a carga a frio dos modelos (e do índice do Neo4j) não pode entrar em nenhum tempo
if (selecionados[0]) {
  const w = await rodar(selecionados[0], "consultar-rapido");
  console.log(`aquecimento (descartado): ${w.medida.estado} em ${Math.round(w.medida.ms / 100) / 10} s`);
}

interface Par {
  id: string;
  ordem: Perfil[];
  consultar: Medida;
  rapido: Medida;
}
const pares: Par[] = [];
const detalhes: Record<string, unknown> = {};
for (const [i, c] of selecionados.entries()) {
  const ordem: Perfil[] = i % 2 === 0 ? ["consultar", "consultar-rapido"] : ["consultar-rapido", "consultar"];
  const saida = {} as Record<Perfil, Awaited<ReturnType<typeof rodar>>>;
  for (const p of ordem) saida[p] = await rodar(c, p);
  const par: Par = { id: c.id, ordem, consultar: saida.consultar.medida, rapido: saida["consultar-rapido"].medida };
  pares.push(par);
  detalhes[c.id] = {
    consultar: { ciclo: saida.consultar.ciclo && { estado: saida.consultar.ciclo.estado, faltando: saida.consultar.ciclo.faltando, rodadas: saida.consultar.ciclo.rodadas.length }, resposta: saida.consultar.resposta },
    rapido: { ciclo: saida["consultar-rapido"].ciclo && { estado: saida["consultar-rapido"].ciclo.estado, faltando: saida["consultar-rapido"].ciclo.faltando, rodadas: saida["consultar-rapido"].ciclo.rodadas.length }, resposta: saida["consultar-rapido"].resposta },
  };
  const s = (m: Medida) => `${m.estado.padEnd(12)} rod ${m.rodadas} ${String(Math.round(m.ms / 100) / 10).padStart(5)} s r@3 ${m.recall[3]}`;
  console.log(`${c.id.padEnd(4)} consultar ${s(par.consultar)} | rápido ${s(par.rapido)}${[...par.consultar.erros_de_infra, ...par.rapido.erros_de_infra].length ? "  INFRA" : ""}${par.consultar.excecao ?? par.rapido.excecao ? "  EXCEÇÃO" : ""}`);
}
await grafo.fechar();

function resumir(escolher: (p: Par) => Medida) {
  const m = pares.map(escolher);
  const segundos = m.map((x) => x.ms / 1000);
  const ate20 = m.filter((x) => x.ms / 1000 <= LIMITE_S);
  return {
    perguntas: m.length,
    completa_em_ate_20s: { n: ate20.filter((x) => x.estado === "suficiente").length, de: m.length, parcela: arredonda(m.length ? ate20.filter((x) => x.estado === "suficiente").length / m.length : 0) },
    so_tempo_ate_20s: { n: ate20.length, de: m.length, parcela: arredonda(m.length ? ate20.length / m.length : 0) },
    estados: contar(m.map((x) => x.estado)),
    rodadas: contar(m.map((x) => String(x.rodadas))),
    page_recall: Object.fromEntries(KS.map((k) => [`@${k}`, media(m.map((x) => x.recall[k] as number))])),
    pagina_citada: { n: m.length, acertos: m.filter((x) => x.pagina_citada).length },
    respostas_que_dizem_que_nao_consta: m.filter((x) => x.diz_que_nao_consta).length,
    tempo_s: { p50: mediana(segundos), p95: percentil(segundos, 0.95), max: Math.max(0, ...segundos), ciclo_p50: mediana(m.map((x) => x.ms_ciclo / 1000)) },
    sem_erro_de_infra: m.filter((x) => x.excecao === null && x.erros_de_infra.length === 0).length,
  };
}
const completo = resumir((p) => p.consultar);
const rapido = resumir((p) => p.rapido);
const dif = (k: number) => {
  const a = media(pares.map((p) => p.consultar.recall[k] as number));
  const b = media(pares.map((p) => p.rapido.recall[k] as number));
  return a === null || b === null ? null : Math.round((a - b) * 10_000) / 10_000;
};
const resumo = {
  nome,
  data: new Date().toISOString().slice(0, 10),
  comando: `npm run avaliar:rapido${values.nome !== "f713-modo-rapido" ? ` -- --nome ${values.nome}` : ""}`,
  conjunto: "perguntas simples do golden (factual_textual e numerica)",
  perguntas: pares.length,
  limite_s: LIMITE_S,
  consultar: completo,
  consultar_rapido: rapido,
  queda_do_page_recall: { "@1": dif(1), "@3": dif(3), "@6": dif(6) },
  por_pergunta_no_recall_3: {
    rapido_perdeu: pares.filter((p) => (p.rapido.recall[3] as number) < (p.consultar.recall[3] as number)).map((p) => p.id),
    rapido_ganhou: pares.filter((p) => (p.rapido.recall[3] as number) > (p.consultar.recall[3] as number)).map((p) => p.id),
    iguais: pares.filter((p) => p.rapido.recall[3] === p.consultar.recall[3]).length,
  },
  ganho_de_tempo_s: { p50_consultar: completo.tempo_s.p50, p50_rapido: rapido.tempo_s.p50, max_consultar: completo.tempo_s.max, max_rapido: rapido.tempo_s.max },
  itens: pares,
};
mkdirSync(new URL("eval/resultados/", RAIZ), { recursive: true });
mkdirSync(new URL("data/avaliacao/", RAIZ), { recursive: true });
writeFileSync(new URL(`eval/resultados/${nome}.json`, RAIZ), JSON.stringify(resumo, null, 2) + "\n");
writeFileSync(new URL(`data/avaliacao/${nome}-detalhes.json`, RAIZ), JSON.stringify(detalhes, null, 2) + "\n");
console.log("\n" + JSON.stringify({ ...resumo, itens: undefined }, null, 2));
process.exitCode = completo.sem_erro_de_infra === pares.length && rapido.sem_erro_de_infra === pares.length ? 0 : 1;
