import { ChangeDetectionStrategy, Component, computed, ElementRef, inject, signal, viewChild } from '@angular/core';
import { SaudeService, type EstadoParte, type EstadoSelo } from './saude.service';

const ROTULOS: Record<EstadoSelo, string> = { verificando: 'verificando…', ok: 'no ar', degradado: 'degradado', fora: 'fora do ar' };
const PARTES: Record<EstadoParte, string> = { ok: 'no ar', indisponivel: 'fora do ar', nao_configurado: 'não configurado' };

/**
 * O selo de saúde no topo (F8.7): um botão "Sistema: no ar | degradado | fora do ar" que abre o estado de cada parte, com o que
 * fazer quando algo caiu. Só informa: não bloqueia o chat. O texto do selo é uma região viva educada (anuncia a mudança de
 * estado, não cada consulta). Tudo que vem da API entra como texto.
 */
@Component({
  selector: 'app-selo-saude',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { '(keydown.escape)': 'fechar()' },
  template: `
    <button #botao type="button" class="selo" [attr.data-estado]="saudeSvc.estado()" [attr.aria-expanded]="aberto()" aria-controls="detalhes-saude" (click)="aberto.set(!aberto())">
      <span class="ponto" aria-hidden="true"></span>
      <span aria-live="polite">Sistema: {{ rotulo() }}</span>
    </button>

    <div id="detalhes-saude" class="detalhes" role="group" aria-label="Detalhes da saúde do sistema" [hidden]="!aberto()">
      @let s = saudeSvc.saude();
      @if (s) {
        <ul>
          <li>
            Modelos de linguagem (llama-swap): {{ parte(s.llm.estado) }}{{ s.llm.estado === 'ok' ? ' · ' + s.llm.ms + ' ms' : '' }}
            @if (s.llm.estado !== 'ok') {
              <span class="dica">Suba o llama-swap: infra\\swap.ps1</span>
            }
          </li>
          <li>
            Grafo (Neo4j): {{ parte(s.neo4j.estado) }}{{ s.neo4j.estado === 'ok' ? ' · ' + s.neo4j.ms + ' ms' : '' }}
            @if (s.neo4j.estado !== 'ok') {
              <span class="dica">Suba o Neo4j: infra\\neo4j.ps1 iniciar</span>
            }
          </li>
          <li>
            Índices: {{ resumoIndices() }}
            @if (indicesForaDoAr().length > 0) {
              <span class="dica">Fora do ar: {{ indicesForaDoAr().join(', ') }}</span>
            }
          </li>
          <li>Modelos na memória: {{ resumoModelos() }}</li>
        </ul>
      } @else if (saudeSvc.motivoFora() === 'inesperada') {
        <p>A API deu uma resposta inesperada (não é a do contrato de saúde).</p>
      } @else if (saudeSvc.motivoFora() === 'sem_resposta') {
        <p>A API não respondeu. Confira se ela está em execução (cd api; node dist/server.js).</p>
      } @else {
        <p>Verificando o estado do sistema…</p>
      }
      <button type="button" class="verificar" (click)="saudeSvc.verificar()">Verificar de novo</button>
    </div>
  `,
  styles: `
    :host {
      display: contents;
    }

    .selo {
      display: inline-flex;
      align-items: center;
      gap: 0.4rem;
      padding: 0.3rem 0.7rem;
      font: inherit;
      font-size: 0.9rem;
      color: inherit;
      background: transparent;
      border: 1px solid var(--borda);
      border-radius: 999px;
      cursor: pointer;
    }

    .selo:focus-visible,
    .verificar:focus-visible {
      outline: 2px solid var(--destaque);
      outline-offset: 2px;
    }

    .ponto {
      width: 0.6rem;
      height: 0.6rem;
      border-radius: 50%;
      background: #8a8a8a;
    }

    [data-estado='ok'] .ponto {
      background: #1a7f37;
    }

    [data-estado='degradado'] .ponto {
      background: #b7791f;
    }

    [data-estado='fora'] .ponto {
      background: #b3261e;
    }

    .detalhes {
      flex: 1 0 100%;
      box-sizing: border-box;
      max-width: 100%;
      padding: 0.6rem 0.9rem;
      font-size: 0.9rem;
      background: var(--superficie);
      border: 1px solid var(--borda);
      border-radius: var(--raio);
      overflow-wrap: anywhere;
    }

    .detalhes[hidden] {
      display: none;
    }

    ul {
      margin: 0 0 0.5rem;
      padding-left: 1.1rem;
    }

    p {
      margin: 0 0 0.5rem;
    }

    .dica {
      display: block;
      color: var(--texto-suave);
      font-size: 0.85rem;
    }

    .verificar {
      padding: 0.3rem 0.8rem;
      font: inherit;
      color: var(--destaque);
      background: transparent;
      border: 1px solid var(--destaque);
      border-radius: var(--raio);
      cursor: pointer;
    }
  `,
})
export class SeloSaude {
  protected readonly saudeSvc = inject(SaudeService);
  protected readonly aberto = signal(false);
  private readonly botao = viewChild.required<ElementRef<HTMLButtonElement>>('botao');

  protected readonly rotulo = computed(() => ROTULOS[this.saudeSvc.estado()]);
  protected readonly parte = (e: EstadoParte) => PARTES[e];

  protected readonly indicesForaDoAr = computed(() =>
    (this.saudeSvc.saude()?.indices ?? []).filter((i) => i.estado !== 'ONLINE').map((i) => `${i.nome} (${i.estado})`),
  );

  protected readonly resumoIndices = computed(() => {
    const s = this.saudeSvc.saude();
    if (!s) return '';
    if (s.neo4j.estado !== 'ok') return 'não foi possível consultar';
    if (s.indices.length === 0) return 'nenhum';
    return `${s.indices.filter((i) => i.estado === 'ONLINE').length} de ${s.indices.length} no ar`;
  });

  protected readonly resumoModelos = computed(() => {
    const s = this.saudeSvc.saude();
    if (!s || s.llm.estado !== 'ok' || s.modelos.length === 0) return 'sem informação';
    return `${s.modelos.filter((m) => m.carregado).length} de ${s.modelos.length} (o primeiro uso de um modelo que não está na memória leva cerca de 14 s)`;
  });

  protected fechar(): void {
    if (!this.aberto()) return;
    this.aberto.set(false);
    this.botao().nativeElement.focus();
  }
}
