import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  afterNextRender,
  computed,
  inject,
  signal,
  viewChild,
} from '@angular/core';
import { ChatService, LIMITE_PERGUNTA } from '../chat/chat.service';
import { ConfiguracoesService } from '../configuracoes/configuracoes.service';
import { MODOS_DA_TELA } from './modelo';

const LIMIAR_CONTADOR = 3500;
const milhar = (n: number) => String(n).replace(/\B(?=(\d{3})+(?!\d))/g, '.');

/**
 * A caixa de pergunta da tela do assistente (F8.9) e as duas escolhas que valem para a próxima pergunta: "Como buscar" (o modo) e,
 * no topo da conversa, "Tipo de resposta" (o perfil). Ambas são as mesmas de Configurações (mesmo `localStorage`).
 */
@Component({
  selector: 'app-compositor',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <form (submit)="$event.preventDefault(); enviar()">
      <div class="linha">
        <label for="pergunta" class="so-leitor">Sua pergunta</label>
        <textarea
          #caixa
          id="pergunta"
          name="pergunta"
          rows="1"
          [maxLength]="limite"
          placeholder="Pergunte sobre o Formulário"
          [value]="rascunho()"
          (input)="rascunho.set(caixa.value)"
          (keydown.enter)="aoApertarEnter($event)"
        ></textarea>
        @if (chat.ocupado()) {
          <button type="button" class="parar" (click)="chat.cancelar()">Parar</button>
        }
        <button
          type="submit"
          class="enviar"
          aria-label="Enviar pergunta"
          [disabled]="!podeEnviar()"
        >
          <svg
            viewBox="0 0 24 24"
            width="20"
            height="20"
            fill="none"
            stroke="currentColor"
            stroke-width="2.2"
            stroke-linecap="round"
            stroke-linejoin="round"
            aria-hidden="true"
          >
            <path d="M12 19V5M5 12l7-7 7 7" />
          </svg>
        </button>
      </div>
      <div class="opcoes">
        <span class="rotulo" aria-hidden="true">Como buscar:</span>
        <div class="chips" role="group" aria-label="Como buscar">
          @for (o of modos; track o.valor) {
            <button
              type="button"
              class="chip"
              [attr.aria-pressed]="config.modo() === o.valor"
              [title]="o.dica"
              (click)="config.escolherModo(o.valor)"
            >
              {{ o.rotulo }}
            </button>
          }
        </div>
      </div>
      <p class="dica">
        Enter envia · Shift+Enter quebra a linha
        @if (mostrarContador()) {
          <span class="contador" aria-live="polite">{{ contador() }}</span>
        }
      </p>
    </form>
  `,
  styles: `
    :host {
      display: block;
    }

    form {
      display: grid;
      grid-template-columns: minmax(0, 1fr);
      gap: 0.5rem;
      padding: 0.75rem 1rem 1rem;
      background: var(--superficie);
      border-top: 1px solid var(--borda);
    }

    .so-leitor {
      position: absolute;
      width: 1px;
      height: 1px;
      margin: -1px;
      overflow: hidden;
      clip-path: inset(50%);
      white-space: nowrap;
    }

    .linha {
      display: flex;
      align-items: flex-end;
      gap: 0.5rem;
      max-width: 52rem;
      width: 100%;
      margin: 0 auto;
    }

    textarea {
      flex: 1;
      min-width: 0;
      min-height: 3rem;
      max-height: 10rem;
      field-sizing: content;
      resize: none;
      padding: 0.75rem 1rem;
      font: inherit;
      color: var(--texto);
      background: var(--a-leve);
      border: 1px solid var(--borda);
      border-radius: 0.9rem;
    }

    textarea:focus-visible {
      outline: 2px solid var(--foco);
      outline-offset: 1px;
    }

    button {
      font: inherit;
      cursor: pointer;
    }

    .enviar {
      flex: none;
      display: grid;
      place-items: center;
      width: 3rem;
      height: 3rem;
      color: #fff;
      background: var(--a-marca);
      border: 0;
      border-radius: 0.9rem;
    }

    .enviar:disabled {
      opacity: 0.45;
      cursor: not-allowed;
    }

    .parar {
      flex: none;
      min-height: 3rem;
      padding: 0 1rem;
      color: var(--texto);
      background: var(--superficie);
      border: 1px solid var(--borda);
      border-radius: 0.9rem;
    }

    .opcoes {
      display: flex;
      align-items: center;
      gap: 0.5rem;
      max-width: 52rem;
      width: 100%;
      margin: 0 auto;
      font-size: 0.8125rem;
      color: var(--texto-suave);
    }

    .rotulo {
      flex: none;
    }

    .chips {
      display: flex;
      gap: 0.4rem;
      min-width: 0;
      overflow-x: auto;
      padding: 0.15rem;
      scrollbar-width: none;
    }

    .chip {
      flex: none;
      min-height: 2.25rem;
      padding: 0 0.8rem;
      font-size: 0.8125rem;
      color: var(--texto);
      background: var(--superficie);
      border: 1px solid var(--borda);
      border-radius: 999px;
    }

    .chip[aria-pressed='true'] {
      font-weight: 600;
      color: var(--a-marca-forte);
      background: var(--a-marca-fundo);
      border-color: var(--a-marca);
    }

    .dica {
      max-width: 52rem;
      width: 100%;
      margin: 0 auto;
      font-size: 0.75rem;
      color: var(--texto-suave);
    }

    .contador {
      margin-left: 0.75rem;
    }

    @media (max-width: 40rem) {
      .dica {
        display: none;
      }
    }
  `,
})
export class Compositor {
  protected readonly chat = inject(ChatService);
  protected readonly config = inject(ConfiguracoesService);

  protected readonly modos = MODOS_DA_TELA;
  protected readonly limite = LIMITE_PERGUNTA;
  protected readonly rascunho = signal('');
  private readonly caixa = viewChild.required<ElementRef<HTMLTextAreaElement>>('caixa');

  protected readonly podeEnviar = computed(
    () => this.rascunho().trim() !== '' && !this.chat.ocupado(),
  );
  protected readonly mostrarContador = computed(() => this.rascunho().length >= LIMIAR_CONTADOR);
  protected readonly contador = computed(
    () => `${milhar(this.rascunho().length)} / ${milhar(LIMITE_PERGUNTA)}`,
  );

  constructor() {
    // só no computador: no celular o foco automático abriria o teclado antes de a pessoa ler a tela
    afterNextRender(() => {
      if (globalThis.matchMedia?.('(min-width: 64rem)').matches) this.caixa().nativeElement.focus();
    });
  }

  protected aoApertarEnter(e: Event): void {
    const k = e as KeyboardEvent;
    if (k.shiftKey || k.isComposing) return;
    k.preventDefault();
    this.enviar();
  }

  protected enviar(): void {
    if (!this.podeEnviar()) return;
    const texto = this.rascunho();
    this.rascunho.set('');
    this.caixa().nativeElement.focus();
    void this.chat.enviar(texto);
  }
}
