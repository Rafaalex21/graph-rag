/**
 * O cliente do `POST /api/chat` (F8.2, `contracts/api.openapi.yaml`): manda a pergunta e devolve os eventos do SSE já em objeto.
 * Toda falha sai como `ErroDaApi` com uma mensagem nossa em português (nunca o HTML de um proxy nem uma pilha); o cancelamento
 * sai como `AbortError`, que não é erro da API.
 */
import { lerQuadros } from './sse';

export interface Turno {
  papel: 'usuario' | 'assistente';
  texto: string;
}

export interface PedidoChat {
  conversationId: string;
  message: string;
  mode?: 'auto' | 'trechos' | 'tabelas' | 'local' | 'global' | 'cypher';
  profile?: 'consultar' | 'consultar-rapido';
  historico?: Turno[];
}

export interface Citacao {
  id: string;
  pagina: string | null;
}

export interface MetricasDoFim {
  latenciaMs: number;
  tokensEntrada: number;
  tokensSaida: number;
  rota: string[];
  estado: string;
}

export type EventoChat =
  | { evento: 'etapa'; dados: { tipo: string; detalhe: unknown } }
  | { evento: 'cypher'; dados: { query: string; linhas: number; ms: number } }
  | {
      evento: 'evidencia';
      dados: { id: string; tipo: string; pagina: string | null; trecho: string; score: number };
    }
  | { evento: 'artefato'; dados: Record<string, unknown> }
  | { evento: 'token'; dados: { t: string } }
  | {
      evento: 'fim';
      dados: { mensagemId: string; resposta: string; citacoes: Citacao[]; metricas: MetricasDoFim };
    }
  | { evento: 'erro'; dados: { codigo: string; mensagem: string } };

export class ErroDaApi extends Error {
  constructor(
    readonly codigo: string,
    mensagem: string,
    readonly status: number | null = null,
  ) {
    super(mensagem);
    this.name = 'ErroDaApi';
  }
}

const MENSAGENS = {
  api_indisponivel:
    'A API do chat não respondeu como esperado. Confira se ela está no ar e tente de novo.',
  sem_conexao: 'Não foi possível falar com a API. Confira se ela está no ar e tente de novo.',
  interrompido: 'A conexão com a API foi interrompida antes do fim da resposta.',
  resposta_invalida: 'A API mandou uma resposta que a interface não entende.',
} as const;

const eAbort = (e: unknown) => e instanceof Error && e.name === 'AbortError';
const abortado = () => new DOMException('A pergunta foi cancelada.', 'AbortError');
const objeto = (x: unknown): x is Record<string, unknown> =>
  typeof x === 'object' && x !== null && !Array.isArray(x);
const texto = (x: unknown): x is string => typeof x === 'string';

/** O corpo `Erro` do contrato (`{codigo, mensagem}`); qualquer outra coisa (HTML do proxy, JSON de outra forma) vira `api_indisponivel`. */
async function erroDaResposta(r: Response): Promise<ErroDaApi> {
  try {
    const j: unknown = JSON.parse(await r.text());
    if (objeto(j) && texto(j['codigo']) && texto(j['mensagem']) && j['mensagem'] !== '')
      return new ErroDaApi(j['codigo'], j['mensagem'].slice(0, 300), r.status);
  } catch {
    // não era JSON
  }
  return new ErroDaApi('api_indisponivel', MENSAGENS.api_indisponivel, r.status);
}

/** Valida o evento e devolve `null` quando não é para a interface (desconhecido ou fora da forma). */
function paraEvento(nome: string, dados: unknown): EventoChat | null {
  if (!objeto(dados)) return null;
  switch (nome) {
    case 'etapa':
    case 'cypher':
    case 'evidencia':
    case 'artefato': // o conteúdo é validado por `artefatoDaResposta` (F8.10), que é quem o usa
      return { evento: nome, dados } as EventoChat;
    case 'token':
      return texto(dados['t']) ? { evento: 'token', dados: { t: dados['t'] } } : null;
    case 'erro':
      return {
        evento: 'erro',
        dados: {
          codigo: texto(dados['codigo']) ? dados['codigo'] : 'falha_interna',
          mensagem:
            texto(dados['mensagem']) && dados['mensagem'] !== ''
              ? dados['mensagem']
              : 'Não foi possível responder agora.',
        },
      };
    case 'fim':
      if (
        !texto(dados['mensagemId']) ||
        !texto(dados['resposta']) ||
        !Array.isArray(dados['citacoes']) ||
        !objeto(dados['metricas'])
      )
        throw new ErroDaApi('resposta_invalida', MENSAGENS.resposta_invalida);
      return { evento: 'fim', dados } as EventoChat;
    default:
      return null;
  }
}

export interface OpcoesConversar {
  signal?: AbortSignal;
  /** Troca o `fetch` (teste). */
  fetch?: typeof fetch;
  url?: string;
}

export async function* conversar(
  pedido: PedidoChat,
  opcoes: OpcoesConversar = {},
): AsyncGenerator<EventoChat> {
  const { signal } = opcoes;
  if (signal?.aborted) throw abortado();
  const corpo = {
    conversationId: pedido.conversationId,
    message: pedido.message,
    ...(pedido.mode ? { mode: pedido.mode } : {}),
    ...(pedido.profile ? { profile: pedido.profile } : {}),
    ...(pedido.historico && pedido.historico.length > 0 ? { historico: pedido.historico } : {}),
  };
  const chamar = opcoes.fetch ?? ((...a: Parameters<typeof fetch>) => globalThis.fetch(...a));
  let resposta: Response;
  try {
    resposta = await chamar(opcoes.url ?? '/api/chat', {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'text/event-stream' },
      body: JSON.stringify(corpo),
      ...(signal ? { signal } : {}),
    });
  } catch (e) {
    if (eAbort(e)) throw e;
    if (e instanceof TypeError) throw new ErroDaApi('sem_conexao', MENSAGENS.sem_conexao);
    throw e;
  }
  if (!resposta.ok) throw await erroDaResposta(resposta);
  if (!resposta.body) throw new ErroDaApi('interrompido', MENSAGENS.interrompido, resposta.status);

  let terminou = false;
  try {
    for await (const q of lerQuadros(resposta.body, signal)) {
      if (signal?.aborted) throw abortado();
      let dados: unknown;
      try {
        dados = JSON.parse(q.dados);
      } catch {
        continue;
      }
      const e = paraEvento(q.evento, dados);
      if (!e) continue;
      yield e;
      if (signal?.aborted) throw abortado();
      if (e.evento === 'fim' || e.evento === 'erro') {
        terminou = true;
        return;
      }
    }
  } catch (e) {
    if (eAbort(e) || e instanceof ErroDaApi) throw e;
    if (e instanceof TypeError) throw new ErroDaApi('interrompido', MENSAGENS.interrompido);
    throw e;
  }
  if (!terminou) {
    if (signal?.aborted) throw abortado();
    throw new ErroDaApi('interrompido', MENSAGENS.interrompido);
  }
}
