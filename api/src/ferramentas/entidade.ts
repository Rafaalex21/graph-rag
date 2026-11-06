/**
 * Ferramenta `entidade` (F7.9): a busca local do GraphRAG (ARQUITETURA §7.2, cap. 7 do livro). Porte de
 * `indexer.busca_local` (F6.1, [ADR-046]): a pergunta vira entidades parecidas (`entity_vec` + `entity_ft`, fundidos
 * por RRF) e, para as primeiras, o resumo, os Pais que as citam, as relações resumidas e os relatórios das
 * comunidades, tudo com teto (entidades, relações, Pais, comunidades e tokens) porque o emissor se liga a milhares
 * de nós. O que o teto corta é contado em `omitido`.
 *
 * Cada evidência traz `id`, `tipo`, `paginas`, `caminho`, `texto` e `score`. Só o Pai tem página do documento;
 * entidade e relação mostram as páginas dos Pais de onde vieram, e o relatório de comunidade, que é síntese, não
 * tem página. O embedding da entidade vai SEM o prefixo `Instruct:` (como no Python).
 */
import { escaparLucene, RRF_K, type LlmDeBusca, type Ranking } from "./busca.ts";
import { envelope, falhar, fechar, mensagemDe, rotuloDePaginas, type Envelope, type Evidencia } from "./contrato.ts";
import type { GrafoLeitura } from "./grafo.ts";
import { arredondar } from "./texto.ts";

export const LIMITES_ENTIDADE = { candidatas: 25, ft: 2, entidades: 6, relacoes: 10, pais: 6, comunidades: 2, tokens: 6000 };
export type LimitesEntidade = typeof LIMITES_ENTIDADE;
const CARACTERES_POR_TOKEN = 3; // o português do documento rende ~3,5; arredondar para baixo erra para o lado seguro
const PAGINAS_POR_ENTIDADE = 5;

export const CONSULTAS_ENTIDADE = {
  entidades_vetor:
    "CALL db.index.vector.queryNodes('entity_vec', $k, $v) YIELD node, score " +
    "RETURN node.id AS id, score ORDER BY score DESC",
  entidades_texto:
    "CALL db.index.fulltext.queryNodes('entity_ft', $q, {limit: $k}) YIELD node, score " +
    "RETURN node.id AS id, score, node.name AS nome, node.aliases AS apelidos ORDER BY score DESC",
  detalhes_entidades:
    "UNWIND $ids AS id MATCH (e:__Entity__ {id: id}) OPTIONAL MATCH (e)-[:MENTIONED_IN]->(p:Parent) " +
    "RETURN e.id AS id, e.name AS nome, e.type AS tipo, e.summary AS resumo, " +
    "collect(DISTINCT p.pageStart) AS pages",
  relacoes:
    "UNWIND $ids AS id MATCH (a:__Entity__ {id: id})-[r:SUMMARIZED_RELATIONSHIP]-(b:__Entity__) " +
    "WITH DISTINCT r, startNode(r) AS x, endNode(r) AS y " +
    "ORDER BY r.weight DESC, r.rank DESC, x.id, y.id LIMIT $k " +
    "OPTIONAL MATCH (x)-[t:RELATED_TO]->(y) " +
    "OPTIONAL MATCH (q:Parent) WHERE q.id IN coalesce(t.parents, []) " +
    "RETURN x.id AS de, y.id AS para, x.name AS de_nome, y.name AS para_nome, r.summary AS resumo, " +
    "r.weight AS peso, r.rank AS rank, collect(DISTINCT q.pageStart) AS pages",
  mencoes: "UNWIND $ids AS id MATCH (e:__Entity__ {id: id})-[:MENTIONED_IN]->(p:Parent) RETURN e.id AS entidade, p.id AS pai",
  similaridade:
    "UNWIND $ids AS id MATCH (p:Parent {id: id})-[:HAS_CHILD]->(c:Child) " +
    "RETURN p.id AS pai, max(vector.similarity.cosine(c.embedding, $v)) AS sim",
  detalhes_pais:
    "UNWIND $ids AS id MATCH (s:Section)-[:HAS_PARENT]->(p:Parent {id: id}) " +
    "RETURN p.id AS id, p.text AS text, p.tokens AS tokens, p.pageStart AS pageStart, " +
    "p.pageEnd AS pageEnd, s.path AS caminho",
  comunidades:
    "UNWIND $ids AS id MATCH (e:__Entity__ {id: id})-[:IN_COMMUNITY]->(c0:__Community__) " +
    "MATCH (c0)-[:PARENT_COMMUNITY*0..]->(c:__Community__) " +
    "RETURN DISTINCT e.id AS entidade, c.id AS id, c.title AS title, c.summary AS summary, " +
    "c.level AS level, c.rank AS rank",
} as const;
type NomeConsulta = keyof typeof CONSULTAS_ENTIDADE;
type Linha = Record<string, unknown>;

// ---------- nome citado na pergunta ----------

const semAcento = (texto: string): string =>
  texto.toLowerCase().normalize("NFD").replace(/\p{Mn}/gu, "").replace(/\s+/g, " ").trim();
const escaparRegex = (t: string) => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** A pergunta cita ao menos um dos nomes (nome e apelidos) como palavra inteira, sem caixa nem acento. */
export function nomeNaPergunta(pergunta: string, nomes: readonly (string | null | undefined)[]): boolean {
  const alvo = semAcento(pergunta);
  for (const nome of nomes) {
    const n = nome ? semAcento(nome) : "";
    if (n && new RegExp(`(?<![\\p{L}\\p{N}_])${escaparRegex(n)}(?![\\p{L}\\p{N}_])`, "u").test(alvo)) return true;
  }
  return false;
}

export interface AcertoTexto {
  id: string;
  score: number;
  nomes: readonly (string | null | undefined)[];
}

/** Do ranking do `entity_ft`, só o que a pergunta cita pelo nome ou apelido. */
export function textoExato(acertos: readonly AcertoTexto[], pergunta: string): Ranking {
  return acertos.filter((a) => nomeNaPergunta(pergunta, a.nomes)).map((a): [string, number] => [a.id, a.score]);
}

/** Entidades do vetor e do nome exato numa lista só (RRF): o que só uma das duas achou também entra. */
export function fundirCandidatas(vetor: Ranking, texto: Ranking, n: number): Ranking {
  const pontos = new Map<string, number>();
  for (const lista of [vetor, texto]) lista.forEach(([i], p) => pontos.set(i, (pontos.get(i) ?? 0) + 1 / (RRF_K + p + 1)));
  return [...pontos.entries()].sort((a, b) => b[1] - a[1]).slice(0, n);
}

// ---------- ranqueamento ----------

const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/** 1 para o maior valor, 2 para o próximo valor distinto… (quem empata no valor empata na posição). */
export function posicoesDensas(valor: ReadonlyMap<string, number>): Map<string, number> {
  const distintos = [...new Set(valor.values())].sort((a, b) => b - a);
  const posicao = new Map(distintos.map((v, n) => [v, n + 1]));
  return new Map([...valor].map(([i, v]) => [i, posicao.get(v) as number]));
}

/** RRF sobre rankings dados como `id → posição`; ids com a mesma posição empatam de verdade. */
function rrfPosicoes(posicoes: readonly ReadonlyMap<string, number>[]): Ranking {
  const pontos = new Map<string, number>();
  for (const ranking of posicoes) for (const [i, p] of ranking) pontos.set(i, (pontos.get(i) ?? 0) + 1 / (RRF_K + p));
  return [...pontos.entries()].sort((a, b) => arredondar(b[1], 12) - arredondar(a[1], 12) || cmp(a[0], b[0]));
}

/**
 * Top-k Pais: RRF de (a) quantas das entidades escolhidas o citam e (b) a similaridade com a pergunta. Quem cita o
 * mesmo número de vezes empata na posição; o empate final é por id, então a ordem não muda entre execuções.
 */
export function ranquearPais(mencoes: Readonly<Record<string, readonly string[]>>, similaridade: ReadonlyMap<string, number>, k: number): string[] {
  const citacoes = new Map<string, number>();
  for (const pais of Object.values(mencoes)) for (const p of new Set(pais)) citacoes.set(p, (citacoes.get(p) ?? 0) + 1);
  if (citacoes.size === 0) return [];
  const porCitacao = posicoesDensas(citacoes);
  const porSimilaridade = posicoesDensas(new Map([...citacoes.keys()].filter((p) => similaridade.has(p)).map((p) => [p, similaridade.get(p) as number])));
  return rrfPosicoes([porCitacao, porSimilaridade]).slice(0, k).map(([p]) => p);
}

export interface InfoComunidade {
  level?: number | null;
  rank?: number | null;
}

/** Mais entidades escolhidas dentro, depois o nível mais fino (mais específico), depois o `rank`. */
export function ranquearComunidades(membros: Readonly<Record<string, readonly string[]>>, info: Readonly<Record<string, InfoComunidade>>, k: number): string[] {
  const nivel = (c: string) => info[c]?.level ?? 0;
  const rank = (c: string) => info[c]?.rank ?? 0;
  return Object.keys(membros)
    .sort(
      (a, b) =>
        new Set(membros[b]).size - new Set(membros[a]).size || nivel(a) - nivel(b) || rank(b) - rank(a) || cmp(a, b),
    )
    .slice(0, k);
}

export const estimarTokens = (texto: string): number => Math.max(1, Math.floor([...texto].length / CARACTERES_POR_TOKEN));

// ---------- evidências ----------

export interface EntidadeAchada {
  id: string;
  nome: string;
  tipo: string;
  resumo: string | null;
  paginas: number[];
  score: number;
}
export interface RelacaoAchada {
  de: string;
  para: string;
  de_nome: string;
  para_nome: string;
  resumo: string | null;
  peso: number | null;
  rank: number | null;
  paginas: number[];
}
export interface PaiAchado {
  id: string;
  text: string;
  tokens: number | null;
  pageStart: number;
  pageEnd: number;
  caminho: string;
  score: number;
}
export interface ComunidadeAchada {
  id: string;
  title: string;
  summary: string | null;
  level: number | null;
  rank: number | null;
}

export interface OmitidoEntidade extends Record<string, number> {
  entidades: number;
  relacoes: number;
  pais: number;
  comunidades: number;
  por_orcamento: number;
}

/**
 * Evidências na ordem entidade, Pai, relação, comunidade, com os tetos e o orçamento de tokens. O orçamento corta o
 * que sobra das camadas de menor prioridade; o que não cabe é pulado e contado em `por_orcamento`. A primeira
 * evidência entra sempre.
 */
export function montarEvidencias(
  entidades: readonly EntidadeAchada[],
  relacoes: readonly RelacaoAchada[],
  pais: readonly PaiAchado[],
  comunidades: readonly ComunidadeAchada[],
  limites: Pick<LimitesEntidade, "entidades" | "relacoes" | "pais" | "comunidades" | "tokens">,
): { evidencias: Evidencia[]; omitido: OmitidoEntidade } {
  const vistas = new Set<string>();
  const unicas = [...relacoes]
    .sort((a, b) => (b.peso ?? 0) - (a.peso ?? 0) || (b.rank ?? 0) - (a.rank ?? 0) || cmp(a.de, b.de) || cmp(a.para, b.para))
    .filter((r) => {
      const par = [r.de, r.para].sort().join("\u0000");
      if (vistas.has(par)) return false;
      vistas.add(par);
      return true;
    });
  const esc = {
    entidades: entidades.slice(0, limites.entidades),
    pais: pais.slice(0, limites.pais),
    relacoes: unicas.slice(0, limites.relacoes),
    comunidades: comunidades.slice(0, limites.comunidades),
  };
  const omitido: OmitidoEntidade = {
    entidades: entidades.length - esc.entidades.length,
    relacoes: unicas.length - esc.relacoes.length,
    pais: pais.length - esc.pais.length,
    comunidades: comunidades.length - esc.comunidades.length,
    por_orcamento: 0,
  };
  const candidatas: [Evidencia, number][] = [];
  for (const e of esc.entidades) {
    const texto = `${e.nome} (${e.tipo}): ${e.resumo ?? ""}`.trim();
    candidatas.push([{ id: e.id, tipo: "entidade", paginas: rotuloDePaginas(e.paginas), caminho: "Entidade", texto, score: e.score ?? 0 }, estimarTokens(texto)]);
  }
  for (const p of esc.pais) {
    const paginas = Array.from({ length: Math.max(0, p.pageEnd - p.pageStart) + 1 }, (_, i) => p.pageStart + i);
    candidatas.push([
      { id: p.id, tipo: "pai", paginas: rotuloDePaginas(paginas), caminho: p.caminho || "", texto: p.text, score: p.score ?? 0 },
      p.tokens || estimarTokens(p.text),
    ]);
  }
  for (const r of esc.relacoes) {
    const texto = `${r.de_nome} → ${r.para_nome}: ${r.resumo ?? ""}`.trim();
    candidatas.push([{ id: `rel:${r.de}:${r.para}`, tipo: "relacao", paginas: rotuloDePaginas(r.paginas), caminho: "Relação", texto, score: r.peso ?? r.rank ?? 0 }, estimarTokens(texto)]);
  }
  for (const c of esc.comunidades) {
    const texto = `${c.title}\n${c.summary ?? ""}`.trim();
    candidatas.push([{ id: c.id, tipo: "comunidade", paginas: "", caminho: `Comunidade (nível ${c.level ?? 0})`, texto, score: c.rank ?? 0 }, estimarTokens(texto)]);
  }
  const evidencias: Evidencia[] = [];
  let gasto = 0;
  for (const [ev, tokens] of candidatas) {
    if (gasto + tokens > limites.tokens && evidencias.length > 0) {
      omitido.por_orcamento += 1;
      continue;
    }
    evidencias.push(ev);
    gasto += tokens;
  }
  return { evidencias, omitido };
}

// ---------- a busca ----------

export interface ResultadoEntidade extends Envelope {
  entidades: { id: string; nome: string; score: number }[];
  rerank: "ok" | "falhou" | "desligado";
  etapas_ms: Record<string, number>;
}

export interface OpcoesEntidade {
  limites?: Partial<LimitesEntidade>;
  /** Padrão `true`: as candidatas são reordenadas pelo reranker sobre "nome: resumo". */
  rerank?: boolean;
}

const numeros = (v: unknown): number[] => (Array.isArray(v) ? v.filter((p): p is number => typeof p === "number") : []);
const num = (v: unknown): number | null => (typeof v === "number" ? v : null);

/**
 * Quem é, ou o que é, a entidade `nome` segundo o documento. Consulta vazia ou sem nenhuma entidade parecida devolve
 * tudo vazio, sem erro.
 */
export async function buscarEntidade(grafo: GrafoLeitura, llm: LlmDeBusca, nome: string, opcoes: OpcoesEntidade = {}): Promise<ResultadoEntidade> {
  const t0 = performance.now();
  const lim = { ...LIMITES_ENTIDADE, ...(opcoes.limites ?? {}) };
  const usarRerank = opcoes.rerank ?? true;
  const saida: ResultadoEntidade = { ...envelope("entidade", { nome }), entidades: [], rerank: "desligado", etapas_ms: {} };
  if (nome.trim() === "") {
    saida.aviso = "Nome vazio.";
    return fechar(saida, t0);
  }
  const q = (c: NomeConsulta, p: Record<string, unknown>): Promise<Linha[]> => grafo.consultar(CONSULTAS_ENTIDADE[c], p);
  try {
    const te = performance.now();
    const [vetorDaConsulta] = await llm.embeddings([nome]); // sem prefixo: é o que a busca local do Python faz
    saida.etapas_ms["embedding_da_consulta"] = Math.round(performance.now() - te);
    if (!vetorDaConsulta) throw new Error("sem vetor");

    const termos = escaparLucene(nome);
    const [vetorLinhas, textoLinhas] = await Promise.all([
      q("entidades_vetor", { k: lim.candidatas, v: vetorDaConsulta }),
      termos !== "" && lim.ft ? q("entidades_texto", { q: termos, k: lim.candidatas }) : Promise.resolve<Linha[]>([]),
    ]);
    const candidatas = vetorLinhas.map((r): [string, number] => [String(r["id"]), Number(r["score"])]);
    const acertos: AcertoTexto[] = textoLinhas.map((r) => ({
      id: String(r["id"]),
      score: Number(r["score"]),
      nomes: [r["nome"] as string | null, ...(Array.isArray(r["apelidos"]) ? (r["apelidos"] as string[]) : [])],
    }));
    const texto = lim.ft === 1 ? acertos.map((a): [string, number] => [a.id, a.score]) : textoExato(acertos, nome);
    const fundidas = fundirCandidatas(candidatas, texto, lim.candidatas);
    if (fundidas.length === 0) {
      saida.aviso = "Nenhuma entidade parecida com esse nome no documento.";
      return fechar(saida, t0);
    }
    const pontuacao = new Map(fundidas);
    const aDetalhar = (usarRerank ? fundidas : fundidas.slice(0, lim.entidades)).map(([i]) => i);

    const porId = new Map<string, EntidadeAchada>();
    for (const r of await q("detalhes_entidades", { ids: aDetalhar })) {
      const id = String(r["id"]);
      porId.set(id, {
        id,
        nome: String(r["nome"] ?? ""),
        tipo: String(r["tipo"] ?? ""),
        resumo: typeof r["resumo"] === "string" ? r["resumo"] : null,
        paginas: [...new Set(numeros(r["pages"]))].sort((a, b) => a - b).slice(0, PAGINAS_POR_ENTIDADE),
        score: arredondar(pontuacao.get(id) ?? 0, 6),
      });
    }
    let ordem = aDetalhar.filter((i) => porId.has(i));
    if (usarRerank && ordem.length > 0) {
      try {
        const notas = await llm.rerank(nome, ordem.map((i) => `${(porId.get(i) as EntidadeAchada).nome}: ${(porId.get(i) as EntidadeAchada).resumo ?? ""}`.trim()));
        if (notas.length !== ordem.length) throw new Error(`${ordem.length} textos, ${notas.length} notas`);
        const nota = new Map(ordem.map((i, k) => [i, notas[k] as number]));
        for (const i of ordem) (porId.get(i) as EntidadeAchada).score = arredondar(nota.get(i) as number, 6);
        ordem = [...ordem].sort((a, b) => (nota.get(b) as number) - (nota.get(a) as number) || cmp(a, b));
        saida.rerank = "ok";
      } catch {
        saida.rerank = "falhou"; // o reranker é um refinamento: sem ele a busca segue na ordem do RRF
        saida.aviso = "O reranker falhou; as entidades seguem na ordem da busca.";
      }
    }
    const ids = ordem.slice(0, lim.entidades);
    const entidades = ids.map((i) => porId.get(i) as EntidadeAchada);

    const relacoes: RelacaoAchada[] = (await q("relacoes", { ids, k: lim.relacoes * 2 })).map((r) => ({
      de: String(r["de"]),
      para: String(r["para"]),
      de_nome: String(r["de_nome"] ?? ""),
      para_nome: String(r["para_nome"] ?? ""),
      resumo: typeof r["resumo"] === "string" ? r["resumo"] : null,
      peso: num(r["peso"]),
      rank: num(r["rank"]),
      paginas: numeros(r["pages"]),
    }));

    const mencoes: Record<string, string[]> = Object.fromEntries(ids.map((i) => [i, [] as string[]]));
    for (const r of await q("mencoes", { ids })) (mencoes[String(r["entidade"])] ??= []).push(String(r["pai"]));
    const candidatosPai = [...new Set(Object.values(mencoes).flat())].sort();
    const similaridade = new Map<string, number>();
    if (candidatosPai.length > 0) {
      for (const r of await q("similaridade", { ids: candidatosPai, v: vetorDaConsulta })) similaridade.set(String(r["pai"]), Number(r["sim"]));
    }
    const escolhidosPai = ranquearPais(mencoes, similaridade, lim.pais + 1); // +1: o excedente vira `omitido`
    const paisPorId = new Map<string, Linha>();
    if (escolhidosPai.length > 0) for (const r of await q("detalhes_pais", { ids: escolhidosPai })) paisPorId.set(String(r["id"]), r);
    const pais: PaiAchado[] = escolhidosPai.flatMap((i) => {
      const d = paisPorId.get(i);
      return d
        ? [
            {
              id: i,
              text: String(d["text"] ?? ""),
              tokens: num(d["tokens"]),
              pageStart: Number(d["pageStart"]),
              pageEnd: Number(d["pageEnd"]),
              caminho: String(d["caminho"] ?? ""),
              score: arredondar(similaridade.get(i) ?? 0, 6),
            },
          ]
        : [];
    });

    const membros: Record<string, string[]> = {};
    const info: Record<string, InfoComunidade & ComunidadeAchada> = {};
    for (const r of await q("comunidades", { ids })) {
      const id = String(r["id"]);
      (membros[id] ??= []).push(String(r["entidade"]));
      info[id] = { id, title: String(r["title"] ?? ""), summary: typeof r["summary"] === "string" ? r["summary"] : null, level: num(r["level"]), rank: num(r["rank"]) };
    }
    const comunidades = ranquearComunidades(membros, info, lim.comunidades + 1).map((c) => info[c] as ComunidadeAchada);

    const { evidencias, omitido } = montarEvidencias(entidades, relacoes, pais, comunidades, lim);
    saida.entidades = entidades.map((e) => ({ id: e.id, nome: e.nome, score: e.score }));
    saida.evidencias = evidencias;
    saida.omitido = omitido;
    saida.etapas_ms["total"] = Math.round(performance.now() - t0);
  } catch (e) {
    return falhar(saida, t0, `falha na busca: ${mensagemDe(e)}`);
  }
  return fechar(saida, t0);
}
