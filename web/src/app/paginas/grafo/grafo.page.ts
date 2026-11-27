import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';
import { DesenhoGrafo } from '../../grafo/desenho-grafo';
import { GrafoService } from '../../grafo/grafo.service';

/**
 * A aba Grafo (F8.5): o subgrafo das entidades que a resposta usou, em SVG (cada entidade é um botão que se expande com clique,
 * Enter ou Espaço), mais um campo para explorar uma entidade pelo nome. O estado e as consultas ficam no `GrafoService`. Tudo o
 * que vem da API é texto (rótulos e tipos entram por interpolação; nada de HTML).
 */
@Component({
  selector: 'app-grafo-page',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [DesenhoGrafo],
  template: `
    <h2>Grafo</h2>
    <form class="explorar" (submit)="explorar($event, campo.value)">
      <label for="grafo-explorar">Explorar uma entidade</label>
      <input #campo id="grafo-explorar" type="text" maxlength="200" autocomplete="off" (input)="rascunho.set(campo.value)" />
      <button type="submit" class="botao" [disabled]="rascunho().trim() === '' || g.carregando()">Explorar</button>
    </form>

    @if (g.erro(); as e) {
      <p role="alert" class="erro">{{ e }}</p>
    }
    @if (g.carregando()) {
      <p class="meta">Carregando o subgrafo…</p>
    }
    @if (g.aviso(); as a) {
      <p data-aviso class="aviso">{{ a }}</p>
    }

    @if (g.resumo()) {
      <app-desenho-grafo />
    } @else if (!g.carregando() && !g.erro()) {
      @if (g.semEntidades()) {
        <p class="vazio">Nenhuma entidade nesta resposta.</p>
      }
      <p class="vazio">Aqui aparece o subgrafo das entidades da resposta. Faça uma pergunta como “Quem é…” ou explore uma entidade pelo nome.</p>
    }
  `,
  styles: `
    h2 {
      margin-top: 0;
      font-size: 1.125rem;
    }

    .explorar {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      gap: 0.5rem;
      margin-bottom: 0.5rem;
    }

    .explorar label,
    .meta,
    .vazio {
      color: var(--texto-suave);
      font-size: 0.85rem;
    }

    .explorar input {
      flex: 1;
      min-width: 8rem;
      padding: 0.3rem 0.5rem;
      font: inherit;
      color: inherit;
      background: var(--superficie);
      border: 1px solid var(--borda);
      border-radius: var(--raio);
    }

    .botao {
      padding: 0.3rem 0.7rem;
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

    }

    .aviso {
      color: var(--texto-suave);
      font-style: italic;
    }

    .erro {
      padding: 0.5rem 0.75rem;
      border: 1px solid #b3261e;
      border-radius: var(--raio);
      color: #b3261e;
    }
  `,
})
export class GrafoPage {
  protected readonly g = inject(GrafoService);
  protected readonly rascunho = signal('');

  protected explorar(e: Event, texto: string): void {
    e.preventDefault();
    void this.g.explorar(texto);
  }
}
