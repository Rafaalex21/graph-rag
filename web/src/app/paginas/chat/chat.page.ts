import { ChangeDetectionStrategy, Component, computed, ElementRef, afterRenderEffect, inject, signal, viewChild } from '@angular/core';
import { Router, RouterLink, RouterLinkActive, RouterOutlet } from '@angular/router';
import { ChatService, LIMITE_PERGUNTA } from '../../chat/chat.service';
import { RespostaMarkdown } from '../../chat/resposta-markdown';

const LIMIAR_CONTADOR = 3500;
const milhar = (n: number) => String(n).replace(/\B(?=(\d{3})+(?!\d))/g, '.');

/** A página do chat: a conversa ao centro e, ao lado, o painel com as abas Rastro, Fontes e Grafo (ARQUITETURA §12). */
@Component({
  selector: 'app-chat-page',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [RouterOutlet, RouterLink, RouterLinkActive, RespostaMarkdown],
  template: `
    <section class="conversa" aria-labelledby="titulo-conversa">
      <header class="topo">
        <h1 id="titulo-conversa">Conversa</h1>
        <button type="button" class="secundario" (click)="chat.novaConversa()" [disabled]="chat.mensagens().length === 0 && !chat.ocupado()">Nova conversa</button>
      </header>

      <p role="status" class="so-leitor">{{ avisoDeEstado() }}</p>

      <div #lista class="mensagens" role="log" aria-live="off" aria-label="Mensagens da conversa" tabindex="0" (scroll)="aoRolar()">
        @if (chat.mensagens().length === 0) {
          <div class="vazio">
            <p>Faça perguntas sobre o Formulário de Referência 2026 do Banco do Brasil e acompanhe de onde vem cada número.</p>
            <ul>
              <li>Qual foi o lucro líquido ajustado em 2025?</li>
              <li>Quais são os principais fatores de risco de crédito?</li>
              <li>Como evoluiu a carteira de crédito do agronegócio?</li>
            </ul>
          </div>
        }
        @for (m of chat.mensagens(); track m.id) {
          @if (m.papel === 'usuario') {
            <article class="bolha usuario" data-papel="usuario" aria-label="Sua pergunta">
              <p class="puro">{{ m.texto }}</p>
            </article>
          } @else {
            <article class="bolha assistente" data-papel="assistente" aria-label="Resposta">
              @if (m.texto !== '') {
                <app-resposta-markdown [texto]="m.texto" (abrirPagina)="abrirPagina($event)" />
              } @else if (m.estado === 'transmitindo') {
                <p class="espera">Gerando a resposta…</p>
              }
              @if (m.estado === 'erro' && m.erro) {
                <div class="erro" role="alert">
                  <p>{{ m.erro.mensagem }}</p>
                  @if ($last && !chat.ocupado()) {
                    <button type="button" class="secundario" (click)="chat.tentarDeNovo()">Tentar de novo</button>
                  }
                </div>
              }
              @if (m.estado === 'cancelada') {
                <p class="aviso">Resposta interrompida.</p>
                @if ($last && !chat.ocupado()) {
                  <button type="button" class="secundario" (click)="chat.tentarDeNovo()">Tentar de novo</button>
                }
              }
            </article>
          }
        }
      </div>

      <form class="envio" (submit)="$event.preventDefault(); enviar()">
        <label for="pergunta" class="so-leitor">Sua pergunta</label>
        <textarea
          #caixa
          id="pergunta"
          name="pergunta"
          rows="2"
          [maxLength]="limite"
          placeholder="Pergunte sobre o Formulário de Referência"
          [value]="rascunho()"
          (input)="rascunho.set(caixa.value)"
          (keydown.enter)="aoApertarEnter($event)"
        ></textarea>
        <div class="acoes">
          @if (mostrarContador()) {
            <span class="contador" aria-live="polite">{{ contador() }}</span>
          }
          @if (chat.ocupado()) {
            <button type="button" class="secundario" (click)="chat.cancelar()">Parar</button>
          }
          <button type="submit" [disabled]="!podeEnviar()">Enviar</button>
        </div>
      </form>
    </section>

    <aside class="painel" aria-label="Painel de apoio">
      <nav aria-label="Painel" class="abas">
        <a routerLink="rastro" routerLinkActive="ativo" ariaCurrentWhenActive="page">Rastro</a>
        <a routerLink="fontes" routerLinkActive="ativo" ariaCurrentWhenActive="page">Fontes</a>
        <a routerLink="grafo" routerLinkActive="ativo" ariaCurrentWhenActive="page">Grafo</a>
      </nav>
      <router-outlet />
    </aside>
  `,
  styles: `
    :host {
      flex: 1;
      display: grid;
      grid-template-columns: minmax(0, 1fr) minmax(18rem, 26rem);
      gap: 1rem;
      padding: 1rem;
      min-height: 0;
    }

    .conversa,
    .painel {
      background: var(--superficie);
      border: 1px solid var(--borda);
      border-radius: var(--raio);
      padding: 1rem;
    }

    .conversa {
      display: flex;
      flex-direction: column;
      gap: 0.75rem;
      min-height: 0;
    }

    .topo {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 1rem;

      h1 {
        margin: 0;
        font-size: 1.25rem;
      }
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

    .mensagens {
      flex: 1;
      min-height: 12rem;
      overflow-y: auto;
      display: flex;
      flex-direction: column;
      gap: 0.75rem;
      padding-right: 0.25rem;
    }

    .vazio {
      color: var(--texto-suave);

      ul {
        margin: 0.5rem 0 0;
        padding-left: 1.25rem;
      }
    }

    .bolha {
      max-width: 52rem;
      padding: 0.6rem 0.9rem;
      border: 1px solid var(--borda);
      border-radius: var(--raio);

      p {
        margin: 0;
      }

      &.usuario {
        align-self: flex-end;
        background: color-mix(in srgb, var(--destaque) 12%, transparent);
      }

      &.assistente {
        align-self: stretch;
      }

      .puro {
        white-space: pre-wrap;
        overflow-wrap: anywhere;
      }
    }

    .espera,
    .aviso {
      color: var(--texto-suave);
      font-style: italic;
    }

    .erro {
      margin-top: 0.5rem;
      padding: 0.5rem 0.75rem;
      border: 1px solid #b3261e;
      border-radius: var(--raio);
      color: #b3261e;

      p {
        margin: 0 0 0.5rem;
      }
    }

    .envio {
      display: grid;
      gap: 0.5rem;

      textarea {
        width: 100%;
        box-sizing: border-box;
        resize: vertical;
        min-height: 3.5rem;
        max-height: 14rem;
        padding: 0.6rem 0.75rem;
        font: inherit;
        color: inherit;
        background: var(--superficie);
        border: 1px solid var(--borda);
        border-radius: var(--raio);
      }

      textarea:focus-visible {
        outline: 2px solid var(--destaque);
        outline-offset: 1px;
      }
    }

    .acoes {
      display: flex;
      align-items: center;
      justify-content: flex-end;
      gap: 0.5rem;
    }

    .contador {
      margin-right: auto;
      color: var(--texto-suave);
      font-size: 0.85rem;
    }

    button {
      padding: 0.45rem 0.9rem;
      font: inherit;
      color: var(--superficie);
      background: var(--destaque);
      border: 1px solid var(--destaque);
      border-radius: var(--raio);
      cursor: pointer;

      &:disabled {
        opacity: 0.5;
        cursor: not-allowed;
      }

      &.secundario {
        color: var(--destaque);
        background: transparent;
      }
    }

    .abas {
      display: flex;
      gap: 0.25rem;
      margin-bottom: 1rem;
      border-bottom: 1px solid var(--borda);

      a {
        padding: 0.5rem 0.75rem;
        color: var(--texto-suave);
        text-decoration: none;
        border-bottom: 2px solid transparent;

        &.ativo {
          color: var(--destaque);
          font-weight: 600;
          border-bottom-color: var(--destaque);
        }
      }
    }

    @media (max-width: 56rem) {
      :host {
        grid-template-columns: minmax(0, 1fr);
      }
    }
  `,
})
export class ChatPage {
  protected readonly chat = inject(ChatService);
  private readonly roteador = inject(Router);

  protected readonly limite = LIMITE_PERGUNTA;
  protected readonly rascunho = signal('');
  private readonly caixa = viewChild.required<ElementRef<HTMLTextAreaElement>>('caixa');
  private readonly lista = viewChild.required<ElementRef<HTMLElement>>('lista');
  /** O leitor está no fim da lista: só então a lista acompanha os tokens novos. */
  private colado = true;

  protected readonly podeEnviar = computed(() => this.rascunho().trim() !== '' && !this.chat.ocupado());
  protected readonly mostrarContador = computed(() => this.rascunho().length >= LIMIAR_CONTADOR);
  protected readonly contador = computed(() => `${milhar(this.rascunho().length)} / ${milhar(LIMITE_PERGUNTA)}`);

  protected readonly avisoDeEstado = computed(() => {
    if (this.chat.ocupado()) return 'Gerando a resposta…';
    const ultima = this.chat.mensagens().at(-1);
    if (ultima?.papel !== 'assistente') return '';
    switch (ultima.estado) {
      case 'pronta':
        return 'Resposta pronta.';
      case 'erro':
        return 'Não foi possível gerar a resposta.';
      case 'cancelada':
        return 'Resposta interrompida.';
      default:
        return '';
    }
  });

  constructor() {
    afterRenderEffect(() => {
      this.chat.mensagens();
      const el = this.lista().nativeElement;
      if (this.colado) el.scrollTop = el.scrollHeight;
    });
  }

  protected aoRolar(): void {
    const el = this.lista().nativeElement;
    this.colado = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
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
    this.colado = true;
    this.caixa().nativeElement.focus();
    void this.chat.enviar(texto);
  }

  protected abrirPagina(pagina: string): void {
    void this.roteador.navigate(['/chat', 'fontes'], { queryParams: { pagina } });
  }
}
