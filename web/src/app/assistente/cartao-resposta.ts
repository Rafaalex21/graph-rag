import {
  ChangeDetectionStrategy,
  Component,
  computed,
  inject,
  input,
  output,
  signal,
} from '@angular/core';
import {
  ChatService,
  LIMITE_COMENTARIO,
  type FeedbackMensagem,
  type Mensagem,
} from '../chat/chat.service';
import { RespostaMarkdown } from '../chat/resposta-markdown';
import {
  cartoesDeFonte,
  nomeDoTipoDeFonte,
  passosDaResposta,
  seloDaResposta,
  type CartaoFonte,
} from './modelo';

const TRECHO_MAXIMO = 110;

/**
 * Uma resposta do assistente (F8.9): o selo de estado, o texto com as citações, os cartões de fonte, a nota e "Como cheguei a esta
 * resposta". Só apresenta: o selo, os cartões e os passos vêm de `modelo.ts`, a nota vai pelo `ChatService`. Tudo que veio da API
 * entra como texto (nada de HTML).
 */
@Component({
  selector: 'app-cartao-resposta',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [RespostaMarkdown],
  host: { 'data-papel': 'assistente', 'aria-label': 'Resposta', role: 'article' },
  template: `
    @if (selo(); as s) {
      <p class="selo" [attr.data-selo]="s.chave">
        <svg
          viewBox="0 0 24 24"
          width="16"
          height="16"
          fill="none"
          stroke="currentColor"
          stroke-width="2.4"
          stroke-linecap="round"
          stroke-linejoin="round"
          aria-hidden="true"
        >
          @switch (s.chave) {
            @case ('encontrado') {
              <path d="M5 12.5l4.5 4.5L19 7.5" />
            }
            @case ('parcial') {
              <path d="M12 8v5M12 16.5v.01" />
            }
            @case ('ausente') {
              <path d="M6 12h12" />
            }
            @default {
              <path d="M7 7l10 10M17 7L7 17" />
            }
          }
        </svg>
        {{ s.texto }}
      </p>
    }

    @if (m().texto !== '') {
      <app-resposta-markdown [texto]="m().texto" (abrirPagina)="abrirPagina.emit($event)" />
    } @else if (m().estado === 'transmitindo') {
      <p class="espera">Gerando a resposta…</p>
    }

    @if (m().estado === 'erro' && m().erro) {
      <div class="erro" role="alert">
        <p>{{ m().erro?.mensagem }}</p>
        @if (ultima() && !ocupado()) {
          <button type="button" class="texto" (click)="tentarDeNovo.emit()">Tentar de novo</button>
        }
      </div>
    }
    @if (m().estado === 'cancelada') {
      <p class="espera">Resposta interrompida.</p>
      @if (ultima() && !ocupado()) {
        <button type="button" class="texto" (click)="tentarDeNovo.emit()">Tentar de novo</button>
      }
    }

    @if (cartoes().length > 0) {
      <section class="fontes" aria-label="Fontes da resposta">
        <h3>De onde vem esta resposta</h3>
        <div class="lista">
          @for (c of cartoes(); track c.id) {
            <button
              type="button"
              class="fonte"
              [attr.aria-pressed]="c.id === fonteAberta()"
              (click)="abrirFonte.emit(c)"
            >
              <span class="tipo">{{ nomeDoTipo(c.tipo) }} · {{ c.rotulo }}</span>
              <span class="trecho">{{ trecho(c) }}</span>
            </button>
          }
        </div>
      </section>
    }

    @if (m().estado === 'pronta' && m().mensagemId) {
      @let f = m().feedback;
      <div class="rodape">
        <div class="avaliar" role="group" aria-label="Avaliar a resposta">
          <button
            type="button"
            class="nota"
            [attr.aria-pressed]="f?.nota === 1"
            [disabled]="f?.enviando ?? false"
            (click)="chat.avaliar(m().id, 1)"
          >
            Resposta útil
          </button>
          <button
            type="button"
            class="nota"
            [attr.aria-pressed]="f?.nota === -1"
            [disabled]="f?.enviando ?? false"
            (click)="chat.avaliar(m().id, -1)"
          >
            Não ajudou
          </button>
          <span class="confirma" aria-live="polite">{{ textoDoFeedback(f) }}</span>
          @if (f?.erro) {
            <p class="falha" role="alert">Não consegui registrar. Tente de novo.</p>
          }
          @if (f && f.nota !== null) {
            <div class="comentario">
              <label [for]="'comentario-' + m().id">Comentário (opcional)</label>
              <textarea
                [id]="'comentario-' + m().id"
                rows="2"
                [maxLength]="limiteComentario"
                [value]="f.rascunho"
                (input)="aoEscrever($event)"
              ></textarea>
              <button
                type="button"
                class="texto"
                [disabled]="f.enviando || f.rascunho.trim() === ''"
                (click)="chat.comentar(m().id)"
              >
                Enviar comentário
              </button>
            </div>
          }
        </div>
        @if (passos().length > 0) {
          <button
            type="button"
            class="passos-botao"
            [attr.aria-expanded]="passosAbertos()"
            [attr.aria-controls]="'passos-' + m().id"
            (click)="passosAbertos.set(!passosAbertos())"
          >
            Como cheguei a esta resposta
            <svg
              viewBox="0 0 24 24"
              width="16"
              height="16"
              fill="none"
              stroke="currentColor"
              stroke-width="2.2"
              stroke-linecap="round"
              stroke-linejoin="round"
              aria-hidden="true"
              [class.virada]="passosAbertos()"
            >
              <path d="M6 9l6 6 6-6" />
            </svg>
          </button>
        }
      </div>
      @if (passosAbertos() && passos().length > 0) {
        <ol class="passos" [id]="'passos-' + m().id" aria-label="Passos da resposta">
          @for (p of passos(); track $index) {
            <li>{{ p }}</li>
          }
        </ol>
      }
    }
  `,
  styles: `
    :host {
      display: flex;
      flex-direction: column;
      gap: 0.9rem;
      padding: 1.25rem;
      min-width: 0;
      background: var(--superficie);
      border: 1px solid var(--borda);
      border-radius: 1.1rem;
      box-shadow: var(--a-sombra);
    }

    p {
      margin: 0;
    }

    .selo {
      display: inline-flex;
      align-items: center;
      gap: 0.4rem;
      align-self: flex-start;
      padding: 0.25rem 0.8rem 0.25rem 0.5rem;
      font-size: 0.8125rem;
      font-weight: 600;
      border-radius: 999px;
      background: var(--a-selo-ausente);
      color: var(--a-selo-ausente-texto);
    }

    .selo[data-selo='encontrado'] {
      background: var(--a-selo-encontrado);
      color: var(--a-selo-encontrado-texto);
    }

    .selo[data-selo='parcial'] {
      background: var(--a-selo-parcial);
      color: var(--a-selo-parcial-texto);
    }

    .selo[data-selo='erro'] {
      background: var(--a-selo-erro);
      color: var(--a-selo-erro-texto);
    }

    .espera {
      color: var(--texto-suave);
      font-style: italic;
    }

    .erro {
      padding: 0.6rem 0.8rem;
      color: var(--a-selo-erro-texto);
      background: var(--a-selo-erro);
      border-radius: 0.6rem;
    }

    .fontes h3 {
      margin: 0 0 0.5rem;
      font-size: 0.75rem;
      font-weight: 600;
      letter-spacing: 0.04em;
      text-transform: uppercase;
      color: var(--texto-suave);
    }

    .lista {
      display: flex;
      flex-wrap: wrap;
      gap: 0.6rem;
    }

    .fonte {
      display: grid;
      grid-template-columns: minmax(0, 1fr);
      gap: 0.15rem;
      min-width: 0;
      max-width: 100%;
      padding: 0.6rem 0.8rem;
      font: inherit;
      text-align: left;
      color: var(--texto);
      background: var(--superficie);
      border: 1px solid var(--borda);
      border-radius: 0.75rem;
      cursor: pointer;
    }

    .fonte:hover {
      border-color: var(--a-marca);
    }

    .fonte[aria-pressed='true'] {
      background: var(--a-marca-fundo);
      border-color: var(--a-marca);
    }

    .tipo {
      font-size: 0.75rem;
      color: var(--texto-suave);
    }

    .trecho {
      font-size: 0.875rem;
      font-weight: 500;
      overflow-wrap: anywhere;
    }

    .rodape {
      display: flex;
      flex-wrap: wrap;
      align-items: flex-start;
      justify-content: space-between;
      gap: 0.5rem;
      padding-top: 0.8rem;
      border-top: 1px solid var(--a-linha);
    }

    .avaliar {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      gap: 0.5rem;
    }

    button {
      font: inherit;
      cursor: pointer;
    }

    button:disabled {
      opacity: 0.55;
      cursor: not-allowed;
    }

    .nota {
      min-height: 2.5rem;
      padding: 0 0.9rem;
      font-size: 0.875rem;
      color: var(--texto);
      background: var(--superficie);
      border: 1px solid var(--borda);
      border-radius: 0.75rem;
    }

    .nota[aria-pressed='true'] {
      color: #fff;
      background: var(--a-marca);
      border-color: var(--a-marca);
    }

    .confirma {
      font-size: 0.8125rem;
      font-weight: 500;
      color: var(--a-marca-forte);
    }

    .falha {
      flex-basis: 100%;
      font-size: 0.8125rem;
      color: var(--a-queda);
    }

    .comentario {
      flex-basis: 100%;
      display: grid;
      grid-template-columns: minmax(0, 1fr);
      gap: 0.35rem;
      justify-items: start;
      font-size: 0.875rem;
    }

    .comentario textarea {
      width: 100%;
      padding: 0.5rem 0.7rem;
      font: inherit;
      color: inherit;
      background: var(--a-leve);
      border: 1px solid var(--borda);
      border-radius: 0.6rem;
      resize: vertical;
    }

    .texto {
      min-height: 2.25rem;
      padding: 0 0.4rem;
      color: var(--a-marca-forte);
      font-weight: 600;
      background: transparent;
      border: 0;
    }

    .passos-botao {
      display: inline-flex;
      align-items: center;
      gap: 0.35rem;
      min-height: 2.5rem;
      margin-left: auto;
      padding: 0 0.4rem;
      font-size: 0.875rem;
      font-weight: 600;
      color: var(--a-marca-forte);
      background: transparent;
      border: 0;
    }

    .virada {
      transform: rotate(180deg);
    }

    .passos {
      display: grid;
      grid-template-columns: minmax(0, 1fr);
      gap: 0.4rem;
      margin: 0;
      padding: 0.9rem 1rem 0.9rem 2.2rem;
      font-size: 0.875rem;
      color: var(--texto);
      background: var(--a-leve);
      border: 1px solid var(--a-linha);
      border-radius: 0.75rem;
    }
  `,
})
export class CartaoResposta {
  protected readonly chat = inject(ChatService);

  readonly m = input.required<Mensagem>();
  /** É a última mensagem da conversa: só nela "Tentar de novo" faz sentido. */
  readonly ultima = input(false);
  /** O id da fonte que está aberta no painel, para marcar o cartão. */
  readonly fonteAberta = input<string | null>(null);
  readonly abrirFonte = output<CartaoFonte>();
  readonly abrirPagina = output<string>();
  readonly tentarDeNovo = output<void>();

  protected readonly ocupado = this.chat.ocupado;
  protected readonly limiteComentario = LIMITE_COMENTARIO;
  protected readonly passosAbertos = signal(false);

  protected readonly selo = computed(() => seloDaResposta(this.m()));
  protected readonly cartoes = computed(() => cartoesDeFonte(this.m()));
  protected readonly passos = computed(() =>
    this.m().estado === 'pronta' ? passosDaResposta(this.m()) : [],
  );

  protected readonly nomeDoTipo = nomeDoTipoDeFonte;

  protected trecho(c: CartaoFonte): string {
    const t = c.trecho.replace(/\s+/g, ' ').trim();
    return t.length <= TRECHO_MAXIMO ? t : `${t.slice(0, TRECHO_MAXIMO - 1).trimEnd()}…`;
  }

  protected aoEscrever(e: Event): void {
    this.chat.editarComentario(this.m().id, (e.target as HTMLTextAreaElement).value);
  }

  protected textoDoFeedback(f: FeedbackMensagem | undefined): string {
    if (!f) return '';
    if (f.enviando) return 'Enviando…';
    if (f.erro) return '';
    if (f.ultimo === 'comentario') return 'Comentário registrado.';
    return f.ultimo === 'nota' ? 'Nota registrada.' : '';
  }
}
