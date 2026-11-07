/**
 * Medida do agente (F7.11): as 60 perguntas do `eval/golden.csv` de ponta a ponta (atualizador → roteador → executor, todos
 * em TypeScript), no Neo4j e no llama-swap reais.
 *
 *   npm run avaliar:agente
 *
 * Precisa do Neo4j (`.\infra\neo4j.ps1 iniciar`) e do llama-swap (`.\infra\swap.ps1`). As definições abaixo foram fixadas
 * ANTES da primeira rodada, a partir do aceite do ETAPAS ("as 60 perguntas executam ponta a ponta sem erro de ferramenta,
 * com a rota e o tempo de cada etapa registrados, e o page recall não é inferior ao do Python"):
 *
 *  - **Executa sem erro de ferramenta**: nenhuma das 60 lança, e nenhuma execução tem erro de *infraestrutura* (exceção
 *    da ferramenta, `falha na ferramenta`, `llm_nao_configurado`, `ferramenta_desconhecida`, `grafo_sem_cypher_livre`,
 *    `falha_na_selecao`, `falha_no_esquema`). O erro de *domínio* (a ferramenta rodou e disse que não achou: métrica
 *    desconhecida, Cypher bloqueado pela guarda, consulta sem linhas) é contado à parte, com o código, mas não reprova.
 *    O número estrito (qualquer `erro`) também vai para o relatório.
 *  - **Page recall**: nas mesmas 55 perguntas do golden com página e sem recusa da F7.9, sobre a lista plana de evidências
 *    do agente, na ordem em que ela sai (subperguntas, depois chamadas), com as mesmas contas de `pageRecall`: recall@1,
 *    @3 e @6 (as k primeiras evidências, mesmo as sem página). "Não inferior" é TypeScript ≥ Python em @1, @3 e @6; o
 *    Python é o `buscar_trechos` recalculado na F7.9 (`eval/resultados/f79-busca.json`: 0,4727 / 0,5788 / 0,6273). O recall
 *    sobre todas as evidências devolvidas (sem corte em k) vai à parte, porque o agente devolve mais de 6 quando roteia
 *    para mais de uma ferramenta.
 *  - **Rota**: a de cada pergunta contra `eval/golden_rotas.json` (estrito e aceito, como na F7.3), só informativa aqui.
 *
 * **Rodadas.** A 1ª rodada (`f711-agente-v1`, sem `--complementar`) foi a medida pré-registrada acima e reprovou o page recall.
 * `--complementar` liga a opção pós-hoc do agente (uma busca de trechos junto de toda rota especializada), decidida DEPOIS
 * de ver os resultados da 1ª; as duas ficam no relatório, a 1ª nunca é substituída (ADR-059).
 *
 * Grava `eval/resultados/<nome>.json` (ids, números, ferramentas e códigos de erro, sem texto do documento — ADR-009) e
 * as saídas completas em `data/avaliacao/<nome>-detalhes.json`, fora do repositório.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { executarAgente, type ResultadoAgente } from "../agente/agente.ts";
import { GrafoNeo4j, criarExecutor } from "../ferramentas/index.ts";
import { ClienteLlm } from "../llm/index.ts";
import { lerCsv, pageRecall, paginasDoGabarito, paginasDoRotulo } from "./busca.ts";
import { avaliarRota, type CasoRota } from "./rotas.ts";

const RAIZ = new URL("../../../", import.meta.url);
const KS = [1, 3, 6] as const;
const INFRA = /^(falha na ferramenta|llm_nao_configurado|ferramenta_desconhecida|ferramenta_nao_portada|grafo_sem_cypher_livre|falha_na_selecao|falha_no_esquema)/;

const { values } = parseArgs({
  options: {
    nome: { type: "string", default: "f711-agente" },
    swap: { type: "string", default: process.env["LLAMA_SWAP_URL"] ?? "http://127.0.0.1:8080" },
    limite: { type: "string", description: "só as N primeiras perguntas (teste rápido)" },
    somente: { type: "string", description: "ids separados por vírgula" },
    complementar: { type: "boolean", default: false, description: "acrescenta buscar_trechos às rotas especializadas (opção pós-hoc, ADR-059)" },
  },
});

const grafo = GrafoNeo4j.conectar();
const llm = new ClienteLlm({ baseUrl: values.swap as string });
const executor = criarExecutor({ grafo, llm });
const golden = lerCsv(readFileSync(new URL("eval/golden.csv", RAIZ), "utf-8"))
  .filter((c) => !values.somente || values.somente.split(",").includes(c["id"] as string))
  .slice(0, values.limite ? Number(values.limite) : undefined);
const rotas = new Map((JSON.parse(readFileSync(new URL("eval/golden_rotas.json", RAIZ), "utf-8")) as CasoRota[]).map((c) => [c.id, c]));
const python = (JSON.parse(readFileSync(new URL("eval/resultados/f79-busca.json", RAIZ), "utf-8")) as { trechos: { page_recall: Record<string, { python: number }> } }).trechos.page_recall;

const mediana = (v: number[]): number | null => {
  if (v.length === 0) return null;
  const o = [...v].sort((a, b) => a - b);
  const m = Math.floor(o.length / 2);
  return o.length % 2 ? (o[m] as number) : ((o[m - 1] as number) + (o[m] as number)) / 2;
};
const media = (v: number[]) => (v.length ? Math.round((v.reduce((a, b) => a + b, 0) / v.length) * 10_000) / 10_000 : null);
const contar = (itens: string[]) => {
  const c: Record<string, number> = {};
  for (const i of itens) c[i] = (c[i] ?? 0) + 1;
  return c;
};

interface Linha {
  id: string;
  categoria: string;
  rota_esperada: string;
  rota: string;
  subperguntas: number;
  ferramentas: string[];
  fallback_atualizador: string | null;
  fallbacks_roteador: string[];
  erros_de_infra: string[];
  erros_de_dominio: string[];
  excecao: string | null;
  evidencias: number;
  com_pagina: number;
  ms: { atualizar: number; rotear: number; executar: number; total: number };
  recall: Record<number, number> | null;
  recall_total: number | null;
  rota_estrita: boolean | null;
  rota_aceita: boolean | null;
}
const linhas: Linha[] = [];
const detalhes: Record<string, unknown> = {};

for (const c of golden) {
  const id = c["id"] as string;
  let r: ResultadoAgente | null = null;
  let excecao: string | null = null;
  try {
    r = await executarAgente(llm, executor, c["pergunta"] as string, { complementar: values.complementar === true });
  } catch (e) {
    excecao = e instanceof Error ? `${e.constructor.name}: ${e.message}` : String(e);
  }
  const execucoes = r?.subperguntas.flatMap((s) => s.execucoes) ?? [];
  const comErro = execucoes.filter((e) => e.erro);
  const infra = [
    ...comErro.filter((e) => INFRA.test(e.erro as string)).map((e) => `${e.ferramenta}:${e.erro}`),
    ...(r?.anotacoes.filter((a) => a.tipo === "excecao").map((a) => `${a.ferramenta}:excecao`) ?? []),
  ];
  const dominio = comErro.filter((e) => !INFRA.test(e.erro as string)).map((e) => `${e.ferramenta}:${String(e.erro).split(":")[0]}`);
  const gold = paginasDoGabarito(c["paginas"] ?? "");
  const mede = gold.length > 0 && c["tipo_gabarito"] !== "recusa";
  const paginas = (r?.evidencias ?? []).map((e) => paginasDoRotulo(e.paginas));
  const rk = mede ? pageRecall(gold, paginas, KS) : null;
  const total = mede ? pageRecall(gold, paginas, [Number.MAX_SAFE_INTEGER])[Number.MAX_SAFE_INTEGER] : null;
  const caso = rotas.get(id);
  const av = caso && r ? avaliarRota(caso, { rotas: r.subperguntas.map((s) => [...new Set(s.chamadas.map((x) => x.nome))]) }) : null;
  const l: Linha = {
    id,
    categoria: c["categoria"] as string,
    rota_esperada: c["rota_esperada"] as string,
    rota: r?.rota ?? "falhou",
    subperguntas: r?.subperguntas.length ?? 0,
    ferramentas: [...new Set(r?.subperguntas.flatMap((s) => s.chamadas.map((x) => x.nome)) ?? [])],
    fallback_atualizador: r?.atualizacao.fallback ?? null,
    fallbacks_roteador: r?.anotacoes.filter((a) => a.tipo === "fallback_do_roteador").map((a) => a.detalhe) ?? [],
    erros_de_infra: infra,
    erros_de_dominio: dominio,
    excecao,
    evidencias: r?.evidencias.length ?? 0,
    com_pagina: r?.evidencias.filter((e) => e.paginas !== "").length ?? 0,
    ms: r?.etapas_ms ?? { atualizar: 0, rotear: 0, executar: 0, total: 0 },
    recall: rk ? Object.fromEntries(KS.map((k) => [k, (rk[k] as { recall: number }).recall])) : null,
    recall_total: total ? total.recall : null,
    rota_estrita: av?.estrito ?? null,
    rota_aceita: av?.aceito ?? null,
  };
  linhas.push(l);
  detalhes[id] = r ?? { excecao };
  console.log(
    `${id.padEnd(4)} ${l.rota.padEnd(11)} ${l.ferramentas.join("+").padEnd(34)} ${String(l.evidencias).padStart(3)} ev  ${String(Math.round(l.ms.total / 100) / 10).padStart(5)} s` +
      `${infra.length ? `  INFRA ${infra.join(",")}` : ""}${dominio.length ? `  dom ${dominio.join(",")}` : ""}${excecao ? `  EXCEÇÃO ${excecao}` : ""}`,
  );
}
await grafo.fechar();

const medidas = linhas.filter((l) => l.recall);
const recallDoAgente = Object.fromEntries(KS.map((k) => [`@${k}`, media(medidas.map((l) => (l.recall as Record<number, number>)[k] as number))]));
const recallPython = Object.fromEntries(KS.map((k) => [`@${k}`, python[`@${k}`]?.python ?? null]));
const naoInferior = KS.every((k) => ((recallDoAgente[`@${k}`] as number | null) ?? 0) >= ((recallPython[`@${k}`] as number | null) ?? Infinity));
const tempos = (f: (l: Linha) => number) => ({ p50: mediana(linhas.map(f)), max: Math.max(0, ...linhas.map(f)) });
const resumo = {
  nome: values.nome,
  data: new Date().toISOString().slice(0, 10),
  comando: ["npm run avaliar:agente", ...(values.complementar || values.nome !== "f711-agente" ? ["--"] : []), ...(values.complementar ? ["--complementar"] : []), ...(values.nome !== "f711-agente" ? ["--nome", values.nome as string] : [])].join(" "),
  complementar: values.complementar === true,
  perguntas: linhas.length,
  execucao: {
    sem_excecao: linhas.filter((l) => l.excecao === null).length,
    sem_erro_de_infra: linhas.filter((l) => l.excecao === null && l.erros_de_infra.length === 0).length,
    sem_nenhum_erro_de_ferramenta: linhas.filter((l) => l.excecao === null && l.erros_de_infra.length === 0 && l.erros_de_dominio.length === 0).length,
    erros_de_infra: contar(linhas.flatMap((l) => l.erros_de_infra)),
    erros_de_dominio: contar(linhas.flatMap((l) => l.erros_de_dominio)),
    fallback_do_atualizador: linhas.filter((l) => l.fallback_atualizador).length,
    fallback_do_roteador: linhas.filter((l) => l.fallbacks_roteador.length).length,
  },
  rotas: {
    por_rota: contar(linhas.map((l) => l.rota)),
    ferramentas: contar(linhas.flatMap((l) => l.ferramentas)),
    com_mais_de_uma_subpergunta: linhas.filter((l) => l.subperguntas > 1).length,
    estrito: linhas.filter((l) => l.rota_estrita).length,
    aceito: linhas.filter((l) => l.rota_aceita).length,
    avaliadas: linhas.filter((l) => l.rota_aceita !== null).length,
  },
  tempo_s: {
    total: tempos((l) => l.ms.total / 1000),
    atualizar: tempos((l) => l.ms.atualizar / 1000),
    rotear: tempos((l) => l.ms.rotear / 1000),
    executar: tempos((l) => l.ms.executar / 1000),
  },
  page_recall: {
    perguntas: medidas.length,
    agente: recallDoAgente,
    python: recallPython,
    nao_inferior_ao_python: naoInferior,
    sobre_todas_as_evidencias: media(medidas.map((l) => l.recall_total as number)),
    evidencias_por_pergunta: media(medidas.map((l) => l.evidencias)),
  },
  itens: linhas,
};
mkdirSync(new URL("eval/resultados/", RAIZ), { recursive: true });
mkdirSync(new URL("data/avaliacao/", RAIZ), { recursive: true });
writeFileSync(new URL(`eval/resultados/${values.nome}.json`, RAIZ), JSON.stringify(resumo, null, 2) + "\n");
writeFileSync(new URL(`data/avaliacao/${values.nome}-detalhes.json`, RAIZ), JSON.stringify(detalhes, null, 2) + "\n");
console.log("\n" + JSON.stringify({ ...resumo, itens: undefined }, null, 2));
process.exitCode = resumo.execucao.sem_erro_de_infra === linhas.length && naoInferior ? 0 : 1;
