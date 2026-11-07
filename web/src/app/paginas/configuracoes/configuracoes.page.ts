import { Component } from '@angular/core';

@Component({
  selector: 'app-configuracoes-page',
  template: `
    <section>
      <h1>Configurações</h1>
      <p>Aqui ficam o perfil (padrão ou rápido) e o modo de recuperação. O tema se troca pelo botão do topo.</p>
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
export class ConfiguracoesPage {}
