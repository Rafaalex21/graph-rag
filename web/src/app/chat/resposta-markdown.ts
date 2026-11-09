import { ChangeDetectionStrategy, Component, effect, ElementRef, inject, input, output } from '@angular/core';
import { renderizar } from './markdown';

/**
 * Mostra o texto de uma resposta como markdown seguro, com os chips de citação. O DOM vem de `renderizar` (nunca de
 * `innerHTML`); o clique num chip de página sobe como `abrirPagina` por delegação, então o componente não precisa de um
 * listener por chip nem refaz listeners a cada token.
 */
@Component({
  selector: 'app-resposta-markdown',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { '(click)': 'aoClicar($event)', class: 'markdown' },
  template: '',
  styles: `
    :host {
      display: block;
      overflow-wrap: anywhere;
      line-height: 1.55;
    }

    :host ::ng-deep {
      p,
      ul,
      ol,
      blockquote,
      pre,
      table {
        margin: 0 0 0.75rem;
      }

      p:last-child,
      ul:last-child,
      ol:last-child,
      blockquote:last-child,
      pre:last-child,
      table:last-child {
        margin-bottom: 0;
      }

      blockquote {
        padding-left: 0.75rem;
        border-left: 3px solid var(--borda);
        color: var(--texto-suave);
      }

      code {
        font-family: ui-monospace, Consolas, monospace;
        font-size: 0.9em;
        background: color-mix(in srgb, var(--borda) 40%, transparent);
        padding: 0.05rem 0.3rem;
        border-radius: 4px;
      }

      pre {
        overflow-x: auto;
        padding: 0.75rem;
        background: color-mix(in srgb, var(--borda) 30%, transparent);
        border-radius: var(--raio);
      }

      pre code {
        background: none;
        padding: 0;
      }

      table {
        border-collapse: collapse;
        display: block;
        overflow-x: auto;
      }

      th,
      td {
        border: 1px solid var(--borda);
        padding: 0.3rem 0.6rem;
        text-align: left;
      }

      .citacao {
        display: inline-block;
        margin: 0 0.15rem;
        padding: 0 0.45rem;
        font: inherit;
        font-size: 0.8em;
        line-height: 1.5;
        color: var(--destaque);
        background: transparent;
        border: 1px solid var(--destaque);
        border-radius: 999px;
        white-space: nowrap;
      }

      button.citacao {
        cursor: pointer;
      }

      button.citacao:hover,
      button.citacao:focus-visible {
        background: var(--destaque);
        color: var(--superficie);
      }

      span.citacao {
        color: var(--texto-suave);
        border-color: var(--borda);
        border-style: dashed;
      }
    }
  `,
})
export class RespostaMarkdown {
  readonly texto = input.required<string>();
  /** O número da primeira página do chip clicado. */
  readonly abrirPagina = output<string>();

  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef).nativeElement;

  constructor() {
    effect(() => {
      this.host.replaceChildren(renderizar(this.texto()));
    });
  }

  protected aoClicar(e: Event): void {
    const alvo = e.target instanceof Element ? e.target.closest<HTMLElement>('button.citacao') : null;
    const pagina = alvo?.dataset['pagina'];
    if (pagina && this.host.contains(alvo)) this.abrirPagina.emit(pagina);
  }
}
