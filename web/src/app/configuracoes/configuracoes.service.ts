/**
 * As escolhas da tela Configurações (F8.6): o modo de recuperação e o perfil do ciclo. Ficam no `localStorage` do navegador
 * (chave `graphrag.config`) e valem para as perguntas seguintes. Um valor guardado que não é conhecido, ou um armazenamento
 * bloqueado, volta ao padrão sem erro: a página funciona e a escolha vale até recarregar.
 */
import { Injectable, signal } from '@angular/core';

export const MODOS = ['auto', 'trechos', 'tabelas', 'local', 'global', 'cypher'] as const;
export type Modo = (typeof MODOS)[number];
export const PERFIS = ['consultar', 'consultar-rapido'] as const;
export type Perfil = (typeof PERFIS)[number];

export const MODO_PADRAO: Modo = 'auto';
export const PERFIL_PADRAO: Perfil = 'consultar';
export const CHAVE_CONFIG = 'graphrag.config';

export interface OpcaoModo {
  valor: Modo;
  rotulo: string;
  descricao: string;
}

export interface OpcaoPerfil {
  valor: Perfil;
  rotulo: string;
  descricao: string;
}

/** Os rótulos são os que o usuário vê na tela e no Rastro ("Modo forçado: …"). */
export const OPCOES_MODO: readonly OpcaoModo[] = [
  { valor: 'auto', rotulo: 'Automático', descricao: 'O roteador escolhe a ferramenta de cada subpergunta. É o padrão.' },
  { valor: 'trechos', rotulo: 'Só trechos', descricao: 'Força buscar_trechos: a busca no texto do documento, por significado e por palavras.' },
  { valor: 'tabelas', rotulo: 'Só tabelas', descricao: 'Força buscar_tabelas: a busca nas tabelas do documento.' },
  { valor: 'local', rotulo: 'Entidades (busca local)', descricao: 'Força entidade: a pergunta vira o nome de uma entidade do grafo e volta o que o grafo sabe dela.' },
  { valor: 'global', rotulo: 'Panorama (busca global)', descricao: 'Força panorama: a visão geral do documento, a partir dos resumos de cada tema.' },
  { valor: 'cypher', rotulo: 'Consulta ao grafo (Cypher)', descricao: 'Força consultar_grafo: o modelo escreve uma consulta Cypher, só de leitura, e o grafo responde.' },
];

export const OPCOES_PERFIL: readonly OpcaoPerfil[] = [
  { valor: 'consultar', rotulo: 'Padrão', descricao: 'Até duas rodadas: se a crítica achar que falta algo, busca de novo antes de responder.' },
  { valor: 'consultar-rapido', rotulo: 'Rápido', descricao: 'Só uma rodada de busca. Responde mais cedo (cerca de metade do tempo) e pode ficar com respostas incompletas.' },
];

export const rotuloDoModo = (modo: string): string => OPCOES_MODO.find((o) => o.valor === modo)?.rotulo ?? modo;
export const rotuloDoPerfil = (perfil: string): string => OPCOES_PERFIL.find((o) => o.valor === perfil)?.rotulo ?? perfil;

const ehModo = (x: unknown): x is Modo => typeof x === 'string' && (MODOS as readonly string[]).includes(x);
const ehPerfil = (x: unknown): x is Perfil => typeof x === 'string' && (PERFIS as readonly string[]).includes(x);

function ler(): { modo: Modo; perfil: Perfil } {
  const padrao = { modo: MODO_PADRAO, perfil: PERFIL_PADRAO };
  try {
    const bruto = globalThis.localStorage.getItem(CHAVE_CONFIG);
    if (bruto === null) return padrao;
    const x: unknown = JSON.parse(bruto);
    if (typeof x !== 'object' || x === null) return padrao;
    const o = x as Record<string, unknown>;
    return { modo: ehModo(o['modo']) ? o['modo'] : MODO_PADRAO, perfil: ehPerfil(o['perfil']) ? o['perfil'] : PERFIL_PADRAO };
  } catch {
    return padrao;
  }
}

@Injectable({ providedIn: 'root' })
export class ConfiguracoesService {
  private readonly inicial = ler();
  readonly modo = signal<Modo>(this.inicial.modo);
  readonly perfil = signal<Perfil>(this.inicial.perfil);

  escolherModo(modo: Modo): void {
    this.modo.set(modo);
    this.guardar();
  }

  escolherPerfil(perfil: Perfil): void {
    this.perfil.set(perfil);
    this.guardar();
  }

  restaurar(): void {
    this.modo.set(MODO_PADRAO);
    this.perfil.set(PERFIL_PADRAO);
    this.guardar();
  }

  private guardar(): void {
    try {
      globalThis.localStorage.setItem(CHAVE_CONFIG, JSON.stringify({ modo: this.modo(), perfil: this.perfil() }));
    } catch {
      // armazenamento bloqueado: a escolha vale até recarregar
    }
  }
}
