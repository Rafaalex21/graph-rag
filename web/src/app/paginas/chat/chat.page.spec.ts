/**
 * Testes da página do chat (F8.2), escritos antes do código. Modos de falha:
 *
 *  1. teclado: Enter envia, Shift+Enter quebra a linha e NÃO envia, Enter durante a composição (IME, acento morto) não envia;
 *     o botão fica desligado com a caixa vazia ou só com espaço e enquanto uma resposta é gerada;
 *  2. a pergunta aparece na hora, a caixa esvazia e volta a ter o foco; os tokens aparecem aos poucos na resposta;
 *  3. o `[E1]` do streaming vira a marca "fonte" e, no fim, os chips `[p. 6]` clicáveis; clicar no chip leva à aba Fontes com
 *     a página na URL (`?pagina=6`), que é onde a F8.4 vai abrir o PDF;
 *  4. HTML na resposta nunca vira elemento (a resposta vem de um modelo): `<img onerror>` e `<script>` ficam sem efeito;
 *  5. erro: aparece num `role="alert"` com a mensagem em português e o botão "Tentar de novo"; nunca "undefined" nem pilha;
 *  6. "Parar" só existe durante a geração, cancela e deixa a resposta parcial com o aviso de que foi interrompida;
 *  7. acessibilidade: a caixa tem rótulo, a lista de mensagens é um `log`, o estado ("Gerando a resposta…", "Resposta
 *     pronta.") vai para um `role="status"` (os tokens não são lidos um a um), e há um único `h1`;
 *  8. contador de caracteres só perto do limite; a caixa tem `maxlength` 4.000 (o limite da API);
 *  9. "Nova conversa" limpa a lista.
 */
import { provideLocationMocks } from '@angular/common/testing';
import { TestBed } from '@angular/core/testing';
import { Router } from '@angular/router';
import { RouterTestingHarness } from '@angular/router/testing';
import { beforeEach, describe, expect, it } from 'vitest';
import { provedoresDoRoteador } from '../../app.config';
import { FETCH_DO_CHAT } from '../../chat/chat.service';

const enc = new TextEncoder();
const quadro = (evento: string, dados: unknown) => `event: ${evento}\ndata: ${JSON.stringify(dados)}\n\n`;
const fim = (resposta: string) => quadro('fim', { mensagemId: 'm1', resposta, citacoes: [{ id: 'p1', pagina: 'p. 6' }], metricas: { latenciaMs: 1, tokensEntrada: 1, tokensSaida: 1, rota: ['buscar_trechos'], estado: 'suficiente' } });

function servidor() {
  let controle!: ReadableStreamDefaultController<Uint8Array>;
  let resolver!: (r: Response) => void;
  const pedidos: Record<string, unknown>[] = [];
  const fetchFalso: typeof fetch = (_u, init) => {
    pedidos.push(JSON.parse(String((init as RequestInit).body)) as Record<string, unknown>);
    return new Promise<Response>((ok, falhou) => {
      resolver = ok;
      (init as RequestInit).signal?.addEventListener('abort', () => falhou(new DOMException('abortado', 'AbortError')));
    });
  };
  return {
    fetchFalso,
    pedidos,
    abrir() {
      resolver(new Response(new ReadableStream<Uint8Array>({ start: (c) => (controle = c) }), { status: 200 }));
    },
    erro(status: number, corpo: unknown) {
      resolver(new Response(JSON.stringify(corpo), { status, headers: { 'content-type': 'application/json' } }));
    },
    enviar(...q: string[]) {
      for (const x of q) controle.enqueue(enc.encode(x));
    },
    fechar() {
      controle.close();
    },
  };
}

let s: ReturnType<typeof servidor>;
async function montar() {
  TestBed.resetTestingModule();
  TestBed.configureTestingModule({ providers: [...provedoresDoRoteador, provideLocationMocks(), { provide: FETCH_DO_CHAT, useValue: s.fetchFalso }] });
  const h = await RouterTestingHarness.create();
  await h.navigateByUrl('/chat/rastro');
  const el = h.routeNativeElement as HTMLElement;
  return { h, el, router: TestBed.inject(Router) };
}

const tick = () => new Promise<void>((r) => setTimeout(r, 0));
async function estavel(h: RouterTestingHarness) {
  for (let i = 0; i < 4; i++) {
    await tick();
    h.detectChanges();
  }
}
const caixa = (el: HTMLElement) => el.querySelector('textarea') as HTMLTextAreaElement;
const botao = (el: HTMLElement, nome: RegExp) => Array.from(el.querySelectorAll('button')).find((b) => nome.test(b.textContent ?? '')) as HTMLButtonElement | undefined;
function digitar(h: RouterTestingHarness, el: HTMLElement, texto: string) {
  const c = caixa(el);
  c.value = texto;
  c.dispatchEvent(new Event('input', { bubbles: true }));
  h.detectChanges();
}
function tecla(el: HTMLElement, key: string, extra: KeyboardEventInit = {}) {
  const ev = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...extra });
  caixa(el).dispatchEvent(ev);
  return ev;
}
const respostas = (el: HTMLElement) => Array.from(el.querySelectorAll<HTMLElement>('[data-papel="assistente"]'));
const perguntas = (el: HTMLElement) => Array.from(el.querySelectorAll<HTMLElement>('[data-papel="usuario"]'));

beforeEach(() => {
  s = servidor();
});

describe('envio pelo teclado e pelo botão', () => {
  it('Enter envia; a pergunta aparece, a caixa esvazia e fica com o foco', async () => {
    const { h, el } = await montar();
    document.body.append(el);
    digitar(h, el, 'Qual o lucro de 2025?');
    const ev = tecla(el, 'Enter');
    expect(ev.defaultPrevented).toBe(true);
    await estavel(h);
    expect(s.pedidos).toHaveLength(1);
    expect(s.pedidos[0]?.['message']).toBe('Qual o lucro de 2025?');
    expect(perguntas(el).map((p) => p.textContent?.trim())).toEqual(['Qual o lucro de 2025?']);
    expect(caixa(el).value).toBe('');
    expect(document.activeElement).toBe(caixa(el));
    el.remove();
  });

  it('Shift+Enter não envia nem bloqueia a quebra de linha', async () => {
    const { h, el } = await montar();
    digitar(h, el, 'linha 1');
    const ev = tecla(el, 'Enter', { shiftKey: true });
    expect(ev.defaultPrevented).toBe(false);
    await estavel(h);
    expect(s.pedidos).toHaveLength(0);
  });

  it('Enter durante a composição (IME) não envia', async () => {
    const { h, el } = await montar();
    digitar(h, el, 'ação');
    tecla(el, 'Enter', { isComposing: true });
    await estavel(h);
    expect(s.pedidos).toHaveLength(0);
  });

  it('Enter com a caixa vazia ou só com espaço não envia', async () => {
    const { h, el } = await montar();
    tecla(el, 'Enter');
    digitar(h, el, '   ');
    tecla(el, 'Enter');
    await estavel(h);
    expect(s.pedidos).toHaveLength(0);
  });

  it('o botão Enviar fica desligado com a caixa vazia e liga ao digitar', async () => {
    const { h, el } = await montar();
    expect(botao(el, /enviar/i)?.disabled).toBe(true);
    digitar(h, el, 'oi');
    expect(botao(el, /enviar/i)?.disabled).toBe(false);
    digitar(h, el, '  ');
    expect(botao(el, /enviar/i)?.disabled).toBe(true);
  });

  it('o clique no botão envia, e durante a geração o botão fica desligado e Enter não envia outra', async () => {
    const { h, el } = await montar();
    digitar(h, el, 'primeira');
    botao(el, /enviar/i)?.click();
    await estavel(h);
    digitar(h, el, 'segunda');
    expect(botao(el, /enviar/i)?.disabled).toBe(true);
    tecla(el, 'Enter');
    await estavel(h);
    expect(s.pedidos).toHaveLength(1);
  });
});

describe('a resposta', () => {
  it('mostra os tokens aos poucos, o [E1] como "fonte" e, no fim, o chip da página', async () => {
    const { h, el } = await montar();
    digitar(h, el, 'Qual o lucro?');
    tecla(el, 'Enter');
    s.abrir();
    s.enviar(quadro('token', { t: 'O lucro foi ' }));
    await estavel(h);
    expect(respostas(el)[0]?.textContent).toContain('O lucro foi');
    s.enviar(quadro('token', { t: 'R$ 20 bi [E1].' }));
    await estavel(h);
    expect(respostas(el)[0]?.querySelector('.citacao')?.textContent).toBe('fonte');
    s.enviar(fim('O lucro foi R$ 20 bi [p. 6].'));
    s.fechar();
    await estavel(h);
    const chip = respostas(el)[0]?.querySelector<HTMLButtonElement>('button.citacao');
    expect(chip?.textContent).toBe('p. 6');
    expect(respostas(el)[0]?.querySelector('.citacao.pendente, span.citacao')).toBeNull();
  });

  it('clicar no chip leva à aba Fontes com a página na URL', async () => {
    const { h, el, router } = await montar();
    digitar(h, el, 'x');
    tecla(el, 'Enter');
    s.abrir();
    s.enviar(fim('Lucro [p. 6, 9].'));
    s.fechar();
    await estavel(h);
    respostas(el)[0]?.querySelector<HTMLButtonElement>('button.citacao')?.click();
    await estavel(h);
    expect(router.url).toBe('/chat/fontes?pagina=6');
  });

  it('HTML na resposta não vira elemento nem executa', async () => {
    const { h, el } = await montar();
    (window as unknown as Record<string, unknown>)['__xss'] = 0;
    digitar(h, el, 'x');
    tecla(el, 'Enter');
    s.abrir();
    s.enviar(quadro('token', { t: '<img src=x onerror="window.__xss=1"><script>window.__xss=1</script>texto **ok**' }));
    await estavel(h);
    const r = respostas(el)[0] as HTMLElement;
    expect(r.querySelector('img, script, iframe')).toBeNull();
    expect(r.textContent).toContain('texto');
    expect(r.querySelector('strong')?.textContent).toBe('ok');
    expect((window as unknown as Record<string, unknown>)['__xss']).toBe(0);
  });

  it('a pergunta do usuário é texto puro: HTML nela não vira elemento', async () => {
    const { h, el } = await montar();
    digitar(h, el, '<b>negrito</b><img src=x>');
    tecla(el, 'Enter');
    await estavel(h);
    expect(perguntas(el)[0]?.querySelector('b, img')).toBeNull();
    expect(perguntas(el)[0]?.textContent).toContain('<b>negrito</b>');
  });
});

describe('erro e cancelamento', () => {
  it('erro da API: alert com a mensagem em português e "Tentar de novo" que refaz a pergunta', async () => {
    const { h, el } = await montar();
    digitar(h, el, 'Qual o lucro?');
    tecla(el, 'Enter');
    await estavel(h);
    s.erro(429, { codigo: 'ocupado', mensagem: 'Há perguntas demais em andamento. Tente de novo em instantes.' });
    await estavel(h);
    const alerta = el.querySelector('[role="alert"]');
    expect(alerta?.textContent).toContain('Há perguntas demais em andamento.');
    expect(el.textContent).not.toMatch(/undefined|\[object|at .*\.js/);
    botao(el, /tentar de novo/i)?.click();
    await estavel(h);
    expect(s.pedidos).toHaveLength(2);
    expect(s.pedidos[1]?.['message']).toBe('Qual o lucro?');
    expect(perguntas(el)).toHaveLength(1);
    expect(el.querySelector('[role="alert"]')).toBeNull();
  });

  it('o erro no meio mantém o texto parcial visível', async () => {
    const { h, el } = await montar();
    digitar(h, el, 'x');
    tecla(el, 'Enter');
    s.abrir();
    s.enviar(quadro('token', { t: 'Começo da resposta' }), quadro('erro', { codigo: 'llm_timeout', mensagem: 'O modelo de linguagem demorou demais. Tente novamente.' }));
    s.fechar();
    await estavel(h);
    expect(respostas(el)[0]?.textContent).toContain('Começo da resposta');
    expect(el.querySelector('[role="alert"]')?.textContent).toContain('demorou demais');
  });

  it('"Parar" só existe durante a geração; cancela e avisa que foi interrompida', async () => {
    const { h, el } = await montar();
    expect(botao(el, /parar/i)).toBeUndefined();
    digitar(h, el, 'x');
    tecla(el, 'Enter');
    s.abrir();
    s.enviar(quadro('token', { t: 'Parcial' }));
    await estavel(h);
    const parar = botao(el, /parar/i);
    expect(parar).toBeDefined();
    parar?.click();
    await estavel(h);
    expect(botao(el, /parar/i)).toBeUndefined();
    expect(respostas(el)[0]?.textContent).toContain('Parcial');
    expect(respostas(el)[0]?.textContent).toMatch(/interrompida/i);
    expect(el.querySelector('[role="alert"]')).toBeNull();
    expect(botao(el, /enviar/i)?.disabled).toBe(true); // caixa vazia, mas livre para nova pergunta
    digitar(h, el, 'outra');
    expect(botao(el, /enviar/i)?.disabled).toBe(false);
  });
});

describe('acessibilidade e limites', () => {
  it('um único h1, caixa com rótulo, lista como log e status separado dos tokens', async () => {
    const { h, el } = await montar();
    expect(el.querySelectorAll('h1')).toHaveLength(1);
    const c = caixa(el);
    expect(c.id).not.toBe('');
    expect(el.querySelector(`label[for="${c.id}"]`)?.textContent?.trim()).not.toBe('');
    expect(el.querySelector('[role="log"]')).not.toBeNull();
    const status = el.querySelector('[role="status"]') as HTMLElement;
    expect(status).not.toBeNull();
    digitar(h, el, 'x');
    tecla(el, 'Enter');
    s.abrir();
    s.enviar(quadro('token', { t: 'abc' }));
    await estavel(h);
    expect(status.textContent).toMatch(/Gerando a resposta/);
    expect(status.textContent).not.toContain('abc');
    s.enviar(fim('abc'));
    s.fechar();
    await estavel(h);
    expect(status.textContent).toMatch(/Resposta pronta/);
  });

  it('a caixa limita a 4.000 caracteres e o contador só aparece perto do limite', async () => {
    const { h, el } = await montar();
    expect(caixa(el).maxLength).toBe(4000);
    expect(el.querySelector('.contador')).toBeNull();
    digitar(h, el, 'x'.repeat(3600));
    expect(el.querySelector('.contador')?.textContent).toContain('3.600');
    expect(el.querySelector('.contador')?.textContent).toContain('4.000');
  });

  it('antes da primeira pergunta há uma explicação do que perguntar, não uma lista vazia sem sentido', async () => {
    const { el } = await montar();
    expect(el.textContent).toMatch(/Formulário de Referência/);
    expect(el.textContent).not.toMatch(/ainda não está ligado/);
  });
});

describe('nova conversa', () => {
  it('limpa a lista de mensagens', async () => {
    const { h, el } = await montar();
    digitar(h, el, 'x');
    tecla(el, 'Enter');
    s.abrir();
    s.enviar(fim('ok'));
    s.fechar();
    await estavel(h);
    expect(perguntas(el)).toHaveLength(1);
    botao(el, /nova conversa/i)?.click();
    await estavel(h);
    expect(perguntas(el)).toHaveLength(0);
    expect(respostas(el)).toHaveLength(0);
  });
});
