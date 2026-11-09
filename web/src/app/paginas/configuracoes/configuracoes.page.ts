import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';
import { ConfiguracoesService, OPCOES_MODO, OPCOES_PERFIL, type Modo, type Perfil } from '../../configuracoes/configuracoes.service';

/**
 * A tela Configurações (F8.6, ARQUITETURA §12): o modo de recuperação (automático ou uma ferramenta forçada) e o perfil
 * (padrão ou rápido). A escolha é salva na hora, vale para as próximas perguntas e aparece no Rastro como a rota da resposta.
 */
@Component({
  selector: 'app-configuracoes-page',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <section>
      <h1>Configurações</h1>
      <p class="intro">As escolhas valem para as próximas perguntas e ficam salvas neste navegador. O tema se troca pelo botão do topo.</p>

      <div class="grupo" role="radiogroup" aria-labelledby="titulo-modo">
        <h2 id="titulo-modo">Modo de recuperação</h2>
        @for (o of modos; track o.valor) {
          <div class="opcao">
            <label>
              <input type="radio" name="modo" [value]="o.valor" [checked]="config.modo() === o.valor" [attr.aria-describedby]="'desc-modo-' + o.valor" (change)="escolherModo(o.valor)" />
              {{ o.rotulo }}
            </label>
            <span class="desc" [id]="'desc-modo-' + o.valor">{{ o.descricao }}</span>
          </div>
        }
      </div>

      <div class="grupo" role="radiogroup" aria-labelledby="titulo-perfil">
        <h2 id="titulo-perfil">Perfil</h2>
        @for (o of perfis; track o.valor) {
          <div class="opcao">
            <label>
              <input type="radio" name="perfil" [value]="o.valor" [checked]="config.perfil() === o.valor" [attr.aria-describedby]="'desc-perfil-' + o.valor" (change)="escolherPerfil(o.valor)" />
              {{ o.rotulo }}
            </label>
            <span class="desc" [id]="'desc-perfil-' + o.valor">{{ o.descricao }}</span>
          </div>
        }
      </div>

      <div class="rodape">
        <button type="button" (click)="restaurar()">Restaurar o padrão</button>
        <p role="status" class="salvo">{{ aviso() }}</p>
      </div>
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

    h1 {
      margin-top: 0;
    }

    h2 {
      margin: 0 0 0.5rem;
      font-size: 1.05rem;
    }

    .intro,
    .desc {
      color: var(--texto-suave);
    }

    .grupo {
      margin-top: 1.25rem;
    }

    .opcao {
      display: grid;
      gap: 0.1rem;
      padding: 0.4rem 0;
      overflow-wrap: anywhere;
    }

    .opcao label {
      display: flex;
      align-items: center;
      gap: 0.5rem;
      cursor: pointer;
    }

    .opcao input {
      accent-color: var(--destaque);
    }

    .opcao input:focus-visible {
      outline: 2px solid var(--destaque);
      outline-offset: 2px;
    }

    .desc {
      margin-left: 1.6rem;
      font-size: 0.85rem;
    }

    .rodape {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      gap: 0.75rem;
      margin-top: 1.25rem;
    }

    .salvo {
      margin: 0;
      color: var(--texto-suave);
      font-size: 0.9rem;
    }

    button {
      padding: 0.45rem 0.9rem;
      font: inherit;
      color: var(--destaque);
      background: transparent;
      border: 1px solid var(--destaque);
      border-radius: var(--raio);
      cursor: pointer;
    }
  `,
})
export class ConfiguracoesPage {
  protected readonly config = inject(ConfiguracoesService);
  protected readonly modos = OPCOES_MODO;
  protected readonly perfis = OPCOES_PERFIL;
  protected readonly aviso = signal('');

  protected escolherModo(m: Modo): void {
    this.config.escolherModo(m);
    this.aviso.set('Configuração salva.');
  }

  protected escolherPerfil(p: Perfil): void {
    this.config.escolherPerfil(p);
    this.aviso.set('Configuração salva.');
  }

  protected restaurar(): void {
    this.config.restaurar();
    this.aviso.set('Configuração salva.');
  }
}
