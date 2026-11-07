/**
 * Testes do tema claro/escuro (F8.1), escritos antes do código. Modos de falha:
 *
 *  1. valor salvo inválido ou adulterado vira "sistema", nunca quebra nem aplica lixo;
 *  2. `localStorage` que lança (janela privada, dados bloqueados) não derruba a leitura nem a gravação;
 *  3. navegador sem `matchMedia` (jsdom, ambiente antigo) cai em "claro", sem lançar;
 *  4. em "sistema" o tema segue a mudança do sistema; com escolha explícita, a mudança do sistema é ignorada;
 *  5. o atributo `data-theme` só existe com escolha explícita (em "sistema" quem decide é o CSS);
 *  6. o ciclo passa pelos três estados e volta, e a escolha é gravada.
 */
import { TestBed } from '@angular/core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TemaService } from './tema.service';

type Ouvinte = (e: { matches: boolean }) => void;

function sistema(escuro: boolean) {
  const ouvintes = new Set<Ouvinte>();
  const mql = {
    matches: escuro,
    addEventListener: (_: string, f: Ouvinte) => ouvintes.add(f),
    removeEventListener: (_: string, f: Ouvinte) => ouvintes.delete(f),
  };
  vi.stubGlobal('matchMedia', () => mql);
  (window as unknown as { matchMedia: unknown }).matchMedia = () => mql;
  return {
    mudarPara: (e: boolean) => {
      mql.matches = e;
      ouvintes.forEach((f) => f({ matches: e }));
    },
    ouvintes,
  };
}

const raiz = () => document.documentElement;

describe('TemaService', () => {
  beforeEach(() => {
    localStorage.clear();
    raiz().removeAttribute('data-theme');
    TestBed.resetTestingModule();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    delete (window as unknown as { matchMedia?: unknown }).matchMedia;
  });

  it('sem nada salvo: preferência "sistema" e nenhum data-theme', () => {
    sistema(false);
    const t = TestBed.inject(TemaService);
    expect(t.preferencia()).toBe('sistema');
    expect(raiz().hasAttribute('data-theme')).toBe(false);
  });

  it.each([
    ['claro', 'light'],
    ['escuro', 'dark'],
  ])('valor salvo "%s" é aplicado na criação (data-theme=%s)', (salvo, attr) => {
    sistema(false);
    localStorage.setItem('graphrag.tema', salvo);
    const t = TestBed.inject(TemaService);
    expect(t.preferencia()).toBe(salvo);
    expect(raiz().getAttribute('data-theme')).toBe(attr);
  });

  it.each(['roxo', '', 'ESCURO', '{"a":1}', '<script>'])('valor salvo inválido %j vira "sistema"', (salvo) => {
    sistema(true);
    localStorage.setItem('graphrag.tema', salvo);
    const t = TestBed.inject(TemaService);
    expect(t.preferencia()).toBe('sistema');
    expect(raiz().hasAttribute('data-theme')).toBe(false);
  });

  it('localStorage que lança na leitura e na gravação: o serviço funciona e só deixa de lembrar', () => {
    sistema(false);
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('bloqueado');
    });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('bloqueado');
    });
    const t = TestBed.inject(TemaService);
    expect(t.preferencia()).toBe('sistema');
    expect(() => t.definir('escuro')).not.toThrow();
    expect(t.preferencia()).toBe('escuro');
    expect(raiz().getAttribute('data-theme')).toBe('dark');
  });

  it('sem matchMedia: o tema efetivo é "claro" e nada lança', () => {
    delete (window as unknown as { matchMedia?: unknown }).matchMedia;
    const t = TestBed.inject(TemaService);
    expect(t.efetivo()).toBe('claro');
  });

  it('em "sistema", o tema efetivo é o do sistema e acompanha a mudança dele', () => {
    const s = sistema(true);
    const t = TestBed.inject(TemaService);
    expect(t.efetivo()).toBe('escuro');
    s.mudarPara(false);
    expect(t.efetivo()).toBe('claro');
  });

  it('com escolha explícita, a mudança do sistema é ignorada', () => {
    const s = sistema(false);
    const t = TestBed.inject(TemaService);
    t.definir('escuro');
    s.mudarPara(false);
    s.mudarPara(true);
    expect(t.efetivo()).toBe('escuro');
    t.definir('claro');
    expect(t.efetivo()).toBe('claro');
  });

  it('o ciclo vai sistema → claro → escuro → sistema, grava cada escolha e limpa o atributo ao voltar', () => {
    sistema(false);
    const t = TestBed.inject(TemaService);
    t.alternar();
    expect(t.preferencia()).toBe('claro');
    expect(localStorage.getItem('graphrag.tema')).toBe('claro');
    expect(raiz().getAttribute('data-theme')).toBe('light');
    t.alternar();
    expect(t.preferencia()).toBe('escuro');
    expect(raiz().getAttribute('data-theme')).toBe('dark');
    t.alternar();
    expect(t.preferencia()).toBe('sistema');
    expect(localStorage.getItem('graphrag.tema')).toBe('sistema');
    expect(raiz().hasAttribute('data-theme')).toBe(false);
  });

  it('definir recusa um valor fora dos três e mantém o atual', () => {
    sistema(false);
    const t = TestBed.inject(TemaService);
    t.definir('escuro');
    t.definir('roxo' as never);
    expect(t.preferencia()).toBe('escuro');
    expect(localStorage.getItem('graphrag.tema')).toBe('escuro');
  });

  it('ao destruir o serviço, o ouvinte do sistema é removido (sem vazamento)', () => {
    const s = sistema(false);
    TestBed.inject(TemaService);
    expect(s.ouvintes.size).toBe(1);
    TestBed.resetTestingModule();
    expect(s.ouvintes.size).toBe(0);
  });
});
