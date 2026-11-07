/**
 * Testes do shell e das rotas (F8.1), escritos antes do código. Modos de falha:
 *
 *  1. a raiz `/` leva a `/chat`; o painel do chat abre em `/chat/rastro`;
 *  2. URL que não existe mostra "Página não encontrada" com saída para o chat, não uma tela em branco;
 *  3. cada página tem exatamente um `h1`, e o título da aba muda com a rota (leitor de tela e histórico);
 *  4. a navegação marca a página atual (`aria-current`) e só ela;
 *  5. há marcos de acessibilidade (header, nav, main) e um link "Ir para o conteúdo" que aponta para o `main`;
 *  6. o botão de tema diz em texto qual é a preferência e a troca a cada clique;
 *  7. as três abas do painel (Rastro, Fontes, Grafo) navegam entre si e marcam a ativa.
 */
import { provideLocationMocks } from '@angular/common/testing';
import { TestBed } from '@angular/core/testing';
import { Router } from '@angular/router';
import { RouterTestingHarness } from '@angular/router/testing';
import { beforeEach, describe, expect, it } from 'vitest';
import { App } from './app';
import { provedoresDoRoteador } from './app.config';

async function abrir(url: string) {
  TestBed.resetTestingModule();
  TestBed.configureTestingModule({ providers: [...provedoresDoRoteador, provideLocationMocks()] });
  const harness = await RouterTestingHarness.create();
  await harness.navigateByUrl(url);
  return harness;
}

async function montar(url: string) {
  TestBed.configureTestingModule({ imports: [App], providers: [...provedoresDoRoteador, provideLocationMocks()] });
  const fixture = TestBed.createComponent(App);
  const router = TestBed.inject(Router);
  await router.navigateByUrl(url);
  fixture.detectChanges();
  await fixture.whenStable();
  return { fixture, el: fixture.nativeElement as HTMLElement, router };
}

beforeEach(() => {
  localStorage.clear();
  document.documentElement.removeAttribute('data-theme');
  TestBed.resetTestingModule();
});

describe('rotas', () => {
  it('a raiz leva a /chat, que abre o painel em /chat/rastro', async () => {
    const h = await abrir('/');
    expect(h.routeNativeElement?.textContent).toContain('Rastro');
    expect(TestBed.inject(Router).url).toBe('/chat/rastro');
  });

  it.each(['/chat/rastro', '/chat/fontes', '/chat/grafo', '/configuracoes'])('%s abre uma página com um único h1', async (url) => {
    const h = await abrir(url);
    expect(h.routeNativeElement?.querySelectorAll('h1').length).toBe(1);
  });

  it.each(['/nao-existe', '/chat/outra', '/configuracoes/x/y', '/%E0%A4%A'])('%s mostra "Página não encontrada" com o caminho de volta', async (url) => {
    const h = await abrir(url);
    const el = h.routeNativeElement as HTMLElement;
    expect(el.querySelector('h1')?.textContent).toContain('Página não encontrada');
    expect(el.querySelector('a[href="/chat"]')).not.toBeNull();
  });

  it('o título da aba muda com a rota', async () => {
    await abrir('/configuracoes');
    expect(document.title).toBe('Configurações · GraphRAG local');
    await abrir('/nao-existe');
    expect(document.title).toBe('Página não encontrada · GraphRAG local');
  });
});

describe('App (shell)', () => {
  it('tem os marcos header, nav e main, e o link "Ir para o conteúdo" aponta para o main', async () => {
    const { el } = await montar('/chat');
    expect(el.querySelector('header')).not.toBeNull();
    expect(el.querySelector('nav[aria-label="Principal"]')).not.toBeNull();
    const main = el.querySelector('main');
    expect(main?.id).toBe('conteudo');
    expect(el.querySelector('a.pular')?.getAttribute('href')).toBe('#conteudo');
  });

  it('marca só a página atual na navegação', async () => {
    const { el } = await montar('/configuracoes');
    const atuais = [...el.querySelectorAll('nav a[aria-current="page"]')].map((a) => a.textContent?.trim());
    expect(atuais).toEqual(['Configurações']);
  });

  it('o botão de tema mostra a preferência em texto e a troca a cada clique', async () => {
    const { el, fixture } = await montar('/chat');
    const botao = el.querySelector('button.tema') as HTMLButtonElement;
    expect(botao.textContent).toContain('sistema');
    botao.click();
    fixture.detectChanges();
    expect(botao.textContent).toContain('claro');
    expect(document.documentElement.getAttribute('data-theme')).toBe('light');
    botao.click();
    fixture.detectChanges();
    expect(botao.textContent).toContain('escuro');
    expect(document.documentElement.getAttribute('data-theme')).toBe('dark');
  });

  it('as abas do painel (Rastro, Fontes, Grafo) navegam entre si e marcam a ativa', async () => {
    const { el, fixture, router } = await montar('/chat/rastro');
    const abas = () => [...el.querySelectorAll('nav[aria-label="Painel"] a')] as HTMLAnchorElement[];
    expect(abas().map((a) => a.textContent?.trim())).toEqual(['Rastro', 'Fontes', 'Grafo']);
    expect(abas().filter((a) => a.getAttribute('aria-current') === 'page').map((a) => a.textContent?.trim())).toEqual(['Rastro']);
    await router.navigateByUrl('/chat/grafo');
    fixture.detectChanges();
    await fixture.whenStable();
    expect(abas().filter((a) => a.getAttribute('aria-current') === 'page').map((a) => a.textContent?.trim())).toEqual(['Grafo']);
  });
});
