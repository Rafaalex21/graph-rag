/**
 * Paridade e page recall das buscas (F7.9): roda no Python (`indexer.reranker buscar --json` e `indexer.busca_local
 * buscar`) e no TypeScript (`buscarTrechos`, `buscarEntidade`) as mesmas entradas, no mesmo Neo4j e no mesmo
 * llama-swap, e compara.
 *
 *   npm run avaliar:busca
 *
 * Precisa do Neo4j (`.\infra\neo4j.ps1 iniciar`), do llama-swap (`.\infra\swap.ps1`) e do `uv` no PATH. Mede:
 *  - `buscar_trechos`: os 6 Pais (ids, texto, caminho, posição antes do rerank, notas) iguais aos do Python em cada
 *    pergunta do golden com página, e o page recall@1/3/6 dos dois lados (o aceite é o do TypeScript não ser inferior
 *    ao do Python). As notas do reranker valem com tolerância de 1e-3: o llama-server dá notas diferentes conforme já
 *    tenha visto a mesma consulta na chamada anterior, então a ordem das chamadas é TS (a frio), Python, TS (a quente)
 *    e só os dois últimos são comparados;
 *  - `entidade`: o JSON inteiro (entidades, evidências, omitido, rerank) igual ao do Python em cada nome (notas com a
 *    mesma tolerância);
 *  - `buscar_tabelas` (sem referência em Python): se a página do gabarito aparece nas tabelas devolvidas;
 *  - T15: a diretora presidente aparece nas evidências de `entidade`.
 *
 * Grava `eval/resultados/<nome>.json` (ids, números e caminhos das diferenças, sem texto do documento) e as saídas
 * completas em `data/avaliacao/<nome>-detalhes.json` (fora do repositório, ADR-009).
 */
import { spawn } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { buscarEntidade, buscarTabelas, buscarTrechos, GrafoNeo4j } from "../ferramentas/index.ts";
import { ClienteLlm } from "../llm/index.ts";
import { lerCsv, pageRecall, paginasDoGabarito, paginasDoRotulo } from "./busca.ts";
import { comoJson, comparar, compararItens, type Item, type Json } from "./paridade.ts";

const RAIZ = new URL("../../../", import.meta.url);
const KS = [1, 3, 6] as const;
/** O reranker do llama.cpp varia a nota de uma execução para outra; abaixo disto a diferença é ruído, não porte. */
const TOLERANCIA_DE_NOTA = 1e-3;

const { values } = parseArgs({
  options: {
    nome: { type: "string", default: "f79-busca" },
    swap: { type: "string", default: process.env["LLAMA_SWAP_URL"] ?? "http://127.0.0.1:8080" },
    somente: { type: "string", description: "trechos,entidades,tabelas" },
    limite: { type: "string", description: "só as N primeiras perguntas do golden (teste rápido)" },
    ruido: { type: "string", default: "10", description: "em quantas perguntas rodar o Python duas vezes para medir o ruído do reranker" },
  },
});
const RUIDO = Number(values.ruido);
const fazer = (parte: string) => !values.somente || values.somente.split(",").includes(parte);

function python(modulo: string, args: string[]): Promise<{ json: Json | null; erro: string | null }> {
  return new Promise((resolver) => {
    const filho = spawn("uv", ["run", "python", "-m", modulo, ...args, "--swap", values.swap as string], {
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
        resolver({ json: JSON.parse(Buffer.concat(saida).toString("utf-8")) as Json, erro: null });
      } catch {
        resolver({ json: null, erro: `saída não é JSON (código ${codigo}): ${Buffer.concat(erro).toString("utf-8").slice(-300)}` });
      }
    });
  });
}

const grafo = GrafoNeo4j.conectar();
const llm = new ClienteLlm({ baseUrl: values.swap as string });
const golden = lerCsv(readFileSync(new URL("eval/golden.csv", RAIZ), "utf-8"))
  .filter((c) => c["paginas"]?.trim() && c["tipo_gabarito"] !== "recusa")
  .slice(0, values.limite ? Number(values.limite) : undefined);
const extra = JSON.parse(readFileSync(new URL("eval/paridade_busca.json", RAIZ), "utf-8")) as { entidades: string[] };
const detalhes: Record<string, unknown> = {};

const media = (v: number[]) => (v.length ? Math.round((v.reduce((a, b) => a + b, 0) / v.length) * 10_000) / 10_000 : null);

// ---------- buscar_trechos ----------
interface LinhaTrecho {
  id: string;
  categoria: string;
  veredito: string;
  diferencas: { caminho: string; tipo: string }[];
  recall_python: Record<number, number> | null;
  recall_ts: Record<number, number> | null;
  ms_ts: number;
  erro?: string;
}
const trechos: LinhaTrecho[] = [];
const difs: number[] = [];
let trocasDeOrdem = 0;
const efeitoFria: number[] = [];
const ruido: { id: string; max_dif_score: number; mesmo_conjunto: boolean; mesma_ordem: boolean }[] = [];
/** Os Pais do Python na forma de `compararItens`. */
const itensDePy = (j: { [k: string]: Json }): Item[] =>
  (j["pais"] as { [k: string]: Json }[]).map((p) => ({
    id: p["id"] as string,
    score: p["nota_rerank"] as number | null,
    posicao_antes: p["posicao_antes"] as number,
    texto: p["text"] as string,
    caminho: p["caminho"] as string,
  }));
if (fazer("trechos")) {
  for (const c of golden) {
    const pergunta = c["pergunta"] as string;
    const gold = paginasDoGabarito(c["paginas"] as string);
    // O reranker dá notas diferentes conforme o servidor já tenha visto a mesma consulta na chamada anterior (cache de
    // prefixo): "a frio" (a chamada anterior era outra pergunta) ou "a quente" (era esta). Para comparar de igual para
    // igual, a ordem é: TS a frio (só para medir o efeito), Python (a quente) e TS (a quente).
    const fria = await buscarTrechos(grafo, llm, pergunta);
    const py = await python("indexer.reranker", ["buscar", pergunta, "--json"]);
    const passadas = [await buscarTrechos(grafo, llm, pergunta)];
    const pyJson = py.json as { [k: string]: Json } | null;
    const analisar = (t: (typeof passadas)[number]) => {
      if (!pyJson) return null;
      const itensTs: Item[] = t.pais.map((p, i) => ({
        id: p.id,
        score: p.nota_rerank,
        posicao_antes: p.posicao_antes,
        texto: t.evidencias[i]?.texto ?? null,
        caminho: t.evidencias[i]?.caminho ?? null,
      }));
      const cmp = compararItens(itensDePy(pyJson), itensTs);
      const outrosIguais =
        comparar(
          comoJson({ cortados: pyJson["cortados"], candidatos: pyJson["candidatos"] }),
          comoJson({ cortados: t.omitido["cortados_no_rerank"], candidatos: (t.omitido["pais"] ?? 0) + t.evidencias.length }),
        ).veredito === "igual";
      const pior = cmp.mesmo_conjunto && cmp.conteudo_igual && outrosIguais ? cmp.max_dif_score : Number.POSITIVE_INFINITY;
      return { cmp, outrosIguais, pior };
    };
    const analises = passadas.map(analisar);
    const melhor = 0;
    const ts = passadas[melhor] as (typeof passadas)[number];
    efeitoFria.push(compararItens(fria.pais.map((p) => ({ id: p.id, score: p.nota_rerank })), ts.pais.map((p) => ({ id: p.id, score: p.nota_rerank }))).max_dif_score);
    const tsJson = comoJson(ts) as { [k: string]: Json };
    let veredito = "falha_python";
    let diferencas: LinhaTrecho["diferencas"] = [];
    let recallPy: LinhaTrecho["recall_python"] = null;
    if (pyJson) {
      const paisPy = pyJson["pais"] as { [k: string]: Json }[];
      const itensPy = itensDePy(pyJson);
      const { cmp, outrosIguais } = analises[melhor] as NonNullable<ReturnType<typeof analisar>>;
      if (!cmp.mesmo_conjunto || !cmp.conteudo_igual || !outrosIguais || cmp.max_dif_score > TOLERANCIA_DE_NOTA) veredito = "diferente";
      else veredito = cmp.mesma_ordem && cmp.max_dif_score === 0 ? "igual" : "ruido_do_reranker";
      diferencas = [
        ...cmp.so_em_a.map((id) => ({ caminho: `só no Python: ${id}`, tipo: "pai" })),
        ...cmp.so_em_b.map((id) => ({ caminho: `só no TS: ${id}`, tipo: "pai" })),
        ...(cmp.conteudo_igual ? [] : [{ caminho: "conteúdo de um Pai comum", tipo: "texto_ou_caminho" }]),
        ...(outrosIguais ? [] : [{ caminho: "cortados/candidatos", tipo: "valor" }]),
        ...(cmp.max_dif_score > TOLERANCIA_DE_NOTA ? [{ caminho: `nota (dif ${cmp.max_dif_score})`, tipo: "valor" }] : []),
      ];
      difs.push(cmp.max_dif_score);
      if (!cmp.mesma_ordem && cmp.mesmo_conjunto) trocasDeOrdem++;
      // Chão de ruído: o Python contra ele mesmo, nas primeiras perguntas.
      if (trechos.length < RUIDO) {
        const py2 = await python("indexer.reranker", ["buscar", pergunta, "--json"]);
        if (py2.json) {
          const c2 = compararItens(itensPy, itensDePy(py2.json as { [k: string]: Json }));
          ruido.push({ id: c["id"] as string, max_dif_score: c2.max_dif_score, mesmo_conjunto: c2.mesmo_conjunto, mesma_ordem: c2.mesma_ordem });
        }
      }
      const paginasPy = paisPy.map((p) => new Set(Array.from({ length: Number(p["pageEnd"]) - Number(p["pageStart"]) + 1 }, (_, i) => Number(p["pageStart"]) + i)));
      const r = pageRecall(gold, paginasPy, KS);
      recallPy = Object.fromEntries(KS.map((k) => [k, (r[k] as { recall: number }).recall]));
    }
    const rTs = pageRecall(gold, ts.evidencias.map((e) => paginasDoRotulo(e.paginas)), KS);
    trechos.push({
      id: c["id"] as string,
      categoria: c["categoria"] as string,
      veredito,
      diferencas,
      recall_python: recallPy,
      recall_ts: Object.fromEntries(KS.map((k) => [k, (rTs[k] as { recall: number }).recall])),
      ms_ts: ts.latencia_ms,
      ...(py.erro || ts.erro ? { erro: `${py.erro ?? ""} ${ts.erro ?? ""}`.trim() } : {}),
    });
    detalhes[`trechos:${c["id"]}`] = { python: py.json, ts: tsJson, ts_a_frio: comoJson(fria) };
    console.log(`trechos  ${veredito.padEnd(9)} ${c["id"]}${diferencas.length ? `  (${diferencas.map((d) => d.caminho).join("; ")})` : ""}`);
  }
}

// ---------- entidade ----------
interface LinhaEntidade {
  nome: string;
  veredito: string;
  diferencas: { caminho: string; tipo: string }[];
  evidencias_python: number | null;
  evidencias_ts: number;
  erro?: string;
}
const entidades: LinhaEntidade[] = [];
if (fazer("entidades")) {
  for (const nome of extra.entidades) {
    await buscarEntidade(grafo, llm, nome); // a frio: deixa o servidor no mesmo estado para Python e TS (ver acima)
    const py = await python("indexer.busca_local", ["buscar", nome]);
    const ts = await buscarEntidade(grafo, llm, nome);
    const pyJson = py.json as { [k: string]: Json } | null;
    let veredito = "falha_python";
    let diferencas: LinhaEntidade["diferencas"] = [];
    if (pyJson) {
      const proj = (j: { [k: string]: Json }) => ({ entidades: j["entidades"], evidencias: j["evidencias"], omitido: j["omitido"], rerank: j["rerank"] });
      const tsJson = comoJson(ts) as { [k: string]: Json };
      // Notas do reranker com tolerância (mesmo ruído das buscas de trechos); tudo o mais, exato.
      const cmp = comparar(comoJson(proj(pyJson)), comoJson(proj(tsJson)), TOLERANCIA_DE_NOTA);
      veredito = cmp.veredito;
      diferencas = cmp.diferencas;
    }
    entidades.push({
      nome,
      veredito,
      diferencas,
      evidencias_python: pyJson ? (pyJson["evidencias"] as Json[]).length : null,
      evidencias_ts: ts.evidencias.length,
      ...(py.erro || ts.erro ? { erro: `${py.erro ?? ""} ${ts.erro ?? ""}`.trim() } : {}),
    });
    detalhes[`entidade:${nome}`] = { python: py.json, ts: comoJson(ts) };
    console.log(`entidade ${veredito.padEnd(9)} ${nome}${diferencas.length ? `  (${diferencas.length} diferenças)` : ""}`);
  }
}

// ---------- buscar_tabelas e T15 ----------
const tabelas: { id: string; pergunta_do_golden: boolean; paginas_gabarito: number[]; acerto: Record<number, number>; ms: number }[] = [];
if (fazer("tabelas")) {
  const perguntas = golden.filter((c) => c["rota_esperada"] === "buscar_tabelas");
  for (const c of perguntas) {
    const r = await buscarTabelas(grafo, llm, c["pergunta"] as string);
    const gold = paginasDoGabarito(c["paginas"] as string);
    const t = pageRecall(gold, r.evidencias.map((e) => paginasDoRotulo(e.paginas)), [1, 3]);
    tabelas.push({ id: c["id"] as string, pergunta_do_golden: true, paginas_gabarito: gold, acerto: { 1: (t[1] as { acerto: number }).acerto, 3: (t[3] as { acerto: number }).acerto }, ms: r.latencia_ms });
    detalhes[`tabelas:${c["id"]}`] = comoJson(r);
    console.log(`tabelas  acerto@3=${(t[3] as { acerto: number }).acerto} ${c["id"]}`);
  }
}
const t15 = golden.find((c) => c["id"] === "T15");
let t15Resultado: { nome_da_pergunta: boolean; por_cargo: boolean } | null = null;
if (fazer("entidades") && t15) {
  const esperado = (t15["gabarito"] ?? "").replace(/[.\s]+$/, "");
  const porPergunta = await buscarEntidade(grafo, llm, t15["pergunta"] as string);
  const porCargo = await buscarEntidade(grafo, llm, "Diretora Presidente");
  const tem = (r: { evidencias: { texto: string }[] }) => r.evidencias.some((e) => e.texto.includes(esperado));
  t15Resultado = { nome_da_pergunta: tem(porPergunta), por_cargo: tem(porCargo) };
}

await grafo.fechar();

const contar = (l: { veredito: string }[], v: string) => l.filter((x) => x.veredito === v).length;
const recall = (l: LinhaTrecho[], lado: "recall_python" | "recall_ts", k: number) => media(l.flatMap((x) => (x[lado] ? [x[lado]?.[k] as number] : [])));
const resumo = {
  nome: values.nome,
  data: new Date().toISOString().slice(0, 10),
  comando: "npm run avaliar:busca",
  trechos: {
    perguntas: trechos.length,
    iguais: contar(trechos, "igual"),
    ruido_do_reranker: contar(trechos, "ruido_do_reranker"),
    diferentes: contar(trechos, "diferente"),
    falhas: trechos.filter((x) => x.veredito.startsWith("falha")).length,
    tolerancia_de_nota: TOLERANCIA_DE_NOTA,
    maior_dif_de_nota: difs.length ? Math.max(...difs) : null,
    trocas_de_ordem: trocasDeOrdem,
    efeito_do_cache_do_servidor: { perguntas_em_que_a_nota_muda_a_frio: efeitoFria.filter((x) => x > TOLERANCIA_DE_NOTA).length, maior_dif_de_nota: efeitoFria.length ? Math.max(...efeitoFria) : null },
    chao_de_ruido_python_contra_python: { perguntas: ruido.length, maior_dif_de_nota: ruido.length ? Math.max(...ruido.map((r) => r.max_dif_score)) : null, conjuntos_diferentes: ruido.filter((r) => !r.mesmo_conjunto).length, ordens_diferentes: ruido.filter((r) => !r.mesma_ordem).length },
    page_recall: Object.fromEntries(KS.map((k) => [`@${k}`, { python: recall(trechos, "recall_python", k), ts: recall(trechos, "recall_ts", k) }])),
    ms_ts_p50: trechos.length ? [...trechos.map((x) => x.ms_ts)].sort((a, b) => a - b)[Math.floor(trechos.length / 2)] : null,
  },
  entidades: {
    nomes: entidades.length,
    iguais: contar(entidades, "igual"),
    so_ordem: contar(entidades, "so_ordem"),
    diferentes: contar(entidades, "diferente"),
    falhas: entidades.filter((x) => x.veredito.startsWith("falha")).length,
    t15: t15Resultado,
  },
  tabelas: {
    perguntas: tabelas.length,
    acerto_de_pagina: { "@1": media(tabelas.map((t) => t.acerto[1] as number)), "@3": media(tabelas.map((t) => t.acerto[3] as number)) },
  },
  itens: { trechos, entidades, tabelas, ruido },
};
mkdirSync(new URL("eval/resultados/", RAIZ), { recursive: true });
mkdirSync(new URL("data/avaliacao/", RAIZ), { recursive: true });
writeFileSync(new URL(`eval/resultados/${values.nome}.json`, RAIZ), JSON.stringify(resumo, null, 2) + "\n");
writeFileSync(new URL(`data/avaliacao/${values.nome}-detalhes.json`, RAIZ), JSON.stringify(detalhes, null, 2) + "\n");
console.log("\n" + JSON.stringify({ ...resumo, itens: undefined }, null, 2));
process.exitCode = resumo.trechos.diferentes + resumo.trechos.falhas + resumo.entidades.diferentes + resumo.entidades.falhas === 0 ? 0 : 1;
