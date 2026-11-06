/**
 * `panorama`: busca global *map-reduce* sobre os relatórios de comunidade, em TypeScript (F7.10, porte de
 * `indexer/busca_global.py`, F6.2; ARQUITETURA §7.2 e cap. 7 do livro).
 *
 * Pergunta → comunidades do nível escolhido com `rating` ≥ limiar, as mais parecidas com a pergunta primeiro
 * (`community_vec`) → **mapa**: o Qwen3.6 lê lotes de relatórios e devolve pontos curtos com nota de 0 a 10 para a
 * pergunta → os melhores pontos, sem repetição, até um teto de itens e de tokens → **reduce**: o LLM escreve a síntese só
 * com esses pontos. A síntese é opcional (o redator da F7.5 também pode ler os pontos).
 *
 * Tempo (aceite da F7.10: ≤ 60 s): o custo é a geração (~35 tok/s), então os lotes saem com poucos pontos, rodam em
 * paralelo (2 vagas no perfil `consultar`) e há um orçamento de tempo: passado o orçamento, os lotes que ainda não
 * começaram são pulados (contados em `omitido`) e o reduce roda com o que chegou. O `progresso` recebe `selecao`, um `mapa`
 * por lote concluído, `sintese` e `fim`.
 *
 * Os pontos vêm de relatórios de comunidade, que são sínteses: não têm página do documento (`paginas` = ""), e a
 * ferramenta não inventa uma. Falha de um lote, do reduce ou do callback de progresso não derruba a busca: vira contagem.
 */
import { envelope, mensagemDe, type Envelope, type Evidencia } from "./contrato.ts";
import type { GrafoLeitura } from "./grafo.ts";

export interface Limites {
  /** 0 a 3; os níveis 2 e 3 do documento inteiro são quase iguais (130 e 129 comunidades). `null`: qualquer nível. */
  nivel: number | null;
  /** §5: limiar de rating da busca global, como no cap. 7. */
  rating: number;
  /** Comunidades enviadas ao mapa, as mais parecidas com a pergunta. */
  candidatas: number;
  /** ≈ 4 mil tokens de relatórios por chamada do mapa. */
  lote_chars: number;
  max_por_relatorio: number;
  max_pontos_por_lote: number;
  /** Vagas do perfil `consultar` (`-np 2`). */
  paralelismo: number;
  /** Pontos que seguem para o reduce e para o redator. */
  pontos: number;
  /** 0 = irrelevante. */
  nota_minima: number;
  tokens: number;
  /** Depois disso, lotes que não começaram são pulados (um em curso leva até ~25 s). */
  orcamento_s: number;
}

export const LIMITES_PANORAMA: Limites = {
  nivel: 1,
  rating: 5,
  candidatas: 16,
  lote_chars: 14000,
  max_por_relatorio: 4500,
  max_pontos_por_lote: 6,
  paralelismo: 2,
  pontos: 12,
  nota_minima: 1,
  tokens: 5000,
  orcamento_s: 45,
};
export const VARREDURA = 1000; // vizinhos lidos no community_vec antes de filtrar por nível e rating
export const TENTATIVAS_POR_LOTE = 2;
const CARACTERES_POR_TOKEN = 3;
const TEMPERATURA_MAPA = 0.1;
const MAX_TOKENS_MAPA = 900;
const TIMEOUT_MAPA_MS = 300_000;
const TEMPERATURA_REDUCE = 0.2;
const MAX_TOKENS_REDUCE = 700;
const TIMEOUT_REDUCE_MS = 300_000;

export const SISTEMA_MAPA =
  "Você ajuda a responder perguntas sobre o Formulário de Referência de uma companhia brasileira. " +
  "Recebe relatórios de comunidades de um grafo de conhecimento, etiquetados C1, C2..., e uma pergunta. " +
  "Para cada relatório que traga informação útil à pergunta, escreva pontos curtos (uma frase, até 30 " +
  "palavras) usando SOMENTE o relatório: não invente, não complete com conhecimento externo, mantenha " +
  "números, nomes e unidades como estão. Dê a cada ponto uma nota de 0 a 10 para a utilidade dele na " +
  "resposta (0 = irrelevante). Relatório sem nada útil à pergunta: não escreva pontos para ele. " +
  "Responda em português, em JSON.";

export const SISTEMA_REDUCE =
  "Responda à pergunta em português usando SOMENTE os pontos fornecidos; cada um vem de um relatório de " +
  "comunidade de um grafo de conhecimento e tem uma nota de utilidade. Organize e agrupe os pontos, sem " +
  "acrescentar nada que não esteja neles. Se os pontos não bastarem para responder, diga o que faltou. " +
  "Seja conciso: no máximo 150 palavras. Os pontos não têm página do documento, então não cite páginas.";

export const CONSULTA =
  "CALL db.index.vector.queryNodes('community_vec', $k, $v) YIELD node, score " +
  "WHERE ($nivel IS NULL OR node.level = $nivel) AND node.rating >= $rating " +
  "RETURN node.id AS id, node.title AS title, node.summary AS summary, node.report AS report, " +
  "node.level AS level, node.rating AS rating, score ORDER BY score DESC LIMIT $limite";

export interface Comunidade {
  id: string;
  title: string | null;
  summary: string | null;
  /** JSON do relatório: `{title, summary, findings: [{summary, explanation}]}`. */
  report: string | null;
  level: number;
  rating: number | null;
  score: number;
}

export interface Ponto {
  comunidade: string;
  titulo: string | null;
  nivel: number;
  texto: string;
  nota: number;
  similaridade: number;
}

type MensagemPanorama = { role: "system" | "user" | "assistant"; content: string };

/** O que a ferramenta pede ao LLM (o `ClienteLlm` da F7.1 satisfaz): o vetor da pergunta, o mapa em JSON e o reduce em texto. */
export interface LlmDePanorama {
  embeddingDeConsulta(pergunta: string): Promise<number[]>;
  chatJson(
    mensagens: MensagemPanorama[],
    opcoes: { perfil?: "principal" | "rapido"; temperatura?: number; maxTokens?: number; timeoutMs?: number; esquema?: Record<string, unknown> },
  ): Promise<{ valor: unknown }>;
  chat(mensagens: MensagemPanorama[], opcoes?: { perfil?: "principal" | "rapido"; temperatura?: number; maxTokens?: number; timeoutMs?: number }): Promise<{ texto: string }>;
}

export type EventoPanorama =
  | { fase: "selecao"; comunidades_total: number; nivel: number | null }
  | {
      fase: "mapa";
      comunidades_feitas: number;
      comunidades_total: number;
      lotes_feitos: number;
      lotes_total: number;
      status: "ok" | "falhou" | "tempo";
      titulos: string[];
      pontos: number;
    }
  | { fase: "sintese"; pontos: number }
  | { fase: "fim"; pontos: number };

// ---------- escolha, lotes e pedido ----------

/** Comunidades do nível (qualquer, se `null`) com rating ≥ limiar, as mais parecidas antes, até `k`. O empate se desfaz pelo id. */
export function escolherComunidades(comunidades: readonly Comunidade[], nivel: number | null, rating: number, k: number): Comunidade[] {
  return comunidades
    .filter((c) => (nivel === null || c.level === nivel) && (c.rating ?? 0) >= rating)
    .sort((a, b) => b.score - a.score || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    .slice(0, k);
}

const textoSimples = (v: unknown): v is string => typeof v === "string";

/** Título, resumo e achados do relatório (o JSON de `report`); sem JSON no formato esperado, só título e resumo. */
export function textoDoRelatorio(c: Pick<Comunidade, "title" | "summary" | "report">): string {
  const reserva = [c.title, c.summary].filter((p): p is string => typeof p === "string" && p !== "").join("\n");
  if (typeof c.report !== "string") return reserva;
  try {
    const r: unknown = JSON.parse(c.report);
    if (r === null || typeof r !== "object" || Array.isArray(r)) return reserva;
    const o = r as { title?: unknown; summary?: unknown; findings?: unknown };
    if (!textoSimples(o.title) || !textoSimples(o.summary)) return reserva;
    const brutos: unknown = o.findings === undefined ? [] : o.findings;
    if (!Array.isArray(brutos)) return reserva;
    const achados: string[] = [];
    for (const a of brutos as unknown[]) {
      const f = a as { summary?: unknown; explanation?: unknown } | null;
      if (f === null || typeof f !== "object" || !textoSimples(f.summary) || !textoSimples(f.explanation)) return reserva;
      achados.push(`- ${f.summary} ${f.explanation}`);
    }
    return [o.title, o.summary, ...achados].join("\n");
  } catch {
    return reserva;
  }
}

/**
 * Agrupa as comunidades, na ordem, em lotes de até `loteChars` caracteres de relatório. Cada relatório conta no máximo
 * `maxPorRelatorio`; o gigante entra sozinho (e é cortado ao montar o pedido).
 */
export function montarLotes(comunidades: readonly Comunidade[], loteChars: number, maxPorRelatorio: number): Comunidade[][] {
  const lotes: Comunidade[][] = [];
  let atual: Comunidade[] = [];
  let gasto = 0;
  for (const c of comunidades) {
    const tamanho = Math.min(textoDoRelatorio(c).length, maxPorRelatorio);
    if (atual.length > 0 && gasto + tamanho > loteChars) {
      lotes.push(atual);
      atual = [];
      gasto = 0;
    }
    atual.push(c);
    gasto += tamanho;
  }
  if (atual.length > 0) lotes.push(atual);
  return lotes;
}

/** Mensagens do mapa, a tabela etiqueta → comunidade e o esquema JSON (a etiqueta é um enum do lote). */
export function montarPedido(
  pergunta: string,
  lote: readonly Comunidade[],
  lim: Pick<Limites, "max_por_relatorio" | "max_pontos_por_lote">,
): { mensagens: MensagemPanorama[]; etiquetas: Record<string, Comunidade>; esquema: Record<string, unknown> } {
  const etiquetas: Record<string, Comunidade> = {};
  lote.forEach((c, i) => {
    etiquetas[`C${i + 1}`] = c;
  });
  const blocos = Object.entries(etiquetas).map(([e, c]) => `[${e}] (nível ${c.level}) ${textoDoRelatorio(c).slice(0, lim.max_por_relatorio)}`);
  const pedido = `Pergunta: ${pergunta}\n\nRelatórios:\n\n${blocos.join("\n\n")}`;
  const esquema = {
    type: "object",
    properties: {
      pontos: {
        type: "array",
        maxItems: Math.min(lim.max_pontos_por_lote, 3 * lote.length),
        items: {
          type: "object",
          properties: {
            comunidade: { type: "string", enum: Object.keys(etiquetas) },
            ponto: { type: "string" },
            nota: { type: "integer", minimum: 0, maximum: 10 },
          },
          required: ["comunidade", "ponto", "nota"],
          additionalProperties: false,
        },
      },
    },
    required: ["pontos"],
    additionalProperties: false,
  };
  return {
    mensagens: [
      { role: "system", content: SISTEMA_MAPA },
      { role: "user", content: pedido },
    ],
    etiquetas,
    esquema,
  };
}

/**
 * Pontos válidos da resposta do mapa e quantos foram descartados (etiqueta inexistente, texto vazio, nota que não é inteiro
 * de 0 a 10). Resposta que não é `{"pontos": [...]}` lança, e o lote é pedido de novo.
 */
export function validarPontos(resposta: unknown, etiquetas: Readonly<Record<string, Comunidade>>): { pontos: Ponto[]; descartados: number } {
  const lista = resposta !== null && typeof resposta === "object" && !Array.isArray(resposta) ? (resposta as { pontos?: unknown }).pontos : undefined;
  if (!Array.isArray(lista)) throw new Error("resposta do mapa fora do esquema");
  const pontos: Ponto[] = [];
  let descartados = 0;
  for (const p of lista) {
    const o = p !== null && typeof p === "object" && !Array.isArray(p) ? (p as { comunidade?: unknown; ponto?: unknown; nota?: unknown }) : null;
    const c = o !== null && typeof o.comunidade === "string" && Object.hasOwn(etiquetas, o.comunidade) ? etiquetas[o.comunidade] : undefined;
    const texto = o?.ponto;
    const nota = o?.nota;
    if (c === undefined || typeof texto !== "string" || texto.trim() === "" || typeof nota !== "number" || !Number.isInteger(nota) || nota < 0 || nota > 10) {
      descartados++;
      continue;
    }
    pontos.push({ comunidade: c.id, titulo: c.title, nivel: c.level, texto: texto.trim(), nota, similaridade: c.score ?? 0 });
  }
  return { pontos, descartados };
}

/** Texto sem acento, caixa nem pontuação: dois pontos que dizem a mesma coisa têm a mesma chave. */
const chaveDoTexto = (texto: string): string =>
  texto
    .toLowerCase()
    .normalize("NFD")
    .replace(/\p{Mn}/gu, "")
    .replace(/[^\p{L}\p{N}_]+/gu, " ")
    .trim();

const comparar = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

export interface OmitidoPontos {
  abaixo_da_nota: number;
  duplicados: number;
  acima_do_teto: number;
  por_orcamento: number;
}

/**
 * Tira os pontos abaixo da nota, os repetidos (fica o de maior nota) e o que passa do teto de itens ou do orçamento de
 * tokens; ordena por nota e depois por similaridade da comunidade, sem depender da ordem de chegada. O melhor ponto entra
 * mesmo que estoure o orçamento.
 */
export function selecionarPontos(pontos: readonly Ponto[], notaMinima: number, k: number, tokens: number): { escolhidos: Ponto[]; omitido: OmitidoPontos } {
  const omitido: OmitidoPontos = { abaixo_da_nota: 0, duplicados: 0, acima_do_teto: 0, por_orcamento: 0 };
  const boas = pontos.filter((p) => {
    if (p.nota < notaMinima) {
      omitido.abaixo_da_nota++;
      return false;
    }
    return true;
  });
  const ordem = [...boas].sort((a, b) => b.nota - a.nota || b.similaridade - a.similaridade || comparar(a.comunidade, b.comunidade) || comparar(a.texto, b.texto));
  const melhor = new Map<string, Ponto>();
  for (const p of ordem) {
    const chave = chaveDoTexto(p.texto);
    if (melhor.has(chave)) omitido.duplicados++;
    else melhor.set(chave, p);
  }
  const ordenados = [...melhor.values()];
  omitido.acima_do_teto = Math.max(0, ordenados.length - k);
  const escolhidos: Ponto[] = [];
  let gasto = 0;
  for (const p of ordenados.slice(0, k)) {
    const custo = Math.max(1, Math.floor(p.texto.length / CARACTERES_POR_TOKEN));
    if (escolhidos.length > 0 && gasto + custo > tokens) {
      omitido.por_orcamento++;
      continue;
    }
    escolhidos.push(p);
    gasto += custo;
  }
  return { escolhidos, omitido };
}

// ---------- a ferramenta ----------

export interface OpcoesPanorama {
  limites?: Partial<Limites>;
  progresso?: (evento: EventoPanorama) => void;
  /** Relógio em segundos (monotônico); os testes põem um falso. */
  agora?: () => number;
  /** `false`: só os pontos, sem a síntese (padrão `true`). */
  reduce?: boolean;
}

export interface EnvelopePanorama extends Envelope {
  sintese: string | null;
  reduce: "ok" | "falhou" | "desligado" | "sem_pontos";
  nivel: number | null;
  comunidades: { consideradas: number; lotes: number; lotes_falhos: number };
  truncado_por_tempo: boolean;
  etapas_ms: { embedding_da_consulta?: number; mapa?: number; reduce?: number };
}

interface ResultadoLote {
  lote: Comunidade[];
  status: "ok" | "falhou" | "tempo";
  pontos: Ponto[];
  descartados: number;
}

const arredonda = (ms: number): number => Math.round(ms * 10) / 10;

export async function panorama(grafo: GrafoLeitura, llm: LlmDePanorama, pergunta: string, opcoes: OpcoesPanorama = {}): Promise<EnvelopePanorama> {
  const lim: Limites = { ...LIMITES_PANORAMA, ...(opcoes.limites ?? {}) };
  const agora = opcoes.agora ?? ((): number => performance.now() / 1000);
  const t0 = performance.now();
  const saida: EnvelopePanorama = {
    ...envelope("panorama", { pergunta, nivel: lim.nivel }),
    sintese: null,
    reduce: "sem_pontos",
    nivel: lim.nivel,
    comunidades: { consideradas: 0, lotes: 0, lotes_falhos: 0 },
    truncado_por_tempo: false,
    etapas_ms: {},
  };
  const fechar = (): EnvelopePanorama => {
    saida.latencia_ms = arredonda(performance.now() - t0);
    return saida;
  };
  if ((pergunta ?? "").trim() === "") {
    saida.erro = "pergunta_vazia";
    return fechar();
  }
  const inicio = agora();
  const avisa = (evento: EventoPanorama): void => {
    try {
      opcoes.progresso?.(evento);
    } catch {
      // um cliente que caiu não pode derrubar a busca
    }
  };

  let escolhidas: Comunidade[];
  try {
    const t = performance.now();
    const vetor = await llm.embeddingDeConsulta(pergunta);
    saida.etapas_ms.embedding_da_consulta = arredonda(performance.now() - t);
    const linhas = await grafo.consultar(CONSULTA, { k: VARREDURA, v: vetor, nivel: lim.nivel, rating: lim.rating, limite: lim.candidatas });
    escolhidas = escolherComunidades(linhas as unknown as Comunidade[], lim.nivel, lim.rating, lim.candidatas);
  } catch (e) {
    saida.erro = `falha_na_selecao: ${mensagemDe(e).slice(0, 150)}`;
    return fechar();
  }
  const total = escolhidas.length;
  saida.comunidades.consideradas = total;
  avisa({ fase: "selecao", comunidades_total: total, nivel: lim.nivel });
  if (total === 0) return fechar();

  const lotes = montarLotes(escolhidas, lim.lote_chars, lim.max_por_relatorio);
  saida.comunidades.lotes = lotes.length;
  const fimDoPrazo = inicio + lim.orcamento_s;

  const umLote = async (lote: Comunidade[]): Promise<ResultadoLote> => {
    if (agora() > fimDoPrazo) return { lote, status: "tempo", pontos: [], descartados: 0 };
    const { mensagens, etiquetas, esquema } = montarPedido(pergunta, lote, lim);
    for (let tentativa = 0; tentativa < TENTATIVAS_POR_LOTE; tentativa++) {
      try {
        const r = await llm.chatJson(mensagens, { perfil: "principal", temperatura: TEMPERATURA_MAPA, maxTokens: MAX_TOKENS_MAPA, timeoutMs: TIMEOUT_MAPA_MS, esquema });
        const { pontos, descartados } = validarPontos(r.valor, etiquetas);
        return { lote, status: "ok", pontos, descartados };
      } catch {
        // HTTP, JSON e esquema: tenta de novo uma vez
      }
    }
    return { lote, status: "falhou", pontos: [], descartados: 0 };
  };

  const tMapa = performance.now();
  const todos: Ponto[] = [];
  let feitas = 0;
  let lotesFeitos = 0;
  let lotesFalhos = 0;
  let porTempo = 0;
  let invalidos = 0;
  let proximo = 0;
  const trabalhador = async (): Promise<void> => {
    for (;;) {
      const i = proximo++;
      const lote = lotes[i];
      if (lote === undefined) return;
      const r = await umLote(lote);
      feitas += r.lote.length;
      lotesFeitos++;
      invalidos += r.descartados;
      if (r.status === "falhou") lotesFalhos++;
      else if (r.status === "tempo") porTempo += r.lote.length;
      todos.push(...r.pontos);
      avisa({
        fase: "mapa",
        comunidades_feitas: feitas,
        comunidades_total: total,
        lotes_feitos: lotesFeitos,
        lotes_total: lotes.length,
        status: r.status,
        titulos: r.lote.map((c) => c.title ?? ""),
        pontos: r.pontos.length,
      });
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(lim.paralelismo, lotes.length)) }, trabalhador));
  saida.etapas_ms.mapa = arredonda(performance.now() - tMapa);
  saida.comunidades.lotes_falhos = lotesFalhos;

  const { escolhidos, omitido } = selecionarPontos(todos, lim.nota_minima, lim.pontos, lim.tokens);
  saida.evidencias = escolhidos.map(
    (p, i): Evidencia => ({
      id: `${p.comunidade}#${i + 1}`,
      tipo: "ponto",
      paginas: "",
      caminho: `Comunidade (nível ${p.nivel}): ${p.titulo ?? ""}`,
      texto: p.texto,
      score: p.nota,
    }),
  );
  saida.omitido = {
    comunidades_por_tempo: porTempo,
    pontos_invalidos: invalidos,
    pontos_abaixo_da_nota: omitido.abaixo_da_nota,
    pontos_duplicados: omitido.duplicados,
    pontos_acima_do_teto: omitido.acima_do_teto,
    pontos_por_orcamento: omitido.por_orcamento,
  };
  saida.truncado_por_tempo = porTempo > 0;
  if (lotesFalhos === lotes.length) saida.erro = "todos os lotes do mapa falharam";

  if (escolhidos.length === 0) saida.reduce = "sem_pontos";
  else if (opcoes.reduce === false) saida.reduce = "desligado";
  else {
    avisa({ fase: "sintese", pontos: escolhidos.length });
    const tReduce = performance.now();
    const lista = escolhidos.map((p) => `- (${p.nota}/10) ${p.texto}`).join("\n");
    try {
      const r = await llm.chat(
        [
          { role: "system", content: SISTEMA_REDUCE },
          { role: "user", content: `Pergunta: ${pergunta}\n\nPontos:\n${lista}` },
        ],
        { perfil: "principal", temperatura: TEMPERATURA_REDUCE, maxTokens: MAX_TOKENS_REDUCE, timeoutMs: TIMEOUT_REDUCE_MS },
      );
      const texto = r.texto.trim();
      if (texto === "") throw new Error("síntese vazia");
      saida.sintese = texto;
      saida.reduce = "ok";
    } catch {
      saida.reduce = "falhou"; // sem a síntese ainda há os pontos
    }
    saida.etapas_ms.reduce = arredonda(performance.now() - tReduce);
  }
  avisa({ fase: "fim", pontos: escolhidos.length });
  return fechar();
}
