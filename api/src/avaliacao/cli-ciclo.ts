/**
 * Medida do crítico (F7.4): o ciclo agente + crítico (`executarCiclo`) nas 60 perguntas do `eval/golden.csv`, no Neo4j e
 * no llama-swap reais.
 *
 *   npm run avaliar:ciclo                 # as 60 do golden (o teste)
 *   npm run avaliar:ciclo -- --ajuste     # as 12 de eval/critico_ajuste.json (só para achar defeito grosseiro no prompt)
 *
 * Definições fixadas ANTES de rodar o golden, a partir do aceite do ETAPAS ("nenhuma conversa ultrapassa duas rodadas;
 * casos 'ausente' respondidos como ausentes"):
 *
 *  - **Rodadas**: o máximo de rodadas entre as 60 é ≤ 2. É garantido por construção (`MAX_RODADAS`); a medida confere.
 *  - **Ausente**: as 5 perguntas de recusa (F01–F05) terminam em `ausente` ou `sem_consulta` (saudação e fora do escopo
 *    não chamam ferramenta). Aceite: 5/5. Também se registra se alguma pediu rodada extra (insistir numa pergunta sem
 *    resposta no documento).
 *  - **Só informativo**: nas 55 respondíveis, a distribuição dos estados, quantas o crítico mandou buscar de novo, quantas
 *    chamou de `ausente` por engano (a pior falha: recusa de pergunta que o documento responde), o page recall do ciclo
 *    contra o do agente da F7.11 v3 (`f711-agente-v3.json`) e o tempo do crítico.
 *  - Erro de infraestrutura: como na F7.11 (`cli-agente.ts`).
 *
 * O prompt foi escrito e ajustado só com `eval/critico_ajuste.json` (fora do golden). As categorias de ausência do prompt
 * (outra empresa, tempo real, previsão ou recomendação de terceiros, assunto geral) foram escritas sabendo que o golden
 * tem recusas desses tipos, então F02–F05 medem menos do que parecem; as 6 ausentes do ajuste têm outros assuntos.
 *
 * Grava `eval/resultados/<nome>.json` (ids, decisões, números; sem texto do documento, ADR-009) e as saídas completas em
 * `data/avaliacao/<nome>-detalhes.json`, fora do repositório.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { executarCiclo, type ResultadoCiclo } from "../agente/ciclo.ts";
import { GrafoNeo4j, criarExecutor } from "../ferramentas/index.ts";
import { ClienteLlm } from "../llm/index.ts";
import { lerCsv, pageRecall, paginasDoGabarito, paginasDoRotulo } from "./busca.ts";

const RAIZ = new URL("../../../", import.meta.url);
const KS = [1, 3, 6] as const;
const INFRA = /^(falha na ferramenta|llm_nao_configurado|ferramenta_desconhecida|ferramenta_nao_portada|grafo_sem_cypher_livre|falha_na_selecao|falha_no_esquema)/;

const { values } = parseArgs({
  options: {
    nome: { type: "string" },
    swap: { type: "string", default: process.env["LLAMA_SWAP_URL"] ?? "http://127.0.0.1:8080" },
    ajuste: { type: "boolean", default: false },
    limite: { type: "string" },
    somente: { type: "string", description: "ids separados por vírgula" },
  },
});
const nome = values.nome ?? (values.ajuste ? "f74-critico-ajuste" : "f74-critico");

interface Caso {
  id: string;
  pergunta: string;
  categoria: string;
  esperado: string;
  paginas: string;
  tipo_gabarito: string;
}
const casos: Caso[] = values.ajuste
  ? (JSON.parse(readFileSync(new URL("eval/critico_ajuste.json", RAIZ), "utf-8")) as { casos: { id: string; pergunta: string; esperado: string }[] }).casos.map((c) => ({ ...c, categoria: "ajuste", paginas: "", tipo_gabarito: "" }))
  : lerCsv(readFileSync(new URL("eval/golden.csv", RAIZ), "utf-8")).map((c) => ({
      id: c["id"] as string,
      pergunta: c["pergunta"] as string,
      categoria: c["categoria"] as string,
      esperado: c["tipo_gabarito"] === "recusa" ? "ausente" : "respondivel",
      paginas: c["paginas"] ?? "",
      tipo_gabarito: c["tipo_gabarito"] as string,
    }));
const selecionados = casos.filter((c) => !values.somente || values.somente.split(",").includes(c.id)).slice(0, values.limite ? Number(values.limite) : undefined);

const grafo = GrafoNeo4j.conectar();
const llm = new ClienteLlm({ baseUrl: values.swap as string });
const executor = criarExecutor({ grafo, llm });
const agenteV3 = values.ajuste
  ? null
  : (JSON.parse(readFileSync(new URL("eval/resultados/f711-agente-v3.json", RAIZ), "utf-8")) as { page_recall: { agente: Record<string, number> } }).page_recall.agente;

const media = (v: number[]) => (v.length ? Math.round((v.reduce((a, b) => a + b, 0) / v.length) * 10_000) / 10_000 : null);
const mediana = (v: number[]): number | null => {
  if (v.length === 0) return null;
  const o = [...v].sort((a, b) => a - b);
  const m = Math.floor(o.length / 2);
  return o.length % 2 ? (o[m] as number) : ((o[m - 1] as number) + (o[m] as number)) / 2;
};
const contar = (itens: string[]) => {
  const c: Record<string, number> = {};
  for (const i of itens) c[i] = (c[i] ?? 0) + 1;
  return c;
};

interface Linha {
  id: string;
  categoria: string;
  esperado: string;
  estado: string;
  rodadas: number;
  decisoes: string[];
  fallbacks_do_critico: string[];
  perguntas_extras: number;
  erros_de_infra: string[];
  excecao: string | null;
  evidencias: number;
  ms: ResultadoCiclo["etapas_ms"];
  recall: Record<number, number> | null;
  recall_antes_da_rodada_extra: Record<number, number> | null;
}
const linhas: Linha[] = [];
const detalhes: Record<string, unknown> = {};

const recallDe = (c: Caso, evidencias: { paginas: string }[]) => {
  const gold = paginasDoGabarito(c.paginas);
  if (gold.length === 0 || c.tipo_gabarito === "recusa") return null;
  const rk = pageRecall(gold, evidencias.map((e) => paginasDoRotulo(e.paginas)), KS);
  return Object.fromEntries(KS.map((k) => [k, (rk[k] as { recall: number }).recall])) as Record<number, number>;
};

for (const c of selecionados) {
  let r: ResultadoCiclo | null = null;
  let excecao: string | null = null;
  try {
    r = await executarCiclo(llm, executor, c.pergunta);
  } catch (e) {
    excecao = e instanceof Error ? `${e.constructor.name}: ${e.message}` : String(e);
  }
  const execucoes = r?.rodadas.flatMap((x) => x.agente.subperguntas.flatMap((s) => s.execucoes)) ?? [];
  const infra = [
    ...execucoes.filter((e) => e.erro && INFRA.test(e.erro)).map((e) => `${e.ferramenta}:${e.erro}`),
    ...(r?.anotacoes.filter((a) => a.tipo === "excecao").map((a) => `${a.ferramenta}:excecao`) ?? []),
  ];
  const l: Linha = {
    id: c.id,
    categoria: c.categoria,
    esperado: c.esperado,
    estado: r?.estado ?? "falhou",
    rodadas: r?.rodadas.length ?? 0,
    decisoes: r?.rodadas.map((x) => x.critica?.decisao ?? "sem_critica") ?? [],
    fallbacks_do_critico: r?.rodadas.flatMap((x) => (x.critica?.fallback ? [x.critica.fallback] : [])) ?? [],
    perguntas_extras: r?.rodadas[0]?.critica?.perguntas.length ?? 0,
    erros_de_infra: infra,
    excecao,
    evidencias: r?.evidencias.length ?? 0,
    ms: r?.etapas_ms ?? { atualizar: 0, rotear: 0, executar: 0, criticar: 0, total: 0 },
    recall: r ? recallDe(c, r.evidencias) : null,
    recall_antes_da_rodada_extra: r && r.rodadas.length > 1 ? recallDe(c, r.rodadas[0]?.agente.evidencias ?? []) : null,
  };
  linhas.push(l);
  detalhes[c.id] = r ?? { excecao };
  console.log(
    `${c.id.padEnd(4)} esp ${c.esperado.padEnd(11)} ${l.estado.padEnd(12)} rod ${l.rodadas} ${l.decisoes.join(">").padEnd(26)} ${String(Math.round(l.ms.total / 100) / 10).padStart(5)} s (crítico ${Math.round(l.ms.criticar / 100) / 10} s)` +
      `${infra.length ? `  INFRA ${infra.join(",")}` : ""}${excecao ? `  EXCEÇÃO ${excecao}` : ""}`,
  );
}
await grafo.fechar();

const recusas = linhas.filter((l) => l.esperado === "ausente");
const respondiveis = linhas.filter((l) => l.esperado === "respondivel");
const medidas = linhas.filter((l) => l.recall);
const recallDoCiclo = Object.fromEntries(KS.map((k) => [`@${k}`, media(medidas.map((l) => (l.recall as Record<number, number>)[k] as number))]));
const maxRodadas = Math.max(0, ...linhas.map((l) => l.rodadas));
const ausentesCertos = recusas.filter((l) => l.estado === "ausente" || l.estado === "sem_consulta").length;
const resumo = {
  nome,
  data: new Date().toISOString().slice(0, 10),
  comando: `npm run avaliar:ciclo${values.ajuste ? " -- --ajuste" : ""}`,
  conjunto: values.ajuste ? "ajuste" : "golden",
  perguntas: linhas.length,
  rodadas: { maximo: maxRodadas, ate_duas: maxRodadas <= 2, por_numero: contar(linhas.map((l) => String(l.rodadas))) },
  ausente: {
    recusas: recusas.length,
    respondidas_como_ausentes: ausentesCertos,
    estados: contar(recusas.map((l) => l.estado)),
    pediram_rodada_extra: recusas.filter((l) => l.rodadas > 1).map((l) => l.id),
  },
  respondiveis: {
    n: respondiveis.length,
    estados: contar(respondiveis.map((l) => l.estado)),
    ausente_por_engano: respondiveis.filter((l) => l.estado === "ausente").map((l) => l.id),
    com_rodada_extra: respondiveis.filter((l) => l.rodadas > 1).length,
  },
  execucao: {
    sem_excecao: linhas.filter((l) => l.excecao === null).length,
    sem_erro_de_infra: linhas.filter((l) => l.excecao === null && l.erros_de_infra.length === 0).length,
    fallbacks_do_critico: contar(linhas.flatMap((l) => l.fallbacks_do_critico)),
  },
  tempo_s: {
    total: { p50: mediana(linhas.map((l) => l.ms.total / 1000)), max: Math.max(0, ...linhas.map((l) => l.ms.total / 1000)) },
    critico: { p50: mediana(linhas.filter((l) => l.ms.criticar > 0).map((l) => l.ms.criticar / 1000)), max: Math.max(0, ...linhas.map((l) => l.ms.criticar / 1000)) },
  },
  page_recall: agenteV3
    ? {
        perguntas: medidas.length,
        ciclo: recallDoCiclo,
        agente_f711_v3: Object.fromEntries(KS.map((k) => [`@${k}`, agenteV3[`@${k}`] ?? null])),
        so_as_com_rodada_extra: {
          n: medidas.filter((l) => l.recall_antes_da_rodada_extra).length,
          antes: Object.fromEntries(KS.map((k) => [`@${k}`, media(medidas.filter((l) => l.recall_antes_da_rodada_extra).map((l) => (l.recall_antes_da_rodada_extra as Record<number, number>)[k] as number))])),
          depois: Object.fromEntries(KS.map((k) => [`@${k}`, media(medidas.filter((l) => l.recall_antes_da_rodada_extra).map((l) => (l.recall as Record<number, number>)[k] as number))])),
        },
      }
    : null,
  itens: linhas,
};
mkdirSync(new URL("eval/resultados/", RAIZ), { recursive: true });
mkdirSync(new URL("data/avaliacao/", RAIZ), { recursive: true });
writeFileSync(new URL(`eval/resultados/${nome}.json`, RAIZ), JSON.stringify(resumo, null, 2) + "\n");
writeFileSync(new URL(`data/avaliacao/${nome}-detalhes.json`, RAIZ), JSON.stringify(detalhes, null, 2) + "\n");
console.log("\n" + JSON.stringify({ ...resumo, itens: undefined }, null, 2));
process.exitCode = resumo.rodadas.ate_duas && resumo.execucao.sem_erro_de_infra === linhas.length && ausentesCertos === recusas.length ? 0 : 1;
