import { ChangeDetectionStrategy, Component, computed, inject, input, output } from '@angular/core';
import { RouterLink } from '@angular/router';
import { ChatService } from '../chat/chat.service';
import { SaudeService, type EstadoSelo } from '../saude/saude.service';
import { TemaService } from '../tema/tema.service';
import { HistoricoService } from './historico.service';

const ESTADOS: Record<EstadoSelo, { titulo: string; detalhe: string }> = {
  verificando: { titulo: 'Verificando…', detalhe: 'Conferindo se o sistema está de pé.' },
  ok: {
    titulo: 'Tudo funcionando',
    detalhe: 'Roda no seu computador: suas perguntas e o documento não saem daqui.',
  },
  degradado: {
    titulo: 'Funcionando com limitações',
    detalhe: 'Alguma parte do sistema não respondeu. As respostas podem demorar ou falhar.',
  },
  fora: {
    titulo: 'Sem conexão com o sistema',
    detalhe: 'Confira se o sistema está ligado neste computador e tente de novo.',
  },
};

/**
 * A barra lateral da tela do assistente (F8.9): marca, "Nova conversa", conversas recentes (guardadas só neste navegador), o
 * estado do sistema, o tema e o caminho para o modo técnico. No celular vira um menu que desliza por cima da conversa.
 */
@Component({
  selector: 'app-barra-lateral',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [RouterLink],
  host: { '[class.aberto]': 'aberto()', '[attr.aria-label]': '"Menu"', role: 'complementary' },
  template: `
    <div class="cabeca">
      <div class="marca">
        <span class="logo" aria-hidden="true">
          <svg
            viewBox="0 0 24 24"
            width="22"
            height="22"
            fill="none"
            stroke="#fff"
            stroke-width="2"
            stroke-linecap="round"
            stroke-linejoin="round"
          >
            <circle cx="6" cy="7" r="2.2" />
            <circle cx="18" cy="7" r="2.2" />
            <circle cx="12" cy="18" r="2.2" />
            <path d="M8 7h8M7 9l4 7M17 9l-4 7" />
          </svg>
        </span>
        <span>
          <span class="nome">GraphRAG local</span>
          <span class="sub">Formulário de Referência 2026 · Banco do Brasil</span>
        </span>
      </div>
      <button type="button" class="fechar" aria-label="Fechar menu" (click)="fechar.emit()">
        <svg
          viewBox="0 0 24 24"
          width="20"
          height="20"
          fill="none"
          stroke="currentColor"
          stroke-width="2"
          stroke-linecap="round"
          aria-hidden="true"
        >
          <path d="M6 6l12 12M18 6L6 18" />
        </svg>
      </button>
    </div>

    <button
      type="button"
      class="nova"
      [disabled]="chat.mensagens().length === 0 && !chat.ocupado()"
      (click)="nova.emit()"
    >
      <svg
        viewBox="0 0 24 24"
        width="18"
        height="18"
        fill="none"
        stroke="currentColor"
        stroke-width="2.2"
        stroke-linecap="round"
        aria-hidden="true"
      >
        <path d="M12 5v14M5 12h14" />
      </svg>
      Nova conversa
    </button>

    <nav aria-label="Conversas recentes">
      <p class="titulo-lista">Recentes</p>
      @for (c of historico.conversas(); track c.id) {
        <div class="item" [class.atual]="c.id === chat.conversationId()">
          <button
            type="button"
            class="abrir"
            [attr.aria-current]="c.id === chat.conversationId() ? 'true' : null"
            (click)="escolher.emit(c.id)"
          >
            {{ c.titulo }}
          </button>
          <button
            type="button"
            class="apagar"
            [attr.aria-label]="'Apagar conversa: ' + c.titulo"
            (click)="historico.apagar(c.id)"
          >
            <svg
              viewBox="0 0 24 24"
              width="16"
              height="16"
              fill="none"
              stroke="currentColor"
              stroke-width="2"
              stroke-linecap="round"
              aria-hidden="true"
            >
              <path d="M6 6l12 12M18 6L6 18" />
            </svg>
          </button>
        </div>
      } @empty {
        <p class="vazio">Suas conversas aparecem aqui.</p>
      }
    </nav>

    <div class="rodape">
      <div class="saude" [attr.data-estado]="saude.estado()">
        <p class="saude-titulo">
          <span class="ponto" aria-hidden="true"></span>{{ estado().titulo }}
        </p>
        <p class="saude-detalhe">{{ estado().detalhe }}</p>
      </div>
      <div class="ferramentas">
        <button type="button" class="tema" (click)="temaSvc.alternar()">
          Tema: {{ temaSvc.preferencia() }}
        </button>
        <a class="tecnico" routerLink="/chat">Modo técnico</a>
      </div>
    </div>
  `,
  styles: `
    :host {
      display: flex;
      flex-direction: column;
      gap: 1.25rem;
      width: 17.5rem;
      flex: none;
      padding: 1.5rem 1.25rem;
      overflow-y: auto;
      color: var(--texto);
      background: var(--superficie);
      border-right: 1px solid var(--borda);
    }

    p {
      margin: 0;
    }

    button {
      font: inherit;
      cursor: pointer;
    }

    .cabeca {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 0.5rem;
    }

    .marca {
      display: flex;
      align-items: center;
      gap: 0.75rem;
      min-width: 0;
    }

    .logo {
      flex: none;
      display: grid;
      place-items: center;
      width: 2.5rem;
      height: 2.5rem;
      background: var(--a-marca);
      border-radius: 0.75rem;
    }

    .nome {
      display: block;
      font-family: 'Space Grotesk Variable', system-ui, sans-serif;
      font-size: 1.0625rem;
      font-weight: 700;
      line-height: 1.2;
    }

    .sub {
      display: block;
      margin-top: 0.1rem;
      font-size: 0.75rem;
      color: var(--texto-suave);
    }

    .fechar {
      display: none;
      flex: none;
      place-items: center;
      width: 2.75rem;
      height: 2.75rem;
      color: var(--texto);
      background: var(--a-leve);
      border: 0;
      border-radius: 0.75rem;
    }

    .nova {
      display: flex;
      align-items: center;
      justify-content: center;
      gap: 0.5rem;
      min-height: 2.75rem;
      font-weight: 600;
      color: #fff;
      background: var(--a-marca);
      border: 0;
      border-radius: 0.75rem;
    }

    .nova:disabled {
      opacity: 0.5;
      cursor: not-allowed;
    }

    nav {
      display: grid;
      grid-template-columns: minmax(0, 1fr);
      gap: 0.2rem;
      align-content: start;
      min-height: 0;
    }

    .titulo-lista {
      padding: 0 0.75rem 0.4rem;
      font-size: 0.75rem;
      font-weight: 600;
      letter-spacing: 0.06em;
      text-transform: uppercase;
      color: var(--texto-suave);
    }

    .vazio {
      padding: 0 0.75rem;
      font-size: 0.875rem;
      color: var(--texto-suave);
    }

    .item {
      display: flex;
      align-items: center;
      border-radius: 0.65rem;
    }

    .item.atual {
      background: var(--a-marca-fundo);
    }

    .item:hover:not(.atual) {
      background: var(--a-leve);
    }

    .abrir {
      flex: 1;
      min-width: 0;
      min-height: 2.75rem;
      padding: 0.4rem 0.75rem;
      overflow: hidden;
      font-size: 0.875rem;
      text-align: left;
      text-overflow: ellipsis;
      white-space: nowrap;
      color: var(--texto);
      background: transparent;
      border: 0;
    }

    .atual .abrir {
      font-weight: 600;
      color: var(--a-marca-forte);
    }

    .apagar {
      flex: none;
      display: grid;
      place-items: center;
      width: 2.5rem;
      height: 2.5rem;
      color: var(--texto-suave);
      background: transparent;
      border: 0;
      border-radius: 0.6rem;
    }

    .rodape {
      display: grid;
      grid-template-columns: minmax(0, 1fr);
      gap: 0.75rem;
      margin-top: auto;
    }

    .saude {
      display: grid;
      grid-template-columns: minmax(0, 1fr);
      gap: 0.3rem;
      padding: 0.85rem;
      background: var(--a-leve);
      border-radius: 0.9rem;
    }

    .saude-titulo {
      display: flex;
      align-items: center;
      gap: 0.5rem;
      font-size: 0.875rem;
      font-weight: 600;
    }

    .saude-detalhe {
      font-size: 0.78rem;
      color: var(--texto-suave);
    }

    .ponto {
      flex: none;
      width: 0.6rem;
      height: 0.6rem;
      background: var(--texto-suave);
      border-radius: 50%;
    }

    [data-estado='ok'] .ponto {
      background: var(--a-ok);
      box-shadow: 0 0 0 4px var(--a-ok-halo);
    }

    [data-estado='degradado'] .ponto {
      background: var(--a-alerta);
      box-shadow: 0 0 0 4px var(--a-alerta-halo);
    }

    [data-estado='fora'] .ponto {
      background: var(--a-queda);
      box-shadow: 0 0 0 4px var(--a-queda-halo);
    }

    .ferramentas {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      justify-content: space-between;
      gap: 0.5rem;
    }

    .tema {
      min-height: 2.25rem;
      padding: 0 0.75rem;
      font-size: 0.8125rem;
      color: var(--texto);
      background: transparent;
      border: 1px solid var(--borda);
      border-radius: 0.6rem;
    }

    .tecnico {
      font-size: 0.8125rem;
      font-weight: 600;
      color: var(--a-marca-forte);
    }

    @media (max-width: 63.99rem) {
      :host {
        position: fixed;
        inset: 0 auto 0 0;
        z-index: 50;
        width: min(20rem, 86vw);
        visibility: hidden;
        transform: translateX(-100%);
        box-shadow: 0 0 2rem rgb(0 0 0 / 0.25);
      }

      :host(.aberto) {
        visibility: visible;
        transform: none;
      }

      .fechar {
        display: grid;
      }
    }
  `,
})
export class BarraLateral {
  protected readonly chat = inject(ChatService);
  protected readonly historico = inject(HistoricoService);
  protected readonly saude = inject(SaudeService);
  protected readonly temaSvc = inject(TemaService);

  /** No celular, o menu está aberto por cima da conversa. */
  readonly aberto = input(false);
  readonly fechar = output<void>();
  readonly nova = output<void>();
  readonly escolher = output<string>();

  protected readonly estado = computed(() => ESTADOS[this.saude.estado()]);
}
