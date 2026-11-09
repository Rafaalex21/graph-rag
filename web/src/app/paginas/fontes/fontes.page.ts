import { toSignal } from '@angular/core/rxjs-interop';
import { ChangeDetectionStrategy, Component, DestroyRef, ElementRef, afterNextRender, computed, effect, inject, signal, untracked, viewChild } from '@angular/core';
import { ActivatedRoute, Router } from '@angular/router';
import type { PDFDocumentProxy, RenderTask, TextLayer } from 'pdfjs-dist';
import { DocumentoPdf } from '../../fontes/documento-pdf';
import { buscarFonte, type ResultadoFonte } from '../../fontes/fonte-api';
import { itensDoTrecho } from '../../fontes/trecho';

type Biblioteca = typeof import('pdfjs-dist');
interface Aberto {
  biblioteca: Biblioteca;
  documento: PDFDocumentProxy;
}
type EstadoDaFonte = 'nenhuma' | 'carregando' | ResultadoFonte;

/**
 * A aba Fontes (F8.4): abre a página do PDF original que sustenta uma citação e destaca o trecho. A URL manda:
 * `?pagina=N` (a primeira página do rótulo citado, página física do PDF) e, opcionalmente, `&fonte=<id>` (o item do grafo, de
 * onde vem o texto a destacar). A página é desenhada pelo pdf.js (canvas + camada de texto); o destaque marca os itens da
 * camada de texto que contêm o trecho. Tudo o que vem da API é texto (nada de HTML).
 */
@Component({
  selector: 'app-fontes-page',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <h2>Fontes</h2>
    @if (bruta() === null) {
      <p class="vazio">Clique numa citação da resposta ou numa evidência do Rastro para abrir a página do documento.</p>
    } @else if (erroDoc()) {
      <p role="alert" class="erro">Não foi possível abrir o documento. Confira se a API está no ar e tente de novo.</p>
    } @else if (total() === null) {
      <p class="meta">Abrindo o documento…</p>
    } @else {
      <div class="navegacao">
        <button type="button" class="botao" [disabled]="numero() === null || numero() === 1" (click)="irPara((numero() ?? 2) - 1)">Página anterior</button>
        @if (numero() !== null) {
          <p role="status" class="posicao">Página {{ numero() }} de {{ total() }}</p>
        }
        <button type="button" class="botao" [disabled]="numero() === null || numero() === total()" (click)="irPara((numero() ?? 0) + 1)">Próxima página</button>
      </div>
      <form class="ir" novalidate (submit)="irParaDigitada($event, campo.value)">
        <label for="fontes-ir">Ir para a página</label>
        <input #campo id="fontes-ir" type="number" min="1" [max]="total()" step="1" [value]="numero() ?? ''" />
        <button type="submit" class="botao secundario">Ir</button>
      </form>
      @if (erroCampo(); as e) {
        <p role="alert" class="erro">{{ e }}</p>
      }
      @if (avisoPagina(); as a) {
        <p data-aviso class="aviso">{{ a }}</p>
      }
      @if (fonte(); as f) {
        @if (f !== 'nenhuma' && f !== 'carregando' && f.estado === 'ok') {
          <section class="fonte" aria-label="Trecho citado">
            <p class="meta">
              <span class="tipo">{{ f.fonte.tipo }}</span>
              @if (f.fonte.secao) {
                · <span>{{ f.fonte.secao }}</span>
              }
              @if (f.fonte.pagina) {
                · <span>{{ f.fonte.pagina }}</span>
              }
            </p>
            <blockquote>{{ f.fonte.texto }}</blockquote>
          </section>
        }
      }
      @if (avisoTrecho(); as t) {
        <p data-aviso class="aviso">{{ t }}</p>
      }
      @if (erroPagina()) {
        <p role="alert" class="erro">Não foi possível desenhar a página {{ numero() }}.</p>
      }
    }
    <div #quadro class="quadro">
      @if (numero() !== null) {
        <div class="folha">
          <canvas #tela role="img" [attr.aria-label]="'Página ' + numero() + ' do documento'"></canvas>
          <div #camada class="camada-texto"></div>
        </div>
      }
    </div>
  `,
  styles: `
    h2 {
      margin-top: 0;
      font-size: 1.125rem;
    }

    .vazio,
    .meta,
    .aviso {
      color: var(--texto-suave);
    }

    .aviso {
      font-style: italic;
    }

    .erro {
      padding: 0.5rem 0.75rem;
      border: 1px solid #b3261e;
      border-radius: var(--raio);
      color: #b3261e;
    }

    .navegacao,
    .ir {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      gap: 0.5rem;
      margin-bottom: 0.5rem;
    }

    .posicao {
      flex: 1;
      margin: 0;
      text-align: center;
      font-variant-numeric: tabular-nums;
    }

    .ir label {
      color: var(--texto-suave);
      font-size: 0.85rem;
    }

    .ir input {
      width: 4.5rem;
      padding: 0.3rem 0.4rem;
      font: inherit;
      color: inherit;
      background: var(--superficie);
      border: 1px solid var(--borda);
      border-radius: var(--raio);
    }

    .botao {
      padding: 0.35rem 0.7rem;
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

      &.secundario {
        color: var(--destaque);
        background: transparent;
      }
    }

    .fonte {
      margin-bottom: 0.5rem;
    }

    .fonte .meta {
      margin: 0 0 0.25rem;
      font-size: 0.85rem;
    }

    blockquote {
      max-height: 7rem;
      margin: 0;
      padding-left: 0.6rem;
      overflow: auto;
      border-left: 3px solid var(--borda);
      color: var(--texto-suave);
      font-size: 0.85rem;
      white-space: pre-wrap;
      overflow-wrap: anywhere;
    }

    .quadro {
      width: 100%;
      min-width: 0;
      overflow: hidden;
    }

    .folha {
      position: relative;
      width: fit-content;
      line-height: 0;
      background: #fff;
      border: 1px solid var(--borda);
    }

    canvas {
      display: block;
    }
  `,
})
export class FontesPage {
  private readonly rota = inject(ActivatedRoute);
  private readonly roteador = inject(Router);
  private readonly pdf = inject(DocumentoPdf);

  private readonly parametros = toSignal(this.rota.queryParamMap, { requireSync: true });
  protected readonly bruta = computed(() => this.parametros().get('pagina'));
  private readonly fonteId = computed(() => this.parametros().get('fonte'));

  private readonly aberto = signal<Aberto | null>(null);
  protected readonly total = signal<number | null>(null);
  protected readonly erroDoc = signal(false);
  protected readonly erroPagina = signal(false);
  protected readonly erroCampo = signal<string | null>(null);
  protected readonly fonte = signal<EstadoDaFonte>('nenhuma');
  private readonly camadaPronta = signal(false);
  private readonly trecho = signal<'indefinido' | 'achou' | 'nao_achou'>('indefinido');
  private readonly largura = signal(0);

  private readonly quadro = viewChild.required<ElementRef<HTMLElement>>('quadro');
  private readonly tela = viewChild<ElementRef<HTMLCanvasElement>>('tela');
  private readonly camada = viewChild<ElementRef<HTMLElement>>('camada');

  /** A página pedida, se for um inteiro dentro do documento. */
  protected readonly numero = computed(() => {
    const b = this.bruta();
    const t = this.total();
    if (b === null || t === null || !/^\d+$/.test(b)) return null;
    const n = Number(b);
    return n >= 1 && n <= t ? n : null;
  });

  protected readonly avisoPagina = computed(() => {
    const b = this.bruta();
    const t = this.total();
    if (b === null || t === null || this.numero() !== null) return null;
    const mostrado = b.length > 20 ? `${b.slice(0, 20)}…` : b;
    return /^-?\d+$/.test(b) ? `A página ${mostrado} não existe neste documento (1 a ${t}).` : `Página inválida: use um número inteiro de 1 a ${t}.`;
  });

  protected readonly avisoTrecho = computed(() => {
    const f = this.fonte();
    if (f === 'nenhuma' || f === 'carregando') return null;
    if (f.estado === 'nao_encontrada') return 'Fonte não encontrada: o item citado não existe mais no grafo.';
    if (f.estado === 'erro') return 'Não foi possível ler o trecho desta fonte.';
    return this.trecho() === 'nao_achou' ? 'Trecho não localizado nesta página.' : null;
  });

  private execucao = 0;
  private fila: Promise<void> = Promise.resolve();
  private tarefa: RenderTask | null = null;
  private camadaDeTexto: TextLayer | null = null;
  private itens: string[] = [];
  private divs: HTMLElement[] = [];
  private marcados: HTMLElement[] = [];

  constructor() {
    const destruir = inject(DestroyRef);
    destruir.onDestroy(() => {
      this.execucao++;
      this.tarefa?.cancel();
      this.camadaDeTexto?.cancel();
    });

    afterNextRender(() => {
      const observador = new ResizeObserver(([e]) => {
        const w = Math.floor(e?.contentRect.width ?? 0);
        if (Math.abs(w - untracked(this.largura)) >= 2) this.largura.set(w);
      });
      observador.observe(this.quadro().nativeElement);
      destruir.onDestroy(() => observador.disconnect());
    });

    // abre o documento (e baixa o pdf.js) só quando alguém pede uma página
    effect(() => {
      if (this.bruta() === null) return;
      untracked(() => void this.garantirDocumento());
    });

    // lê o texto da fonte citada
    effect((limpar) => {
      const id = this.fonteId();
      if (id === null) {
        this.fonte.set('nenhuma');
        return;
      }
      const controle = new AbortController();
      limpar(() => controle.abort());
      this.fonte.set('carregando');
      void buscarFonte(id, controle.signal).then((r) => {
        if (!controle.signal.aborted) this.fonte.set(r);
      });
    });

    // desenha a página (de novo se mudar a página, o documento ou a largura)
    effect(() => {
      const aberto = this.aberto();
      const n = this.numero();
      const w = this.largura();
      const tela = this.tela()?.nativeElement;
      const camada = this.camada()?.nativeElement;
      untracked(() => this.desenhar(aberto, n, w, tela, camada));
    });

    // marca o trecho quando a camada de texto e a fonte estão prontas
    effect(() => {
      const f = this.fonte();
      const pronta = this.camadaPronta();
      untracked(() => this.marcar(f, pronta));
    });
  }

  protected irPara(n: number): void {
    this.erroCampo.set(null);
    void this.roteador.navigate([], { relativeTo: this.rota, queryParams: { pagina: n } });
  }

  protected irParaDigitada(e: Event, digitado: string): void {
    e.preventDefault();
    const t = this.total();
    if (t === null) return;
    const n = Number(digitado);
    if (digitado.trim() === '' || !Number.isInteger(n)) {
      this.erroCampo.set(`Digite um número inteiro de 1 a ${t}.`);
    } else if (n < 1 || n > t) {
      this.erroCampo.set(`A página ${n} não existe neste documento (1 a ${t}).`);
    } else {
      this.irPara(n);
    }
  }

  private async garantirDocumento(): Promise<void> {
    if (this.aberto() !== null) return;
    this.erroDoc.set(false);
    try {
      const a = await this.pdf.abrir();
      this.aberto.set(a);
      this.total.set(a.documento.numPages);
    } catch {
      this.erroDoc.set(true);
    }
  }

  private desenhar(aberto: Aberto | null, n: number | null, largura: number, tela: HTMLCanvasElement | undefined, camada: HTMLElement | undefined): void {
    const execucao = ++this.execucao;
    this.tarefa?.cancel();
    this.camadaDeTexto?.cancel();
    this.camadaPronta.set(false);
    this.erroPagina.set(false);
    if (!aberto || n === null || largura <= 0 || !tela || !camada) return;
    // um desenho por vez no mesmo canvas: o novo espera o anterior terminar (ou ser cancelado)
    this.fila = this.fila.then(() => this.executar(execucao, aberto, n, largura, tela, camada));
  }

  private async executar(execucao: number, { biblioteca, documento }: Aberto, n: number, largura: number, tela: HTMLCanvasElement, camada: HTMLElement): Promise<void> {
    if (execucao !== this.execucao) return;
    try {
      const pagina = await documento.getPage(n);
      if (execucao !== this.execucao) return;
      const escala = largura / pagina.getViewport({ scale: 1 }).width;
      const densidade = window.devicePixelRatio || 1;
      const css = pagina.getViewport({ scale: escala });
      const pixels = pagina.getViewport({ scale: escala * densidade });
      tela.width = Math.floor(pixels.width);
      tela.height = Math.floor(pixels.height);
      tela.style.width = `${css.width}px`;
      tela.style.height = `${css.height}px`;
      camada.replaceChildren();
      camada.style.setProperty('--total-scale-factor', String(escala));

      this.tarefa = pagina.render({ canvas: tela, viewport: pixels });
      await this.tarefa.promise;
      if (execucao !== this.execucao) return;

      const texto = new biblioteca.TextLayer({ textContentSource: pagina.streamTextContent(), container: camada, viewport: css });
      this.camadaDeTexto = texto;
      await texto.render();
      if (execucao !== this.execucao) return;
      this.itens = texto.textContentItemsStr;
      this.divs = texto.textDivs;
      this.camadaPronta.set(true);
    } catch (erro) {
      if (execucao !== this.execucao || erro instanceof biblioteca.RenderingCancelledException) return;
      this.erroPagina.set(true);
    }
  }

  private marcar(f: EstadoDaFonte, pronta: boolean): void {
    for (const d of this.marcados) d.classList.remove('destaque');
    this.marcados = [];
    if (!pronta || f === 'nenhuma' || f === 'carregando' || f.estado !== 'ok') {
      this.trecho.set('indefinido');
      return;
    }
    const indices = itensDoTrecho(f.fonte.texto, this.itens);
    const elementos = indices.map((i) => this.divs[i]).filter((d): d is HTMLElement => d !== undefined);
    if (elementos.length === 0) {
      this.trecho.set('nao_achou');
      return;
    }
    for (const d of elementos) d.classList.add('destaque');
    this.marcados = elementos;
    this.trecho.set('achou');
    elementos[0]?.scrollIntoView({ block: 'center', inline: 'nearest' });
  }
}
