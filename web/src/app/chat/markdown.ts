/**
 * A resposta do modelo em DOM seguro (F8.2). O texto é entrada não confiável (um modelo que leu um documento), então a conta é
 * em três camadas, e nenhuma usa `innerHTML` na página:
 *
 *  1. o `marked` converte markdown em HTML, mas o HTML cru que vier no texto é escapado (vira texto na tela), os cabeçalhos
 *     viram parágrafo em negrito (a página já tem o seu `h1`) e imagem e link saem (a imagem faria um pedido de rede ao abrir
 *     a resposta, o que fura o "100% local"; o texto do link fica);
 *  2. o DOMPurify, com lista fechada de elementos e sem nenhum atributo além de `start`, devolve um fragmento de DOM;
 *  3. os marcadores de citação (`[p. 6]`, `[p. 6-7]`, `[p. 6, 9, 12]`, `[sem página]`, `[E1]`) viram chips por nós de texto,
 *     criados com `createElement` e `textContent`, fora de `code` e `pre`.
 */
import DOMPurify from 'dompurify';
import { Marked } from 'marked';

const escapar = (t: string) => t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

const marcado = new Marked({ gfm: true, breaks: false, async: false });
marcado.use({
  renderer: {
    html({ text }) {
      return escapar(text);
    },
    heading({ tokens }) {
      return `<p><strong>${this.parser.parseInline(tokens)}</strong></p>\n`;
    },
    image({ text }) {
      return escapar(text);
    },
  },
});

const ELEMENTOS = ['p', 'strong', 'em', 'del', 'code', 'pre', 'ul', 'ol', 'li', 'blockquote', 'table', 'thead', 'tbody', 'tr', 'th', 'td', 'br', 'hr'];

// Uma página: 1 a 5 dígitos, sem zero à esquerda; faixa "6-7"; lista "6, 9, 12".
const PAG = '[1-9]\\d{0,4}';
const ITEM = `${PAG}(?:-${PAG})?`;
const CITACAO = new RegExp(`\\[p\\. (${ITEM}(?:, ${ITEM})*)\\]|\\[(sem página)\\]|\\[E\\d{1,4}\\]`, 'g');

function chip(m: RegExpExecArray): HTMLElement {
  const [todo, paginas, semPagina] = m;
  if (paginas) {
    const primeira = /^\d+/.exec(paginas)?.[0] ?? '';
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'citacao';
    b.dataset['pagina'] = primeira;
    b.setAttribute('aria-label', `Abrir a página ${primeira} do documento`);
    b.textContent = `p. ${paginas}`;
    return b;
  }
  const s = document.createElement('span');
  s.className = 'citacao';
  s.textContent = semPagina ?? (todo.startsWith('[E') ? 'fonte' : todo);
  return s;
}

function comChips(raiz: DocumentFragment): void {
  const nos: Text[] = [];
  const andador = document.createTreeWalker(raiz, NodeFilter.SHOW_TEXT);
  for (let n = andador.nextNode(); n; n = andador.nextNode()) {
    const t = n as Text;
    if (t.data.includes('[') && !t.parentElement?.closest('code, pre')) nos.push(t);
  }
  for (const no of nos) {
    const texto = no.data;
    CITACAO.lastIndex = 0;
    let fim = 0;
    let saida: DocumentFragment | null = null;
    for (let m = CITACAO.exec(texto); m; m = CITACAO.exec(texto)) {
      saida ??= document.createDocumentFragment();
      if (m.index > fim) saida.append(texto.slice(fim, m.index));
      saida.append(chip(m));
      fim = m.index + m[0].length;
    }
    if (!saida) continue;
    if (fim < texto.length) saida.append(texto.slice(fim));
    no.replaceWith(saida);
  }
}

/** O texto da resposta (inclusive o parcial do streaming) em um fragmento de DOM seguro, com os chips de citação. */
export function renderizar(texto: string): DocumentFragment {
  if (texto.trim() === '') return document.createDocumentFragment();
  const bruto = (marcado.parse(texto) as string).trim();
  const limpo = DOMPurify.sanitize(bruto, { ALLOWED_TAGS: ELEMENTOS, ALLOWED_ATTR: ['start'], RETURN_DOM_FRAGMENT: true });
  comChips(limpo);
  return limpo;
}
