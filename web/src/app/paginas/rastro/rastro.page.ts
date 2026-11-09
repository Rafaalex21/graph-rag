import { ChangeDetectionStrategy, Component, computed, inject } from '@angular/core';
import { Router } from '@angular/router';
import { ChatService } from '../../chat/chat.service';
import { rotuloDoModo } from '../../configuracoes/configuracoes.service';
import { montarRastro, type PassoRastro } from '../../chat/rastro';

const numeroBr = new Intl.NumberFormat('pt-BR');
const segundoBr = new Intl.NumberFormat('pt-BR', { minimumFractionDigits: 1, maximumFractionDigits: 1 });
const escoreBr = new Intl.NumberFormat('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

const plural = (n: number, um: string, varios: string) => `${numeroBr.format(n)} ${n === 1 ? um : varios}`;
const DECISOES: Record<string, string> = { suficiente: 'suficiente', buscar_mais: 'buscar mais', ausente: 'o documento não tem esse dado' };

/**
 * A aba Rastro (F8.3): o caminho da resposta mais recente em linha do tempo, na ordem em que os eventos do SSE chegaram e
 * enquanto chegam. É texto puro (nada de HTML do modelo nem do documento) e a lista não é uma região viva: o leitor de tela
 * lê a lista quando o usuário vai até ela, e quem anuncia o andamento é o `role="status"` do chat.
 */
@Component({
  selector: 'app-rastro-page',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <h2>Rastro</h2>
    @if (passos().length === 0) {
      <p class="vazio">Aqui aparece o caminho de cada resposta: a pergunta reescrita, a rota escolhida, o Cypher, as evidências e a crítica.</p>
    } @else {
      <ol aria-label="Linha do tempo da resposta" class="tempo">
        @for (p of passos(); track $index) {
          <li [attr.data-tipo]="p.tipo" [attr.data-ferramentas]="p.tipo === 'rota' ? p.ferramentas.join(',') : null" [class.erro]="p.tipo === 'erro' || (p.tipo === 'ferramenta_fim' && p.erro !== null)">
            @switch (p.tipo) {
              @case ('reescrita-inicio') {
                <strong>Pergunta recebida</strong>
              }
              @case ('reescrita') {
                <strong>Pergunta reescrita</strong>
                <span class="meta">{{ meta(rodada(p.rodada), p.subperguntas === null ? '' : plural(p.subperguntas, 'subpergunta', 'subperguntas'), tempo(p.ms)) }}</span>
                @if (p.fallback) {
                  <span class="meta">Plano de reserva: {{ p.fallback }}</span>
                }
              }
              @case ('rota') {
                <strong>Rota: {{ p.rota }}</strong>
                <span class="meta">{{ meta(rodada(p.rodada), p.ferramentas.join(', '), tempo(p.ms)) }}</span>
                @if (p.forcado) {
                  <span class="meta">Modo forçado: {{ rotuloModo(p.forcado) }}</span>
                }
                @if (p.fallback) {
                  <span class="meta">Plano de reserva: {{ p.fallback }}</span>
                }
              }
              @case ('ferramenta_inicio') {
                <strong>Executando {{ p.ferramenta }}</strong>
                <span class="meta">{{ rodada(p.rodada) }}</span>
              }
              @case ('ferramenta_fim') {
                @if (p.erro !== null) {
                  <strong>{{ p.ferramenta }} falhou</strong>
                  <span class="meta">{{ meta(rodada(p.rodada), tempo(p.ms)) }}</span>
                  <span class="meta">{{ p.erro }}</span>
                } @else {
                  <strong>{{ p.ferramenta }}: {{ p.evidencias === null ? 'terminou' : plural(p.evidencias, 'evidência', 'evidências') }}</strong>
                  <span class="meta">{{ meta(rodada(p.rodada), tempo(p.ms)) }}</span>
                }
              }
              @case ('cypher') {
                <strong>Consulta Cypher</strong>
                <span class="meta">{{ meta(plural(p.linhas, 'linha', 'linhas'), tempo(p.ms)) }}</span>
                <details>
                  <summary>Ver a consulta</summary>
                  <pre><code>{{ p.query }}</code></pre>
                </details>
              }
              @case ('critica') {
                <strong>Crítica: {{ decisao(p.decisao) }}</strong>
                <span class="meta">{{ meta(rodada(p.rodada), p.perguntas ? plural(p.perguntas, 'pergunta nova', 'perguntas novas') : '', tempo(p.ms)) }}</span>
                @if (p.faltando !== '') {
                  <span class="meta">Faltando: {{ p.faltando }}</span>
                }
              }
              @case ('reparo') {
                <strong>Reparo da resposta</strong>
                <span class="meta">{{ plural(p.frases, 'frase com número sem citação', 'frases com número sem citação') }} reescrita{{ p.frases === 1 ? '' : 's' }}</span>
              }
              @case ('evidencias') {
                @if (p.evidencias.length === 0) {
                  <strong>Nenhuma evidência recuperada</strong>
                } @else {
                  <strong>Evidências recuperadas ({{ p.evidencias.length }})</strong>
                  <ul class="evidencias">
                    @for (e of p.evidencias; track $index) {
                      <li>
                        <span class="meta">{{ e.tipo }} · nota {{ nota(e.score) }} ·</span>
                        @if (e.primeiraPagina !== null) {
                          <button type="button" class="pagina" [attr.aria-label]="'Abrir a página ' + e.primeiraPagina + ' do documento'" (click)="abrirPagina(e.primeiraPagina, e.id)">{{ e.pagina }}</button>
                        } @else {
                          <span class="meta">sem página</span>
                        }
                        <blockquote>{{ e.trecho }}</blockquote>
                      </li>
                    }
                  </ul>
                }
              }
              @case ('fim') {
                <strong>Resposta pronta</strong>
                <span class="meta">{{ tempo(p.metricas.latenciaMs) }} · {{ numero(p.metricas.tokensEntrada) }} tokens de entrada · {{ numero(p.metricas.tokensSaida) }} de saída</span>
                <span class="meta">Rota: {{ p.metricas.rota.length === 0 ? 'sem ferramentas' : p.metricas.rota.join(' → ') }}</span>
                <span class="meta">Estado: {{ p.metricas.estado }}</span>
              }
              @case ('erro') {
                <strong>Erro: {{ p.mensagem }}</strong>
                <span class="meta">{{ p.codigo }}</span>
              }
            }
          </li>
        }
      </ol>
    }
  `,
  styles: `
    h2 {
      margin-top: 0;
      font-size: 1.125rem;
    }

    .vazio {
      color: var(--texto-suave);
    }

    ol,
    ul {
      min-width: 0;
      margin: 0;
      padding: 0;
      list-style: none;
    }

    .tempo > li {
      display: grid;
      grid-template-columns: minmax(0, 1fr);
      gap: 0.15rem;
      padding: 0 0 0.75rem 0.9rem;
      margin-left: 0.4rem;
      border-left: 2px solid var(--borda);
      overflow-wrap: anywhere;
    }

    .tempo > li.erro {
      border-left-color: #b3261e;
    }

    .meta {
      color: var(--texto-suave);
      font-size: 0.85rem;
    }

    pre {
      margin: 0.35rem 0 0;
      padding: 0.5rem;
      overflow-x: auto;
      background: color-mix(in srgb, var(--borda) 30%, transparent);
      border-radius: var(--raio);
      font-size: 0.8rem;
    }

    blockquote {
      margin: 0.2rem 0 0.5rem;
      padding-left: 0.6rem;
      border-left: 3px solid var(--borda);
      color: var(--texto-suave);
      font-size: 0.85rem;
    }

    .pagina {
      padding: 0 0.45rem;
      font: inherit;
      font-size: 0.8rem;
      color: var(--destaque);
      background: transparent;
      border: 1px solid var(--destaque);
      border-radius: 999px;
      cursor: pointer;
    }
  `,
})
export class RastroPage {
  private readonly chat = inject(ChatService);
  private readonly roteador = inject(Router);

  protected readonly passos = computed<PassoRastro[]>(() => {
    const l = this.chat.mensagens();
    for (let i = l.length - 1; i >= 0; i--) {
      const m = l[i];
      if (m?.papel === 'assistente') return montarRastro(m.eventos);
    }
    return [];
  });

  protected readonly plural = plural;
  protected readonly rotuloModo = rotuloDoModo;
  protected readonly meta = (...partes: string[]) => partes.filter((x) => x !== '').join(' · ');
  protected readonly numero = (n: number) => numeroBr.format(n);
  protected readonly nota = (n: number) => escoreBr.format(n);
  protected readonly rodada = (n: number | null) => (n === null ? '' : `Rodada ${n}`);
  protected readonly decisao = (d: string) => DECISOES[d] ?? d;
  protected readonly tempo = (ms: number | null) => (ms === null ? '' : ms < 1000 ? `${numeroBr.format(Math.round(ms))} ms` : `${segundoBr.format(ms / 1000)} s`);

  protected abrirPagina(pagina: string, fonte: string): void {
    void this.roteador.navigate(['/chat', 'fontes'], { queryParams: { pagina, fonte } });
  }
}
