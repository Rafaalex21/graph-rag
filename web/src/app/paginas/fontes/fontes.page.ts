import { toSignal } from '@angular/core/rxjs-interop';
import { ChangeDetectionStrategy, Component, computed, inject } from '@angular/core';
import { ActivatedRoute, Router } from '@angular/router';
import { VisualizadorFonte } from '../../fontes/visualizador-fonte';

/**
 * A aba Fontes (F8.4): a URL manda. `?pagina=N` (a primeira página do rótulo citado) e, opcionalmente, `&fonte=<id>` (o item do
 * grafo, de onde vem o texto a destacar). Quem desenha a página e destaca o trecho é o `VisualizadorFonte`.
 */
@Component({
  selector: 'app-fontes-page',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [VisualizadorFonte],
  template: `
    <h2>Fontes</h2>
    @if (bruta() === null) {
      <p class="vazio">
        Clique numa citação da resposta ou numa evidência do Rastro para abrir a página do
        documento.
      </p>
    }
    <app-visualizador-fonte
      [pagina]="bruta()"
      [fonteId]="fonteId()"
      (paginaEscolhida)="irPara($event)"
    />
  `,
  styles: `
    h2 {
      margin-top: 0;
      font-size: 1.125rem;
    }

    .vazio {
      color: var(--texto-suave);
    }
  `,
})
export class FontesPage {
  private readonly rota = inject(ActivatedRoute);
  private readonly roteador = inject(Router);

  private readonly parametros = toSignal(this.rota.queryParamMap, { requireSync: true });
  protected readonly bruta = computed(() => this.parametros().get('pagina'));
  protected readonly fonteId = computed(() => this.parametros().get('fonte'));

  protected irPara(n: number): void {
    void this.roteador.navigate([], { relativeTo: this.rota, queryParams: { pagina: n } });
  }
}
