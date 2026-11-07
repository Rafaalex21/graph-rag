import { DOCUMENT } from '@angular/common';
import { DestroyRef, Injectable, computed, inject, signal } from '@angular/core';

export type Preferencia = 'sistema' | 'claro' | 'escuro';

const CHAVE = 'graphrag.tema';
const ORDEM: readonly Preferencia[] = ['sistema', 'claro', 'escuro'];
const ATRIBUTO: Record<Exclude<Preferencia, 'sistema'>, 'light' | 'dark'> = { claro: 'light', escuro: 'dark' };

const valida = (v: unknown): v is Preferencia => typeof v === 'string' && (ORDEM as readonly string[]).includes(v);

/**
 * O tema da interface. A preferência é "sistema" (segue o `prefers-color-scheme`), "claro" ou "escuro" e fica no
 * `localStorage` (se ele falhar, vale só nesta aba). O atributo `data-theme` do `<html>` só existe com escolha explícita:
 * em "sistema" quem decide é o CSS (`styles.scss`).
 */
@Injectable({ providedIn: 'root' })
export class TemaService {
  private readonly doc = inject(DOCUMENT);

  readonly preferencia = signal<Preferencia>(this.lerSalva());
  private readonly sistemaEscuro = signal(false);

  /** O tema que está valendo agora, já resolvido. */
  readonly efetivo = computed<'claro' | 'escuro'>(() => {
    const p = this.preferencia();
    if (p !== 'sistema') return p;
    return this.sistemaEscuro() ? 'escuro' : 'claro';
  });

  constructor() {
    const mql = this.doc.defaultView?.matchMedia?.('(prefers-color-scheme: dark)');
    if (mql) {
      this.sistemaEscuro.set(mql.matches);
      const ouvir = (e: { matches: boolean }) => this.sistemaEscuro.set(e.matches);
      mql.addEventListener('change', ouvir);
      inject(DestroyRef).onDestroy(() => mql.removeEventListener('change', ouvir));
    }
    this.aplicar(this.preferencia());
  }

  definir(p: Preferencia): void {
    if (!valida(p)) return;
    this.preferencia.set(p);
    this.aplicar(p);
    try {
      this.doc.defaultView?.localStorage.setItem(CHAVE, p);
    } catch {
      // janela privada ou dados do site bloqueados: a escolha vale só até fechar a aba
    }
  }

  /** sistema → claro → escuro → sistema. */
  alternar(): void {
    this.definir(ORDEM[(ORDEM.indexOf(this.preferencia()) + 1) % ORDEM.length] as Preferencia);
  }

  private lerSalva(): Preferencia {
    try {
      const v = this.doc.defaultView?.localStorage.getItem(CHAVE);
      return valida(v) ? v : 'sistema';
    } catch {
      return 'sistema';
    }
  }

  private aplicar(p: Preferencia): void {
    const raiz = this.doc.documentElement;
    if (p === 'sistema') raiz.removeAttribute('data-theme');
    else raiz.setAttribute('data-theme', ATRIBUTO[p]);
  }
}
