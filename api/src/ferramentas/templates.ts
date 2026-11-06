/**
 * Templates Cypher (F7.8, ARQUITETURA §7.2): `fato_financeiro`, `serie_metrica`, `comparar_segmentos`, `riscos`,
 * `eventos` e `pessoas_cargos`. É o porte de `indexer.templates_cypher` (F6.3, ADR-048): cada ferramenta resolve o
 * texto do roteador ("lucro líquido", "4T25", "diretora presidente") para o que o grafo guarda e roda uma consulta
 * **fixa**, somente leitura e com `LIMIT`; o texto do usuário só entra como parâmetro. O resultado tem as mesmas
 * chaves do Python (a paridade compara JSON com JSON): `evidencias[]` com `id`, `tipo`, `paginas`, `caminho`,
 * `texto` e `score`, mais os campos de cada ferramenta, `aviso`, `erro` e `sugestoes`.
 *
 * Nada é inventado: sem resultado, a lista vem vazia e o `aviso` diz por quê; falha do grafo vira `erro`.
 */
import type { Metrica } from "./catalogo.ts";
import { lerCatalogo } from "./catalogo.ts";
import { envelope, evidencia, falhar, fechar, mensagemDe, type Envelope, type Evidencia } from "./contrato.ts";
import type { GrafoLeitura } from "./grafo.ts";
import {
  consolidarFatos,
  normalizarPeriodo,
  resolverEntidade,
  resolverMetrica,
  type FatoConsolidado,
  type LinhaFato,
} from "./resolucao.ts";
import { arredondar, casaTexto, compararChaves, contidoEm, normalizar, raiz, raizes, tokens } from "./texto.ts";

export const QUALIFICADORES = ["nenhum", "variacao_percentual", "variacao_absoluta", "percentual_do_total"] as const;
export const TIPOS_DE_PERIODO = ["fiscal_year", "quarter", "point_in_time"] as const;
export const CATEGORIAS_DE_RISCO = ["market", "credit", "operational", "regulatory", "liquidity", "currency", "sem_categoria"] as const;
/** A unidade que um fato deve ter, conforme o tipo da métrica (ADR-037). */
export const UNIDADE_DO_TIPO: Record<string, string> = {
  monetary: "currency",
  price: "currency",
  percent: "percent",
  ratio: "percent",
  count: "count",
};
const LIMITE_FATOS = 500; // linhas lidas do grafo por consulta de fatos
const TETO_DE_NOS = 1000; // linhas lidas por consulta de riscos, eventos e pessoas (o grafo tem ~350, ~240 e ~170)
export const LIMITES_PADRAO = { fatos: 10, pontos: 40, segmentos: 15, riscos: 10, eventos: 10, pessoas: 10 } as const;

export const CONSULTAS = {
  emissor: "MATCH (d:Document) RETURN d.issuer AS emissor, d.fiscalYear AS ano_base LIMIT 1",
  entidades_dos_fatos:
    "MATCH (f:FinancialFact) WHERE f.entity IS NOT NULL " +
    "RETURN f.entity AS entidade, count(*) AS n ORDER BY n DESC LIMIT 1000",
  fatos:
    "MATCH (f:FinancialFact)-[r:OF_METRIC]->(m:Metric {id: $metrica}) " +
    "MATCH (f)-[:FOR_PERIOD]->(p:Period) " +
    "WHERE f.entity IN $entidades AND r.qualifier = $qualificador AND f.unit = $unidade " +
    "AND ($periodos IS NULL OR p.id IN $periodos) " +
    "AND ($tipo_periodo IS NULL OR f.periodType = $tipo_periodo) " +
    "AND (($modo = 'total' AND r.dimension IS NULL) OR ($modo = 'recortes' AND r.dimension IS NOT NULL)) " +
    "RETURN f.id AS id, f.value AS valor, f.unit AS unidade, f.currency AS moeda, f.scale AS escala, " +
    "p.id AS periodo, p.end AS fim, f.periodType AS tipo_periodo, f.entity AS entidade, " +
    "r.qualifier AS qualificador, r.dimension AS dimensao, f.metric AS rotulo, " +
    "f.page AS pagina, f.pageEnd AS pagina_fim " +
    "ORDER BY p.end DESC, f.scale ASC, f.page ASC LIMIT $limite",
  riscos:
    "MATCH (r:RiskFactor) " +
    "WHERE ($categoria IS NULL OR r.category = $categoria) " +
    "AND ($sem_categoria = false OR r.category IS NULL) " +
    "OPTIONAL MATCH (r)-[:DESCRIBED_IN]->(p:Parent) " +
    "WITH r, collect(DISTINCT p.pageStart) AS ini, collect(DISTINCT p.pageEnd) AS fim " +
    "RETURN r.id AS id, r.name AS nome, r.category AS categoria, r.summary AS resumo, " +
    "r.aliasesText AS apelidos, r.layers AS camadas, ini, fim ORDER BY nome LIMIT $teto",
  eventos:
    "MATCH (e:Event) " +
    "OPTIONAL MATCH (e)-[:DESCRIBED_IN|MENTIONED_IN]->(p:Parent) " +
    "OPTIONAL MATCH (e)-[:INVOLVES]->(o) " +
    "WITH e, collect(DISTINCT p.pageStart) AS paginas, collect(DISTINCT o.name) AS envolvidos " +
    "RETURN e.id AS id, e.name AS nome, e.date AS data, e.eventType AS tipo, e.summary AS resumo, " +
    "paginas, envolvidos ORDER BY nome LIMIT $teto",
  pessoas:
    "MATCH (p:Person) " +
    "OPTIONAL MATCH (p)-[h:HOLDS_POSITION]->(o) " +
    "OPTIONAL MATCH (p)-[:MENTIONED_IN]->(x:Parent) " +
    "WITH p, h, o, collect(DISTINCT x.pageStart) AS paginas " +
    "RETURN p.id AS id, p.name AS nome, p.position AS cargo_no_no, h.title AS cargo, " +
    "o.name AS orgao, p.summary AS resumo, paginas ORDER BY nome LIMIT $teto",
} as const;
type NomeConsulta = keyof typeof CONSULTAS;

const PALAVRAS_DE_CARGO: ReadonlySet<string> = new Set([
  "diretor", "diretore", "presidente", "vice", "gerente", "chefe", "membro", "conselheiro", "secretario",
  "representante", "coordenador", "superintendente", "ouvidor", "auditor", "diretoria", "conselho", "comite", "assessor",
]);

// ---------- tipos dos resultados ----------

export interface FatoPublico {
  id: string;
  ids_equivalentes: string[];
  valor: number;
  unidade: string;
  moeda: string | null;
  escala: number;
  valor_absoluto: number;
  texto_valor: string;
  periodo: string;
  tipo_periodo: string;
  entidade: string;
  qualificador: string | null;
  dimensao: string | null;
  rotulo: string | null;
  paginas: number[];
  conflito: boolean;
}

export interface Alternativa {
  valor: number;
  texto_valor: string;
  paginas: number[];
}

export interface ResultadoFato extends Envelope {
  fatos: FatoPublico[];
  periodo_assumido: boolean;
  conflito: boolean;
}
export interface PontoSerie extends FatoPublico {
  fim: string | null;
  alternativas: Alternativa[];
  variacao_pct: number | null;
}
export interface ResultadoSerie extends Envelope {
  pontos: PontoSerie[];
  periodos_ausentes: string[];
}
export interface Segmento extends FatoPublico {
  segmento: string | null;
  alternativas: Alternativa[];
}
export interface ResultadoSegmentos extends Envelope {
  segmentos: Segmento[];
  nao_encontrados: string[];
  periodo: string | null;
  periodo_assumido: boolean;
}
export interface ResultadoRiscos extends Envelope {
  riscos: Record<string, unknown>[];
}
export interface ResultadoEventos extends Envelope {
  eventos: Record<string, unknown>[];
}
export interface Pessoa {
  id: string;
  nome: string | null;
  cargo: string | null;
  orgao: string | null;
  paginas: number[];
  nome_parece_cargo: boolean;
  fonte: "cargo" | "resumo";
  resumo: string | null;
}
export interface ResultadoPessoas extends Envelope {
  pessoas: Pessoa[];
}

// ---------- infraestrutura comum ----------

type Linha = Record<string, unknown>;
const texto = (v: unknown): string | null => (typeof v === "string" ? v : null);
const numeros = (v: unknown): number[] => (Array.isArray(v) ? v.filter((p): p is number => typeof p === "number") : []);

function rodar(grafo: GrafoLeitura, nome: NomeConsulta, parametros: Record<string, unknown> = {}): Promise<Linha[]> {
  return grafo.consultar(CONSULTAS[nome], parametros);
}

interface Contexto {
  metrica: Metrica;
  periodos: string[] | null;
  entidade: string;
  anoBase: number | null;
}

async function contextoDeFatos(
  grafo: GrafoLeitura,
  saida: Envelope,
  t0: number,
  p: { metrica: string; entidade?: string | null; periodo?: string | null; qualificador: string; catalogo?: readonly Metrica[] | undefined },
): Promise<{ ctx: Contexto } | { falha: Envelope }> {
  if (!(QUALIFICADORES as readonly string[]).includes(p.qualificador)) {
    return { falha: falhar(saida, t0, "qualificador_invalido", { sugestoes: [...QUALIFICADORES] }) };
  }
  const [m, sugestoes] = resolverMetrica(p.metrica, p.catalogo ?? lerCatalogo());
  if (m === null) return { falha: falhar(saida, t0, "metrica_desconhecida", { sugestoes }) };
  let periodos: string[] | null = null;
  if (p.periodo) {
    try {
      periodos = [normalizarPeriodo(p.periodo)];
    } catch (e) {
      return { falha: falhar(saida, t0, "periodo_invalido", { aviso: mensagemDe(e) }) };
    }
  }
  const doc = await rodar(grafo, "emissor");
  const primeiro = doc[0];
  if (!primeiro) return { falha: falhar(saida, t0, "grafo_sem_documento") };
  const emissor = texto(primeiro["emissor"]);
  const anoBase = typeof primeiro["ano_base"] === "number" ? primeiro["ano_base"] : null;
  const conhecidas = (await rodar(grafo, "entidades_dos_fatos")).map((r) => String(r["entidade"]));
  const [nome, sugEntidade] = resolverEntidade(p.entidade, conhecidas, emissor);
  if (nome === null) return { falha: falhar(saida, t0, "entidade_desconhecida", { sugestoes: sugEntidade }) };
  Object.assign(saida.parametros, { metrica: m.name, metrica_id: m.id, entidade: nome, qualificador: p.qualificador });
  saida.parametros["periodo"] = periodos ? periodos[0] : null;
  return { ctx: { metrica: m, periodos, entidade: nome, anoBase } };
}

async function lerFatos(
  grafo: GrafoLeitura,
  ctx: Contexto,
  qualificador: string,
  modo: "total" | "recortes",
  tipoPeriodo: string | null,
): Promise<LinhaFato[]> {
  const linhas = (await rodar(grafo, "fatos", {
    metrica: `metric:${ctx.metrica.id}`,
    entidades: [ctx.entidade],
    qualificador,
    unidade: UNIDADE_DO_TIPO[ctx.metrica.kind],
    periodos: ctx.periodos,
    tipo_periodo: tipoPeriodo,
    modo,
    limite: LIMITE_FATOS,
  })) as unknown as LinhaFato[];
  return ctx.periodos ? linhas.filter((r) => (ctx.periodos as string[]).includes(r.periodo)) : linhas; // o contrato vale mesmo que o grafo devolva mais
}

const ateOAnoBase = (linhas: LinhaFato[], anoBase: number | null) =>
  anoBase === null ? linhas : linhas.filter((r) => (r.fim ?? "") <= `${anoBase}-12-31`);

/** Só o período mais recente (por data de fim) das linhas. */
function maisRecente(linhas: LinhaFato[]): LinhaFato[] {
  const recente = linhas.reduce((m, r) => ((r.fim ?? "") > m ? (r.fim ?? "") : m), "");
  return linhas.filter((r) => (r.fim ?? "") === recente);
}

function evidenciaDeFato(f: FatoPublico, ferramenta: string): Evidencia {
  const recorte = f.dimensao ? ` · ${f.dimensao}` : "";
  const aviso = f.conflito ? " [valores divergentes no documento]" : "";
  return evidencia(
    f.id,
    "fato",
    f.paginas,
    `${ferramenta}: ${f.rotulo || ""}${recorte}`,
    `${f.rotulo || "Valor"}: ${f.texto_valor} (${f.periodo}${recorte}; ${f.entidade})${aviso}`,
  );
}

function publico(f: FatoConsolidado): FatoPublico {
  return {
    id: f.id,
    ids_equivalentes: f.ids_equivalentes,
    valor: f.valor,
    unidade: f.unidade,
    moeda: f.moeda ?? null,
    escala: f.escala,
    valor_absoluto: f.valor_absoluto,
    texto_valor: f.texto_valor,
    periodo: f.periodo,
    tipo_periodo: f.tipo_periodo,
    entidade: f.entidade,
    qualificador: f.qualificador ?? null,
    dimensao: f.dimensao ?? null,
    rotulo: f.rotulo ?? null,
    paginas: f.paginas,
    conflito: f.conflito,
  };
}

const alternativas = (itens: readonly FatoConsolidado[]): Alternativa[] =>
  itens.map((o) => ({ valor: o.valor, texto_valor: o.texto_valor, paginas: o.paginas }));

// ---------- fato_financeiro ----------

export interface ParametrosFato {
  metrica: string;
  entidade?: string | null;
  periodo?: string | null;
  qualificador?: string;
  dimensao?: string | null;
  catalogo?: readonly Metrica[];
  limite?: number;
}

/**
 * O valor de uma métrica para uma entidade e um período. Sem `entidade`, o emissor; sem `periodo`, o mais recente
 * até o ano-base; sem `dimensao`, o total.
 */
export async function fatoFinanceiro(grafo: GrafoLeitura, p: ParametrosFato): Promise<ResultadoFato> {
  const t0 = performance.now();
  const qualificador = p.qualificador ?? "nenhum";
  const dimensao = p.dimensao ?? null;
  const limite = p.limite ?? LIMITES_PADRAO.fatos;
  const saida: ResultadoFato = { ...envelope("fato_financeiro", { dimensao }), fatos: [], periodo_assumido: false, conflito: false };
  let fatos: FatoConsolidado[];
  try {
    const r = await contextoDeFatos(grafo, saida, t0, { ...p, qualificador });
    if ("falha" in r) return r.falha as ResultadoFato;
    let linhas = await lerFatos(grafo, r.ctx, qualificador, dimensao ? "recortes" : "total", null);
    if (dimensao) linhas = linhas.filter((l) => casaTexto(dimensao, l.dimensao));
    if (!r.ctx.periodos) {
      linhas = ateOAnoBase(linhas, r.ctx.anoBase);
      const primeira = linhas[0];
      if (primeira) {
        linhas = maisRecente(linhas);
        saida.periodo_assumido = true;
        saida.parametros["periodo"] = (linhas[0] as LinhaFato).periodo;
      }
    }
    fatos = consolidarFatos(linhas);
  } catch (e) {
    return falhar(saida, t0, `falha no grafo: ${mensagemDe(e)}`);
  }
  if (fatos.length === 0) {
    saida.aviso =
      "Nenhum fato encontrado para esta métrica" +
      (dimensao ? ` com o recorte '${dimensao}'` : " sem recorte (total)") +
      ". Se ela só aparece por recorte, use comparar_segmentos ou informe `dimensao`.";
    return fechar(saida, t0);
  }
  const omitido = Math.max(0, fatos.length - limite);
  fatos = fatos.slice(0, limite);
  saida.fatos = fatos.map(publico);
  saida.evidencias = saida.fatos.map((f) => evidenciaDeFato(f, "fato_financeiro"));
  saida.conflito = saida.fatos.some((f) => f.conflito);
  saida.omitido = { fatos: omitido };
  if (saida.conflito) saida.aviso = "O documento traz valores diferentes para este fato; confira as páginas de cada um.";
  return fechar(saida, t0);
}

// ---------- serie_metrica ----------

type TipoPeriodo = "fiscal_year" | "quarter";
const ordinal = (periodo: string, tipo: string): number | null =>
  tipo === "fiscal_year" ? Number(periodo.slice(0, 4)) : tipo === "quarter" ? Number(periodo.slice(0, 4)) * 4 + Number(periodo.slice(-1)) - 1 : null;
const idDoOrdinal = (n: number, tipo: TipoPeriodo) => (tipo === "fiscal_year" ? `${n}-FY` : `${Math.floor(n / 4)}-Q${(n % 4) + 1}`);

export interface ParametrosSerie {
  metrica: string;
  entidade?: string | null;
  dimensao?: string | null;
  /** Padrão `fiscal_year`; `null` mistura todos os tipos. */
  tipoPeriodo?: string | null;
  qualificador?: string;
  catalogo?: readonly Metrica[];
  limite?: number;
}

/**
 * A métrica ao longo dos períodos, do mais antigo ao mais novo, sem preencher lacunas. `pontos[]` tem um valor por
 * período (o mais sustentado, com `alternativas` quando o documento diverge) e `variacao_pct` só entre períodos
 * vizinhos e sem divergência; `periodos_ausentes` lista os buracos.
 */
export async function serieMetrica(grafo: GrafoLeitura, p: ParametrosSerie): Promise<ResultadoSerie> {
  const t0 = performance.now();
  const qualificador = p.qualificador ?? "nenhum";
  const dimensao = p.dimensao ?? null;
  const tipoPeriodo = p.tipoPeriodo === undefined ? "fiscal_year" : p.tipoPeriodo;
  const limite = p.limite ?? LIMITES_PADRAO.pontos;
  const saida: ResultadoSerie = { ...envelope("serie_metrica", { dimensao, tipo_periodo: tipoPeriodo }), pontos: [], periodos_ausentes: [] };
  if (tipoPeriodo !== null && !(TIPOS_DE_PERIODO as readonly string[]).includes(tipoPeriodo)) {
    return falhar(saida, t0, "tipo_periodo_invalido", { sugestoes: [...TIPOS_DE_PERIODO] });
  }
  let fatos: FatoConsolidado[];
  try {
    const r = await contextoDeFatos(grafo, saida, t0, { ...p, periodo: null, qualificador });
    if ("falha" in r) return r.falha as ResultadoSerie;
    let linhas = await lerFatos(grafo, r.ctx, qualificador, dimensao ? "recortes" : "total", tipoPeriodo);
    if (dimensao) linhas = linhas.filter((l) => casaTexto(dimensao, l.dimensao));
    fatos = consolidarFatos(linhas);
  } catch (e) {
    return falhar(saida, t0, `falha no grafo: ${mensagemDe(e)}`);
  }
  if (fatos.length === 0) {
    saida.aviso = "Nenhum valor encontrado para esta métrica nos períodos do documento.";
    return fechar(saida, t0);
  }
  const porPeriodo = new Map<string, FatoConsolidado[]>();
  for (const f of fatos) porPeriodo.set(f.periodo, [...(porPeriodo.get(f.periodo) ?? []), f]);
  let pontos: PontoSerie[] = [];
  for (const itens of porPeriodo.values()) {
    itens.sort((a, b) => compararChaves([-a.apoio, a.escala, a.paginas[0] ?? 0], [-b.apoio, b.escala, b.paginas[0] ?? 0]));
    const escolhido = itens[0] as FatoConsolidado;
    pontos.push({
      ...publico(escolhido),
      fim: escolhido.fim ?? null,
      alternativas: alternativas(itens.slice(1)),
      variacao_pct: null,
    });
  }
  pontos.sort((a, b) => compararChaves([a.fim ?? "", a.periodo], [b.fim ?? "", b.periodo]));
  for (let i = 1; i < pontos.length; i++) {
    const ant = pontos[i - 1] as PontoSerie;
    const atual = pontos[i] as PontoSerie;
    const oa = ordinal(ant.periodo, ant.tipo_periodo);
    const ob = ordinal(atual.periodo, atual.tipo_periodo);
    if (
      oa !== null && ob !== null && ob - oa === 1 &&
      ant.tipo_periodo === atual.tipo_periodo && ant.unidade === atual.unidade &&
      !ant.conflito && !atual.conflito && ant.valor_absoluto !== 0
    ) {
      atual.variacao_pct = arredondar(((atual.valor_absoluto - ant.valor_absoluto) / Math.abs(ant.valor_absoluto)) * 100, 1);
    }
  }
  const tipos = new Set(pontos.map((x) => x.tipo_periodo));
  const unico = tipos.size === 1 ? ([...tipos][0] as string) : null;
  if (unico === "fiscal_year" || unico === "quarter") {
    const ordinais = pontos.map((x) => ordinal(x.periodo, unico) as number);
    const presentes = new Set(ordinais);
    const ausentes: number[] = [];
    for (let n = Math.min(...ordinais); n <= Math.max(...ordinais); n++) if (!presentes.has(n)) ausentes.push(n);
    saida.periodos_ausentes = ausentes.map((n) => idDoOrdinal(n, unico));
  }
  saida.omitido = { pontos: Math.max(0, pontos.length - limite) };
  pontos = pontos.slice(limite > 0 ? -limite : 0);
  saida.pontos = pontos;
  saida.evidencias = pontos.map((x) => evidenciaDeFato(x, "serie_metrica"));
  const avisos: string[] = [];
  if (saida.periodos_ausentes.length > 0) avisos.push(`Períodos sem valor no documento: ${saida.periodos_ausentes.join(", ")}.`);
  if (pontos.some((x) => x.conflito)) avisos.push("Há períodos com valores divergentes (veja `alternativas`).");
  saida.aviso = avisos.length > 0 ? avisos.join(" ") : null;
  return fechar(saida, t0);
}

// ---------- comparar_segmentos ----------

export interface ParametrosSegmentos {
  metrica: string;
  segmentos?: string[] | null;
  periodo?: string | null;
  entidade?: string | null;
  qualificador?: string;
  catalogo?: readonly Metrica[];
  limite?: number;
}

/**
 * A mesma métrica em vários recortes (`dimension`: Rurais, Pessoas Físicas...) num período, do maior ao menor. Com
 * `segmentos`, só esses (os que não existem vêm em `nao_encontrados`); sem eles, os `limite` maiores.
 */
export async function compararSegmentos(grafo: GrafoLeitura, p: ParametrosSegmentos): Promise<ResultadoSegmentos> {
  const t0 = performance.now();
  const qualificador = p.qualificador ?? "nenhum";
  const segmentos = p.segmentos ?? null;
  const limite = p.limite ?? LIMITES_PADRAO.segmentos;
  const saida: ResultadoSegmentos = {
    ...envelope("comparar_segmentos", { segmentos }),
    segmentos: [],
    nao_encontrados: [],
    periodo: null,
    periodo_assumido: false,
  };
  let fatos: FatoConsolidado[];
  try {
    const r = await contextoDeFatos(grafo, saida, t0, { ...p, qualificador });
    if ("falha" in r) return r.falha as ResultadoSegmentos;
    let linhas = await lerFatos(grafo, r.ctx, qualificador, "recortes", null);
    if (!r.ctx.periodos) {
      linhas = ateOAnoBase(linhas, r.ctx.anoBase);
      if (linhas.length > 0) {
        linhas = maisRecente(linhas);
        saida.periodo_assumido = true;
      }
    }
    fatos = consolidarFatos(linhas);
  } catch (e) {
    return falhar(saida, t0, `falha no grafo: ${mensagemDe(e)}`);
  }
  const primeiro = fatos[0];
  if (primeiro) saida.periodo = primeiro.periodo;
  const porRecorte = new Map<string, FatoConsolidado[]>();
  for (const f of fatos) porRecorte.set(normalizar(f.dimensao), [...(porRecorte.get(normalizar(f.dimensao)) ?? []), f]);
  let linhasSeg: Segmento[] = [];
  for (const itens of porRecorte.values()) {
    itens.sort((a, b) => compararChaves([-a.apoio, a.escala], [-b.apoio, b.escala]));
    const melhor = itens[0] as FatoConsolidado;
    linhasSeg.push({ segmento: melhor.dimensao ?? null, ...publico(melhor), alternativas: alternativas(itens.slice(1)) });
  }
  if (segmentos && segmentos.length > 0) {
    const escolhidos: Segmento[] = [];
    for (const pedido of segmentos) {
      const exatos = linhasSeg.filter((s) => normalizar(s.segmento) === normalizar(pedido));
      const contidos = linhasSeg.filter((s) => casaTexto(pedido, s.segmento)).sort((a, b) => (a.segmento ?? "").length - (b.segmento ?? "").length);
      const achado = exatos.length > 0 ? exatos : contidos.slice(0, 1);
      const a = achado[0];
      if (a && !escolhidos.includes(a)) escolhidos.push(a);
      else if (!a) saida.nao_encontrados.push(pedido);
    }
    linhasSeg = escolhidos;
  }
  linhasSeg.sort((a, b) => compararChaves([-a.valor_absoluto, a.segmento ?? ""], [-b.valor_absoluto, b.segmento ?? ""]));
  if (!segmentos || segmentos.length === 0) {
    saida.omitido = { segmentos: Math.max(0, linhasSeg.length - limite) };
    linhasSeg = linhasSeg.slice(0, limite);
  }
  saida.segmentos = linhasSeg;
  saida.evidencias = linhasSeg.map((s) => evidenciaDeFato(s, "comparar_segmentos"));
  const avisos: string[] = [];
  if (linhasSeg.length === 0) avisos.push("Nenhum recorte encontrado para esta métrica no período.");
  if (saida.nao_encontrados.length > 0) avisos.push(`Segmentos sem valor no documento: ${saida.nao_encontrados.join(", ")}.`);
  if (linhasSeg.some((s) => s.conflito)) avisos.push("Há recortes com valores divergentes (veja `alternativas`).");
  saida.aviso = avisos.length > 0 ? avisos.join(" ") : null;
  return fechar(saida, t0);
}

// ---------- busca por tema nos nós (riscos, eventos, pessoas) ----------

/** Pontos do tema nos campos (peso por campo); `null` quando menos da metade das palavras aparece. */
function pontuar(tema: string | null | undefined, campos: [string | null | undefined, number][]): number | null {
  const pedidas = raizes(tema);
  if (pedidas.size === 0) return 0;
  let pontos = 0;
  const achadas = new Set<string>();
  for (const [t, peso] of campos) {
    const doCampo = raizes(t);
    const presentes = [...pedidas].filter((x) => doCampo.has(x));
    pontos += peso * presentes.length;
    for (const x of presentes) achadas.add(x);
  }
  return achadas.size >= Math.ceil(pedidas.size / 2) ? pontos : null;
}

export interface ParametrosRiscos {
  tema?: string | null;
  categoria?: string | null;
  limite?: number;
}

/**
 * Fatores de risco por categoria e/ou tema, com as páginas onde o documento os descreve. Sem tema, vêm primeiro os
 * da extração dirigida e os que têm página. Sem resultado, lista vazia e aviso.
 */
export async function riscos(grafo: GrafoLeitura, p: ParametrosRiscos): Promise<ResultadoRiscos> {
  const t0 = performance.now();
  const tema = p.tema ?? null;
  const categoria = p.categoria ?? null;
  const limite = p.limite ?? LIMITES_PADRAO.riscos;
  const saida: ResultadoRiscos = { ...envelope("riscos", { tema, categoria }), riscos: [] };
  if (categoria !== null && !(CATEGORIAS_DE_RISCO as readonly string[]).includes(categoria)) {
    return falhar(saida, t0, "categoria_invalida", { sugestoes: [...CATEGORIAS_DE_RISCO] });
  }
  let linhas: Linha[];
  try {
    linhas = await rodar(grafo, "riscos", {
      categoria: categoria === "sem_categoria" ? null : categoria,
      sem_categoria: categoria === "sem_categoria",
      teto: TETO_DE_NOS,
    });
  } catch (e) {
    return falhar(saida, t0, `falha no grafo: ${mensagemDe(e)}`);
  }
  const candidatos: { r: Linha; paginas: number[]; ordem: (string | number)[] }[] = [];
  for (const r of linhas) {
    const paginas = [...new Set([...numeros(r["ini"]), ...numeros(r["fim"])])].sort((a, b) => a - b);
    const nome = texto(r["nome"]) ?? "";
    let ordem: (string | number)[];
    if (tema) {
      const pontos = pontuar(tema, [[nome, 3], [texto(r["apelidos"]), 2], [texto(r["resumo"]), 1]]);
      if (pontos === null) continue;
      ordem = [-pontos, nome];
    } else {
      const camadas = Array.isArray(r["camadas"]) ? r["camadas"] : [];
      ordem = [camadas.includes("dirigida") ? 0 : 1, paginas.length > 0 ? 0 : 1, nome];
    }
    candidatos.push({ r: { ...r, paginas }, paginas, ordem });
  }
  candidatos.sort((a, b) => compararChaves(a.ordem, b.ordem));
  saida.omitido = { riscos: Math.max(0, candidatos.length - limite) };
  const escolhidos = candidatos.slice(0, limite);
  saida.evidencias = escolhidos.map(({ r, paginas }) => {
    const cat = texto(r["categoria"]) || "sem categoria";
    return evidencia(
      String(r["id"]),
      "risco",
      paginas,
      `Risco (${cat})`,
      `${String(r["nome"])} [${cat}]: ${texto(r["resumo"]) ?? ""}`.trim(),
    );
  });
  saida.riscos = escolhidos.map(({ r }) => r);
  if (escolhidos.length === 0) saida.aviso = `Nenhum fator de risco encontrado${tema ? ` para o tema '${tema}'.` : "."}`;
  return fechar(saida, t0);
}

export interface ParametrosEventos {
  tema?: string | null;
  ano?: number | null;
  limite?: number;
}

/** Chave de ordenação decrescente para datas ISO em texto (sem data fica para o fim). */
const inverter = (data: string | null): number[] => [...(data ?? "")].map((c) => -(c.codePointAt(0) as number));

/**
 * Eventos do documento por tema e/ou ano da data. Só uns 7% têm data: com `ano`, os sem data ficam de fora e o
 * resultado conta quantos foram (`omitido.sem_data`).
 */
export async function eventos(grafo: GrafoLeitura, p: ParametrosEventos): Promise<ResultadoEventos> {
  const t0 = performance.now();
  const tema = p.tema ?? null;
  const ano = p.ano ?? null;
  const limite = p.limite ?? LIMITES_PADRAO.eventos;
  const saida: ResultadoEventos = { ...envelope("eventos", { tema, ano }), eventos: [] };
  if (ano !== null && !(Number.isFinite(ano) && Math.trunc(ano) >= 1900 && Math.trunc(ano) <= 2100)) return falhar(saida, t0, "ano_invalido");
  let linhas: Linha[];
  try {
    linhas = await rodar(grafo, "eventos", { teto: TETO_DE_NOS });
  } catch (e) {
    return falhar(saida, t0, `falha no grafo: ${mensagemDe(e)}`);
  }
  let semData = 0;
  const candidatos: { e: Linha; pontos: number }[] = [];
  for (const e of linhas) {
    const data = texto(e["data"]);
    if (ano !== null) {
      if (!data) {
        semData += 1;
        continue;
      }
      if (!data.startsWith(String(Math.trunc(ano)))) continue;
    }
    let pontos = 0;
    if (tema) {
      const r = pontuar(tema, [[texto(e["nome"]), 3], [texto(e["resumo"]), 1]]);
      if (r === null) continue;
      pontos = r;
    }
    candidatos.push({ e, pontos });
  }
  // relevância primeiro (só com tema), depois datados do mais recente, depois os sem data por nome
  const chave = ({ e, pontos }: { e: Linha; pontos: number }) => ({ cabeca: [-pontos, texto(e["data"]) ? 0 : 1], data: inverter(texto(e["data"])), nome: texto(e["nome"]) ?? "" });
  candidatos.sort((a, b) => {
    const x = chave(a);
    const y = chave(b);
    return compararChaves(x.cabeca, y.cabeca) || compararChaves(x.data, y.data) || compararChaves([x.nome], [y.nome]);
  });
  saida.omitido = { eventos: Math.max(0, candidatos.length - limite), sem_data: semData };
  const escolhidos = candidatos.slice(0, limite).map(({ e }) => e);
  saida.evidencias = escolhidos.map((e) =>
    evidencia(
      String(e["id"]),
      "evento",
      numeros(e["paginas"]),
      "Evento",
      `${texto(e["data"]) || "s/ data"}: ${String(e["nome"])}${texto(e["resumo"]) ? ` — ${texto(e["resumo"])}` : ""}`,
    ),
  );
  saida.eventos = escolhidos;
  const avisos: string[] = [];
  if (escolhidos.length === 0) {
    avisos.push(`Nenhum evento encontrado${ano ? ` em ${Math.trunc(ano)}` : ""}${tema ? ` para o tema '${tema}'` : ""}.`);
  }
  if (ano !== null && semData > 0) avisos.push(`${semData} evento(s) sem data no documento ficaram de fora do filtro por ano.`);
  saida.aviso = avisos.length > 0 ? avisos.join(" ") : null;
  return fechar(saida, t0);
}

// ---------- pessoas_cargos ----------

/** O nome começa por palavra de cargo ("Diretoria Executiva", "A Presidente do BB"): defeito conhecido da extração. */
function pareceCargo(nome: string | null): boolean {
  const ts = tokens(nome).filter((t) => !["a", "o", "as", "os"].includes(t));
  const primeiro = ts[0];
  return primeiro !== undefined && PALAVRAS_DE_CARGO.has(raiz(primeiro));
}

/** Os títulos de um campo que junta vários ("Diretor Executivo; Vice-presidente de Riscos"). */
const segmentosDe = (t: string | null, separadores = ";"): string[] => (t ?? "").split(new RegExp(separadores)).filter((x) => x.trim() !== "");

export interface ParametrosPessoas {
  cargo?: string | null;
  nome?: string | null;
  orgao?: string | null;
  limite?: number;
}

/**
 * Quem ocupa um cargo, em que órgão, e onde o documento diz. Exige um de `cargo`, `nome` ou `orgao`. A extração
 * gravou alguns cargos como nome de pessoa ("Diretoria Executiva"): `nome_parece_cargo` os marca, e eles vêm depois
 * das pessoas de nome próprio.
 */
export async function pessoasCargos(grafo: GrafoLeitura, p: ParametrosPessoas): Promise<ResultadoPessoas> {
  const t0 = performance.now();
  const { cargo = null, nome = null, orgao = null } = p;
  const limite = p.limite ?? LIMITES_PADRAO.pessoas;
  const saida: ResultadoPessoas = { ...envelope("pessoas_cargos", { cargo, nome, orgao }), pessoas: [] };
  if (![cargo, nome, orgao].some((x) => (x ?? "").trim() !== "")) {
    return falhar(saida, t0, "filtro_obrigatorio", { aviso: "Informe cargo, nome ou órgão." });
  }
  let linhas: Linha[];
  try {
    linhas = await rodar(grafo, "pessoas", { teto: TETO_DE_NOS });
  } catch (e) {
    return falhar(saida, t0, `falha no grafo: ${mensagemDe(e)}`);
  }
  const unidas = new Map<string, Pessoa & { _paginas: Set<number> }>();
  for (const r of linhas) {
    const nomeDoNo = texto(r["nome"]);
    const parece = pareceCargo(nomeDoNo);
    let fonte: "cargo" | "resumo" = "cargo";
    if (cargo) {
      const pedido = raizes(cargo);
      // cada título sozinho tem de conter o cargo (um título por vez)
      const titulos = [...segmentosDe(texto(r["cargo"])), ...segmentosDe(texto(r["cargo_no_no"]))];
      if (!titulos.some((t) => contidoEm(pedido, raizes(t)))) {
        // só o resumo diz o cargo: vale para pessoa de nome próprio, não para nó que é cargo
        if (parece || !segmentosDe(texto(r["resumo"]), "[.;]").some((t) => contidoEm(pedido, raizes(t)))) continue;
        fonte = "resumo";
      }
    }
    if (nome && !contidoEm(raizes(nome), raizes(nomeDoNo))) continue;
    if (orgao && !contidoEm(raizes(orgao), raizes(texto(r["orgao"])))) continue;
    const chave = JSON.stringify(fonte === "cargo" ? [r["id"], texto(r["cargo"]), texto(r["orgao"])] : [r["id"], "resumo"]);
    const paginas = numeros(r["paginas"]);
    const existente = unidas.get(chave);
    if (existente) {
      for (const pg of paginas) existente._paginas.add(pg);
    } else {
      unidas.set(chave, {
        id: String(r["id"]),
        nome: nomeDoNo,
        cargo: fonte === "cargo" ? (texto(r["cargo"]) ?? texto(r["cargo_no_no"])) : null,
        orgao: fonte === "cargo" ? texto(r["orgao"]) : null,
        paginas: [],
        nome_parece_cargo: parece,
        fonte,
        resumo: fonte === "resumo" ? texto(r["resumo"]) : null,
        _paginas: new Set(paginas),
      });
    }
  }
  const ordenadas = [...unidas.values()].sort((a, b) =>
    compararChaves([a.fonte !== "cargo" ? 1 : 0, a.nome_parece_cargo ? 1 : 0, a.nome ?? ""], [b.fonte !== "cargo" ? 1 : 0, b.nome_parece_cargo ? 1 : 0, b.nome ?? ""]),
  );
  saida.omitido = { pessoas: Math.max(0, ordenadas.length - limite) };
  const vistos = new Map<string, number>();
  const pessoas: Pessoa[] = [];
  for (const { _paginas, ...pessoa } of ordenadas.slice(0, limite)) {
    pessoas.push({ ...pessoa, paginas: [..._paginas].sort((a, b) => a - b) });
  }
  saida.evidencias = pessoas.map((pe) => {
    const n = (vistos.get(pe.id) ?? 0) + 1;
    vistos.set(pe.id, n);
    const marca = pe.nome_parece_cargo ? "[nome registrado como cargo] " : "";
    return evidencia(
      n === 1 ? pe.id : `${pe.id}#${n}`,
      "pessoa",
      pe.paginas,
      "Pessoa e cargo",
      `${marca}${pe.nome} — ${pe.fonte === "resumo" ? pe.resumo : pe.cargo || "cargo não informado"}${pe.orgao ? ` (${pe.orgao})` : ""}`,
    );
  });
  saida.pessoas = pessoas;
  if (pessoas.length === 0) saida.aviso = "Nenhuma pessoa encontrada para esses filtros.";
  else if (pessoas.some((pe) => pe.nome_parece_cargo)) saida.aviso = "Alguns nomes são cargos gravados como pessoa pela extração (nome_parece_cargo).";
  return fechar(saida, t0);
}
