import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { GrafoService, type NoDesenhado } from './grafo.service';

/** Oito cores distinguíveis (Okabe–Ito); o tipo também aparece como texto na legenda e no nome acessível de cada nó. */
const PALETA = ['#0072b2', '#e69f00', '#009e73', '#cc79a7', '#56b4e9', '#d55e00', '#f0e442', '#999999'];
const RAIO = 9;
const RAIO_SEMENTE = 12;
const ROTULOS_ATE = 30;
const PASSO_ZOOM = 1.4;

/**
 * O desenho do subgrafo (F8.5): o resumo ("N entidades e M ligações"), o zoom, o SVG (cada entidade é um botão que se expande com
 * clique, Enter ou Espaço) e a legenda. O estado é o do `GrafoService`. Usado pela aba Grafo do modo técnico e pelos Bastidores da
 * visão dev do assistente (F8.11); as cores vêm dos tokens de quem o usa. Tudo o que vem da API é texto (nada de HTML).
 */
@Component({
  selector: 'app-desenho-grafo',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (g.resumo(); as resumo) {
      <p role="status" class="resumo">{{ resumo }}</p>
      @if (g.avisoDeTruncado(); as t) {
        <p data-aviso class="aviso">{{ t }}</p>
      }
      <div class="ferramentas">
        <button type="button" class="botao" (click)="mudarZoom(1 / passo)">Afastar</button>
        <button type="button" class="botao" (click)="mudarZoom(passo)">Aproximar</button>
        <button type="button" class="botao" (click)="zoom.set(1)">Ajustar à tela</button>
      </div>
      <svg role="group" aria-label="Subgrafo da resposta" class="tela" preserveAspectRatio="xMidYMid meet" [attr.viewBox]="area()">
        <defs>
          <marker id="grafo-seta" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto">
            <path d="M0 0 L10 5 L0 10 z" class="seta" />
          </marker>
        </defs>
        @for (l of linhas(); track l.chave) {
          <line data-aresta [attr.x1]="l.x1" [attr.y1]="l.y1" [attr.x2]="l.x2" [attr.y2]="l.y2" marker-end="url(#grafo-seta)">
            <title>{{ l.titulo }}</title>
          </line>
        }
        @for (n of g.nos(); track n.id) {
          <g
            role="button"
            tabindex="0"
            class="no"
            [class.expandido]="n.expandido"
            [attr.data-semente]="n.semente ? '' : null"
            [attr.aria-label]="nome(n)"
            (click)="g.expandir(n.id)"
            (keydown.enter)="tecla($event, n)"
            (keydown.space)="tecla($event, n)"
          >
            <title>{{ n.rotulo }} · {{ n.tipo === '' ? 'sem tipo' : n.tipo }}</title>
            <circle [attr.cx]="n.x" [attr.cy]="n.y" [attr.r]="raio(n)" [attr.fill]="cor(n)" />
            @if (comRotulo(n)) {
              <text [attr.x]="n.x" [attr.y]="n.y + raio(n) + 12" text-anchor="middle">{{ n.rotulo }}</text>
            }
          </g>
        }
      </svg>
      <ul aria-label="Tipos de entidade" class="legenda">
        @for (t of g.tipos(); track t.tipo) {
          <li><span class="amostra" [style.background]="paleta(t.cor)"></span>{{ t.rotulo }}</li>
        }
      </ul>
    }
  `,
  styles: `
    :host {
      display: block;
    }

    .ferramentas {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      gap: 0.5rem;
      margin-bottom: 0.5rem;
    }

    .legenda {
      color: var(--texto-suave);
      font-size: 0.85rem;
    }

    .botao {
      padding: var(--grafo-botao-padding, 0.3rem 0.7rem);
      font: inherit;
      color: var(--grafo-destaque, var(--destaque));
      background: transparent;
      border: 1px solid var(--grafo-destaque-borda, var(--destaque));
      border-radius: var(--grafo-raio, var(--raio));
      cursor: pointer;
    }

    .resumo {
      margin: 0 0 0.25rem;
      font-variant-numeric: tabular-nums;
    }

    .aviso {
      color: var(--texto-suave);
      font-style: italic;
    }

    .tela {
      display: block;
      width: 100%;
      height: var(--grafo-altura, 22rem);
      background: var(--grafo-fundo, var(--superficie));
      border: 1px solid var(--borda);
      border-radius: var(--grafo-raio, var(--raio));
    }

    line {
      stroke: var(--texto-suave);
      stroke-opacity: 0.55;
      stroke-width: 1.2;
    }

    .seta {
      fill: var(--texto-suave);
      fill-opacity: 0.7;
    }

    .no {
      cursor: pointer;
      outline: none;

      circle {
        stroke: var(--superficie);
        stroke-width: 2;
      }

      &[data-semente] circle {
        stroke: var(--texto);
        stroke-width: 2.5;
      }

      &.expandido {
        cursor: default;
      }

      &:hover circle,
      &:focus-visible circle {
        stroke: var(--foco);
        stroke-width: 3.5;
      }

      text {
        fill: var(--texto);
        font-size: 10px;
        paint-order: stroke;
        stroke: var(--superficie);
        stroke-width: 3px;
        pointer-events: none;
      }
    }

    .legenda {
      display: flex;
      flex-wrap: wrap;
      gap: 0.25rem 0.9rem;
      margin: 0.5rem 0 0;
      padding: 0;
      list-style: none;
    }

    .amostra {
      display: inline-block;
      width: 0.7rem;
      height: 0.7rem;
      margin-right: 0.35rem;
      border-radius: 50%;
    }
  `,
})
export class DesenhoGrafo {
  protected readonly g = inject(GrafoService);
  protected readonly zoom = signal(1);
  protected readonly passo = PASSO_ZOOM;

  private readonly cores = computed(() => new Map(this.g.tipos().map((t) => [t.tipo, PALETA[t.cor % PALETA.length] ?? PALETA[0]])));

  /** A área vista: a caixa que envolve os nós (com folga para os rótulos), dividida pelo zoom em torno do centro. */
  protected readonly area = computed(() => {
    const nos = this.g.nos();
    if (nos.length === 0) return '0 0 100 100';
    let x0 = Infinity;
    let x1 = -Infinity;
    let y0 = Infinity;
    let y1 = -Infinity;
    for (const n of nos) {
      x0 = Math.min(x0, n.x);
      x1 = Math.max(x1, n.x);
      y0 = Math.min(y0, n.y);
      y1 = Math.max(y1, n.y);
    }
    const largura = Math.max(x1 - x0 + 140, 240);
    const altura = Math.max(y1 - y0 + 90, 180);
    const cx = (x0 + x1) / 2;
    const cy = (y0 + y1) / 2;
    const z = this.zoom();
    return `${(cx - largura / 2 / z).toFixed(1)} ${(cy - altura / 2 / z).toFixed(1)} ${(largura / z).toFixed(1)} ${(altura / z).toFixed(1)}`;
  });

  protected readonly linhas = computed(() => {
    const porId = new Map(this.g.nos().map((n) => [n.id, n]));
    const saida: { chave: string; x1: number; y1: number; x2: number; y2: number; titulo: string }[] = [];
    for (const l of this.g.ligacoes()) {
      const a = porId.get(l.origem);
      const b = porId.get(l.destino);
      if (!a || !b) continue;
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const d = Math.hypot(dx, dy) || 1;
      const ra = this.raio(a);
      const rb = this.raio(b) + 3;
      saida.push({
        chave: `${l.origem}\u0000${l.destino}\u0000${l.tipo}`,
        x1: a.x + (dx / d) * ra,
        y1: a.y + (dy / d) * ra,
        x2: b.x - (dx / d) * rb,
        y2: b.y - (dy / d) * rb,
        titulo: `${a.rotulo} ${l.tipo} ${b.rotulo}`,
      });
    }
    return saida;
  });

  protected mudarZoom(fator: number): void {
    this.zoom.update((z) => Math.min(6, Math.max(0.3, z * fator)));
  }

  protected tecla(e: Event, n: NoDesenhado): void {
    e.preventDefault();
    void this.g.expandir(n.id);
  }

  protected raio(n: NoDesenhado): number {
    return n.semente ? RAIO_SEMENTE : RAIO;
  }

  protected cor(n: NoDesenhado): string {
    return this.cores().get(n.tipo) ?? PALETA[0]!;
  }

  protected paleta(indice: number): string {
    return PALETA[indice % PALETA.length] ?? PALETA[0]!;
  }

  /** Com muitos nós os rótulos se atropelam: só as sementes e as expandidas levam rótulo (o nome está no nome acessível). */
  protected comRotulo(n: NoDesenhado): boolean {
    return this.g.nos().length <= ROTULOS_ATE || n.semente || n.expandido;
  }

  protected nome(n: NoDesenhado): string {
    const estado = this.g.expandindo() === n.id ? 'expandindo vizinhança' : n.expandido ? 'vizinhança expandida' : 'expandir vizinhança';
    return `${n.rotulo}, ${n.tipo === '' ? 'sem tipo' : n.tipo}, ${estado}`;
  }
}
