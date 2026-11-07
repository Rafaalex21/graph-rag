import { Component } from '@angular/core';
import { RouterLink } from '@angular/router';

@Component({
  selector: 'app-nao-encontrada-page',
  imports: [RouterLink],
  template: `
    <section>
      <h1>Página não encontrada</h1>
      <p>Esse endereço não existe nesta interface.</p>
      <p><a routerLink="/chat">Voltar ao chat</a></p>
    </section>
  `,
  styles: `
    section {
      max-width: 40rem;
      margin: 1rem auto;
      padding: 1rem;
      background: var(--superficie);
      border: 1px solid var(--borda);
      border-radius: var(--raio);
    }
  `,
})
export class NaoEncontradaPage {}
