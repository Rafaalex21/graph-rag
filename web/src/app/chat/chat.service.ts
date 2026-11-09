/**
 * O estado do chat (F8.2): a lista de mensagens, a trava de "uma pergunta por vez" e a leitura do SSE. Os componentes só leem os
 * sinais e chamam `enviar`, `cancelar`, `tentarDeNovo` e `novaConversa`. O que a F8.3 vai mostrar (etapas, Cypher, evidências) fica
 * guardado em `eventos` de cada resposta, sem os tokens.
 */
import { inject, Injectable, InjectionToken, signal } from '@angular/core';
import { conversar, ErroDaApi, type Citacao, type EventoChat, type MetricasDoFim, type Turno } from './chat-api';

/** O `fetch` do chat; os testes trocam por um falso. */
export const FETCH_DO_CHAT = new InjectionToken<typeof fetch>('FETCH_DO_CHAT', {
  providedIn: 'root',
  factory: () => (...a: Parameters<typeof fetch>) => globalThis.fetch(...a),
});

export const LIMITE_PERGUNTA = 4000;
const LIMITE_TURNO = 8000;
const TURNOS_NO_HISTORICO = 4;

export type EstadoMensagem = 'pronta' | 'transmitindo' | 'erro' | 'cancelada';

export interface Tempos {
  /** Milissegundos desde o envio até o primeiro evento de qualquer tipo; `null` se ainda não veio. */
  primeiroEventoMs: number | null;
  primeiroTokenMs: number | null;
  fimMs: number | null;
}

export interface Mensagem {
  id: number;
  papel: 'usuario' | 'assistente';
  texto: string;
  estado: EstadoMensagem;
  mensagemId?: string;
  citacoes?: Citacao[];
  metricas?: MetricasDoFim;
  erro?: { codigo: string; mensagem: string };
  /** Etapas, Cypher, evidências e o `fim`, na ordem em que chegaram (para o Rastro da F8.3). */
  eventos: EventoChat[];
  tempos: Tempos;
}

const SEM_TEMPOS: Tempos = { primeiroEventoMs: null, primeiroTokenMs: null, fimMs: null };
const ERRO_GENERICO = { codigo: 'falha_interna', mensagem: 'Não foi possível responder agora.' };

function novoId(): string {
  return globalThis.crypto?.randomUUID?.() ?? `c-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

@Injectable({ providedIn: 'root' })
export class ChatService {
  private readonly buscar = inject(FETCH_DO_CHAT);

  readonly mensagens = signal<Mensagem[]>([]);
  readonly ocupado = signal(false);
  readonly conversationId = signal(novoId());

  private proximoId = 1;
  /** Muda a cada pergunta e a cada nova conversa: o que chegar de uma execução antiga é ignorado. */
  private execucao = 0;
  private controlador: AbortController | null = null;

  /** Faz a pergunta. Resolve quando a resposta termina (pronta, com erro ou cancelada); nunca lança. */
  async enviar(texto: string): Promise<void> {
    const pergunta = texto.trim();
    if (this.ocupado() || pergunta === '' || pergunta.length > LIMITE_PERGUNTA) return;
    this.ocupado.set(true); // síncrono: a trava não espera o primeiro evento
    const historico = this.historicoAte(this.mensagens().length);
    const usuario: Mensagem = { id: this.proximoId++, papel: 'usuario', texto: pergunta, estado: 'pronta', eventos: [], tempos: SEM_TEMPOS };
    const resposta = this.respostaVazia();
    this.mensagens.update((l) => [...l, usuario, resposta]);
    await this.executar(pergunta, historico, resposta.id);
  }

  /** Refaz a última pergunta quando a última resposta falhou ou foi cancelada; a bolha do usuário não se repete. */
  async tentarDeNovo(): Promise<void> {
    if (this.ocupado()) return;
    const l = this.mensagens();
    const ultima = l.at(-1);
    const pergunta = l.at(-2);
    if (!ultima || !pergunta || ultima.papel !== 'assistente' || pergunta.papel !== 'usuario') return;
    if (ultima.estado !== 'erro' && ultima.estado !== 'cancelada') return;
    this.ocupado.set(true);
    const historico = this.historicoAte(l.length - 2);
    const resposta = this.respostaVazia();
    this.mensagens.set([...l.slice(0, -1), resposta]);
    await this.executar(pergunta.texto, historico, resposta.id);
  }

  /** Para a resposta em andamento; o texto que já chegou fica na tela. */
  cancelar(): void {
    this.controlador?.abort();
  }

  /** Esvazia a conversa, cancela o que estiver em andamento e começa um `conversationId` novo. */
  novaConversa(): void {
    this.execucao++;
    this.controlador?.abort();
    this.controlador = null;
    this.mensagens.set([]);
    this.ocupado.set(false);
    this.conversationId.set(novoId());
  }

  private respostaVazia(): Mensagem {
    return { id: this.proximoId++, papel: 'assistente', texto: '', estado: 'transmitindo', eventos: [], tempos: SEM_TEMPOS };
  }

  /** Só os turnos completos (pergunta e resposta prontas), os últimos quatro, cada texto cortado no limite do contrato. */
  private historicoAte(fim: number): Turno[] {
    const l = this.mensagens().slice(0, fim);
    const turnos: Turno[] = [];
    for (let i = 0; i + 1 < l.length; i += 2) {
      const p = l[i];
      const r = l[i + 1];
      if (p?.papel === 'usuario' && r?.papel === 'assistente' && r.estado === 'pronta' && r.texto !== '') {
        turnos.push({ papel: 'usuario', texto: p.texto.slice(0, LIMITE_TURNO) }, { papel: 'assistente', texto: r.texto.slice(0, LIMITE_TURNO) });
      }
    }
    return turnos.slice(-TURNOS_NO_HISTORICO);
  }

  private async executar(pergunta: string, historico: Turno[], idResposta: number): Promise<void> {
    const minha = ++this.execucao;
    const ac = new AbortController();
    this.controlador = ac;
    const t0 = performance.now();
    const vigente = () => minha === this.execucao;
    const atualizar = (f: (m: Mensagem) => Mensagem) => {
      if (vigente()) this.mensagens.update((l) => l.map((m) => (m.id === idResposta ? f(m) : m)));
    };
    const marca = (m: Mensagem, campo: keyof Tempos): Mensagem => (m.tempos[campo] === null ? { ...m, tempos: { ...m.tempos, [campo]: performance.now() - t0 } } : m);

    try {
      for await (const e of conversar({ conversationId: this.conversationId(), message: pergunta, ...(historico.length > 0 ? { historico } : {}) }, { signal: ac.signal, fetch: this.buscar })) {
        if (ac.signal.aborted || !vigente()) break;
        atualizar((m) => marca(m, 'primeiroEventoMs'));
        if (e.evento === 'token') {
          atualizar((m) => marca({ ...m, texto: m.texto + e.dados.t }, 'primeiroTokenMs'));
        } else if (e.evento === 'fim') {
          atualizar((m) => marca({ ...m, texto: e.dados.resposta, estado: 'pronta', mensagemId: e.dados.mensagemId, citacoes: e.dados.citacoes, metricas: e.dados.metricas, eventos: [...m.eventos, e] }, 'fimMs'));
        } else if (e.evento === 'erro') {
          atualizar((m) => ({ ...m, estado: 'erro', erro: e.dados, eventos: [...m.eventos, e] }));
        } else {
          atualizar((m) => ({ ...m, eventos: [...m.eventos, e] }));
        }
      }
      if (ac.signal.aborted) atualizar((m) => (m.estado === 'transmitindo' ? { ...m, estado: 'cancelada' } : m));
    } catch (e) {
      if (ac.signal.aborted || (e instanceof Error && e.name === 'AbortError')) {
        atualizar((m) => ({ ...m, estado: 'cancelada' }));
      } else {
        const erro = e instanceof ErroDaApi ? { codigo: e.codigo, mensagem: e.message } : ERRO_GENERICO;
        atualizar((m) => ({ ...m, estado: 'erro', erro }));
      }
    } finally {
      if (vigente()) {
        this.ocupado.set(false);
        this.controlador = null;
      }
    }
  }
}
