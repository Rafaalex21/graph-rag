import { ChangeDetectionStrategy, Component, input, output, signal } from '@angular/core';
import { paginaDaCelula, tamanhoEmTexto, type MaterialGerado } from './modelo';

/**
 * O material que o assistente gerou (F8.10): o gráfico (uma imagem SVG que o servidor desenhou, com texto alternativo), a tabela
 * com a página de cada valor (clicar abre o visualizador na página) e os links para baixar o `.xlsx`, `.docx`, `.pptx` ou `.svg`.
 * Tudo que veio da API entra como texto, e só endereços `/api/arquivos/…` viram imagem ou link (ver `materialDaResposta`).
 */
@Component({
  selector: 'app-material-gerado',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { '[attr.aria-label]': '"Material gerado: " + material().titulo', role: 'region' },
  template: `
    @if (material().grafico; as g) {
      <figure class="grafico">
        @if (!imagemFalhou()) {
          <img [src]="g.url" [alt]="g.descricao" (error)="imagemFalhou.set(true)" />
        } @else {
          <p class="falha">Não foi possível carregar o gráfico.</p>
        }
      </figure>
    }

    <div class="rolagem" tabindex="0">
      <table>
        <caption>
          {{
            material().titulo
          }}
          @if (material().unidade !== '') {
            <span class="unidade">({{ material().unidade }})</span>
          }
        </caption>
        <thead>
          <tr>
            @for (c of material().colunas; track $index) {
              <th scope="col">{{ c }}</th>
            }
          </tr>
        </thead>
        <tbody>
          @for (linha of material().linhas; track $index) {
            <tr>
              @for (celula of linha; track $index) {
                <td>
                  @if (paginaDaCelula(celula); as pagina) {
                    <button type="button" class="pagina" (click)="abrirPagina.emit(pagina)">
                      {{ celula }}
                    </button>
                  } @else {
                    {{ celula }}
                  }
                </td>
              }
            </tr>
          }
        </tbody>
      </table>
    </div>

    @if (material().removidos > 0) {
      <p class="aviso" role="note">
        {{ material().removidos }}
        {{ material().removidos === 1 ? 'valor sem lastro' : 'valores sem lastro' }} no documento
        {{ material().removidos === 1 ? 'foi deixado' : 'foram deixados' }} de fora.
      </p>
    }

    @if (material().arquivos.length > 0) {
      <div class="arquivos">
        @for (a of material().arquivos; track a.url) {
          <a class="baixar" [href]="a.url" [attr.download]="a.nome">
            {{ a.rotulo }}
            <span class="tamanho">{{ tamanho(a.bytes) }}</span>
          </a>
        }
      </div>
    }
  `,
  styles: `
    :host {
      display: grid;
      grid-template-columns: minmax(0, 1fr);
      gap: 0.8rem;
      min-width: 0;
      padding: 0.9rem;
      background: var(--a-leve);
      border: 1px solid var(--a-linha);
      border-radius: 0.9rem;
    }

    figure {
      display: grid;
      gap: 0.4rem;
      margin: 0;
      min-width: 0;
    }

    img {
      display: block;
      width: 100%;
      max-width: 640px;
      height: auto;
      background: #fff;
      border: 1px solid var(--a-linha);
      border-radius: 0.6rem;
    }

    .unidade {
      font-size: 0.8125rem;
      color: var(--texto-suave);
    }

    .falha,
    .aviso {
      margin: 0;
      padding: 0.5rem 0.7rem;
      font-size: 0.875rem;
      color: var(--a-selo-parcial-texto);
      background: var(--a-selo-parcial);
      border-radius: 0.5rem;
    }

    .rolagem {
      min-width: 0;
      overflow-x: auto;
    }

    table {
      width: 100%;
      border-collapse: collapse;
      font-size: 0.875rem;
    }

    caption {
      padding-bottom: 0.4rem;
      font-weight: 600;
      text-align: left;
    }

    th,
    td {
      padding: 0.45rem 0.7rem;
      text-align: left;
      border-bottom: 1px solid var(--a-linha);
    }

    th {
      font-size: 0.75rem;
      font-weight: 600;
      letter-spacing: 0.03em;
      color: var(--texto-suave);
    }

    td:nth-child(2),
    th:nth-child(2) {
      text-align: right;
      font-variant-numeric: tabular-nums;
    }

    .pagina {
      padding: 0;
      font: inherit;
      color: var(--a-marca-forte);
      text-decoration: underline;
      background: transparent;
      border: 0;
      cursor: pointer;
    }

    .arquivos {
      display: flex;
      flex-wrap: wrap;
      gap: 0.5rem;
    }

    .baixar {
      display: inline-flex;
      align-items: center;
      gap: 0.5rem;
      min-height: 2.5rem;
      max-width: 100%;
      padding: 0 0.9rem;
      font-size: 0.875rem;
      font-weight: 600;
      color: #fff;
      text-decoration: none;
      background: var(--a-marca);
      border-radius: 0.75rem;
    }

    .tamanho {
      font-weight: 400;
      opacity: 0.85;
    }
  `,
})
export class MaterialGeradoComponent {
  readonly material = input.required<MaterialGerado>();
  /** O número da página da célula "Fonte" clicada. */
  readonly abrirPagina = output<string>();

  protected readonly imagemFalhou = signal(false);
  protected readonly paginaDaCelula = paginaDaCelula;
  protected readonly tamanho = tamanhoEmTexto;
}
