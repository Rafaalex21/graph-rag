/**
 * Buscas no texto e nas tabelas (F7.9): `buscar_trechos` e `buscar_tabelas`. Porte de `indexer.busca`,
 * `indexer.recuperador`, `indexer.reescrita` e `indexer.reranker` (degrau 3 da escada, ARQUITETURA §6.3 e §7.2):
 *
 *   pergunta (± step-back, ± HyDE) → k×4 Filhos (vetor `child_vec` + texto `child_ft`, fundidos por RRF)
 *   → deduplicação por Pai (até 24) → reranker sobre "caminho + corpo" → 6 Pais.
 *
 * O embedding de consulta e o reranker vêm do cliente da F7.1 (`LlmDeBusca`). O reranker é refinamento: se ele
 * falha, a busca segue na ordem da recuperação e avisa (no Python a exceção sobe). Nada é inventado: sem resultado,
 * a lista vem vazia e o `aviso` diz por quê; falha do grafo ou do embedding vira `erro`.
 */
import type { Mensagem, OpcoesJson } from "../llm/index.ts";
import { envelope, evidencia, falhar, fechar, mensagemDe, type Envelope } from "./contrato.ts";
import type { GrafoLeitura } from "./grafo.ts";
import { arredondar, normalizar } from "./texto.ts";

/** O que as buscas pedem ao cliente LLM (a `ClienteLlm` da F7.1 satisfaz; os testes põem um dublê). */
export interface LlmDeBusca {
  /** O vetor da pergunta, já com o prefixo `Instruct:`. */
  embeddingDeConsulta(pergunta: string): Promise<number[]>;
  /** Vetores de textos como estão, sem prefixo (HyDE, busca de entidades). */
  embeddings(textos: string[]): Promise<number[][]>;
  /** Uma nota por texto, na ordem de entrada. */
  rerank(pergunta: string, textos: string[]): Promise<number[]>;
  /** JSON forçado por esquema; opcional, só as reescritas o usam. */
  chatJson?: (mensagens: Mensagem[], opcoes: OpcoesJson<unknown>) => Promise<{ valor: unknown }>;
}

export const RRF_K = 60;
export const ALFA_PADRAO = 0.5;
export const FATOR_DE_CANDIDATOS = 4; // k × 4 Filhos, como no cap. 3
export const CANDIDATOS = 24; // Pais enviados ao reranker (§5.1)
export const TOP_PADRAO = 6; // Pais devolvidos (§5.1)
export const LIMITE_DE_CARACTERES = 6000; // ~1.500 tokens do reranker (ADR-011); só vale para a nota
export const PERGUNTAS_DE_TABELA = 20; // perguntas hipotéticas lidas de `question_vec`
export const TABELAS_PADRAO = 3;
export const LIMITE_MARKDOWN = 10_000;
export const LIMITE_RESPOSTA_JA_DADA = 8000;

export const CONSULTAS_BUSCA = {
  vetor_filhos:
    "CALL db.index.vector.queryNodes('child_vec', $k, $v) YIELD node, score " +
    "RETURN node.id AS id, score ORDER BY score DESC",
  texto_filhos:
    "CALL db.index.fulltext.queryNodes('child_ft', $q, {limit: $k}) YIELD node, score " +
    "RETURN node.id AS id, score ORDER BY score DESC",
  pai_dos_filhos: "UNWIND $ids AS id MATCH (p:Parent)-[:HAS_CHILD]->(c:Child {id: id}) RETURN c.id AS id, p.id AS pai",
  detalhes_pais:
    "UNWIND $ids AS id MATCH (s:Section)-[:HAS_PARENT]->(p:Parent {id: id}) " +
    "RETURN p.id AS id, p.text AS text, p.tokens AS tokens, p.pageStart AS pageStart, " +
    "p.pageEnd AS pageEnd, s.id AS secaoId, s.path AS caminho",
  tabelas_por_pergunta:
    "CALL db.index.vector.queryNodes('question_vec', $k, $v) YIELD node, score " +
    "MATCH (t:Table)-[:HAS_QUESTION]->(node) " +
    "OPTIONAL MATCH (s:Section)-[:HAS_TABLE]->(t) " +
    "RETURN node.id AS id, score, t.id AS tabela, t.markdown AS markdown, t.description AS descricao, " +
    "t.pageStart AS pageStart, t.pageEnd AS pageEnd, t.scale AS escala, t.currency AS moeda, s.path AS caminho " +
    "ORDER BY score DESC",
} as const;
type NomeConsulta = keyof typeof CONSULTAS_BUSCA;
type Linha = Record<string, unknown>;

const rodar = (g: GrafoLeitura, nome: NomeConsulta, p: Record<string, unknown> = {}): Promise<Linha[]> =>
  g.consultar(CONSULTAS_BUSCA[nome], p);

// ---------- Lucene e fusões ----------

const ESPECIAIS = /([+\-&|!(){}[\]^"~*?:\\/])/g;
const RESERVADAS = new Set(["AND", "OR", "NOT"]);

/** Pergunta em linguagem natural → consulta Lucene segura (termos soltos, operador padrão OU). */
export function escaparLucene(pergunta: string): string {
  return pergunta
    .trim()
    .split(/\s+/)
    .map((t) => t.replace(ESPECIAIS, "\\$1"))
    .filter((t) => t !== "" && !RESERVADAS.has(t.toUpperCase()))
    .join(" ");
}

export type Ranking = [string, number][];

/** Divide cada escore pelo maior da lista (lista vazia ou de máximo 0 vira zeros). */
export function normalizarPeloMaximo(lista: Ranking): Map<string, number> {
  const saida = new Map<string, number>();
  if (lista.length === 0) return saida;
  const topo = Math.max(...lista.map(([, s]) => s));
  for (const [i, s] of lista) saida.set(i, topo > 0 ? s / topo : 0);
  return saida;
}

const porEscoreDecrescente = (a: [string, number], b: [string, number]) => b[1] - a[1]; // sort estável, como o `sorted` do Python

export function fundirMax(vetor: Ranking, texto: Ranking, alfa: number = ALFA_PADRAO): Ranking {
  const v = normalizarPeloMaximo(vetor);
  const t = normalizarPeloMaximo(texto);
  const ids = [...new Set([...vetor.map(([i]) => i), ...texto.map(([i]) => i)])];
  return ids.map((i): [string, number] => [i, alfa * (v.get(i) ?? 0) + (1 - alfa) * (t.get(i) ?? 0)]).sort(porEscoreDecrescente);
}

/** RRF sobre N rankings, cada um já na ordem final de uma lista (índice ou variante da consulta). */
export function fundirVariantes(rankings: readonly Ranking[], k: number = RRF_K): Ranking {
  const pontos = new Map<string, number>();
  for (const ranking of rankings) {
    ranking.forEach(([i], p) => pontos.set(i, (pontos.get(i) ?? 0) + 1 / (k + p + 1)));
  }
  return [...pontos.entries()].sort(porEscoreDecrescente);
}

export function fundirRrf(vetor: Ranking, texto: Ranking, k: number = RRF_K): Ranking {
  return fundirVariantes([vetor, texto], k);
}

// ---------- Filhos e Pais ----------

export interface PaiAgrupado {
  id: string;
  score: number;
  filhos: string[];
}

/** Colapsa a lista fundida de Filhos em Pais únicos: o melhor Filho define escore e ordem; corta em k. */
export function agruparPorPai(filhos: Ranking, paiDe: ReadonlyMap<string, string>, k: number): PaiAgrupado[] {
  const pais = new Map<string, PaiAgrupado>();
  for (const [filho, escore] of filhos) {
    const pai = paiDe.get(filho);
    if (pai === undefined) continue;
    const existente = pais.get(pai);
    if (existente) existente.filhos.push(filho);
    else pais.set(pai, { id: pai, score: escore, filhos: [filho] });
  }
  return [...pais.values()].slice(0, k);
}

/** Texto enviado ao reranker: caminho da seção + corpo, cortado em `limite` caracteres; diz se cortou. */
export function textoDoPai(pai: { caminho: string; text: string }, limite: number = LIMITE_DE_CARACTERES): [string, boolean] {
  const texto = `${pai.caminho}\n${pai.text}`;
  return [texto.slice(0, limite), texto.length > limite];
}

export interface PaiRecuperado {
  id: string;
  score: number;
  pageStart: number;
  pageEnd: number;
  caminho: string;
  text: string;
  tokens: number | null;
  filhos: string[];
}

// ---------- reescritas opcionais (step-back e HyDE) ----------

const DOCUMENTO = "Formulário de Referência (documento da CVM) de uma companhia brasileira";
const ESQUEMA_STEPBACK = {
  type: "object",
  properties: { pergunta_geral: { type: "string", minLength: 15 } },
  required: ["pergunta_geral"],
  additionalProperties: false,
};
const ESQUEMA_HYDE = {
  type: "object",
  properties: { trecho: { type: "string", minLength: 200 } },
  required: ["trecho"],
  additionalProperties: false,
};

const promptStepback = (pergunta: string) => `Você ajuda um sistema de busca sobre um ${DOCUMENTO}.
Reescreva a pergunta do usuário como UMA pergunta mais geral e abstrata, que trate do tema e do contexto
necessários para respondê-la, mantendo a empresa e o período quando houver. Não responda a pergunta.

Exemplos:
Pergunta: Qual foi o lucro líquido ajustado em 2025?
Pergunta geral: Quais foram os resultados financeiros da companhia no exercício de 2025?
Pergunta: Quem é o presidente do conselho de administração?
Pergunta geral: Como é composta e organizada a administração da companhia?

Pergunta: ${pergunta}`;

const promptHyde = (pergunta: string) => `Você ajuda um sistema de busca sobre um ${DOCUMENTO}.
Escreva um trecho de 80 a 130 palavras, em português formal e no estilo desse tipo de documento, que
responderia à pergunta abaixo. Não é preciso que os fatos estejam corretos: o que importa é o vocabulário e o
tom do documento. Evite números exatos. Não mencione a pergunta nem o usuário.

Pergunta: ${pergunta}`;

/** Problema da pergunta geral (`null` = válida). */
export function validarStepback(original: string, texto: unknown): string | null {
  if (typeof texto !== "string" || texto.trim().length < 15 || texto.trim().length > 300) {
    return "pergunta geral ausente ou fora de 15 a 300 caracteres";
  }
  if (!texto.trim().endsWith("?")) return "não termina com '?'";
  if (normalizar(texto) === normalizar(original)) return "igual à pergunta original";
  return null;
}

export function validarHyde(texto: unknown): string | null {
  if (typeof texto !== "string" || texto.trim().length < 200 || texto.trim().length > 1500) {
    return "trecho ausente ou fora de 200 a 1.500 caracteres";
  }
  return null;
}

export interface Reescrita {
  stepback: string | null;
  hyde: string | null;
  ms: Record<string, number>;
  erros: Record<string, string>;
}

/** As reescritas pedidas, em paralelo. Qualquer falha vira `null` e entra em `erros`: a busca segue com a pergunta. */
export async function reescrever(llm: LlmDeBusca, pergunta: string, pedidas: { stepback?: boolean; hyde?: boolean }): Promise<Reescrita> {
  const saida: Reescrita = { stepback: null, hyde: null, ms: {}, erros: {} };
  const passo = async (nome: "stepback" | "hyde") => {
    const t0 = performance.now();
    try {
      if (!llm.chatJson) throw new Error("o cliente LLM não tem chatJson");
      const stepback = nome === "stepback";
      const r = await llm.chatJson([{ role: "user", content: stepback ? promptStepback(pergunta) : promptHyde(pergunta) }], {
        esquema: stepback ? ESQUEMA_STEPBACK : ESQUEMA_HYDE,
        maxTokens: stepback ? 120 : 400,
        temperatura: stepback ? 0.2 : 0.4,
      });
      const bruto = (r.valor ?? {}) as Record<string, unknown>;
      const texto = stepback ? bruto["pergunta_geral"] : bruto["trecho"];
      const erro = stepback ? validarStepback(pergunta, texto) : validarHyde(texto);
      if (erro) saida.erros[nome] = erro;
      else saida[nome] = (texto as string).trim();
    } catch (e) {
      saida.erros[nome] = mensagemDe(e).slice(0, 200);
    }
    saida.ms[nome] = Math.round((performance.now() - t0) * 10) / 10;
  };
  await Promise.all([...(pedidas.stepback ? [passo("stepback")] : []), ...(pedidas.hyde ? [passo("hyde")] : [])]);
  return saida;
}

// ---------- buscar_trechos ----------

export interface OpcoesTrechos {
  stepback?: boolean;
  hyde?: boolean;
  candidatos?: number;
  top?: number;
}

export interface ResultadoTrechos extends Envelope {
  pais: { id: string; nota_rerank: number | null; posicao_antes: number }[];
  /** `ok`, `falhou` (a ordem é a da recuperação) ou `desligado` (nada a ordenar). */
  rerank: "ok" | "falhou" | "desligado";
  reescrita: Reescrita | null;
  etapas_ms: Record<string, number>;
}

async function rankingDeFilhos(grafo: GrafoLeitura, llm: LlmDeBusca, pergunta: string, n: number): Promise<Ranking> {
  const q = escaparLucene(pergunta);
  const [vetor, texto] = await Promise.all([
    llm.embeddingDeConsulta(pergunta).then((v) => rodar(grafo, "vetor_filhos", { k: n, v })),
    q === "" ? Promise.resolve<Linha[]>([]) : rodar(grafo, "texto_filhos", { k: n, q }),
  ]);
  const par = (r: Linha[]): Ranking => r.map((x) => [String(x["id"]), Number(x["score"])]);
  return fundirRrf(par(vetor), par(texto)).slice(0, n);
}

/**
 * Os trechos do texto que respondem à pergunta: busca híbrida de Filhos, Pais únicos e rerank. Cada evidência é
 * um Pai inteiro (`tipo: "pai"`) com a página, o caminho da seção e a nota do reranker como escore.
 */
export async function buscarTrechos(grafo: GrafoLeitura, llm: LlmDeBusca, pergunta: string, opcoes: OpcoesTrechos = {}): Promise<ResultadoTrechos> {
  const t0 = performance.now();
  const candidatos = opcoes.candidatos ?? CANDIDATOS;
  const top = opcoes.top ?? TOP_PADRAO;
  const saida: ResultadoTrechos = { ...envelope("buscar_trechos", { pergunta }), pais: [], rerank: "desligado", reescrita: null, etapas_ms: {} };
  if (pergunta.trim() === "") {
    saida.aviso = "Pergunta vazia.";
    return fechar(saida, t0);
  }
  try {
    const n = candidatos * FATOR_DE_CANDIDATOS;
    const pedida = Boolean(opcoes.stepback || opcoes.hyde);
    if (pedida) {
      const tr = performance.now();
      saida.reescrita = await reescrever(llm, pergunta, { stepback: opcoes.stepback ?? false, hyde: opcoes.hyde ?? false });
      saida.etapas_ms["reescrita"] = Math.round(performance.now() - tr);
    }
    const t1 = performance.now();
    const rankings: Ranking[] = [await rankingDeFilhos(grafo, llm, pergunta, n)];
    const re = saida.reescrita;
    if (re?.stepback) rankings.push(await rankingDeFilhos(grafo, llm, re.stepback, n));
    if (re?.hyde) {
      const [vh] = await llm.embeddings([re.hyde]); // trecho hipotético = lado do documento: sem prefixo de instrução
      const linhas = await rodar(grafo, "vetor_filhos", { k: n, v: vh });
      rankings.push(linhas.map((x): [string, number] => [String(x["id"]), Number(x["score"])]));
    }
    const filhos = rankings.length === 1 ? (rankings[0] as Ranking) : fundirVariantes(rankings).slice(0, n);
    saida.etapas_ms["busca_nos_indices"] = Math.round(performance.now() - t1);

    let pais: PaiRecuperado[] = [];
    if (filhos.length > 0) {
      const t2 = performance.now();
      const paiDe = new Map((await rodar(grafo, "pai_dos_filhos", { ids: filhos.map(([i]) => i) })).map((r) => [String(r["id"]), String(r["pai"])]));
      const escolhidos = agruparPorPai(filhos, paiDe, candidatos);
      const detalhes = new Map((await rodar(grafo, "detalhes_pais", { ids: escolhidos.map((p) => p.id) })).map((r) => [String(r["id"]), r]));
      pais = escolhidos.flatMap((p) => {
        const d = detalhes.get(p.id);
        if (!d) return [];
        return [
          {
            id: p.id,
            score: arredondar(p.score, 6),
            pageStart: Number(d["pageStart"]),
            pageEnd: Number(d["pageEnd"]),
            caminho: String(d["caminho"] ?? ""),
            text: String(d["text"] ?? ""),
            tokens: typeof d["tokens"] === "number" ? d["tokens"] : null,
            filhos: p.filhos,
          },
        ];
      });
      saida.etapas_ms["pais"] = Math.round(performance.now() - t2);
    }
    if (pais.length === 0) {
      saida.aviso = "Nenhum trecho encontrado para a pergunta.";
      return fechar(saida, t0);
    }

    const enviados = pais.map((p) => textoDoPai(p));
    let ordem = pais.map((_, i) => i);
    let notas: number[] | null = null;
    const tr = performance.now();
    try {
      notas = await llm.rerank(pergunta, enviados.map(([t]) => t));
      if (notas.length !== pais.length) throw new Error(`${pais.length} textos, ${notas.length} notas`);
      const n_ = notas;
      ordem = [...ordem].sort((a, b) => (n_[b] as number) - (n_[a] as number) || a - b); // empate: mantém a ordem da recuperação
      saida.rerank = "ok";
    } catch (e) {
      notas = null;
      saida.rerank = "falhou";
      saida.aviso = `O reranker falhou (${mensagemDe(e).slice(0, 120)}); os trechos seguem na ordem da busca.`;
    }
    saida.etapas_ms["rerank"] = Math.round(performance.now() - tr);

    const escolhidos = ordem.slice(0, top);
    saida.pais = escolhidos.map((i) => ({
      id: (pais[i] as PaiRecuperado).id,
      nota_rerank: notas ? arredondar(notas[i] as number, 6) : null,
      posicao_antes: i + 1,
    }));
    saida.evidencias = escolhidos.map((i) => {
      const p = pais[i] as PaiRecuperado;
      const nota = notas ? arredondar(notas[i] as number, 6) : p.score;
      return evidencia(p.id, "pai", rangeDePaginas(p.pageStart, p.pageEnd), p.caminho, p.text, nota);
    });
    saida.omitido = {
      pais: Math.max(0, pais.length - top),
      cortados_no_rerank: enviados.filter(([, c]) => c).length,
    };
  } catch (e) {
    return falhar(saida, t0, `falha na busca: ${mensagemDe(e)}`);
  }
  return fechar(saida, t0);
}

/** `[6, 7]` para um Pai que cobre as páginas 6 e 7 (o rótulo agrupa em `p. 6-7`). */
function rangeDePaginas(a: number, b: number): number[] {
  if (!Number.isFinite(a) || !Number.isFinite(b)) return [];
  return Array.from({ length: Math.max(0, Math.min(b, a + 50) - a) + 1 }, (_, i) => a + i);
}

// ---------- buscar_tabelas ----------

export interface OpcoesTabelas {
  tabelas?: number;
  perguntas?: number;
}

export interface ResultadoTabelas extends Envelope {
  tabelas: { id: string; score: number }[];
}

/**
 * As tabelas que respondem à pergunta, achadas pelas perguntas hipotéticas que o indexador gerou para cada uma
 * (`question_vec`, F2.7): a melhor pergunta de cada tabela dá o escore. A evidência traz a descrição e o Markdown.
 */
export async function buscarTabelas(grafo: GrafoLeitura, llm: LlmDeBusca, pergunta: string, opcoes: OpcoesTabelas = {}): Promise<ResultadoTabelas> {
  const t0 = performance.now();
  const limite = opcoes.tabelas ?? TABELAS_PADRAO;
  const saida: ResultadoTabelas = { ...envelope("buscar_tabelas", { pergunta }), tabelas: [] };
  if (pergunta.trim() === "") {
    saida.aviso = "Pergunta vazia.";
    return fechar(saida, t0);
  }
  try {
    const v = await llm.embeddingDeConsulta(pergunta);
    const linhas = await rodar(grafo, "tabelas_por_pergunta", { k: opcoes.perguntas ?? PERGUNTAS_DE_TABELA, v });
    const melhor = new Map<string, Linha>();
    for (const l of linhas) {
      const id = String(l["tabela"]);
      const atual = melhor.get(id);
      if (!atual || Number(l["score"]) > Number(atual["score"])) melhor.set(id, l);
    }
    const ordenadas = [...melhor.values()].sort((a, b) => Number(b["score"]) - Number(a["score"]));
    if (ordenadas.length === 0) {
      saida.aviso = "Nenhuma tabela encontrada para a pergunta.";
      return fechar(saida, t0);
    }
    let cortadas = 0;
    const escolhidas = ordenadas.slice(0, limite);
    saida.evidencias = escolhidas.map((l) => {
      const markdown = String(l["markdown"] ?? "");
      const cortada = markdown.length > LIMITE_MARKDOWN;
      if (cortada) cortadas += 1;
      const escala = l["escala"] ? `Escala: ${String(l["escala"])}${l["moeda"] ? `; moeda: ${String(l["moeda"])}` : ""}` : "";
      const corpo = [String(l["descricao"] ?? ""), escala, cortada ? `${markdown.slice(0, LIMITE_MARKDOWN)}\n[tabela cortada: mostrado só o começo]` : markdown]
        .filter((x) => x !== "")
        .join("\n\n");
      const ini = typeof l["pageStart"] === "number" ? l["pageStart"] : null;
      const fim = typeof l["pageEnd"] === "number" ? l["pageEnd"] : ini;
      return evidencia(String(l["tabela"]), "tabela", ini === null || fim === null ? [] : rangeDePaginas(ini, fim), String(l["caminho"] ?? ""), corpo, arredondar(Number(l["score"]), 6));
    });
    saida.tabelas = escolhidas.map((l) => ({ id: String(l["tabela"]), score: arredondar(Number(l["score"]), 6) }));
    saida.omitido = { tabelas: Math.max(0, ordenadas.length - limite), tabelas_cortadas: cortadas };
  } catch (e) {
    return falhar(saida, t0, `falha na busca: ${mensagemDe(e)}`);
  }
  return fechar(saida, t0);
}

// ---------- resposta_ja_dada ----------

/** A resposta já está numa mensagem anterior do assistente: o trecho que o roteador apontou vira a evidência. */
export function respostaJaDada(args: { resposta: string }): Envelope & { evidencias: Envelope["evidencias"] } {
  const t0 = performance.now();
  const saida = envelope("resposta_ja_dada", {});
  const texto = args.resposta.trim();
  if (texto === "") return falhar(saida, t0, "resposta_vazia", { aviso: "Informe o trecho da conversa que responde." });
  const cortado = texto.slice(0, LIMITE_RESPOSTA_JA_DADA);
  saida.evidencias = [evidencia("conversa", "conversa", [], "Conversa", cortado, 1)];
  saida.omitido = { caracteres: texto.length - cortado.length };
  return fechar(saida, t0);
}
