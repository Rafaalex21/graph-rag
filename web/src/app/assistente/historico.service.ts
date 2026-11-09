/**
 * As conversas recentes da tela do assistente (F8.9): ficam só no `localStorage` deste navegador (chave `graphrag.historico`),
 * até 20, a mais recente primeiro. Cada conversa guarda as mensagens como o chat as tem (com os eventos, para os selos, as fontes
 * e o passo a passo voltarem como estavam) e o `conversationId`, para a pergunta seguinte continuar a mesma conversa.
 * Um armazenamento bloqueado, cheio ou com lixo nunca quebra a tela: ela segue sem guardar.
 */
import { effect, inject, Injectable, signal, untracked } from '@angular/core';
import { ChatService, type EstadoMensagem, type Mensagem } from '../chat/chat.service';
import { tituloDaConversa } from './modelo';

export const CHAVE_HISTORICO = 'graphrag.historico';
export const MAXIMO_DE_CONVERSAS = 20;

export interface ConversaGuardada {
  id: string;
  titulo: string;
  atualizadaEm: number;
  mensagens: Mensagem[];
}

const ESTADOS: readonly EstadoMensagem[] = ['pronta', 'transmitindo', 'erro', 'cancelada'];
const objeto = (x: unknown): x is Record<string, unknown> =>
  typeof x === 'object' && x !== null && !Array.isArray(x);

/** Uma resposta que ainda estava chegando quando a conversa foi guardada vira "interrompida". */
function mensagemValida(x: unknown): Mensagem | null {
  if (
    !objeto(x) ||
    typeof x['id'] !== 'number' ||
    (x['papel'] !== 'usuario' && x['papel'] !== 'assistente') ||
    typeof x['texto'] !== 'string'
  )
    return null;
  const estado = ESTADOS.find((e) => e === x['estado']);
  if (!estado) return null;
  const tempos = objeto(x['tempos'])
    ? (x['tempos'] as unknown as Mensagem['tempos'])
    : { primeiroEventoMs: null, primeiroTokenMs: null, fimMs: null };
  const feedback = objeto(x['feedback'])
    ? {
        ...(x['feedback'] as unknown as NonNullable<Mensagem['feedback']>),
        enviando: false,
        erro: null,
      }
    : undefined;
  return {
    ...(x as unknown as Mensagem),
    estado: estado === 'transmitindo' ? 'cancelada' : estado,
    eventos: Array.isArray(x['eventos']) ? (x['eventos'] as Mensagem['eventos']) : [],
    tempos,
    ...(feedback ? { feedback } : {}),
  };
}

function conversaValida(x: unknown): ConversaGuardada | null {
  if (
    !objeto(x) ||
    typeof x['id'] !== 'string' ||
    typeof x['titulo'] !== 'string' ||
    typeof x['atualizadaEm'] !== 'number' ||
    !Array.isArray(x['mensagens'])
  )
    return null;
  const mensagens = x['mensagens'].map(mensagemValida);
  if (mensagens.length === 0 || mensagens.some((m) => m === null)) return null;
  return {
    id: x['id'],
    titulo: x['titulo'],
    atualizadaEm: x['atualizadaEm'],
    mensagens: mensagens as Mensagem[],
  };
}

function ler(): ConversaGuardada[] {
  try {
    const bruto = globalThis.localStorage.getItem(CHAVE_HISTORICO);
    if (bruto === null) return [];
    const lista: unknown = JSON.parse(bruto);
    if (!Array.isArray(lista)) return [];
    return lista
      .map(conversaValida)
      .filter((c): c is ConversaGuardada => c !== null)
      .slice(0, MAXIMO_DE_CONVERSAS);
  } catch {
    return [];
  }
}

@Injectable({ providedIn: 'root' })
export class HistoricoService {
  private readonly chat = inject(ChatService);

  readonly conversas = signal<ConversaGuardada[]>(ler());

  constructor() {
    // guarda a conversa da tela sempre que ela muda e nenhuma resposta está chegando
    effect(() => {
      const mensagens = this.chat.mensagens();
      const id = this.chat.conversationId();
      if (this.chat.ocupado() || mensagens.length === 0) return;
      untracked(() => this.guardar(id, mensagens));
    });
  }

  /** Põe a conversa guardada na tela. */
  abrir(id: string): void {
    const c = this.conversas().find((x) => x.id === id);
    if (c) this.chat.restaurar(c.id, c.mensagens);
  }

  /** Tira da lista; se era a que está na tela, volta à tela inicial. */
  apagar(id: string): void {
    this.conversas.update((l) => l.filter((c) => c.id !== id));
    this.gravar();
    if (this.chat.conversationId() === id) this.chat.novaConversa();
  }

  private guardar(id: string, mensagens: Mensagem[]): void {
    const primeira = mensagens.find((m) => m.papel === 'usuario');
    if (!primeira) return;
    const nova: ConversaGuardada = {
      id,
      titulo: tituloDaConversa(primeira.texto),
      atualizadaEm: Date.now(),
      mensagens,
    };
    this.conversas.update((l) =>
      [nova, ...l.filter((c) => c.id !== id)].slice(0, MAXIMO_DE_CONVERSAS),
    );
    this.gravar();
  }

  /** Grava a lista; se não couber, tira as mais antigas até caber (ou desiste sem barulho). */
  private gravar(): void {
    let lista = this.conversas();
    for (;;) {
      try {
        globalThis.localStorage.setItem(CHAVE_HISTORICO, JSON.stringify(lista));
        return;
      } catch {
        if (lista.length <= 1) return;
        lista = lista.slice(0, -1);
      }
    }
  }
}
