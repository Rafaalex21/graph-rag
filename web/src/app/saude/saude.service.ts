/**
 * O estado do sistema para o selo de saúde (F8.7): consulta `GET /api/saude` ao abrir, a cada 30 s e sob demanda.
 * Três estados além de "verificando": `ok` (llama-swap, Neo4j e todos os índices no ar), `degradado` (a API respondeu, mas
 * alguma parte não está bem) e `fora` (a API não respondeu ou deu um corpo que não é o do contrato). O corpo é conferido campo
 * a campo: o que vem da API só entra na tela como texto.
 */
import { Injectable, signal } from '@angular/core';

export type EstadoSelo = 'verificando' | 'ok' | 'degradado' | 'fora';
export type EstadoParte = 'ok' | 'indisponivel' | 'nao_configurado';

export interface ParteSaude {
  estado: EstadoParte;
  ms: number;
}

export interface Saude {
  llm: ParteSaude;
  modelos: { nome: string; carregado: boolean }[];
  neo4j: ParteSaude;
  indices: { nome: string; estado: string }[];
}

/** Por que o selo está em `fora`: a API não respondeu, ou respondeu algo que não é o contrato. */
export type MotivoFora = 'sem_resposta' | 'inesperada';

export const INTERVALO_MS = 30_000;
export const TEMPO_MAXIMO_MS = 10_000;

const objeto = (x: unknown): x is Record<string, unknown> => typeof x === 'object' && x !== null && !Array.isArray(x);
const ehParte = (x: unknown): x is ParteSaude =>
  objeto(x) && (x['estado'] === 'ok' || x['estado'] === 'indisponivel' || x['estado'] === 'nao_configurado') && typeof x['ms'] === 'number' && Number.isFinite(x['ms']);

/** O corpo do contrato (`Saude`) ou `null` se qualquer campo estiver fora do formato. */
export function lerSaude(corpo: unknown): Saude | null {
  if (!objeto(corpo) || !ehParte(corpo['llm']) || !ehParte(corpo['neo4j']) || !Array.isArray(corpo['modelos']) || !Array.isArray(corpo['indices'])) return null;
  const modelos: Saude['modelos'] = [];
  for (const m of corpo['modelos']) {
    if (!objeto(m) || typeof m['nome'] !== 'string' || typeof m['carregado'] !== 'boolean') return null;
    modelos.push({ nome: m['nome'], carregado: m['carregado'] });
  }
  const indices: Saude['indices'] = [];
  for (const i of corpo['indices']) {
    if (!objeto(i) || typeof i['nome'] !== 'string' || typeof i['estado'] !== 'string') return null;
    indices.push({ nome: i['nome'], estado: i['estado'] });
  }
  return { llm: corpo['llm'], neo4j: corpo['neo4j'], modelos, indices };
}

/** `ok` só se llama-swap, Neo4j e todos os índices estão no ar. */
export const estadoDe = (s: Saude): EstadoSelo => (s.llm.estado === 'ok' && s.neo4j.estado === 'ok' && s.indices.every((i) => i.estado === 'ONLINE') ? 'ok' : 'degradado');

@Injectable({ providedIn: 'root' })
export class SaudeService {
  readonly estado = signal<EstadoSelo>('verificando');
  readonly saude = signal<Saude | null>(null);
  readonly motivoFora = signal<MotivoFora | null>(null);

  private emCurso: Promise<void> | null = null;

  constructor() {
    void this.verificar();
    setInterval(() => void this.verificar(), INTERVALO_MS);
  }

  /** Consulta agora. Se já há uma consulta em curso, espera por ela em vez de empilhar outra. */
  verificar(): Promise<void> {
    this.emCurso ??= this.consultar().finally(() => (this.emCurso = null));
    return this.emCurso;
  }

  private async consultar(): Promise<void> {
    const ac = new AbortController();
    const prazo = setTimeout(() => ac.abort(), TEMPO_MAXIMO_MS);
    try {
      const r = await fetch('/api/saude', { signal: ac.signal, headers: { accept: 'application/json' } });
      if (!r.ok) return this.fora('sem_resposta');
      let corpo: unknown;
      try {
        corpo = await r.json();
      } catch {
        return this.fora('sem_resposta');
      }
      const s = lerSaude(corpo);
      if (!s) return this.fora('inesperada');
      this.saude.set(s);
      this.motivoFora.set(null);
      this.estado.set(estadoDe(s));
    } catch {
      this.fora('sem_resposta');
    } finally {
      clearTimeout(prazo);
    }
  }

  private fora(motivo: MotivoFora): void {
    this.saude.set(null);
    this.motivoFora.set(motivo);
    this.estado.set('fora');
  }
}
