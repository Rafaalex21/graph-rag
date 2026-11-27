import { ChangeDetectionStrategy, Component, computed, inject, input, output, signal } from '@angular/core';
import type { Mensagem } from '../chat/chat.service';
import { montarRastro, type EvidenciaRastro, type PassoRastro } from '../chat/rastro';
import { rotuloDoModo } from '../configuracoes/configuracoes.service';
import { DesenhoGrafo } from '../grafo/desenho-grafo';
import { GrafoService } from '../grafo/grafo.service';
import { nomeDoTipoDeFonte } from './modelo';

const numeroBr = new Intl.NumberFormat('pt-BR');
const segundoBr = new Intl.NumberFormat('pt-BR', { minimumFractionDigits: 1, maximumFractionDigits: 1 });
const notaBr = new Intl.NumberFormat('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

const plural = (n: number, um: string, varios: string) => `${numeroBr.format(n)} ${n === 1 ? um : varios}`;
const DECISOES: Record<string, string> = { suficiente: 'suficiente', buscar_mais: 'buscar mais', ausente: 'o documento não tem esse dado' };

/** "45 ms" abaixo de 1 s; "12,3 s" depois. */
export function tempoTecnico(ms: number | null): string {
  if (ms === null) return '';
  return ms < 1000 ? `${numeroBr.format(Math.round(ms))} ms` : `${segundoBr.format(ms / 1000)} s`;
}

export const juntar = (...partes: string[]): string => partes.filter((x) => x !== '').join(' · ');

type Aba = 'caminho' | 'evidencias' | 'grafo';

/** A cor do marcador de cada passo na linha do tempo. */
type Tom = 'neutro' | 'marca' | 'ferramenta' | 'cypher' | 'alerta' | 'erro' | 'ok';

interface ItemDoCaminho {
  passo: PassoRastro;
  tom: Tom;
  /** O começo de uma rodada nova (a partir da 2ª), para o divisor "Rodada N". */
  novaRodada: number | null;
}

interface PedacoCypher {
  texto: string;
  classe: 'k' | 's' | 'r' | 'c' | '';
}

const PALAVRAS =
  /(\/\/[^\n]*)|('(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*")|(:[A-Za-z_][A-Za-z0-9_]*)|\b(MATCH|OPTIONAL|WHERE|RETURN|WITH|AND|OR|NOT|IN|AS|LIMIT|ORDER|BY|DESC|ASC|STARTS|ENDS|CONTAINS|COUNT|SUM|MIN|MAX|AVG|COLLECT|DISTINCT|UNWIND|CALL|YIELD|SKIP|IS|NULL|CASE|WHEN|THEN|ELSE|END|EXISTS)\b/gi;

/** O Cypher em pedaços de texto com uma classe de cor (palavra-chave, texto, rótulo, comentário). Só texto: nada vira HTML. */
export function pedacosDoCypher(query: string): PedacoCypher[] {
  const saida: PedacoCypher[] = [];
  let ultimo = 0;
  for (const m of query.matchAll(PALAVRAS)) {
    const i = m.index ?? 0;
    if (i > ultimo) saida.push({ texto: query.slice(ultimo, i), classe: '' });
    const classe = m[1] ? 'c' : m[2] ? 's' : m[3] ? 'r' : 'k';
    saida.push({ texto: m[0], classe });
    ultimo = i + m[0].length;
  }
  if (ultimo < query.length) saida.push({ texto: query.slice(ultimo), classe: '' });
  return saida;
}

function tomDe(p: PassoRastro): Tom {
  switch (p.tipo) {
    case 'rota':
      return 'marca';
    case 'ferramenta_inicio':
      return 'ferramenta';
    case 'ferramenta_fim':
      return p.erro === null ? 'ferramenta' : 'erro';
    case 'cypher':
      return 'cypher';
    case 'critica':
      return p.decisao === 'suficiente' ? 'ok' : 'alerta';
    case 'reparo':
      return 'alerta';
    case 'fim':
      return 'ok';
    case 'erro':
      return 'erro';
    default:
      return 'neutro';
  }
}

const rodadaDe = (p: PassoRastro): number | null => ('rodada' in p ? p.rodada : null);

/**
 * Os Bastidores da visão dev (F8.11): o que o modo técnico mostra de uma resposta, com o design da tela do assistente. Três abas:
 * o caminho (a linha do tempo dos eventos SSE, que se enche ao vivo, com a consulta Cypher sempre à vista), as evidências (tipo,
 * nota, página que abre a fonte) e o subgrafo das entidades da resposta mais recente. Tudo o que veio da API entra como texto.
 */
@Component({
  selector: 'app-bastidores',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [DesenhoGrafo],
  host: { role: 'complementary', 'aria-label': 'Bastidores' },
  template: `
    <header class="cabeca">
      <div>
        <p class="sobre">Visão dev</p>
        <h2>Bastidores</h2>
        <p class="de-qual">{{ m() === null ? 'Nenhuma resposta ainda' : ehAUltima() ? 'Da resposta mais recente' : 'Da resposta escolhida' }}</p>
      </div>
      <button type="button" class="fechar" aria-label="Fechar bastidores" (click)="fechar.emit()">
        <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" aria-hidden="true">
          <path d="M6 6l12 12M18 6L6 18" />
        </svg>
      </button>
    </header>

    @if (m(); as msg) {
      <div class="abas" role="tablist" aria-label="Partes dos bastidores">
        <button type="button" role="tab" id="aba-caminho" aria-controls="painel-caminho" [attr.aria-selected]="aba() === 'caminho'" (click)="aba.set('caminho')">Caminho</button>
        <button type="button" role="tab" id="aba-evidencias" aria-controls="painel-evidencias" [attr.aria-selected]="aba() === 'evidencias'" (click)="aba.set('evidencias')">
          Evidências <span class="conta">{{ evidencias().length }}</span>
        </button>
        <button type="button" role="tab" id="aba-grafo" aria-controls="painel-grafo" [attr.aria-selected]="aba() === 'grafo'" (click)="aba.set('grafo')">Grafo</button>
      </div>

      @switch (aba()) {
        @case ('caminho') {
          <div role="tabpanel" id="painel-caminho" aria-labelledby="aba-caminho">
            @if (caminho().length === 0) {
              <p class="vazio">Esperando o primeiro passo…</p>
            } @else {
              <ol class="tempo" aria-label="Caminho da resposta">
                @for (item of caminho(); track $index) {
                  @if (item.novaRodada !== null) {
                    <li class="divisor" aria-hidden="true"><span>Rodada {{ item.novaRodada }}</span></li>
                  }
                  @let p = item.passo;
                  <li class="passo" [attr.data-tom]="item.tom" [attr.data-tipo]="p.tipo">
                    <span class="marcador" aria-hidden="true"></span>
                    <div class="corpo">
                      @switch (p.tipo) {
                        @case ('reescrita-inicio') {
                          <strong>Pergunta recebida</strong>
                        }
                        @case ('reescrita') {
                          <strong>Pergunta reescrita</strong>
                          <span class="meta">{{ juntar(rodada(p.rodada), p.subperguntas === null ? '' : plural(p.subperguntas, 'subpergunta', 'subperguntas'), tempo(p.ms)) }}</span>
                          @if (p.fallback) {
                            <span class="meta">Plano de reserva: {{ p.fallback }}</span>
                          }
                        }
                        @case ('rota') {
                          <strong>Rota: {{ p.rota }}</strong>
                          <span class="meta">{{ juntar(rodada(p.rodada), tempo(p.ms)) }}</span>
                          @if (p.ferramentas.length > 0) {
                            <span class="chips">
                              @for (f of p.ferramentas; track $index) {
                                <code class="chip">{{ f }}</code>
                              }
                            </span>
                          }
                          @if (p.forcado) {
                            <span class="meta">Modo forçado: {{ rotuloModo(p.forcado) }}</span>
                          }
                          @if (p.fallback) {
                            <span class="meta">Plano de reserva: {{ p.fallback }}</span>
                          }
                        }
                        @case ('ferramenta_inicio') {
                          <strong>Executando {{ p.ferramenta }}…</strong>
                          <span class="meta">{{ rodada(p.rodada) }}</span>
                        }
                        @case ('ferramenta_fim') {
                          @if (p.erro !== null) {
                            <strong>{{ p.ferramenta }} falhou</strong>
                            <span class="meta">{{ juntar(rodada(p.rodada), tempo(p.ms)) }}</span>
                            <span class="meta erro">{{ p.erro }}</span>
                          } @else {
                            <strong>{{ p.ferramenta }}: {{ p.evidencias === null ? 'terminou' : plural(p.evidencias, 'evidência', 'evidências') }}</strong>
                            <span class="meta">{{ juntar(rodada(p.rodada), tempo(p.ms)) }}</span>
                          }
                        }
                        @case ('cypher') {
                          <figure class="cypher" aria-label="Consulta Cypher">
                            <figcaption>
                              <strong>Consulta Cypher</strong>
                              <span class="meta">{{ juntar(plural(p.linhas, 'linha', 'linhas'), tempo(p.ms)) }}</span>
                            </figcaption>
                            <pre><code>@for (c of cypher(p.query); track $index) {<span [class]="c.classe">{{ c.texto }}</span>}</code></pre>
                          </figure>
                        }
                        @case ('critica') {
                          <strong>Crítica: {{ decisao(p.decisao) }}</strong>
                          <span class="meta">{{ juntar(rodada(p.rodada), p.perguntas ? plural(p.perguntas, 'pergunta nova', 'perguntas novas') : '', tempo(p.ms)) }}</span>
                          @if (p.faltando !== '') {
                            <span class="meta">Faltando: {{ p.faltando }}</span>
                          }
                        }
                        @case ('reparo') {
                          <strong>Reparo da resposta</strong>
                          <span class="meta">{{ plural(p.frases, 'frase com número sem citação reescrita', 'frases com número sem citação reescritas') }}</span>
                        }
                        @case ('evidencias') {
                          <strong>{{ p.evidencias.length === 0 ? 'Nenhuma evidência recuperada' : 'Evidências recuperadas (' + p.evidencias.length + ')' }}</strong>
                          @if (p.evidencias.length > 0) {
                            <button type="button" class="link" (click)="aba.set('evidencias')">Ver as evidências</button>
                          }
                        }
                        @case ('fim') {
                          <strong>Resposta pronta</strong>
                          <span class="meta">{{ juntar(tempo(p.metricas.latenciaMs), numero(p.metricas.tokensEntrada) + ' tokens de entrada', numero(p.metricas.tokensSaida) + ' de saída') }}</span>
                          <span class="meta">{{ juntar('Ferramentas: ' + (p.metricas.rota.length === 0 ? 'nenhuma' : p.metricas.rota.join(' → ')), 'Estado: ' + p.metricas.estado) }}</span>
                        }
                        @case ('erro') {
                          <strong>Erro: {{ p.mensagem }}</strong>
                          <span class="meta">{{ p.codigo }}</span>
                        }
                      }
                    </div>
                  </li>
                }
              </ol>
            }
          </div>
        }
        @case ('evidencias') {
          <div role="tabpanel" id="painel-evidencias" aria-labelledby="aba-evidencias">
            @if (evidencias().length === 0) {
              <p class="vazio">Nenhuma evidência {{ msg.estado === 'transmitindo' ? 'ainda' : 'nesta resposta' }}.</p>
            } @else {
              <ul class="evidencias" aria-label="Evidências recuperadas">
                @for (e of evidencias(); track $index) {
                  <li>
                    <div class="linha">
                      <span class="tipo">{{ nomeDoTipo(e.tipo) }} <code>{{ e.tipo }}</code></span>
                      @if (e.primeiraPagina !== null) {
                        <button type="button" class="pagina" [attr.aria-label]="'Abrir a página ' + e.primeiraPagina + ' do documento'" (click)="abrirPagina.emit({ pagina: e.primeiraPagina, fonteId: e.id })">{{ e.pagina }}</button>
                      } @else {
                        <span class="sem-pagina">sem página</span>
                      }
                    </div>
                    <div class="nota">
                      <span class="barra" aria-hidden="true"><span [style.width.%]="largura(e)"></span></span>
                      <span>nota {{ nota(e.score) }}</span>
                    </div>
                    <blockquote>{{ e.trecho }}</blockquote>
                  </li>
                }
              </ul>
            }
          </div>
        }
        @case ('grafo') {
          <div role="tabpanel" id="painel-grafo" aria-labelledby="aba-grafo" class="grafo">
            @if (!ehAUltima()) {
              <p class="vazio">O grafo acompanha a resposta mais recente.</p>
            }
            @if (g.erro(); as e) {
              <p role="alert" class="meta erro">{{ e }}</p>
            }
            @if (g.carregando()) {
              <p class="vazio">Carregando o subgrafo…</p>
            }
            @if (g.resumo()) {
              <app-desenho-grafo />
            } @else if (!g.carregando() && !g.erro()) {
              <p class="vazio">{{ g.semEntidades() ? 'Nenhuma entidade nesta resposta.' : 'O subgrafo aparece quando a resposta usa pessoas ou empresas do documento.' }}</p>
            }
          </div>
        }
      }
    } @else {
      <p class="vazio inicio">Faça uma pergunta: aqui aparecem a rota que o agente escolheu, as ferramentas e o tempo de cada uma, a consulta Cypher, as evidências com nota e página, a crítica e o subgrafo da resposta.</p>
    }
  `,
  styles: `
    :host {
      flex: none;
      width: min(30rem, 38vw);
      display: flex;
      flex-direction: column;
      gap: 0.9rem;
      padding: 1.1rem 1.25rem 1.5rem;
      overflow-y: auto;
      background: var(--superficie);
      border-left: 1px solid var(--borda);
      --grafo-destaque: var(--a-marca-forte);
      --grafo-destaque-borda: var(--borda);
      --grafo-raio: 0.7rem;
      --grafo-fundo: var(--a-leve);
      --grafo-altura: 20rem;
      --grafo-botao-padding: 0.35rem 0.8rem;
    }

    p {
      margin: 0;
    }

    button {
      font: inherit;
      cursor: pointer;
    }

    .cabeca {
      display: flex;
      align-items: flex-start;
      justify-content: space-between;
      gap: 0.75rem;
    }

    .sobre {
      font-size: 0.6875rem;
      font-weight: 700;
      letter-spacing: 0.08em;
      text-transform: uppercase;
      color: var(--a-marca-forte);
    }

    h2 {
      margin: 0.1rem 0 0;
      font-family: 'Space Grotesk Variable', system-ui, sans-serif;
      font-size: 1.25rem;
      font-weight: 600;
    }

    .de-qual {
      font-size: 0.8125rem;
      color: var(--texto-suave);
    }

    .fechar {
      flex: none;
      display: grid;
      place-items: center;
      width: 2.5rem;
      height: 2.5rem;
      color: var(--texto);
      background: var(--a-leve);
      border: 1px solid var(--borda);
      border-radius: 0.7rem;
    }

    .abas {
      display: flex;
      gap: 0.25rem;
      padding: 0.25rem;
      background: var(--realce);
      border-radius: 0.8rem;
    }

    .abas button {
      flex: 1;
      min-height: 2.25rem;
      padding: 0 0.6rem;
      font-size: 0.875rem;
      color: var(--texto-suave);
      background: transparent;
      border: 0;
      border-radius: 0.6rem;
    }

    .abas button[aria-selected='true'] {
      font-weight: 600;
      color: var(--texto);
      background: var(--superficie);
      box-shadow: var(--a-sombra);
    }

    .conta {
      display: inline-block;
      min-width: 1.4rem;
      margin-left: 0.2rem;
      padding: 0 0.35rem;
      font-size: 0.75rem;
      font-variant-numeric: tabular-nums;
      color: var(--a-marca-forte);
      background: var(--a-marca-fundo);
      border-radius: 999px;
    }

    .vazio {
      font-size: 0.875rem;
      color: var(--texto-suave);
    }

    .inicio {
      padding: 0.9rem 1rem;
      background: var(--a-leve);
      border: 1px dashed var(--borda);
      border-radius: 0.8rem;
    }

    .tempo {
      position: relative;
      display: grid;
      grid-template-columns: minmax(0, 1fr);
      gap: 0.15rem;
      margin: 0;
      padding: 0;
      list-style: none;
    }

    .passo {
      position: relative;
      display: grid;
      grid-template-columns: 1.4rem minmax(0, 1fr);
      gap: 0.5rem;
      padding: 0.45rem 0;
    }

    /* o fio da linha do tempo, ligando um marcador ao próximo */
    .passo::before {
      content: '';
      position: absolute;
      top: 1.35rem;
      bottom: -0.6rem;
      left: calc(0.7rem - 1px);
      width: 2px;
      background: var(--a-linha);
    }

    .passo:last-child::before {
      display: none;
    }

    .marcador {
      position: relative;
      z-index: 1;
      width: 0.85rem;
      height: 0.85rem;
      margin: 0.3rem auto 0;
      border-radius: 50%;
      background: var(--superficie);
      border: 3px solid var(--tom);
    }

    .passo {
      --tom: #8a96a8;
    }

    .passo[data-tom='marca'] {
      --tom: var(--a-marca);
    }

    .passo[data-tom='ferramenta'] {
      --tom: #2f6fd6;
    }

    .passo[data-tom='cypher'] {
      --tom: #7c4dcc;
    }

    .passo[data-tom='alerta'] {
      --tom: var(--a-alerta);
    }

    .passo[data-tom='erro'] {
      --tom: var(--a-queda);
    }

    .passo[data-tom='ok'] {
      --tom: var(--a-ok);
    }

    .corpo {
      display: grid;
      grid-template-columns: minmax(0, 1fr);
      gap: 0.15rem;
      min-width: 0;
    }

    .corpo strong {
      font-size: 0.9375rem;
      font-weight: 600;
      overflow-wrap: anywhere;
    }

    .meta {
      font-size: 0.8125rem;
      color: var(--texto-suave);
      overflow-wrap: anywhere;
    }

    .meta.erro {
      color: var(--a-queda);
    }

    .chips {
      display: flex;
      flex-wrap: wrap;
      gap: 0.3rem;
      margin-top: 0.15rem;
    }

    .chip {
      padding: 0.1rem 0.5rem;
      font-family: 'Cascadia Mono', Consolas, ui-monospace, monospace;
      font-size: 0.78rem;
      color: var(--a-marca-forte);
      background: var(--a-marca-fundo);
      border-radius: 0.45rem;
    }

    .divisor {
      display: flex;
      align-items: center;
      gap: 0.6rem;
      margin: 0.35rem 0 0.1rem;
      font-size: 0.6875rem;
      font-weight: 700;
      letter-spacing: 0.08em;
      text-transform: uppercase;
      color: var(--texto-suave);
    }

    .divisor::after {
      content: '';
      flex: 1;
      height: 1px;
      background: var(--a-linha);
    }

    .cypher {
      display: grid;
      grid-template-columns: minmax(0, 1fr);
      gap: 0.4rem;
      margin: 0;
    }

    .cypher figcaption {
      display: flex;
      flex-wrap: wrap;
      align-items: baseline;
      gap: 0.2rem 0.6rem;
    }

    .cypher pre {
      margin: 0;
      padding: 0.8rem 0.9rem;
      font-family: 'Cascadia Mono', Consolas, ui-monospace, monospace;
      font-size: 0.78rem;
      line-height: 1.55;
      color: #e6edf3;
      white-space: pre-wrap;
      overflow-wrap: anywhere;
      background: #0e1726;
      border-radius: 0.75rem;
      box-shadow: inset 0 0 0 1px rgb(255 255 255 / 0.06);
    }

    .cypher .k {
      color: #7fdac8;
      font-weight: 600;
    }

    .cypher .s {
      color: #f3d27a;
    }

    .cypher .r {
      color: #a9c7ff;
    }

    .cypher .c {
      color: #8b98a9;
      font-style: italic;
    }

    .link {
      justify-self: start;
      padding: 0;
      font-size: 0.8125rem;
      font-weight: 600;
      color: var(--a-marca-forte);
      background: transparent;
      border: 0;
    }

    .evidencias {
      display: grid;
      grid-template-columns: minmax(0, 1fr);
      gap: 0.6rem;
      margin: 0;
      padding: 0;
      list-style: none;
    }

    .evidencias li {
      display: grid;
      grid-template-columns: minmax(0, 1fr);
      gap: 0.4rem;
      padding: 0.75rem 0.85rem;
      background: var(--a-leve);
      border: 1px solid var(--a-linha);
      border-radius: 0.8rem;
    }

    .linha {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      justify-content: space-between;
      gap: 0.4rem;
    }

    .tipo {
      font-size: 0.8125rem;
      font-weight: 600;
    }

    .tipo code {
      margin-left: 0.25rem;
      font-size: 0.75rem;
      font-weight: 400;
      color: var(--texto-suave);
    }

    .pagina {
      padding: 0.1rem 0.55rem;
      font-size: 0.8125rem;
      font-weight: 600;
      color: var(--a-pagina-texto);
      background: var(--a-pagina-fundo);
      border: 1px solid var(--a-pagina-borda);
      border-radius: 999px;
    }

    .pagina:hover,
    .pagina:focus-visible {
      color: var(--a-pagina-fundo);
      background: var(--a-pagina-texto);
    }

    .sem-pagina {
      font-size: 0.8125rem;
      color: var(--texto-suave);
    }

    .nota {
      display: flex;
      align-items: center;
      gap: 0.5rem;
      font-size: 0.75rem;
      font-variant-numeric: tabular-nums;
      color: var(--texto-suave);
    }

    .barra {
      flex: 1;
      max-width: 8rem;
      height: 0.35rem;
      overflow: hidden;
      background: var(--a-linha);
      border-radius: 999px;
    }

    .barra span {
      display: block;
      height: 100%;
      background: var(--a-marca);
      border-radius: 999px;
    }

    blockquote {
      margin: 0;
      padding-left: 0.6rem;
      font-size: 0.8125rem;
      color: var(--texto);
      overflow-wrap: anywhere;
      border-left: 3px solid var(--a-linha);
    }

    .grafo {
      display: grid;
      grid-template-columns: minmax(0, 1fr);
      gap: 0.5rem;
    }

    @media (max-width: 72rem) {
      :host {
        position: fixed;
        inset: 0;
        z-index: 45;
        width: auto;
        border-left: 0;
      }
    }
  `,
})
export class Bastidores {
  protected readonly g = inject(GrafoService);

  readonly m = input<Mensagem | null>(null);
  /** A resposta mostrada é a mais recente (o grafo só acompanha essa). */
  readonly ehAUltima = input(true);
  readonly fechar = output<void>();
  readonly abrirPagina = output<{ pagina: string; fonteId: string }>();

  protected readonly aba = signal<Aba>('caminho');

  private readonly rastro = computed(() => {
    const m = this.m();
    return m === null ? [] : montarRastro(m.eventos);
  });

  protected readonly evidencias = computed<EvidenciaRastro[]>(() =>
    this.rastro()
      .filter((p): p is Extract<PassoRastro, { tipo: 'evidencias' }> => p.tipo === 'evidencias')
      .flatMap((p) => p.evidencias),
  );

  /** A linha do tempo: um "Executando X" some quando o fim de X chega; um divisor marca cada rodada a partir da 2ª. */
  protected readonly caminho = computed<ItemDoCaminho[]>(() => {
    const passos = this.rastro();
    const terminadas = new Set(passos.filter((p) => p.tipo === 'ferramenta_fim').map((p) => `${rodadaDe(p)}|${(p as { ferramenta: string }).ferramenta}`));
    const saida: ItemDoCaminho[] = [];
    let rodadaAtual = 1;
    for (const p of passos) {
      if (p.tipo === 'ferramenta_inicio' && terminadas.has(`${p.rodada}|${p.ferramenta}`)) continue;
      const r = rodadaDe(p);
      let novaRodada: number | null = null;
      if (r !== null && r > rodadaAtual) {
        novaRodada = r;
        rodadaAtual = r;
      }
      saida.push({ passo: p, tom: tomDe(p), novaRodada });
    }
    return saida;
  });

  protected readonly plural = plural;
  protected readonly juntar = juntar;
  protected readonly tempo = tempoTecnico;
  protected readonly rotuloModo = rotuloDoModo;
  protected readonly nomeDoTipo = nomeDoTipoDeFonte;
  protected readonly cypher = pedacosDoCypher;
  protected readonly numero = (n: number) => numeroBr.format(n);
  protected readonly nota = (n: number) => notaBr.format(n);
  protected readonly rodada = (n: number | null) => (n === null ? '' : `Rodada ${n}`);
  protected readonly decisao = (d: string) => DECISOES[d] ?? d;

  protected largura(e: EvidenciaRastro): number {
    return Math.round(Math.min(1, Math.max(0, e.score)) * 100);
  }
}
