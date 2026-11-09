/**
 * Testes do cliente do `POST /api/chat` (F8.2), escritos antes do código. O contrato é `contracts/api.openapi.yaml`: o corpo é
 * `additionalProperties: false`, então um campo a mais vira 400 no servidor. Modos de falha:
 *
 *  1. o corpo enviado tem só campos do contrato (`conversationId`, `message`, `mode`, `profile`, `historico`) e vai como JSON;
 *  2. resposta HTTP de erro (400, 429, 503, 500) vira `ErroDaApi` com o código e a mensagem do corpo `Erro` do contrato;
 *  3. erro que não é do contrato (502 do proxy do dev-server com HTML, corpo vazio, JSON de outra forma) vira uma mensagem
 *     nossa em português; nunca o HTML nem a pilha na tela;
 *  4. rede fora do ar (`fetch` lança `TypeError`) vira `ErroDaApi` `sem_conexao`, não uma exceção solta;
 *  5. o cancelamento (`AbortSignal`) propaga como `AbortError` e solta o fluxo; não vira erro da API;
 *  6. os eventos conhecidos saem com os dados já em objeto; evento desconhecido e quadro com JSON quebrado são pulados sem
 *     derrubar a resposta;
 *  7. o fluxo que acaba SEM `fim` nem `erro` (servidor caiu) vira `ErroDaApi` `interrompido`;
 *  8. depois de `fim` ou de `erro` nada mais é entregue (um servidor com defeito não reescreve a resposta pronta);
 *  9. resposta 200 sem corpo vira `interrompido`, não `TypeError`.
 */
import { describe, expect, it } from 'vitest';
import { conversar, ErroDaApi, type EventoChat, type PedidoChat } from './chat-api';

const enc = new TextEncoder();
const quadro = (evento: string, dados: unknown) => `event: ${evento}\ndata: ${JSON.stringify(dados)}\n\n`;
const FIM = { mensagemId: 'm1', resposta: 'ok [p. 6]', citacoes: [{ id: 'p1', pagina: 'p. 6' }], metricas: { latenciaMs: 10, tokensEntrada: 1, tokensSaida: 1, rota: ['buscar_trechos'], estado: 'suficiente' } };

function respostaSse(pedacos: string[], status = 200): Response {
  const fluxo = new ReadableStream<Uint8Array>({
    start(c) {
      for (const p of pedacos) c.enqueue(enc.encode(p));
      c.close();
    },
  });
  return new Response(fluxo, { status, headers: { 'content-type': 'text/event-stream' } });
}

const PEDIDO: PedidoChat = { conversationId: 'c-1', message: 'Qual o lucro?' };

async function coletar(fetchFalso: typeof fetch, pedido: PedidoChat = PEDIDO, signal?: AbortSignal): Promise<EventoChat[]> {
  const out: EventoChat[] = [];
  for await (const e of conversar(pedido, { fetch: fetchFalso, ...(signal ? { signal } : {}) })) out.push(e);
  return out;
}
async function falha(fetchFalso: typeof fetch, pedido: PedidoChat = PEDIDO): Promise<ErroDaApi> {
  try {
    await coletar(fetchFalso, pedido);
  } catch (e) {
    expect(e).toBeInstanceOf(ErroDaApi);
    return e as ErroDaApi;
  }
  throw new Error('devia ter falhado');
}

describe('o pedido', () => {
  it('vai por POST /api/chat, em JSON, só com campos do contrato', async () => {
    let visto: { url: string; init: RequestInit } | null = null;
    const f: typeof fetch = async (url, init) => {
      visto = { url: String(url), init: init as RequestInit };
      return respostaSse([quadro('fim', FIM)]);
    };
    await coletar(f, { conversationId: 'c-9', message: 'oi', historico: [{ papel: 'usuario', texto: 'a' }, { papel: 'assistente', texto: 'b' }], profile: 'consultar-rapido', mode: 'auto' });
    expect(visto).not.toBeNull();
    const v = visto as unknown as { url: string; init: RequestInit };
    expect(v.url).toBe('/api/chat');
    expect(v.init.method).toBe('POST');
    expect(new Headers(v.init.headers).get('content-type')).toBe('application/json');
    expect(new Headers(v.init.headers).get('accept')).toBe('text/event-stream');
    const corpo = JSON.parse(String(v.init.body)) as Record<string, unknown>;
    expect(Object.keys(corpo).sort()).toEqual(['conversationId', 'historico', 'message', 'mode', 'profile']);
    expect(corpo['profile']).toBe('consultar-rapido');
  });

  it('campos que não foram dados nem aparecem no corpo', async () => {
    let corpo: Record<string, unknown> = {};
    await coletar(async (_u, init) => {
      corpo = JSON.parse(String((init as RequestInit).body)) as Record<string, unknown>;
      return respostaSse([quadro('fim', FIM)]);
    });
    expect(Object.keys(corpo).sort()).toEqual(['conversationId', 'message']);
  });
});

describe('eventos', () => {
  it('entrega os eventos conhecidos com os dados em objeto, na ordem', async () => {
    const r = await coletar(async () =>
      respostaSse([
        quadro('etapa', { tipo: 'reescrita', detalhe: { estado: 'inicio' } }),
        quadro('evidencia', { id: 'p1', tipo: 'pai', pagina: 'p. 6', trecho: 'x', score: 0.9 }),
        quadro('token', { t: 'Olá ' }),
        quadro('token', { t: 'mundo' }),
        quadro('fim', FIM),
      ]),
    );
    expect(r.map((e) => e.evento)).toEqual(['etapa', 'evidencia', 'token', 'token', 'fim']);
    expect(r[2]).toEqual({ evento: 'token', dados: { t: 'Olá ' } });
    expect((r[4] as { dados: { mensagemId: string } }).dados.mensagemId).toBe('m1');
  });

  it('evento desconhecido e quadro com JSON quebrado são pulados', async () => {
    const r = await coletar(async () => respostaSse([quadro('futuro', { a: 1 }), 'event: token\ndata: {quebrado\n\n', quadro('token', { t: 'a' }), quadro('fim', FIM)]));
    expect(r.map((e) => e.evento)).toEqual(['token', 'fim']);
  });

  it('token sem o campo t é pulado (não vira "undefined" na tela)', async () => {
    const r = await coletar(async () => respostaSse([quadro('token', { x: 1 }), quadro('token', { t: 5 }), quadro('token', { t: 'ok' }), quadro('fim', FIM)]));
    expect(r.filter((e) => e.evento === 'token')).toEqual([{ evento: 'token', dados: { t: 'ok' } }]);
  });

  it('fim sem os campos do contrato é um erro de protocolo, não uma resposta vazia', async () => {
    const e = await falha(async () => respostaSse([quadro('token', { t: 'a' }), quadro('fim', { mensagemId: 'x' })]));
    expect(e.codigo).toBe('resposta_invalida');
  });

  it('depois de fim nada mais é entregue', async () => {
    const r = await coletar(async () => respostaSse([quadro('fim', FIM), quadro('token', { t: 'tarde' }), quadro('erro', { codigo: 'x', mensagem: 'y' })]));
    expect(r.map((e) => e.evento)).toEqual(['fim']);
  });

  it('erro encerra o fluxo e é entregue como evento', async () => {
    const r = await coletar(async () => respostaSse([quadro('token', { t: 'a' }), quadro('erro', { codigo: 'llm_timeout', mensagem: 'O modelo demorou demais.' }), quadro('token', { t: 'tarde' })]));
    expect(r.map((e) => e.evento)).toEqual(['token', 'erro']);
  });
});

describe('falhas', () => {
  it.each([
    [400, 'requisicao_invalida', 'Corpo inválido: mande conversationId e message.'],
    [429, 'ocupado', 'Há perguntas demais em andamento. Tente de novo em instantes.'],
    [503, 'agente_nao_configurado', 'O agente não está configurado nesta API.'],
    [500, 'falha_interna', 'Não foi possível responder agora.'],
  ])('HTTP %i com o corpo Erro do contrato', async (status, codigo, mensagem) => {
    const e = await falha(async () => new Response(JSON.stringify({ codigo, mensagem }), { status, headers: { 'content-type': 'application/json' } }));
    expect(e).toMatchObject({ codigo, status });
    expect(e.message).toBe(mensagem);
  });

  it.each([
    ['502 HTML do proxy', new Response('<html><body><h1>Bad Gateway</h1><script>x</script></body></html>', { status: 502, headers: { 'content-type': 'text/html' } })],
    ['500 sem corpo', new Response(null, { status: 500 })],
    ['JSON de outra forma', new Response(JSON.stringify({ error: 'x', stack: 'at /srv/app.js:10' }), { status: 500, headers: { 'content-type': 'application/json' } })],
    ['JSON quebrado', new Response('{nao', { status: 500, headers: { 'content-type': 'application/json' } })],
    ['404', new Response('Not found', { status: 404 })],
  ])('%s vira uma mensagem nossa, sem HTML nem pilha', async (_nome, resposta) => {
    const e = await falha(async () => resposta);
    expect(e.codigo).toBe('api_indisponivel');
    expect(e.message).toMatch(/API/);
    expect(e.message).not.toMatch(/<|stack|\/srv|Bad Gateway/);
  });

  it('rede fora do ar: sem_conexao', async () => {
    const e = await falha(async () => {
      throw new TypeError('Failed to fetch');
    });
    expect(e).toMatchObject({ codigo: 'sem_conexao', status: null });
    expect(e.message).not.toMatch(/Failed to fetch/);
  });

  it('200 sem corpo vira interrompido', async () => {
    const e = await falha(async () => new Response(null, { status: 200 }));
    expect(e.codigo).toBe('interrompido');
  });

  it('o fluxo que acaba sem fim nem erro vira interrompido, depois de entregar o que chegou', async () => {
    const r: string[] = [];
    let erro: unknown = null;
    try {
      for await (const e of conversar(PEDIDO, { fetch: async () => respostaSse([quadro('token', { t: 'a' }), quadro('token', { t: 'b' })]) })) r.push(e.evento);
    } catch (e) {
      erro = e;
    }
    expect(r).toEqual(['token', 'token']);
    expect(erro).toBeInstanceOf(ErroDaApi);
    expect((erro as ErroDaApi).codigo).toBe('interrompido');
  });

  it('quadro cortado no fim (sem a linha em branco) também é interrompido', async () => {
    const e = await falha(async () => respostaSse([quadro('token', { t: 'a' }), 'event: fim\ndata: {"mensagemId":"m']));
    expect(e.codigo).toBe('interrompido');
  });
});

describe('cancelamento', () => {
  it('abortar antes de responder propaga AbortError (não é ErroDaApi) e passa o signal ao fetch', async () => {
    const ac = new AbortController();
    let recebido: AbortSignal | undefined;
    const f: typeof fetch = (_u, init) =>
      new Promise((_ok, falhou) => {
        recebido = (init as RequestInit).signal as AbortSignal;
        recebido.addEventListener('abort', () => falhou(new DOMException('abortado', 'AbortError')));
      });
    const p = coletar(f, PEDIDO, ac.signal);
    ac.abort();
    await expect(p).rejects.toMatchObject({ name: 'AbortError' });
    expect(recebido).toBe(ac.signal);
  });

  it('abortar no meio do fluxo solta o corpo', async () => {
    const ac = new AbortController();
    let cancelado = false;
    const fluxo = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(enc.encode(quadro('token', { t: 'a' })));
      },
      cancel() {
        cancelado = true;
      },
    });
    const vistos: string[] = [];
    await expect(
      (async () => {
        for await (const e of conversar(PEDIDO, { fetch: async () => new Response(fluxo, { status: 200 }), signal: ac.signal })) {
          vistos.push(e.evento);
          ac.abort();
        }
      })(),
    ).rejects.toMatchObject({ name: 'AbortError' });
    expect(vistos).toEqual(['token']);
    expect(cancelado).toBe(true);
  });
});
