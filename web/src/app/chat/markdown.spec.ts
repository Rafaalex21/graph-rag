/**
 * Testes da renderização da resposta (F8.2), escritos antes do código: markdown sanitizado e chips de citação.
 * O texto vem de um modelo que leu um documento: é entrada não confiável. Modos de falha:
 *
 *  1. XSS: `<script>`, `<img onerror>`, `<svg onload>`, `<iframe>`, `<style>`, `<object>`, `<form>`, `javascript:` em link
 *     de markdown e em HTML, `data:`, entidade que forma `javascript:`, atributo `on*`, `<math>`; o resultado não tem nenhum
 *     elemento nem atributo perigoso, e `window` nunca é tocada;
 *  2. imagem e link saem (a imagem faria um pedido de rede ao abrir a resposta, o que fura o "100% local"); o texto do
 *     link fica;
 *  3. cabeçalho (`#`) não vira `h1`..`h6` (a página já tem o seu `h1`): vira parágrafo em negrito;
 *  4. o markdown que a resposta usa funciona: negrito, itálico, listas, tabela, código, citação em bloco;
 *  5. texto PARCIAL, como o do streaming (`**aberto`, tabela cortada, crase sem fechar, `[` solto, `<` sozinho), não lança
 *     erro e mostra o que já chegou;
 *  6. números e moeda ("R$ 20,5 bilhões", "1.234,56", "a < b", "5%") saem como entraram;
 *  7. chips: `[p. 6]`, `[p. 6-7]`, `[p. 6, 9, 12]` viram botão com a página, `[sem página]` vira marca sem clique,
 *     `[E1]` (a resposta ainda em streaming) vira marca "fonte" sem clique; nada disso dentro de código;
 *  8. um colchete que parece mas não é citação (`[p. abc]`, `[página 6]`, `[p. 6` sem fechar) fica como texto;
 *  9. o texto do chip nunca é HTML: `[p. 6]` dentro de um elemento perigoso não escapa da sanitização;
 * 10. vazio e só espaço dão fragmento vazio; a mesma entrada dá o mesmo resultado.
 */
import { describe, expect, it } from 'vitest';
import { renderizar } from './markdown';

function html(texto: string): string {
  const d = document.createElement('div');
  d.append(renderizar(texto));
  return d.innerHTML;
}
function dom(texto: string): HTMLElement {
  const d = document.createElement('div');
  d.append(renderizar(texto));
  return d;
}

const PERIGOSOS = 'script, iframe, object, embed, style, form, input, button:not(.citacao), svg, math, img, link, meta, base, a, video, audio, textarea, select, frame';

describe('sanitização', () => {
  const ataques: [string, string][] = [
    ['script', '<script>window.__xss = 1</script>olá'],
    ['img onerror', '<img src=x onerror="window.__xss=1">'],
    ['svg onload', '<svg onload="window.__xss=1"><circle/></svg>'],
    ['iframe', '<iframe src="https://evil.example"></iframe>'],
    ['iframe srcdoc', '<iframe srcdoc="<script>parent.__xss=1</script>"></iframe>'],
    ['style', '<style>body{display:none}</style>texto'],
    ['object', '<object data="https://evil.example"></object>'],
    ['embed', '<embed src="https://evil.example">'],
    ['form', '<form action="https://evil.example"><input name=x><button>ok</button></form>'],
    ['link markdown javascript', '[clique](javascript:window.__xss=1)'],
    ['link html javascript', '<a href="javascript:window.__xss=1">x</a>'],
    ['link entidade', '<a href="&#106;avascript:window.__xss=1">x</a>'],
    ['link data', '[x](data:text/html;base64,PHNjcmlwdD53aW5kb3cuX194c3M9MTwvc2NyaXB0Pg==)'],
    ['imagem markdown', '![rastreador](https://evil.example/pixel.png)'],
    ['onclick em tag permitida', '<p onclick="window.__xss=1" onmouseover="window.__xss=1">x</p>'],
    ['math', '<math><mtext><table><mglyph><style><img src=x onerror=window.__xss=1></style></mglyph></table></mtext></math>'],
    ['meta refresh', '<meta http-equiv="refresh" content="0;url=https://evil.example">'],
    ['base', '<base href="https://evil.example/">'],
    ['atributo style', '<p style="background:url(https://evil.example/x)">x</p>'],
    ['marcador de citação com html', '[p. 6"><img src=x onerror=window.__xss=1>]'],
    ['tabela com script', '| a |\n|---|\n| <script>window.__xss=1</script> |'],
    ['código com html', '`<img src=x onerror=window.__xss=1>`'],
  ];

  it.each(ataques)('%s: nenhum elemento perigoso e nenhum atributo de evento', (_nome, entrada) => {
    (window as unknown as Record<string, unknown>)['__xss'] = 0;
    const d = dom(entrada);
    expect(d.querySelectorAll(PERIGOSOS).length, d.innerHTML).toBe(0);
    for (const el of Array.from(d.querySelectorAll('*'))) {
      for (const a of Array.from(el.attributes)) {
        expect(a.name.startsWith('on'), `${el.tagName} ${a.name}`).toBe(false);
        expect(['style', 'href', 'src', 'srcdoc', 'action', 'formaction'].includes(a.name), `${el.tagName} ${a.name}`).toBe(false);
        expect(/javascript:/i.test(a.value), `${el.tagName} ${a.name}=${a.value}`).toBe(false);
      }
    }
    expect((window as unknown as Record<string, unknown>)['__xss']).toBe(0);
  });

  it('o texto de um link sobrevive sem o link', () => {
    expect(dom('veja [a página oficial](https://exemplo.com.br) agora').textContent).toBe('veja a página oficial agora');
  });

  it('o texto de código com HTML aparece como texto, não como elemento', () => {
    const d = dom('`<img src=x>`');
    expect(d.querySelector('code')?.textContent).toBe('<img src=x>');
    expect(d.querySelector('img')).toBeNull();
  });
});

describe('markdown da resposta', () => {
  it('negrito, itálico, código em linha e parágrafos', () => {
    const d = dom('O lucro foi **R$ 20 bilhões**, _acima_ do `guia`.\n\nSegundo parágrafo.');
    expect(d.querySelectorAll('p')).toHaveLength(2);
    expect(d.querySelector('strong')?.textContent).toBe('R$ 20 bilhões');
    expect(d.querySelector('em')?.textContent).toBe('acima');
    expect(d.querySelector('code')?.textContent).toBe('guia');
  });

  it('listas ordenada e não ordenada', () => {
    const d = dom('- um\n- dois\n\n1. a\n2. b');
    expect(d.querySelectorAll('ul > li')).toHaveLength(2);
    expect(d.querySelectorAll('ol > li')).toHaveLength(2);
  });

  it('tabela', () => {
    const d = dom('| Ano | Lucro |\n|---|---|\n| 2024 | 37,9 |\n| 2025 | 20,0 |');
    expect(d.querySelectorAll('table th')).toHaveLength(2);
    expect(d.querySelectorAll('table tbody tr')).toHaveLength(2);
    expect(d.querySelector('tbody tr td')?.textContent).toBe('2024');
  });

  it('citação em bloco e bloco de código', () => {
    const d = dom('> trecho\n\n```\nlinha 1\nlinha 2\n```');
    expect(d.querySelector('blockquote')?.textContent?.trim()).toBe('trecho');
    expect(d.querySelector('pre code')?.textContent).toContain('linha 2');
  });

  it.each(['# Título', '## Subtítulo', '###### Fundo'])('cabeçalho %j vira parágrafo em negrito, nunca h1..h6', (entrada) => {
    const d = dom(`${entrada}\n\ncorpo`);
    expect(d.querySelectorAll('h1,h2,h3,h4,h5,h6')).toHaveLength(0);
    expect(d.querySelector('p > strong')?.textContent).toBe(entrada.replace(/^#+ /, ''));
  });

  it.each([
    ['R$ 20,5 bilhões em 2025', 'R$ 20,5 bilhões em 2025'],
    ['1.234,56 e 5% (a < b)', '1.234,56 e 5% (a < b)'],
    ['a * b * c', 'a * b * c'],
    ['lucro de R$ 1,5* mi', 'lucro de R$ 1,5* mi'],
  ])('números e símbolos %j saem como entraram', (entrada, texto) => {
    expect(dom(entrada).textContent?.trim()).toBe(texto);
  });
});

describe('texto parcial do streaming', () => {
  it.each(['**negrito aberto', '_itálico', '| a | b |\n|---', '| a | b |\n|---|---|\n| 1', '`crase', '```\ncódigo sem fim', '[', '[p.', '[p. 6', '<', '<p', '<scr', '- ', '1.', '> ', '![', '[x](', '&', '\\'])(
    '%j não lança erro',
    (entrada) => {
      expect(() => renderizar(entrada)).not.toThrow();
    },
  );

  it('mostra o que já chegou', () => {
    expect(dom('O lucro foi **R$ 20').textContent).toContain('R$ 20');
  });

  it('<scr sozinho aparece como texto e não some em silêncio', () => {
    const t = dom('antes <scr').textContent ?? '';
    expect(t).toContain('antes');
  });
});

describe('chips de citação', () => {
  const chips = (t: string) => Array.from(dom(t).querySelectorAll<HTMLElement>('.citacao'));

  it('[p. 6] vira botão com a página e nome acessível', () => {
    const [c] = chips('Lucro de R$ 20 bi [p. 6].');
    expect(c?.tagName).toBe('BUTTON');
    expect(c?.getAttribute('type')).toBe('button');
    expect(c?.textContent).toBe('p. 6');
    expect(c?.getAttribute('data-pagina')).toBe('6');
    expect(c?.getAttribute('aria-label')).toBe('Abrir a página 6 do documento');
  });

  it.each([
    ['[p. 6-7]', 'p. 6-7', '6'],
    ['[p. 6, 9, 12]', 'p. 6, 9, 12', '6'],
    ['[p. 10-12, 40]', 'p. 10-12, 40', '10'],
  ])('%s vira um chip que abre a primeira página', (entrada, rotulo, pagina) => {
    const [c] = chips(`texto ${entrada}`);
    expect(c?.textContent).toBe(rotulo);
    expect(c?.getAttribute('data-pagina')).toBe(pagina);
  });

  it('várias citações na mesma frase viram vários chips, na ordem', () => {
    expect(chips('a [p. 6][p. 9] e b [p. 12].').map((c) => c.getAttribute('data-pagina'))).toEqual(['6', '9', '12']);
  });

  it('[sem página] é uma marca sem clique', () => {
    const [c] = chips('x [sem página].');
    expect(c?.tagName).toBe('SPAN');
    expect(c?.textContent).toBe('sem página');
    expect(c?.hasAttribute('data-pagina')).toBe(false);
  });

  it('[E1] (streaming) é uma marca "fonte" sem clique', () => {
    const [c] = chips('x [E1][E2].');
    expect(c?.tagName).toBe('SPAN');
    expect(c?.textContent).toBe('fonte');
    expect(chips('x [E1][E2].')).toHaveLength(2);
  });

  it('dentro de código o colchete fica como texto', () => {
    expect(chips('`[p. 6]` e\n\n```\n[p. 7]\n```')).toHaveLength(0);
    expect(dom('`[p. 6]`').querySelector('code')?.textContent).toBe('[p. 6]');
  });

  it('o chip funciona dentro de lista e de tabela', () => {
    expect(chips('- item [p. 3]\n- outro [p. 4]')).toHaveLength(2);
    expect(chips('| a |\n|---|\n| 1 [p. 5] |')).toHaveLength(1);
  });

  it.each(['[p. abc]', '[página 6]', '[p.6]', '[p. 6', 'p. 6]', '[P. 6]', '[p. 6-]', '[p. ]', '[pp. 6]', '[p. 0]', '[p. 99999999999999999999]'])('%j não é citação', (entrada) => {
    expect(chips(`texto ${entrada}`)).toHaveLength(0);
    expect(dom(`texto ${entrada}`).textContent).toContain(entrada.replace(/\\/g, ''));
  });

  it('o rótulo do chip nunca é HTML', () => {
    const d = dom('[p. 6]');
    expect(d.querySelector('.citacao')?.innerHTML).toBe('p. 6');
  });
});

describe('geral', () => {
  it('vazio e só espaço dão fragmento vazio', () => {
    expect(html('')).toBe('');
    expect(html('  \n  ')).toBe('');
  });

  it('a mesma entrada dá o mesmo resultado', () => {
    const t = 'Lucro **R$ 20 bi** [p. 6] e [p. 9].\n\n- a\n- b';
    expect(html(t)).toBe(html(t));
  });

  it('uma resposta de 200 kB renderiza em menos de 1,5 s', () => {
    const t0 = performance.now();
    renderizar(`${'Parágrafo com **negrito** e [p. 6] e números 1.234,56. '.repeat(3500)}`);
    expect(performance.now() - t0).toBeLessThan(1500);
  });
});
