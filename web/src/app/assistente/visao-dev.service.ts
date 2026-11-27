import { Injectable, signal } from '@angular/core';

const CHAVE = 'graphrag.visaoDev';
/** Abaixo desta largura o painel cobriria a conversa: só abre quando pedido (a mesma quebra do painel da fonte). */
const ESTREITA = '(max-width: 72rem)';

function lerPreferencia(): boolean {
  try {
    return localStorage.getItem(CHAVE) === '1';
  } catch {
    return false;
  }
}

function gravarPreferencia(ligada: boolean): void {
  try {
    if (ligada) localStorage.setItem(CHAVE, '1');
    else localStorage.removeItem(CHAVE);
  } catch {
    // sem armazenamento (janela privada): a escolha vale só até recarregar
  }
}

const telaEstreita = (): boolean => typeof matchMedia === 'function' && matchMedia(ESTREITA).matches;

/**
 * A visão dev da tela do assistente (F8.11): ligada ou não (guardada neste navegador), o painel "Bastidores" aberto ou fechado e a
 * resposta que ele mostra (`null` = a mais recente). Numa tela larga, ligar abre o painel; numa estreita, ele só abre pelo cartão.
 */
@Injectable({ providedIn: 'root' })
export class VisaoDevService {
  readonly ligada = signal(lerPreferencia());
  readonly painelAberto = signal(this.ligada() && !telaEstreita());
  /** O id (`Mensagem.id`) da resposta escolhida em "Ver bastidores"; `null` acompanha a mais recente. */
  readonly escolhida = signal<number | null>(null);

  alternar(): void {
    const ligada = !this.ligada();
    this.ligada.set(ligada);
    gravarPreferencia(ligada);
    this.painelAberto.set(ligada && !telaEstreita());
    this.escolhida.set(null);
  }

  verBastidores(id: number): void {
    this.escolhida.set(id);
    this.painelAberto.set(true);
  }

  fechar(): void {
    this.painelAberto.set(false);
  }

  /** Uma pergunta nova ou outra conversa: o painel volta a acompanhar a resposta mais recente. */
  acompanharAUltima(): void {
    this.escolhida.set(null);
  }
}
