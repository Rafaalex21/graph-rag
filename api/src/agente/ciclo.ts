/**
 * Ciclo do agente com crítico (F7.4, ARQUITETURA §7.1, passos 1 a 4): uma rodada do agente (atualizador → roteador →
 * executor), o crítico e, só se ele pedir, UMA rodada extra com as perguntas que ele escreveu, seguida de uma última
 * crítica que já não pode pedir mais. Nunca passa de `MAX_RODADAS` (2) rodadas, por construção: não há laço.
 *
 * Estados finais (o redator da F7.5 escolhe o tom por eles):
 *  - `suficiente`: as evidências bastam;
 *  - `incompleta`: o crítico quis mais e não havia como (acabaram as rodadas ou não havia pergunta nova); `faltando` diz o quê;
 *  - `ausente`: o documento não trata do assunto; `faltando` diz o que não consta;
 *  - `sem_consulta`: nenhuma ferramenta foi chamada (saudação, fora do escopo, pergunta vazia); o crítico nem roda.
 *
 * Falha do crítico não derruba nem repete a pergunta (vira `suficiente`, anotada). Só o cancelamento do chamador sobe.
 */
import {
  executarAgente,
  type Anotacao,
  type EventoAgente,
  type EvidenciaDoAgente,
  type ExecutorDoAgente,
  type LlmDoAgente,
  type OpcoesAgente,
  type ResultadoAgente,
  type ResultadoSub,
  type TipoAnotacao,
} from "./agente.ts";
import { criticar, type Critica, type SubParaCritica } from "./critico.ts";

export const MAX_RODADAS = 2;

export type EstadoDoCiclo = "suficiente" | "incompleta" | "ausente" | "sem_consulta";

export interface EvidenciaDoCiclo extends EvidenciaDoAgente {
  rodada: number;
}

export type AnotacaoDoCiclo = Omit<Anotacao, "tipo"> & { tipo: TipoAnotacao | "fallback_do_critico"; rodada: number };

export interface RodadaDoCiclo {
  rodada: number;
  agente: ResultadoAgente;
  /** `null` quando não houve o que criticar (rota `nenhuma`). */
  critica: Critica | null;
}

export interface ResultadoCiclo {
  pergunta: string;
  autonoma: string;
  estado: EstadoDoCiclo;
  /** O que falta ou não consta, segundo a última crítica; vazio quando suficiente. */
  faltando: string;
  rodadas: RodadaDoCiclo[];
  /** Evidências das duas rodadas, sem repetição, com a rodada de origem; as com página primeiro (opção `paginasPrimeiro`). */
  evidencias: EvidenciaDoCiclo[];
  anotacoes: AnotacaoDoCiclo[];
  etapas_ms: { atualizar: number; rotear: number; executar: number; criticar: number; total: number };
  uso: { entrada: number; saida: number };
  erro: string | null;
}

export type EventoCiclo =
  | (EventoAgente & { rodada: number })
  | { fase: "critica"; rodada: number; decisao: Critica["decisao"]; perguntas: number; faltando: string; ms: number };

/** As opções do agente, menos as subperguntas prontas (a rodada extra é do ciclo) e com o progresso do ciclo. */
export type OpcoesCiclo = Omit<OpcoesAgente, "progresso" | "subperguntas"> & { progresso?: (evento: EventoCiclo) => void };

const arredonda = (ms: number) => Math.round(ms * 10) / 10;
const chaveDe = (e: { tipo: string; id: string }) => `${e.tipo}\u0000${e.id}`;

function paraCritica(subs: ResultadoSub[]): SubParaCritica[] {
  return subs.map((s) => {
    const ordenadas = [...s.evidencias.filter((e) => e.paginas !== ""), ...s.evidencias.filter((e) => e.paginas === "")];
    return {
      pergunta: s.pergunta,
      evidencias: ordenadas.map((e) => ({ tipo: e.tipo, paginas: e.paginas, texto: e.texto })),
      erros: s.execucoes.filter((x) => x.erro).map((x) => `${x.ferramenta}: ${x.erro}`),
    };
  });
}

export async function executarCiclo(llm: LlmDoAgente, executor: ExecutorDoAgente, pergunta: string, opcoes: OpcoesCiclo = {}): Promise<ResultadoCiclo> {
  const t0 = performance.now();
  const rodadas: RodadaDoCiclo[] = [];
  const emite = (evento: EventoCiclo): void => {
    try {
      opcoes.progresso?.(evento);
    } catch {
      // um cliente que caiu não pode derrubar a pergunta
    }
  };
  const rodar = async (rodada: number, extra: OpcoesAgente): Promise<ResultadoAgente> =>
    executarAgente(llm, executor, pergunta, {
      ...opcoes,
      ...extra,
      progresso: (e: EventoAgente) => emite({ ...e, rodada }),
    });
  const criticarAgora = async (rodada: number, podeBuscarMais: boolean): Promise<Critica> => {
    const subs = rodadas.flatMap((r) => r.agente.subperguntas);
    const c = await criticar(
      llm,
      { pergunta: rodadas[0]?.agente.autonoma ?? pergunta, subperguntas: paraCritica(subs), podeBuscarMais },
      opcoes.signal ? { signal: opcoes.signal } : {},
    );
    emite({ fase: "critica", rodada, decisao: c.decisao, perguntas: c.perguntas.length, faltando: c.faltando, ms: c.ms });
    return c;
  };

  const r1 = await rodar(1, {});
  rodadas.push({ rodada: 1, agente: r1, critica: null });
  let estado: EstadoDoCiclo = "sem_consulta";
  let faltando = "";

  if (!r1.erro && r1.rota === "ferramentas") {
    const c1 = await criticarAgora(1, true);
    (rodadas[0] as RodadaDoCiclo).critica = c1;
    let final = c1;
    if (c1.decisao === "buscar_mais") {
      const r2 = await rodar(2, { subperguntas: c1.perguntas.map((p) => ({ pergunta: p, dependeDe: [] })) });
      rodadas.push({ rodada: 2, agente: r2, critica: null });
      final = await criticarAgora(2, false);
      (rodadas[1] as RodadaDoCiclo).critica = final;
    }
    estado = final.decisao === "suficiente" ? "suficiente" : final.decisao === "ausente" ? "ausente" : "incompleta";
    faltando = final.faltando;
  }

  const vistas = new Set<string>();
  const planas: EvidenciaDoCiclo[] = [];
  for (const r of rodadas) {
    for (const e of r.agente.evidencias) {
      const k = chaveDe(e);
      if (vistas.has(k)) continue;
      vistas.add(k);
      planas.push({ ...e, rodada: r.rodada });
    }
  }
  const evidencias =
    opcoes.paginasPrimeiro ?? true ? [...planas.filter((e) => e.paginas !== ""), ...planas.filter((e) => e.paginas === "")] : planas;

  const anotacoes: AnotacaoDoCiclo[] = rodadas.flatMap((r) => [
    ...r.agente.anotacoes.map((a) => ({ ...a, rodada: r.rodada })),
    ...(r.critica && (r.critica.fallback === "llm_falhou" || r.critica.fallback === "resposta_invalida")
      ? [{ subpergunta: null, ferramenta: null, tipo: "fallback_do_critico" as const, detalhe: r.critica.fallback, rodada: r.rodada }]
      : []),
  ]);
  const soma = (f: (r: RodadaDoCiclo) => number) => arredonda(rodadas.reduce((s, r) => s + f(r), 0));
  const uso = { entrada: 0, saida: 0 };
  for (const r of rodadas) {
    uso.entrada += r.agente.uso.entrada + (r.critica?.uso.entrada ?? 0);
    uso.saida += r.agente.uso.saida + (r.critica?.uso.saida ?? 0);
  }
  return {
    pergunta: r1.pergunta,
    autonoma: r1.autonoma,
    estado,
    faltando,
    rodadas,
    evidencias,
    anotacoes,
    etapas_ms: {
      atualizar: soma((r) => r.agente.etapas_ms.atualizar),
      rotear: soma((r) => r.agente.etapas_ms.rotear),
      executar: soma((r) => r.agente.etapas_ms.executar),
      criticar: soma((r) => r.critica?.ms ?? 0),
      total: arredonda(performance.now() - t0),
    },
    uso,
    erro: r1.erro,
  };
}
