import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  afterRenderEffect,
  computed,
  effect,
  inject,
  signal,
  untracked,
  viewChild,
} from '@angular/core';
import { BarraLateral } from '../../assistente/barra-lateral';
import { CartaoResposta } from '../../assistente/cartao-resposta';
import { Compositor } from '../../assistente/compositor';
import { HistoricoService } from '../../assistente/historico.service';
import { nomeDoTipoDeFonte, SUGESTOES, type CartaoFonte } from '../../assistente/modelo';
import { ChatService } from '../../chat/chat.service';
import { primeiraPagina } from '../../chat/rastro';
import {
  ConfiguracoesService,
  OPCOES_PERFIL,
  type Perfil,
} from '../../configuracoes/configuracoes.service';
import { VisualizadorFonte } from '../../fontes/visualizador-fonte';

interface FonteAberta {
  pagina: string;
  fonteId: string | null;
  titulo: string;
}

/** Os dois perfis com o nome que a tela do assistente usa. */
const PERFIS_DA_TELA: readonly { valor: Perfil; rotulo: string }[] = [
  { valor: 'consultar', rotulo: 'Completa' },
  { valor: 'consultar-rapido', rotulo: 'Rápida' },
];

/**
 * A tela do usuário final (F8.9, `/assistente`): conversa ao centro, conversas recentes e estado do sistema à esquerda e, quando se
 * abre uma fonte, a página do documento à direita (o mesmo visualizador pdf.js da aba Fontes). Reaproveita o `ChatService` e as
 * Configurações do modo técnico: é outra apresentação do mesmo chat, não outro chat.
 */
@Component({
  selector: 'app-assistente-page',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [BarraLateral, CartaoResposta, Compositor, VisualizadorFonte],
  host: { class: 'assistente', '(keydown.escape)': 'aoApertarEscape()' },
  template: `
    <app-barra-lateral
      [aberto]="menuAberto()"
      (fechar)="menuAberto.set(false)"
      (nova)="novaConversa()"
      (escolher)="abrirConversa($event)"
    />
    @if (menuAberto()) {
      <div class="cortina" aria-hidden="true" (click)="menuAberto.set(false)"></div>
    }

    <section class="conversa" aria-label="Conversa">
      <header class="topo">
        <button
          type="button"
          class="menu-botao"
          aria-label="Abrir menu"
          (click)="menuAberto.set(true)"
        >
          <svg
            viewBox="0 0 24 24"
            width="22"
            height="22"
            fill="none"
            stroke="currentColor"
            stroke-width="2"
            stroke-linecap="round"
            aria-hidden="true"
          >
            <path d="M4 7h16M4 12h16M4 17h16" />
          </svg>
        </button>
        <div class="titulos">
          <h1>Pergunte ao Formulário</h1>
          <p>Formulário de Referência 2026 · Banco do Brasil</p>
        </div>
        <div class="segmento" role="group" aria-label="Tipo de resposta">
          @for (p of perfis; track p.valor) {
            <button
              type="button"
              [attr.aria-pressed]="config.perfil() === p.valor"
              [title]="dicaDoPerfil(p.valor)"
              (click)="config.escolherPerfil(p.valor)"
            >
              {{ p.rotulo }}
            </button>
          }
        </div>
      </header>

      <p role="status" class="so-leitor">{{ avisoDeEstado() }}</p>

      <div
        #lista
        class="mensagens"
        role="log"
        aria-live="off"
        aria-label="Mensagens da conversa"
        tabindex="0"
        (scroll)="aoRolar()"
      >
        <div class="coluna">
          @if (chat.mensagens().length === 0) {
            <div class="inicio">
              <h2>Do que você precisa?</h2>
              <p>
                Pergunte sobre o Formulário de Referência 2026 do Banco do Brasil. Cada resposta
                mostra de onde vem.
              </p>
              <div class="sugestoes" role="group" aria-label="Perguntas para começar">
                @for (s of sugestoes; track s) {
                  <button type="button" (click)="perguntar(s)">{{ s }}</button>
                }
              </div>
            </div>
          }
          @for (m of chat.mensagens(); track m.id; let ultima = $last) {
            @if (m.papel === 'usuario') {
              <div class="bolha" data-papel="usuario">{{ m.texto }}</div>
            } @else {
              <app-cartao-resposta
                [m]="m"
                [ultima]="ultima"
                [fonteAberta]="fonte()?.fonteId ?? null"
                (abrirFonte)="abrirFonte($event)"
                (abrirPagina)="abrirPagina($event, m.citacoes)"
                (tentarDeNovo)="chat.tentarDeNovo()"
              />
            }
          }
        </div>
      </div>

      <app-compositor />
    </section>

    @if (fonte(); as f) {
      <aside class="painel" aria-label="Fonte aberta">
        <header>
          <h2>{{ f.titulo }}</h2>
          <button type="button" (click)="fecharFonte()">Fechar fonte</button>
        </header>
        <app-visualizador-fonte
          [pagina]="f.pagina"
          [fonteId]="f.fonteId"
          [compacto]="true"
          (paginaEscolhida)="irParaPagina($event)"
        />
      </aside>
    }
  `,
  styles: `
    :host {
      display: flex;
      height: 100dvh;
      min-width: 0;
      overflow: hidden;
    }

    p {
      margin: 0;
    }

    button {
      font: inherit;
      cursor: pointer;
    }

    .so-leitor {
      position: absolute;
      width: 1px;
      height: 1px;
      margin: -1px;
      overflow: hidden;
      clip-path: inset(50%);
      white-space: nowrap;
    }

    .conversa {
      flex: 1;
      min-width: 0;
      display: flex;
      flex-direction: column;
    }

    .topo {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 0.75rem;
      padding: 1rem 2rem;
    }

    .menu-botao {
      display: none;
      flex: none;
      place-items: center;
      width: 2.75rem;
      height: 2.75rem;
      color: var(--texto);
      background: var(--superficie);
      border: 1px solid var(--borda);
      border-radius: 0.75rem;
    }

    .titulos {
      flex: 1;
      min-width: 0;
    }

    h1 {
      margin: 0;
      font-family: 'Space Grotesk Variable', system-ui, sans-serif;
      font-size: 1.375rem;
      font-weight: 600;
      line-height: 1.2;
    }

    .titulos p {
      font-size: 0.8125rem;
      color: var(--texto-suave);
    }

    .segmento {
      flex: none;
      display: flex;
      gap: 0.25rem;
      padding: 0.25rem;
      background: var(--realce);
      border-radius: 0.8rem;
    }

    .segmento button {
      min-height: 2.25rem;
      padding: 0 0.9rem;
      font-size: 0.875rem;
      color: var(--texto-suave);
      background: transparent;
      border: 0;
      border-radius: 0.6rem;
    }

    .segmento button[aria-pressed='true'] {
      font-weight: 600;
      color: var(--texto);
      background: var(--superficie);
      box-shadow: var(--a-sombra);
    }

    .mensagens {
      flex: 1;
      min-height: 0;
      overflow-y: auto;
      padding: 0.5rem 2rem 1.5rem;
    }

    .coluna {
      display: flex;
      flex-direction: column;
      gap: 1.25rem;
      max-width: 52rem;
      margin: 0 auto;
    }

    .bolha {
      align-self: flex-end;
      max-width: 80%;
      padding: 0.75rem 1.1rem;
      color: var(--a-bolha-texto);
      white-space: pre-wrap;
      overflow-wrap: anywhere;
      background: var(--a-bolha);
      border-radius: 1.1rem 1.1rem 0.25rem 1.1rem;
    }

    .inicio {
      display: grid;
      grid-template-columns: minmax(0, 1fr);
      gap: 0.6rem;
      padding: 3vh 0 0;
    }

    .inicio h2 {
      margin: 0;
      font-family: 'Space Grotesk Variable', system-ui, sans-serif;
      font-size: 1.75rem;
    }

    .inicio p {
      color: var(--texto-suave);
    }

    .sugestoes {
      display: grid;
      grid-template-columns: minmax(0, 1fr);
      gap: 0.6rem;
      margin-top: 0.75rem;
    }

    .sugestoes button {
      min-height: 3rem;
      padding: 0.6rem 1rem;
      text-align: left;
      color: var(--texto);
      background: var(--superficie);
      border: 1px solid var(--borda);
      border-radius: 0.9rem;
    }

    .sugestoes button:hover {
      border-color: var(--a-marca);
    }

    .painel {
      flex: none;
      width: min(28rem, 36vw);
      display: flex;
      flex-direction: column;
      gap: 0.75rem;
      padding: 1rem 1.25rem;
      overflow-y: auto;
      background: var(--superficie);
      border-left: 1px solid var(--borda);
    }

    .painel header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 0.5rem;
    }

    .painel h2 {
      margin: 0;
      font-size: 1rem;
      overflow-wrap: anywhere;
    }

    .painel header button {
      flex: none;
      min-height: 2.5rem;
      padding: 0 0.9rem;
      color: var(--texto);
      background: var(--a-leve);
      border: 1px solid var(--borda);
      border-radius: 0.7rem;
    }

    .cortina {
      position: fixed;
      inset: 0;
      z-index: 40;
      background: rgb(0 0 0 / 0.4);
    }

    @media (max-width: 72rem) {
      .painel {
        position: fixed;
        inset: 0;
        z-index: 45;
        width: auto;
        border-left: 0;
      }
    }

    @media (max-width: 63.99rem) {
      .menu-botao {
        display: grid;
      }

      .topo {
        padding: 0.75rem 1rem;
      }

      .titulos p {
        display: none;
      }

      h1 {
        font-size: 1.125rem;
      }

      .mensagens {
        padding: 0.5rem 1rem 1rem;
      }
    }
  `,
})
export class AssistentePage {
  protected readonly chat = inject(ChatService);
  protected readonly config = inject(ConfiguracoesService);
  private readonly historico = inject(HistoricoService);

  protected readonly perfis = PERFIS_DA_TELA;
  protected readonly sugestoes = SUGESTOES;
  protected readonly menuAberto = signal(false);
  protected readonly fonte = signal<FonteAberta | null>(null);

  private readonly lista = viewChild.required<ElementRef<HTMLElement>>('lista');
  /** O leitor está no fim da lista: só então a lista acompanha os tokens novos. */
  private colado = true;
  private quantas = 0;

  protected readonly avisoDeEstado = computed(() => {
    if (this.chat.ocupado()) return 'Gerando a resposta…';
    const ultima = this.chat.mensagens().at(-1);
    if (ultima?.papel !== 'assistente') return '';
    switch (ultima.estado) {
      case 'pronta':
        return 'Resposta pronta.';
      case 'erro':
        return 'Não foi possível gerar a resposta.';
      case 'cancelada':
        return 'Resposta interrompida.';
      default:
        return '';
    }
  });

  constructor() {
    // uma conversa vazia (nova, ou a aberta foi apagada) não tem fonte aberta
    effect(() => {
      if (this.chat.mensagens().length === 0) untracked(() => this.fonte.set(null));
    });

    afterRenderEffect(() => {
      const n = this.chat.mensagens().length;
      if (n > this.quantas) this.colado = true; // uma pergunta nova: volta ao fim
      this.quantas = n;
      const el = this.lista().nativeElement;
      if (this.colado) el.scrollTop = el.scrollHeight;
    });
  }

  protected dicaDoPerfil(valor: Perfil): string {
    return OPCOES_PERFIL.find((o) => o.valor === valor)?.descricao ?? '';
  }

  protected aoRolar(): void {
    const el = this.lista().nativeElement;
    this.colado = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
  }

  protected aoApertarEscape(): void {
    if (this.menuAberto()) this.menuAberto.set(false);
  }

  protected perguntar(texto: string): void {
    void this.chat.enviar(texto);
  }

  protected novaConversa(): void {
    this.chat.novaConversa();
    this.menuAberto.set(false);
  }

  protected abrirConversa(id: string): void {
    this.historico.abrir(id);
    this.fonte.set(null);
    this.menuAberto.set(false);
  }

  /** Abre o painel no cartão; clicar de novo no mesmo cartão fecha. */
  protected abrirFonte(c: CartaoFonte): void {
    if (this.fonte()?.fonteId === c.id) {
      this.fonte.set(null);
      return;
    }
    this.fonte.set({
      pagina: c.pagina,
      fonteId: c.id,
      titulo: `${nomeDoTipoDeFonte(c.tipo)} · ${c.rotulo}`,
    });
  }

  /** A citação [p. N] no texto da resposta: abre a página N e, se achar a citação dessa página, o trecho de onde ela vem. */
  protected abrirPagina(
    pagina: string,
    citacoes: { id: string; pagina: string | null }[] | undefined,
  ): void {
    const fonteId = citacoes?.find((c) => primeiraPagina(c.pagina) === pagina)?.id ?? null;
    this.fonte.set({ pagina, fonteId, titulo: `Página ${pagina}` });
  }

  protected irParaPagina(n: number): void {
    this.fonte.update((f) => (f ? { ...f, pagina: String(n), titulo: `Página ${n}` } : f));
  }

  protected fecharFonte(): void {
    this.fonte.set(null);
  }
}
