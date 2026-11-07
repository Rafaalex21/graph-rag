import { Component, input } from '@angular/core';

/** O conteúdo provisório de uma aba do painel; o `titulo` e o `texto` vêm do `data` da rota. */
@Component({
  selector: 'app-painel-vazio',
  template: `
    <h2>{{ titulo() }}</h2>
    <p>{{ texto() }}</p>
  `,
  styles: `
    h2 {
      margin-top: 0;
      font-size: 1.125rem;
    }

    p {
      color: var(--texto-suave);
    }
  `,
})
export class PainelVazio {
  readonly titulo = input('');
  readonly texto = input('');
}
