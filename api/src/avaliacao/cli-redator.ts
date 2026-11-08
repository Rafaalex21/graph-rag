/**
 * Medida do redator (F7.5): o pipeline inteiro (atualizador → roteador → executor → crítico → redator) nas 60 perguntas do
 * `eval/golden.csv`, no Neo4j e no llama-swap reais.
 *
 *   npm run avaliar:redator                 # as 60 do golden (o teste)
 *   npm run avaliar:redator -- --ajuste     # as 16 de eval/critico_ajuste.json (só para achar defeito grosseiro no prompt)
 *
 * Definições fixadas ANTES de rodar o golden, a partir do aceite do ETAPAS ("100% das afirmações numéricas citadas no
 * golden set"):
 *
 *  - **Afirmação numérica**: frase (ou item de lista) da resposta final com ao menos um número pela régua de `numeros.ts`
 *    (pt-BR, escala escrita, "dois" a "dez"; fora: ano solto, parte de data, numeração de lista, o número do marcador).
 *  - **Citada**: a frase tem ao menos um marcador `[E#]` que existe entre as evidências entregues ao redator. O aceite é
 *    **100%** nas 60 respostas: nenhuma frase numérica sem citação válida depois do reparo (`verificacao.sem_citacao`
 *    vazio em todas). Também se registra quantas respostas precisaram do reparo e o que a 1ª versão tinha de errado.
 *  - **Só informativo**: citação que aponta para a página do gabarito (a mesma conta de `pagina_citada` do Python), acerto
 *    numérico (0,5%) nas perguntas de gabarito `valor`, números sem lastro nas evidências citadas, formato fora do pt-BR
 *    que sobrou, respostas cortadas, recusas (F01–F05) que dizem que não consta, e o tempo (primeiro token do redator e
 *    pergunta inteira).
 *  - Erro de infraestrutura: como na F7.11 (`cli-agente.ts`).
 *
 * A régua mede se há citação, não se a citação sustenta a frase: "citada" não é "correta". O lastro numérico e o acerto
 * numérico olham isso por outro lado, sem substituir a leitura das respostas (que ficam em `data/avaliacao/`).
 *
 * Grava `eval/resultados/<nome>.json` (ids, contagens e tempos; sem texto do documento nem da resposta, ADR-009) e as saídas
 * completas em `data/avaliacao/<nome>-detalhes.json`, fora do repositório.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { executarCiclo, type ResultadoCiclo } from "../agente/ciclo.ts";
import { acertoNumerico } from "../agente/numeros.ts";
import { MAX_EVIDENCIAS, redigir, verificar, type RespostaRedator } from "../agente/redator.ts";
import { GrafoNeo4j, criarExecutor } from "../ferramentas/index.ts";
import { ClienteLlm } from "../llm/index.ts";
import { lerCsv, paginasDoGabarito, paginasDoRotulo } from "./busca.ts";

const RAIZ = new URL("../../../", import.meta.url);
const INFRA = /^(falha na ferramenta|llm_nao_configurado|ferramenta_desconhecida|ferramenta_nao_portada|grafo_sem_cypher_livre|falha_na_selecao|falha_no_esquema)/;
const DIZ_QUE_NAO_CONSTA = /(n[ãa]o consta|fora d[oe]|n[ãa]o (traz|encontr|trata|h[áa]|tenho|posso)|n[ãa]o (est[áa]|faz parte))/i;

const { values } = parseArgs({
  options: {
    nome: { type: "string" },
    swap: { type: "string", default: process.env["LLAMA_SWAP_URL"] ?? "http://127.0.0.1:8080" },
    ajuste: { type: "boolean", default: false },
    golden: { type: "string", default: "eval/golden.csv", description: "CSV de perguntas (F7.12: eval/golden_novas.csv, o grupo novo)" },
    limite: { type: "string" },
    somente: { type: "string", description: "ids separados por vírgula" },
    reavaliar: { type: "string", description: "nome de uma medida anterior: refaz só a verificação sobre os textos gravados" },
  },
});
const nome = values.nome ?? (values.ajuste ? "f75-redator-ajuste" : "f75-redator");

interface Caso {
  id: string;
  pergunta: string;
  esperado: string;
  paginas: string;
  tipo_gabarito: string;
  valor: string;
  unidade: string;
}
const casos: Caso[] = values.ajuste
  ? (JSON.parse(readFileSync(new URL("eval/critico_ajuste.json", RAIZ), "utf-8")) as { casos: { id: string; pergunta: string; esperado: string }[] }).casos.map((c) => ({ ...c, paginas: "", tipo_gabarito: "", valor: "", unidade: "" }))
  : lerCsv(readFileSync(new URL(values.golden as string, RAIZ), "utf-8")).map((c) => ({
      id: c["id"] as string,
      pergunta: c["pergunta"] as string,
      esperado: c["tipo_gabarito"] === "recusa" ? "ausente" : "respondivel",
      paginas: c["paginas"] ?? "",
      tipo_gabarito: c["tipo_gabarito"] as string,
      valor: c["valor"] ?? "",
      unidade: c["unidade"] ?? "",
    }));
const selecionados = casos.filter((c) => !values.somente || values.somente.split(",").includes(c.id)).slice(0, values.limite ? Number(values.limite) : undefined);

// --reavaliar <nome>: refaz só a verificação sobre os textos finais já gravados em data/avaliacao/<nome>-detalhes.json, com a
// régua de hoje, sem Neo4j nem LLM. Existe porque a régua teve defeitos achados na 1ª medida (ver o ADR-061).
if (values.reavaliar) {
  const detalhesAntigos = JSON.parse(readFileSync(new URL(`data/avaliacao/${values.reavaliar}-detalhes.json`, RAIZ), "utf-8")) as Record<string, { resposta: RespostaRedator | null }>;
  let afirmacoes = 0;
  let semCitacao = 0;
  let ausencias = 0;
  const achados: Record<string, { sem_citacao: number; declaracoes_de_ausencia: number }> = {};
  for (const c of casos) {
    const r = detalhesAntigos[c.id]?.resposta;
    if (!r) continue;
    // só importa quais E# existem; o texto da evidência não entra na contagem de citações
    const refs = new Map(Array.from({ length: MAX_EVIDENCIAS }, (_, i) => [`E${i + 1}`, { id: "", tipo: "", paginas: "", texto: "" }] as const));
    const v = verificar(r.texto, refs, [], c.pergunta);
    afirmacoes += v.afirmacoes_numericas;
    semCitacao += v.sem_citacao.length;
    ausencias += v.declaracoes_de_ausencia;
    if (v.sem_citacao.length > 0 || v.declaracoes_de_ausencia > 0) achados[c.id] = { sem_citacao: v.sem_citacao.length, declaracoes_de_ausencia: v.declaracoes_de_ausencia };
  }
  const saida = {
    nome: `${values.reavaliar}-reavaliado`,
    data: new Date().toISOString().slice(0, 10),
    comando: `npm run avaliar:redator -- --reavaliar ${values.reavaliar}`,
    observacao: "pós-hoc: os mesmos textos finais da medida original, verificados com a régua corrigida (sigla 'Val.' e frase de ausência que repete número conhecido); a pergunta usada é a do golden, não a reescrita pelo atualizador",
    conjunto: values.ajuste ? "ajuste" : "golden",
    respostas: casos.filter((c) => detalhesAntigos[c.id]?.resposta).length,
    afirmacoes_numericas: afirmacoes,
    sem_citacao: semCitacao,
    declaracoes_de_ausencia: ausencias,
    percentual: afirmacoes === 0 ? null : Math.round(((afirmacoes - semCitacao) / afirmacoes) * 10_000) / 100,
    achados,
  };
  writeFileSync(new URL(`eval/resultados/${saida.nome}.json`, RAIZ), JSON.stringify(saida, null, 2) + "\n");
  console.log(JSON.stringify(saida, null, 2));
  process.exit(semCitacao === 0 ? 0 : 1);
}

const grafo = GrafoNeo4j.conectar();
const llm =new ClienteLlm({ baseUrl: values.swap as string });
const executor = criarExecutor({ grafo, llm });

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
const soma = (v: number[]) => v.reduce((a, b) => a + b, 0);

interface Linha {
  id: string;
  esperado: string;
  estado: string;
  modo: string;
  excecao: string | null;
  erros_de_infra: string[];
  afirmacoes_numericas: number;
  sem_citacao: number;
  citacoes_invalidas: number;
  formato_nao_ptbr: number;
  numeros_sem_lastro: number;
  declaracoes_de_ausencia: number;
  reparos: number;
  antes_do_reparo: RespostaRedator["antes_do_reparo"];
  cortada: boolean;
  fallback: string | null;
  citacoes: number;
  pagina_citada: boolean | null;
  acerto_numerico: boolean | null;
  diz_que_nao_consta: boolean;
  caracteres: number;
  ms: { ciclo: number; redator: number; primeiro_token_do_redator: number | null; total: number };
}
const linhas: Linha[] = [];
const detalhes: Record<string, unknown> = {};

for (const c of selecionados) {
  const t0 = performance.now();
  let ciclo: ResultadoCiclo | null = null;
  let resp: RespostaRedator | null = null;
  let excecao: string | null = null;
  try {
    ciclo = await executarCiclo(llm, executor, c.pergunta);
    const tR = performance.now();
    resp = await redigir(llm, {
      pergunta: ciclo.autonoma,
      estado: ciclo.estado,
      faltando: ciclo.faltando,
      evidencias: ciclo.evidencias,
    });
    (resp as { _tR?: number })._tR = tR;
  } catch (e) {
    excecao = e instanceof Error ? `${e.constructor.name}: ${e.message}` : String(e);
  }
  const execucoes = ciclo?.rodadas.flatMap((x) => x.agente.subperguntas.flatMap((s) => s.execucoes)) ?? [];
  const infra = [
    ...execucoes.filter((e) => e.erro && INFRA.test(e.erro)).map((e) => `${e.ferramenta}:${e.erro}`),
    ...(ciclo?.anotacoes.filter((a) => a.tipo === "excecao").map((a) => `${a.ferramenta}:excecao`) ?? []),
  ];
  const gold = new Set(paginasDoGabarito(c.paginas));
  const citadas = new Set((resp?.citacoes ?? []).flatMap((x) => [...paginasDoRotulo(x.paginas)]));
  const valor = c.tipo_gabarito === "valor" && c.valor !== "" ? Number(c.valor) : null;
  const total = Math.round(performance.now() - t0);
  const l: Linha = {
    id: c.id,
    esperado: c.esperado,
    estado: ciclo?.estado ?? "falhou",
    modo: resp?.modo ?? "falhou",
    excecao,
    erros_de_infra: infra,
    afirmacoes_numericas: resp?.verificacao.afirmacoes_numericas ?? 0,
    sem_citacao: resp?.verificacao.sem_citacao.length ?? 0,
    citacoes_invalidas: resp?.verificacao.citacoes_invalidas.length ?? 0,
    formato_nao_ptbr: resp?.verificacao.formato_nao_ptbr.length ?? 0,
    numeros_sem_lastro: resp?.verificacao.numeros_sem_lastro.length ?? 0,
    declaracoes_de_ausencia: resp?.verificacao.declaracoes_de_ausencia ?? 0,
    reparos: resp?.reparos ?? 0,
    antes_do_reparo: resp?.antes_do_reparo ?? null,
    cortada: resp?.cortada ?? false,
    fallback: resp?.fallback ?? null,
    citacoes: resp?.citacoes.length ?? 0,
    pagina_citada: gold.size > 0 && c.tipo_gabarito !== "recusa" ? [...gold].some((p) => citadas.has(p)) : null,
    acerto_numerico: valor !== null && !Number.isNaN(valor) && resp ? acertoNumerico({ valor, unidade: c.unidade }, resp.texto) : null,
    diz_que_nao_consta: resp ? DIZ_QUE_NAO_CONSTA.test(resp.texto) : false,
    caracteres: resp?.texto.length ?? 0,
    ms: {
      ciclo: Math.round(ciclo?.etapas_ms.total ?? 0),
      redator: Math.round(resp?.ms.total ?? 0),
      primeiro_token_do_redator: resp?.ms.primeiroToken ?? null,
      total,
    },
  };
  linhas.push(l);
  detalhes[c.id] = { ciclo: ciclo && { estado: ciclo.estado, faltando: ciclo.faltando, rodadas: ciclo.rodadas.length }, resposta: resp, excecao };
  console.log(
    `${c.id.padEnd(4)} ${l.estado.padEnd(12)} ${l.modo.padEnd(12)} num ${String(l.afirmacoes_numericas).padStart(2)} sem cit ${l.sem_citacao}${l.reparos ? " (reparo)" : ""}  ${String(Math.round(total / 100) / 10).padStart(5)} s` +
      `${infra.length ? `  INFRA ${infra.join(",")}` : ""}${excecao ? `  EXCEÇÃO ${excecao}` : ""}`,
  );
}
await grafo.fechar();

const comLlm = linhas.filter((l) => l.modo === "llm" || l.modo === "modelo_fixo");
const totalNum = soma(comLlm.map((l) => l.afirmacoes_numericas));
const semCit = soma(comLlm.map((l) => l.sem_citacao));
const recusas = linhas.filter((l) => l.esperado === "ausente");
const valores = linhas.filter((l) => l.acerto_numerico !== null);
const respondiveis = linhas.filter((l) => l.esperado === "respondivel");
const resumo = {
  nome,
  data: new Date().toISOString().slice(0, 10),
  comando: `npm run avaliar:redator${values.ajuste ? " -- --ajuste" : ""}${values.golden !== "eval/golden.csv" ? ` -- --golden ${values.golden}${values.nome ? ` --nome ${values.nome}` : ""}` : ""}`,
  conjunto: values.ajuste ? "ajuste" : values.golden === "eval/golden.csv" ? "golden" : (values.golden as string),
  perguntas: linhas.length,
  execucao: {
    sem_excecao: linhas.filter((l) => l.excecao === null).length,
    sem_erro_de_infra: linhas.filter((l) => l.excecao === null && l.erros_de_infra.length === 0).length,
    modos: contar(linhas.map((l) => l.modo)),
    estados: contar(linhas.map((l) => l.estado)),
    fallbacks: contar(linhas.flatMap((l) => (l.fallback ? [l.fallback] : []))),
    cortadas: linhas.filter((l) => l.cortada).length,
  },
  citacao: {
    afirmacoes_numericas: totalNum,
    citadas: totalNum - semCit,
    sem_citacao: semCit,
    percentual: totalNum === 0 ? null : Math.round(((totalNum - semCit) / totalNum) * 10_000) / 100,
    respostas_com_frase_sem_citacao: linhas.filter((l) => l.sem_citacao > 0).map((l) => l.id),
    declaracoes_de_ausencia_fora_da_conta: soma(linhas.map((l) => l.declaracoes_de_ausencia)),
    respostas_com_numero: linhas.filter((l) => l.afirmacoes_numericas > 0).length,
    precisaram_de_reparo: linhas.filter((l) => l.reparos > 0).length,
    antes_do_reparo: {
      sem_citacao: soma(linhas.map((l) => l.antes_do_reparo?.sem_citacao ?? 0)),
      citacoes_invalidas: soma(linhas.map((l) => l.antes_do_reparo?.citacoes_invalidas ?? 0)),
      formato_nao_ptbr: soma(linhas.map((l) => l.antes_do_reparo?.formato_nao_ptbr ?? 0)),
    },
    citacoes_invalidas_que_sobraram: soma(linhas.map((l) => l.citacoes_invalidas)),
    formato_nao_ptbr_que_sobrou: soma(linhas.map((l) => l.formato_nao_ptbr)),
  },
  informativo: {
    pagina_citada: { n: linhas.filter((l) => l.pagina_citada !== null).length, acertos: linhas.filter((l) => l.pagina_citada === true).length },
    acerto_numerico: { n: valores.length, acertos: valores.filter((l) => l.acerto_numerico).length, erros: valores.filter((l) => !l.acerto_numerico).map((l) => l.id) },
    numeros_sem_lastro: { total: soma(linhas.map((l) => l.numeros_sem_lastro)), respostas: linhas.filter((l) => l.numeros_sem_lastro > 0).map((l) => l.id) },
    recusas: { n: recusas.length, dizem_que_nao_consta: recusas.filter((l) => l.diz_que_nao_consta).length, ids_que_nao_dizem: recusas.filter((l) => !l.diz_que_nao_consta).map((l) => l.id), sem_numero: recusas.filter((l) => l.afirmacoes_numericas === 0).length },
    respondiveis_que_dizem_que_nao_consta: respondiveis.filter((l) => l.diz_que_nao_consta).map((l) => l.id),
  },
  tempo_s: {
    primeiro_token_do_redator: { p50: mediana(linhas.flatMap((l) => (l.ms.primeiro_token_do_redator === null ? [] : [l.ms.primeiro_token_do_redator / 1000]))), max: Math.max(0, ...linhas.map((l) => (l.ms.primeiro_token_do_redator ?? 0) / 1000)) },
    redator: { p50: mediana(linhas.map((l) => l.ms.redator / 1000)), p95: percentil(linhas.map((l) => l.ms.redator / 1000), 0.95), max: Math.max(0, ...linhas.map((l) => l.ms.redator / 1000)) },
    pergunta_inteira: { p50: mediana(linhas.map((l) => l.ms.total / 1000)), p95: percentil(linhas.map((l) => l.ms.total / 1000), 0.95), max: Math.max(0, ...linhas.map((l) => l.ms.total / 1000)) },
  },
  itens: linhas,
};
mkdirSync(new URL("eval/resultados/", RAIZ), { recursive: true });
mkdirSync(new URL("data/avaliacao/", RAIZ), { recursive: true });
writeFileSync(new URL(`eval/resultados/${nome}.json`, RAIZ), JSON.stringify(resumo, null, 2) + "\n");
writeFileSync(new URL(`data/avaliacao/${nome}-detalhes.json`, RAIZ), JSON.stringify(detalhes, null, 2) + "\n");
console.log("\n" + JSON.stringify({ ...resumo, itens: undefined }, null, 2));
process.exitCode = resumo.execucao.sem_erro_de_infra === linhas.length && semCit === 0 ? 0 : 1;
