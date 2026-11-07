/**
 * Agente (F7.11, ARQUITETURA §7.1, passos 1 a 3): atualizador → roteador → executor, em ondas, com `evidencias[]` por
 * subpergunta. É a cola das três peças já prontas: `atualizarPergunta` (F7.2) reescreve e decompõe, `rotearSubperguntas`
 * (F7.3) escolhe as ferramentas por onda (as independentes juntas, até 2, o `-np` do Qwen; as dependentes depois, com o
 * resumo da resposta de que precisam) e o executor (F7.8 a F7.10) roda as ferramentas escolhidas.
 *
 * O agente só recupera: não critica (F7.4) nem redige (F7.5). Devolve, para cada subpergunta, a rota, as chamadas, o que
 * cada ferramenta respondeu e as evidências, e uma lista plana e deduplicada de todas elas, na ordem das subperguntas e das
 * chamadas (nunca na de quem terminou primeiro).
 *
 * Nada aqui derruba a pergunta: ferramenta que devolve `erro` ou lança vira evidência vazia **anotada** (qual
 * subpergunta, qual ferramenta, qual erro); atualizador e roteador em caminho seguro e chamadas descartadas também ficam
 * nas anotações. Só o cancelamento do chamador sobe como erro. Cada etapa tem o seu tempo (aceite da F7.11).
 */
import type { ChamadaFerramenta, Envelope, Evidencia } from "../ferramentas/contrato.ts";
import { LlmAbortadoError } from "../llm/index.ts";
import { atualizarPergunta, type LlmDeJson, type PerguntaAtualizada, type SubPergunta, type Turno } from "./atualizador.ts";
import { rotearSubperguntas, type ChamadaRoteada, type LlmDeFerramentas, type SubRoteada } from "./roteador.ts";

export type LlmDoAgente = LlmDeJson & LlmDeFerramentas;

/** O que o agente pede ao executor de ferramentas (`criarExecutor` da F7.8 satisfaz). */
export interface ExecutorDoAgente {
  executar(chamada: ChamadaFerramenta): Promise<Envelope>;
}

export interface EvidenciaDoAgente extends Evidencia {
  /** Índice da subpergunta de onde veio. */
  subpergunta: number;
  ferramenta: string;
}

export interface Execucao {
  ferramenta: string;
  argumentos: Record<string, unknown>;
  erro: string | null;
  aviso: string | null;
  evidencias: number;
  omitido: Record<string, number>;
  /** Tempo medido pelo agente em volta da chamada. */
  ms: number;
  /** Tempo que a própria ferramenta registrou, quando ela registra. */
  latencia_ms: number | null;
  /** `true` na chamada a `buscar_trechos` que o agente acrescentou (opção `complementar`), não escolhida pelo roteador. */
  complemento: boolean;
  /** A consulta Cypher que `consultar_grafo` gerou e rodou, com o número de linhas; `null` nas outras ferramentas e quando nada rodou. */
  cypher: { query: string; linhas: number } | null;
}

export type TipoAnotacao = "erro_da_ferramenta" | "excecao" | "fallback_do_atualizador" | "fallback_do_roteador" | "chamada_descartada";

export interface Anotacao {
  /** `null` para o que não é de uma subpergunta só (o atualizador). */
  subpergunta: number | null;
  ferramenta: string | null;
  tipo: TipoAnotacao;
  detalhe: string;
}

export interface ResultadoSub {
  indice: number;
  pergunta: string;
  dependeDe: number[];
  onda: number;
  rota: "ferramentas" | "nenhuma";
  chamadas: ChamadaRoteada[];
  /** O que o roteador disse sem chamar ferramenta (rota `nenhuma`). */
  texto: string;
  execucoes: Execucao[];
  evidencias: EvidenciaDoAgente[];
  /** O que vai ao roteador das subperguntas que dependem desta; `null` se não houve evidência com texto. */
  resumo: string | null;
  ms: { rotear: number; executar: number };
}

export interface ResultadoAgente {
  pergunta: string;
  autonoma: string;
  /** `nenhuma` só quando todas as subperguntas foram sem ferramenta (saudação, fora do escopo, pergunta vazia). */
  rota: "ferramentas" | "nenhuma";
  texto: string;
  atualizacao: { fallback: string | null; subperguntas: number; ms: number; erro?: string };
  subperguntas: ResultadoSub[];
  /** Todas as evidências, sem repetição, na ordem das subperguntas e das chamadas. */
  evidencias: EvidenciaDoAgente[];
  anotacoes: Anotacao[];
  /** Tempo de trabalho de cada etapa (soma entre subperguntas) e o tempo de parede da pergunta. */
  etapas_ms: { atualizar: number; rotear: number; executar: number; total: number };
  uso: { entrada: number; saida: number };
  erro: string | null;
}

export type EventoAgente =
  | { fase: "atualizacao"; subperguntas: number; fallback: string | null; ms: number }
  | { fase: "roteamento"; indice: number; onda: number; rota: "ferramentas" | "nenhuma"; ferramentas: string[]; fallback: string | null; ms: number }
  | { fase: "execucao"; indice: number; ferramentas: { ferramenta: string; erro: string | null; evidencias: number; ms: number; cypher: Execucao["cypher"] }[]; evidencias: number; ms: number }
  | { fase: "fim"; evidencias: number; ms: number };

export interface OpcoesAgente {
  historico?: Turno[];
  /** Subperguntas roteadas e executadas ao mesmo tempo. Padrão 2, o `-np` do Qwen. */
  concorrencia?: number;
  companhia?: string;
  signal?: AbortSignal;
  progresso?: (evento: EventoAgente) => void;
  /**
   * Acrescenta uma busca de trechos (`buscar_trechos`) à subpergunta roteada só para ferramentas especializadas, em
   * paralelo, com as evidências dela **depois** das da ferramenta escolhida. Serve para a resposta ter sempre passagens
   * com página para citar (o `panorama` e vários caminhos de grafo devolvem evidência sem página). Não se aplica à rota
   * `nenhuma`, a quem já chama `buscar_trechos` e a `resposta_ja_dada` (a resposta está na conversa). Padrão: ligado
   * (desde a v3 do ADR-059; foi introduzida, desligada, DEPOIS da primeira medida da F7.11, que fica no relatório).
   */
  complementar?: boolean;
  /**
   * Na lista plana `evidencias`, as evidências com página vêm antes das sem página (ordem estável dentro de cada grupo),
   * porque o redator só cita página e o `panorama` e alguns caminhos de grafo devolvem evidência sem ela. Não reordena
   * as evidências de cada subpergunta. Padrão: ligado (v3 do ADR-059, decidida depois de ver as rodadas 1 e 2).
   */
  paginasPrimeiro?: boolean;
  /**
   * Subperguntas já prontas: o atualizador não roda e elas vão direto ao roteador. É a rodada extra do crítico (F7.4),
   * cujas perguntas já saem autônomas.
   */
  subperguntas?: SubPergunta[];
}

const SEM_COMPLEMENTO = new Set(["buscar_trechos", "resposta_ja_dada"]);

const MAX_EVIDENCIAS_NO_RESUMO = 3;
const MAX_CARACTERES_POR_EVIDENCIA = 180;
const MAX_CARACTERES_DO_RESUMO = 600;

const compacta = (t: string) => t.replace(/\s+/g, " ").trim();

/**
 * O resumo da resposta de uma subpergunta para o roteador das que dependem dela: as 3 primeiras evidências com texto,
 * cada uma cortada, com a página quando há. `null` se nenhuma tem texto (não vira "resposta anterior" vazia).
 */
export function resumirEvidencias(evidencias: readonly Evidencia[]): string | null {
  const linhas: string[] = [];
  for (const e of evidencias) {
    const t = compacta(e.texto);
    if (t === "") continue;
    const corte = t.length > MAX_CARACTERES_POR_EVIDENCIA ? `${t.slice(0, MAX_CARACTERES_POR_EVIDENCIA).trimEnd()}…` : t;
    linhas.push(e.paginas ? `[${e.paginas}] ${corte}` : corte);
    if (linhas.length >= MAX_EVIDENCIAS_NO_RESUMO) break;
  }
  if (linhas.length === 0) return null;
  const junto = linhas.join("\n");
  return junto.length > MAX_CARACTERES_DO_RESUMO ? junto.slice(0, MAX_CARACTERES_DO_RESUMO) : junto;
}

const mensagemDe = (e: unknown): string => (e instanceof Error ? e.message : String(e));
const arredonda = (ms: number) => Math.round(ms * 10) / 10;
const chaveDaEvidencia = (e: Evidencia) => `${e.tipo}\u0000${e.id}`;

/** `consultar_grafo` põe `cypher` e `linhas` no envelope; as outras ferramentas não. */
function cypherDe(r: Envelope): Execucao["cypher"] {
  const x = r as Envelope & { cypher?: unknown; linhas?: unknown };
  return typeof x.cypher === "string" && x.cypher.trim() !== "" ? { query: x.cypher, linhas: Array.isArray(x.linhas) ? x.linhas.length : 0 } : null;
}

async function executarChamada(executor: ExecutorDoAgente, chamada: ChamadaRoteada, complemento = false): Promise<{ execucao: Execucao; evidencias: Evidencia[]; excecao: boolean }> {
  const t = performance.now();
  try {
    const r = await executor.executar({ nome: chamada.nome, argumentos: chamada.argumentos });
    return {
      execucao: {
        ferramenta: chamada.nome,
        argumentos: chamada.argumentos,
        erro: r.erro,
        aviso: r.aviso,
        evidencias: r.evidencias.length,
        omitido: r.omitido,
        ms: arredonda(performance.now() - t),
        latencia_ms: typeof r.latencia_ms === "number" ? r.latencia_ms : null,
        complemento,
        cypher: cypherDe(r),
      },
      evidencias: r.evidencias,
      excecao: false,
    };
  } catch (e) {
    if (e instanceof LlmAbortadoError) throw e;
    return {
      execucao: { ferramenta: chamada.nome, argumentos: chamada.argumentos, erro: mensagemDe(e), aviso: null, evidencias: 0, omitido: {}, ms: arredonda(performance.now() - t), latencia_ms: null, complemento, cypher: null },
      evidencias: [],
      excecao: true,
    };
  }
}

interface Parcial {
  execucoes: Execucao[];
  evidencias: Evidencia[][];
  excecoes: Set<string>;
  msExecutar: number;
}

export async function executarAgente(llm: LlmDoAgente, executor: ExecutorDoAgente, pergunta: string, opcoes: OpcoesAgente = {}): Promise<ResultadoAgente> {
  const t0 = performance.now();
  const original = pergunta.trim();
  const avisa = (evento: EventoAgente): void => {
    try {
      opcoes.progresso?.(evento);
    } catch {
      // um cliente que caiu não pode derrubar a pergunta
    }
  };
  const vazio: ResultadoAgente = {
    pergunta: original,
    autonoma: original,
    rota: "nenhuma",
    texto: "",
    atualizacao: { fallback: null, subperguntas: 0, ms: 0 },
    subperguntas: [],
    evidencias: [],
    anotacoes: [],
    etapas_ms: { atualizar: 0, rotear: 0, executar: 0, total: 0 },
    uso: { entrada: 0, saida: 0 },
    erro: null,
  };
  if (original === "") return { ...vazio, erro: "pergunta_vazia" };

  const atualizada: PerguntaAtualizada = opcoes.subperguntas
    ? { original, autonoma: original, subperguntas: opcoes.subperguntas, fallback: null, uso: { entrada: 0, saida: 0 }, ms: 0 }
    : await atualizarPergunta(llm, original, opcoes.historico ?? [], opcoes.signal ? { signal: opcoes.signal } : {});
  const subperguntas: SubPergunta[] = atualizada.subperguntas.length > 0 ? atualizada.subperguntas : [{ pergunta: original, dependeDe: [] }];
  avisa({ fase: "atualizacao", subperguntas: subperguntas.length, fallback: atualizada.fallback, ms: atualizada.ms });

  const parciais = new Map<number, Parcial>();
  const roteadas = await rotearSubperguntas(llm, subperguntas, {
    ...(opcoes.concorrencia !== undefined ? { concorrencia: opcoes.concorrencia } : {}),
    ...(opcoes.historico ? { historico: opcoes.historico } : {}),
    ...(opcoes.companhia ? { companhia: opcoes.companhia } : {}),
    ...(opcoes.signal ? { signal: opcoes.signal } : {}),
    executar: async (sub: SubRoteada) => {
      const rot = sub.roteamento;
      avisa({ fase: "roteamento", indice: sub.indice, onda: sub.onda, rota: rot.rota, ferramentas: rot.chamadas.map((c) => c.nome), fallback: rot.fallback, ms: rot.ms });
      const inicio = performance.now();
      const complemento =
        (opcoes.complementar ?? true) && rot.chamadas.length > 0 && !rot.chamadas.some((c) => SEM_COMPLEMENTO.has(c.nome))
          ? [{ nome: "buscar_trechos", argumentos: { pergunta: sub.pergunta } } satisfies ChamadaRoteada]
          : [];
      const feitas = await Promise.all([...rot.chamadas.map((c) => executarChamada(executor, c)), ...complemento.map((c) => executarChamada(executor, c, true))]);
      const msExecutar = arredonda(performance.now() - inicio);
      const parcial: Parcial = {
        execucoes: feitas.map((f) => f.execucao),
        evidencias: feitas.map((f) => f.evidencias),
        excecoes: new Set(feitas.filter((f) => f.excecao).map((f) => f.execucao.ferramenta)),
        msExecutar,
      };
      parciais.set(sub.indice, parcial);
      if (rot.chamadas.length > 0) {
        avisa({
          fase: "execucao",
          indice: sub.indice,
          ferramentas: parcial.execucoes.map((e) => ({ ferramenta: e.ferramenta, erro: e.erro, evidencias: e.evidencias, ms: e.ms, cypher: e.cypher })),
          evidencias: parcial.evidencias.reduce((s, l) => s + l.length, 0),
          ms: msExecutar,
        });
      }
      const resumo = resumirEvidencias(dedup(parcial.evidencias.flat()));
      return resumo ?? undefined;
    },
  });

  const anotacoes: Anotacao[] = [];
  if (atualizada.fallback) anotacoes.push({ subpergunta: null, ferramenta: null, tipo: "fallback_do_atualizador", detalhe: atualizada.fallback });
  const vistas = new Set<string>();
  const planas: EvidenciaDoAgente[] = [];
  const resultados: ResultadoSub[] = roteadas.map((sub) => {
    const rot = sub.roteamento;
    const p = parciais.get(sub.indice) ?? { execucoes: [], evidencias: [], excecoes: new Set<string>(), msExecutar: 0 };
    if (rot.fallback) anotacoes.push({ subpergunta: sub.indice, ferramenta: null, tipo: "fallback_do_roteador", detalhe: rot.fallback });
    for (const d of rot.descartadas) anotacoes.push({ subpergunta: sub.indice, ferramenta: d.nome, tipo: "chamada_descartada", detalhe: d.motivo });
    p.execucoes.forEach((e) => {
      if (e.erro) anotacoes.push({ subpergunta: sub.indice, ferramenta: e.ferramenta, tipo: p.excecoes.has(e.ferramenta) ? "excecao" : "erro_da_ferramenta", detalhe: e.erro });
    });
    const proprias: EvidenciaDoAgente[] = [];
    const daSub = new Set<string>();
    p.evidencias.forEach((lista, i) => {
      const ferramenta = p.execucoes[i]?.ferramenta ?? "";
      for (const e of lista) {
        const k = chaveDaEvidencia(e);
        if (daSub.has(k)) continue;
        daSub.add(k);
        const marcada: EvidenciaDoAgente = { ...e, subpergunta: sub.indice, ferramenta };
        proprias.push(marcada);
        if (!vistas.has(k)) {
          vistas.add(k);
          planas.push(marcada);
        }
      }
    });
    return {
      indice: sub.indice,
      pergunta: sub.pergunta,
      dependeDe: sub.dependeDe,
      onda: sub.onda,
      rota: rot.rota,
      chamadas: rot.chamadas,
      texto: rot.texto,
      execucoes: p.execucoes,
      evidencias: proprias,
      resumo: resumirEvidencias(proprias),
      ms: { rotear: rot.ms, executar: p.msExecutar },
    };
  });

  if (opcoes.paginasPrimeiro ?? true) {
    const com = planas.filter((e) => e.paginas !== "");
    const sem = planas.filter((e) => e.paginas === "");
    planas.splice(0, planas.length, ...com, ...sem);
  }

  const nenhuma = resultados.length > 0 && resultados.every((r) => r.rota === "nenhuma");
  const uso = { entrada: atualizada.uso.entrada, saida: atualizada.uso.saida };
  for (const s of roteadas) {
    uso.entrada += s.roteamento.uso.entrada;
    uso.saida += s.roteamento.uso.saida;
  }
  const total = arredonda(performance.now() - t0);
  avisa({ fase: "fim", evidencias: planas.length, ms: total });
  return {
    pergunta: original,
    autonoma: atualizada.autonoma,
    rota: nenhuma ? "nenhuma" : "ferramentas",
    texto: resultados.map((r) => r.texto).find((t) => t !== "") ?? "",
    atualizacao: { fallback: atualizada.fallback, subperguntas: subperguntas.length, ms: atualizada.ms, ...(atualizada.erro ? { erro: atualizada.erro } : {}) },
    subperguntas: resultados,
    evidencias: planas,
    anotacoes,
    etapas_ms: {
      atualizar: atualizada.ms,
      rotear: arredonda(resultados.reduce((s, r) => s + r.ms.rotear, 0)),
      executar: arredonda(resultados.reduce((s, r) => s + r.ms.executar, 0)),
      total,
    },
    uso,
    erro: null,
  };
}

/** Tira as repetidas (mesmo tipo e id), mantendo a primeira. */
function dedup(evidencias: readonly Evidencia[]): Evidencia[] {
  const vistas = new Set<string>();
  return evidencias.filter((e) => {
    const k = chaveDaEvidencia(e);
    if (vistas.has(k)) return false;
    vistas.add(k);
    return true;
  });
}
