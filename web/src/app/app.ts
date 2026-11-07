import { Component, computed, inject } from '@angular/core';
import { RouterLink, RouterLinkActive, RouterOutlet } from '@angular/router';
import { TemaService } from './tema/tema.service';

@Component({
  imports: [RouterOutlet, RouterLink, RouterLinkActive],
  selector: 'app-root',
  styleUrl: './app.scss',
  templateUrl: './app.html',
})
export class App {
  private readonly tema = inject(TemaService);
  protected readonly rotuloDoTema = computed(() => this.tema.preferencia());

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
