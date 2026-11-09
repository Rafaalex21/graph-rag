/**
 * Dos eventos SSE de uma resposta (`etapa`, `cypher`, `evidencia`, `fim`, `erro`; os `token` não entram) para os passos da linha
 * do tempo do painel Rastro (F8.3, ARQUITETURA §11.1 e §12). Função pura. O `detalhe` das etapas é livre no contrato, então cada
 * campo é conferido: um campo que falta ou veio com outro tipo vira "sem dado" e o passo continua aparecendo.
 */
import type { Citacao, EventoChat, MetricasDoFim } from './chat-api';

export interface EvidenciaRastro {
  id: string;
  tipo: string;
  pagina: string | null;
  /** O número da primeira página do rótulo (`p. 9-10` → `9`), para abrir a aba Fontes. */
  primeiraPagina: string | null;
  trecho: string;
  score: number;
}

export type PassoRastro =
  | { tipo: 'reescrita-inicio' }
  | { tipo: 'reescrita'; rodada: number | null; subperguntas: number | null; fallback: string | null; ms: number | null }
  | { tipo: 'rota'; rodada: number | null; rota: string; ferramentas: string[]; fallback: string | null; ms: number | null }
  | { tipo: 'ferramenta_inicio'; rodada: number | null; ferramenta: string }
  | { tipo: 'ferramenta_fim'; rodada: number | null; ferramenta: string; erro: string | null; evidencias: number | null; ms: number | null }
  | { tipo: 'cypher'; query: string; linhas: number; ms: number }
  | { tipo: 'critica'; rodada: number | null; decisao: string; perguntas: number | null; faltando: string; ms: number | null }
  | { tipo: 'reparo'; frases: number }
  | { tipo: 'evidencias'; evidencias: EvidenciaRastro[] }
  | { tipo: 'fim'; metricas: MetricasDoFim; citacoes: Citacao[] }
  | { tipo: 'erro'; codigo: string; mensagem: string };

const objeto = (x: unknown): x is Record<string, unknown> => typeof x === 'object' && x !== null && !Array.isArray(x);
const numero = (x: unknown): number | null => (typeof x === 'number' && Number.isFinite(x) ? x : null);
const texto = (x: unknown): string | null => (typeof x === 'string' && x !== '' ? x : null);

/** `p. 9-10` → `9`; `p. 6, 9` → `6`; sem número → `null`. */
export function primeiraPagina(rotulo: string | null): string | null {
  return rotulo === null ? null : (/\d+/.exec(rotulo)?.[0] ?? null);
}

function etapa(tipo: string, d: Record<string, unknown>): PassoRastro | null {
  switch (tipo) {
    case 'reescrita':
      if (d['estado'] === 'inicio') return { tipo: 'reescrita-inicio' };
      return { tipo: 'reescrita', rodada: numero(d['rodada']), subperguntas: numero(d['subperguntas']), fallback: texto(d['fallback']), ms: numero(d['ms']) };
    case 'rota':
      return {
        tipo: 'rota',
        rodada: numero(d['rodada']),
        rota: texto(d['rota']) ?? 'desconhecida',
        ferramentas: Array.isArray(d['ferramentas']) ? d['ferramentas'].filter((f): f is string => typeof f === 'string') : [],
        fallback: texto(d['fallback']),
        ms: numero(d['ms']),
      };
    case 'ferramenta_inicio':
      return { tipo: 'ferramenta_inicio', rodada: numero(d['rodada']), ferramenta: texto(d['ferramenta']) ?? 'ferramenta' };
    case 'ferramenta_fim':
      return { tipo: 'ferramenta_fim', rodada: numero(d['rodada']), ferramenta: texto(d['ferramenta']) ?? 'ferramenta', erro: texto(d['erro']), evidencias: numero(d['evidencias']), ms: numero(d['ms']) };
    case 'critica':
      return { tipo: 'critica', rodada: numero(d['rodada']), decisao: texto(d['decisao']) ?? 'desconhecida', perguntas: numero(d['perguntas']), faltando: texto(d['faltando']) ?? '', ms: numero(d['ms']) };
    case 'reparo':
      return { tipo: 'reparo', frases: Array.isArray(d['frases']) ? d['frases'].length : 0 };
    default:
      return null;
  }
}

/** Os passos, na ordem em que os eventos chegaram. As evidências (que chegam juntas) viram um passo só, na posição da primeira. */
export function montarRastro(eventos: readonly EventoChat[]): PassoRastro[] {
  const passos: PassoRastro[] = [];
  let evidencias: EvidenciaRastro[] | null = null;
  for (const e of eventos) {
    if (e.evento === 'etapa') {
      const p = objeto(e.dados.detalhe) ? etapa(e.dados.tipo, e.dados.detalhe) : null;
      if (p) passos.push(p);
    } else if (e.evento === 'cypher') {
      passos.push({ tipo: 'cypher', query: e.dados.query, linhas: e.dados.linhas, ms: e.dados.ms });
    } else if (e.evento === 'evidencia') {
      if (!evidencias) {
        evidencias = [];
        passos.push({ tipo: 'evidencias', evidencias });
      }
      evidencias.push({ id: e.dados.id, tipo: e.dados.tipo, pagina: e.dados.pagina, primeiraPagina: primeiraPagina(e.dados.pagina), trecho: e.dados.trecho, score: e.dados.score });
    } else if (e.evento === 'fim') {
      if (!evidencias) passos.push({ tipo: 'evidencias', evidencias: [] }); // chegou ao fim sem nenhuma evidência
      passos.push({ tipo: 'fim', metricas: e.dados.metricas, citacoes: e.dados.citacoes });
    } else if (e.evento === 'erro') {
      passos.push({ tipo: 'erro', codigo: e.dados.codigo, mensagem: e.dados.mensagem });
    }
  }
  return passos;
}
