import { Component } from '@angular/core';
import { RouterLink, RouterLinkActive, RouterOutlet } from '@angular/router';

/** A página do chat: a conversa ao centro e, ao lado, o painel com as abas Rastro, Fontes e Grafo (ARQUITETURA §12). */
@Component({
  selector: 'app-chat-page',
  imports: [RouterOutlet, RouterLink, RouterLinkActive],
  template: `
    <section class="conversa" aria-labelledby="titulo-conversa">
      <h1 id="titulo-conversa">Conversa</h1>
      <p>Faça perguntas sobre o Formulário de Referência e acompanhe de onde vem cada número. O chat ainda não está ligado.</p>
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
export class ChatPage {}
