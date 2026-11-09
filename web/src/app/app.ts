import { Component, computed, inject, signal } from '@angular/core';
import { NavigationEnd, Router, RouterLink, RouterLinkActive, RouterOutlet } from '@angular/router';
import { HistoricoService } from './assistente/historico.service';
import { SeloSaude } from './saude/selo-saude';
import { TemaService } from './tema/tema.service';

@Component({
  imports: [RouterOutlet, RouterLink, RouterLinkActive, SeloSaude],
  selector: 'app-root',
  styleUrl: './app.scss',
  templateUrl: './app.html',
})
export class App {
  private readonly tema = inject(TemaService);
  private readonly roteador = inject(Router);
  /** A tela do assistente tem a própria barra: sem o cabeçalho do modo técnico. */
  protected readonly telaDoAssistente = signal(false);
  protected readonly rotuloDoTema = computed(() => this.tema.preferencia());

  constructor() {
    inject(HistoricoService); // guarda as conversas em qualquer tela, não só na do assistente
    const ver = (url: string) => this.telaDoAssistente.set(url.split(/[?#]/)[0] === '/assistente');
    ver(this.roteador.url);
    this.roteador.events.subscribe((e) => e instanceof NavigationEnd && ver(e.urlAfterRedirects));
  }

  protected alternarTema(): void {
    this.tema.alternar();
  }

  /**
   * O `<base href="/">` faria o `href="#conteudo"` navegar para `/#conteudo` e recarregar a rota; por isso o clique foca o
   * `<main>` direto. Sem JavaScript o `href` continua valendo.
   */
  protected irParaOConteudo(evento: Event, principal: HTMLElement): void {
    evento.preventDefault();
    principal.focus();
  }
}
