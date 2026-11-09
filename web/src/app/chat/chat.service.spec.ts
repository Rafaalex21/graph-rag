/**
 * Testes do estado do chat (F8.2), escritos antes do código. Modos de falha:
 *
 *  1. a pergunta aparece na conversa na hora, antes de a API responder; a resposta nasce vazia, "transmitindo";
 *  2. os tokens se juntam em ordem; o `fim` TROCA o texto streamado pelo texto final (os marcadores `[E1]` viram `[p. 6]`) e
 *     guarda o `mensagemId`, as citações e as métricas;
 *  3. só uma pergunta de cada vez: enviar durante o streaming, enviar vazio ou só com espaço, ou passar de 4.000 caracteres
 *     NÃO chama a API (a API recusa com 400 e a tela mostraria um erro que nós mesmos causamos);
 *  4. o corpo leva um `conversationId` estável e o `historico` (os últimos 4 turnos COMPLETOS: pergunta e resposta prontas;
 *     o que falhou ou foi cancelado fica de fora, senão o atualizador reescreve em cima de uma resposta que não existe);
 *  5. erro da API (HTTP ou evento `erro`) deixa a mensagem em "erro" com o texto da API e mantém o que já tinha chegado;
 *  6. cancelar durante o streaming deixa "cancelada" com o texto parcial, sem erro, e libera para a próxima pergunta;
 *  7. conexão que cai no meio (fluxo acaba sem `fim`) vira erro "interrompido", com o parcial mantido;
 *  8. "tentar de novo" refaz a última pergunta SEM duplicar a bolha do usuário e sem duplicar a pergunta no histórico;
 *  9. os tempos (primeiro evento, primeiro token, fim) são medidos no cliente, a partir do envio;
 * 10. os eventos do Rastro (etapa, cypher, evidência) ficam guardados na resposta para a F8.3, sem os tokens;
 * 11. "nova conversa" troca o `conversationId`, esvazia a lista e cancela o que estiver em andamento;
 * 12. dois `enviar` quase ao mesmo tempo: o segundo é ignorado de forma síncrona (a trava não pode esperar o primeiro evento).
 */
import { TestBed } from '@angular/core/testing';
import { beforeEach, describe, expect, it } from 'vitest';
import { ChatService, FETCH_DO_CHAT } from './chat.service';

const enc = new TextEncoder();
const quadro = (evento: string, dados: unknown) => `event: ${evento}\ndata: ${JSON.stringify(dados)}\n\n`;
const fim = (resposta: string, mensagemId = 'm1') => quadro('fim', { mensagemId, resposta, citacoes: [{ id: 'p1', pagina: 'p. 6' }], metricas: { latenciaMs: 100, tokensEntrada: 10, tokensSaida: 5, rota: ['buscar_trechos'], estado: 'suficiente' } });

/** Um fetch falso com o fluxo na mão do teste: `enviar` empurra pedaços, `fechar` encerra. */
function servidor() {
  const corpos: Record<string, unknown>[] = [];
  const sinais: AbortSignal[] = [];
  let controle!: ReadableStreamDefaultController<Uint8Array>;
  let resolver!: (r: Response) => void;
  const fetchFalso: typeof fetch = (_u, init) => {
    corpos.push(JSON.parse(String((init as RequestInit).body)) as Record<string, unknown>);
    sinais.push((init as RequestInit).signal as AbortSignal);
    return new Promise<Response>((ok, falhou) => {
      resolver = ok;
      (init as RequestInit).signal?.addEventListener('abort', () => falhou(new DOMException('abortado', 'AbortError')));
    });
  };
  return {
    fetchFalso,
    corpos,
    sinais,
    abrir(status = 200) {
      const fluxo = new ReadableStream<Uint8Array>({
        start(c) {
          controle = c;
        },
      });
      resolver(new Response(fluxo, { status, headers: { 'content-type': 'text/event-stream' } }));
    },
    responderComErro(status: number, corpo: unknown) {
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

const tick = () => new Promise<void>((r) => setTimeout(r, 0));
async function ateQue(cond: () => boolean) {
  for (let i = 0; i < 200 && !cond(); i++) await tick();
  expect(cond()).toBe(true);
}

function criar(s: ReturnType<typeof servidor>) {
  TestBed.resetTestingModule();
  TestBed.configureTestingModule({ providers: [{ provide: FETCH_DO_CHAT, useValue: s.fetchFalso }] });
  return TestBed.inject(ChatService);
}

let s: ReturnType<typeof servidor>;
beforeEach(() => {
  s = servidor();
});

/** Faz uma pergunta inteira até o `fim`. */
async function perguntar(chat: ChatService, texto: string, resposta: string, id = 'm') {
  const p = chat.enviar(texto);
  await ateQue(() => s.corpos.length > 0 && chat.mensagens().at(-1)?.estado === 'transmitindo');
  s.abrir();
  s.enviar(fim(resposta, id));
  s.fechar();
  await p;
}

describe('o envio', () => {
  it('a pergunta aparece na hora e a resposta nasce vazia, transmitindo', async () => {
    const chat = criar(s);
    const p = chat.enviar('Qual o lucro?');
    expect(chat.mensagens().map((m) => [m.papel, m.texto, m.estado])).toEqual([
      ['usuario', 'Qual o lucro?', 'pronta'],
      ['assistente', '', 'transmitindo'],
    ]);
    expect(chat.ocupado()).toBe(true);
    s.abrir();
    s.enviar(fim('ok'));
    s.fechar();
    await p;
    expect(chat.ocupado()).toBe(false);
  });

  it('junta os tokens em ordem e o fim troca o texto streamado pelo final', async () => {
    const chat = criar(s);
    const p = chat.enviar('Qual o lucro?');
    s.abrir();
    s.enviar(quadro('token', { t: 'O lucro foi ' }), quadro('token', { t: 'R$ 20 bi [E1].' }));
    await ateQue(() => chat.mensagens().at(-1)?.texto === 'O lucro foi R$ 20 bi [E1].');
    expect(chat.mensagens().at(-1)?.estado).toBe('transmitindo');
    s.enviar(fim('O lucro foi R$ 20 bi [p. 6].'));
    s.fechar();
    await p;
    const r = chat.mensagens().at(-1);
    expect(r).toMatchObject({ texto: 'O lucro foi R$ 20 bi [p. 6].', estado: 'pronta', mensagemId: 'm1' });
    expect(r?.citacoes).toEqual([{ id: 'p1', pagina: 'p. 6' }]);
    expect(r?.metricas).toMatchObject({ latenciaMs: 100, estado: 'suficiente' });
  });

  it('guarda os eventos do rastro, sem os tokens', async () => {
    const chat = criar(s);
    const p = chat.enviar('oi');
    s.abrir();
    s.enviar(quadro('etapa', { tipo: 'reescrita', detalhe: {} }), quadro('cypher', { query: 'RETURN 1', linhas: 1, ms: 3 }), quadro('evidencia', { id: 'p1', tipo: 'pai', pagina: 'p. 6', trecho: 'x', score: 1 }), quadro('token', { t: 'a' }), fim('a'));
    s.fechar();
    await p;
    expect(chat.mensagens().at(-1)?.eventos.map((e) => e.evento)).toEqual(['etapa', 'cypher', 'evidencia', 'fim']);
  });

  it('mede o primeiro evento, o primeiro token e o fim a partir do envio', async () => {
    const chat = criar(s);
    const p = chat.enviar('oi');
    s.abrir();
    s.enviar(quadro('etapa', { tipo: 'reescrita', detalhe: {} }));
    await ateQue(() => chat.mensagens().at(-1)?.eventos.length === 1);
    await new Promise((r) => setTimeout(r, 20));
    s.enviar(quadro('token', { t: 'a' }));
    await ateQue(() => chat.mensagens().at(-1)?.texto === 'a');
    s.enviar(fim('a'));
    s.fechar();
    await p;
    const t = chat.mensagens().at(-1)?.tempos;
    expect(t?.primeiroEventoMs).not.toBeNull();
    expect(t?.primeiroTokenMs).not.toBeNull();
    expect((t?.primeiroTokenMs ?? 0) >= (t?.primeiroEventoMs ?? 0)).toBe(true);
    expect((t?.fimMs ?? 0) >= (t?.primeiroTokenMs ?? 0)).toBe(true);
    expect((t?.primeiroTokenMs ?? 0) - (t?.primeiroEventoMs ?? 0)).toBeGreaterThanOrEqual(15);
  });

  it('sem nenhum token (recusa só com o fim) o primeiro token fica nulo', async () => {
    const chat = criar(s);
    await perguntar(chat, 'oi', 'Fora do escopo.');
    expect(chat.mensagens().at(-1)?.tempos.primeiroTokenMs).toBeNull();
  });
});

describe('o que não é enviado', () => {
  it.each([['', 'vazio'], ['   \n\t ', 'só espaço'], ['x'.repeat(4001), 'maior que 4.000']])('%j (%s) não chama a API nem cria bolha', async (texto) => {
    const chat = criar(s);
    await chat.enviar(texto);
    expect(s.corpos).toHaveLength(0);
    expect(chat.mensagens()).toHaveLength(0);
  });

  it('4.000 caracteres exatos passam', async () => {
    const chat = criar(s);
    const p = chat.enviar('x'.repeat(4000));
    await ateQue(() => s.corpos.length === 1);
    s.abrir();
    s.enviar(fim('ok'));
    s.fechar();
    await p;
  });

  it('o texto é enviado sem os espaços das pontas', async () => {
    const chat = criar(s);
    const p = chat.enviar('  Qual o lucro?  \n');
    await ateQue(() => s.corpos.length === 1);
    expect(s.corpos[0]?.['message']).toBe('Qual o lucro?');
    s.abrir();
    s.enviar(fim('ok'));
    s.fechar();
    await p;
  });

  it('durante o streaming outra pergunta é ignorada (síncrono, mesmo antes do 1º evento)', async () => {
    const chat = criar(s);
    const p1 = chat.enviar('primeira');
    const p2 = chat.enviar('segunda');
    await p2;
    expect(s.corpos).toHaveLength(1);
    expect(chat.mensagens().map((m) => m.texto)).toEqual(['primeira', '']);
    s.abrir();
    s.enviar(fim('ok'));
    s.fechar();
    await p1;
  });
});

describe('o corpo do pedido', () => {
  it('a segunda pergunta leva a primeira e a resposta no historico, e o mesmo conversationId', async () => {
    const chat = criar(s);
    await perguntar(chat, 'P1', 'R1 [p. 6]');
    const p = chat.enviar('P2');
    await ateQue(() => s.corpos.length === 2);
    expect(s.corpos[1]?.['historico']).toEqual([
      { papel: 'usuario', texto: 'P1' },
      { papel: 'assistente', texto: 'R1 [p. 6]' },
    ]);
    expect(s.corpos[1]?.['conversationId']).toBe(s.corpos[0]?.['conversationId']);
    s.abrir();
    s.enviar(fim('R2', 'm2'));
    s.fechar();
    await p;
  });

  it('o historico tem no máximo os 4 últimos turnos', async () => {
    const chat = criar(s);
    for (const i of [1, 2, 3]) await perguntar(chat, `P${i}`, `R${i}`);
    const p = chat.enviar('P4');
    await ateQue(() => s.corpos.length === 4);
    expect((s.corpos[3]?.['historico'] as unknown[]).length).toBe(4);
    expect((s.corpos[3]?.['historico'] as { texto: string }[]).map((t) => t.texto)).toEqual(['P2', 'R2', 'P3', 'R3']);
    s.abrir();
    s.enviar(fim('R4', 'm4'));
    s.fechar();
    await p;
  });

  it('resposta com erro ou cancelada fica de fora do historico, com a pergunta dela', async () => {
    const chat = criar(s);
    await perguntar(chat, 'P1', 'R1');
    const p2 = chat.enviar('P2 que falha');
    await ateQue(() => s.corpos.length === 2);
    s.responderComErro(500, { codigo: 'falha_interna', mensagem: 'Não foi possível responder agora.' });
    await p2;
    expect(chat.mensagens().at(-1)?.estado).toBe('erro');
    const p3 = chat.enviar('P3');
    await ateQue(() => s.corpos.length === 3);
    expect(s.corpos[2]?.['historico']).toEqual([
      { papel: 'usuario', texto: 'P1' },
      { papel: 'assistente', texto: 'R1' },
    ]);
    s.abrir();
    s.enviar(fim('R3', 'm3'));
    s.fechar();
    await p3;
  });

  it('a resposta longa é cortada em 8.000 caracteres no historico (limite do contrato)', async () => {
    const chat = criar(s);
    await perguntar(chat, 'P1', 'y'.repeat(9000));
    const p = chat.enviar('P2');
    await ateQue(() => s.corpos.length === 2);
    const h = s.corpos[1]?.['historico'] as { texto: string }[];
    expect(h[1]?.texto.length).toBe(8000);
    s.abrir();
    s.enviar(fim('ok', 'm2'));
    s.fechar();
    await p;
  });
});

describe('erros', () => {
  it('HTTP 429: erro com a mensagem da API, sem texto de resposta', async () => {
    const chat = criar(s);
    const p = chat.enviar('oi');
    await ateQue(() => s.corpos.length === 1);
    s.responderComErro(429, { codigo: 'ocupado', mensagem: 'Há perguntas demais em andamento. Tente de novo em instantes.' });
    await p;
    expect(chat.mensagens().at(-1)).toMatchObject({ estado: 'erro', texto: '', erro: { codigo: 'ocupado', mensagem: 'Há perguntas demais em andamento. Tente de novo em instantes.' } });
    expect(chat.ocupado()).toBe(false);
  });

  it('evento erro no meio mantém o parcial', async () => {
    const chat = criar(s);
    const p = chat.enviar('oi');
    s.abrir();
    s.enviar(quadro('token', { t: 'Começo' }), quadro('erro', { codigo: 'llm_timeout', mensagem: 'O modelo de linguagem demorou demais. Tente novamente.' }));
    s.fechar();
    await p;
    expect(chat.mensagens().at(-1)).toMatchObject({ estado: 'erro', texto: 'Começo', erro: { codigo: 'llm_timeout' } });
  });

  it('conexão que cai no meio: interrompido, com o parcial', async () => {
    const chat = criar(s);
    const p = chat.enviar('oi');
    s.abrir();
    s.enviar(quadro('token', { t: 'Metade' }));
    s.fechar();
    await p;
    expect(chat.mensagens().at(-1)).toMatchObject({ estado: 'erro', texto: 'Metade', erro: { codigo: 'interrompido' } });
  });

  it('rede fora do ar: sem_conexao e a próxima pergunta funciona', async () => {
    TestBed.resetTestingModule();
    let n = 0;
    TestBed.configureTestingModule({
      providers: [
        {
          provide: FETCH_DO_CHAT,
          useValue: (async () => {
            if (n++ === 0) throw new TypeError('Failed to fetch');
            return new Response(new ReadableStream({ start: (c) => { c.enqueue(enc.encode(fim('ok'))); c.close(); } }), { status: 200 }); // prettier-ignore
          }) as typeof fetch,
        },
      ],
    });
    const chat = TestBed.inject(ChatService);
    await chat.enviar('a');
    expect(chat.mensagens().at(-1)?.erro?.codigo).toBe('sem_conexao');
    await chat.enviar('b');
    expect(chat.mensagens().at(-1)).toMatchObject({ estado: 'pronta', texto: 'ok' });
  });

  it('exceção inesperada vira erro genérico em português, sem vazar a mensagem interna', async () => {
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({ providers: [{ provide: FETCH_DO_CHAT, useValue: (async () => { throw new RangeError('stack at C:\\segredo\\x.js'); }) as typeof fetch }] }); // prettier-ignore
    const chat = TestBed.inject(ChatService);
    await chat.enviar('a');
    const e = chat.mensagens().at(-1)?.erro;
    expect(e?.codigo).toBe('falha_interna');
    expect(e?.mensagem).not.toMatch(/segredo|RangeError|stack/);
  });
});

describe('cancelar', () => {
  it('durante o streaming: cancelada, parcial mantido, sem erro, e libera a próxima', async () => {
    const chat = criar(s);
    const p = chat.enviar('oi');
    s.abrir();
    s.enviar(quadro('token', { t: 'Pela metade' }));
    await ateQue(() => chat.mensagens().at(-1)?.texto === 'Pela metade');
    chat.cancelar();
    await p;
    expect(chat.mensagens().at(-1)).toMatchObject({ estado: 'cancelada', texto: 'Pela metade' });
    expect(chat.mensagens().at(-1)?.erro).toBeUndefined();
    expect(chat.ocupado()).toBe(false);
    expect(s.sinais[0]?.aborted).toBe(true);
  });

  it('antes da resposta chegar (esperando o fetch): cancelada e libera', async () => {
    const chat = criar(s);
    const p = chat.enviar('oi');
    chat.cancelar();
    await p;
    expect(chat.mensagens().at(-1)).toMatchObject({ estado: 'cancelada', texto: '' });
    expect(chat.ocupado()).toBe(false);
  });

  it('cancelar sem nada em andamento não faz nada', () => {
    const chat = criar(s);
    expect(() => chat.cancelar()).not.toThrow();
    expect(chat.mensagens()).toEqual([]);
  });

  it('um token que chega depois do cancelamento não altera a resposta', async () => {
    const chat = criar(s);
    const p = chat.enviar('oi');
    s.abrir();
    s.enviar(quadro('token', { t: 'A' }));
    await ateQue(() => chat.mensagens().at(-1)?.texto === 'A');
    chat.cancelar();
    try {
      s.enviar(quadro('token', { t: 'B' }));
    } catch {
      // o fluxo já foi cancelado
    }
    await p;
    await tick();
    expect(chat.mensagens().at(-1)?.texto).toBe('A');
  });
});

describe('tentar de novo', () => {
  it('refaz a última pergunta sem duplicar a bolha do usuário e troca a resposta que falhou', async () => {
    const chat = criar(s);
    const p = chat.enviar('Qual o lucro?');
    await ateQue(() => s.corpos.length === 1);
    s.responderComErro(500, { codigo: 'falha_interna', mensagem: 'Não foi possível responder agora.' });
    await p;
    const p2 = chat.tentarDeNovo();
    await ateQue(() => s.corpos.length === 2);
    expect(chat.mensagens().map((m) => [m.papel, m.estado])).toEqual([
      ['usuario', 'pronta'],
      ['assistente', 'transmitindo'],
    ]);
    expect(s.corpos[1]?.['message']).toBe('Qual o lucro?');
    expect(s.corpos[1]?.['historico']).toBeUndefined();
    s.abrir();
    s.enviar(fim('R$ 20 bi'));
    s.fechar();
    await p2;
    expect(chat.mensagens()).toHaveLength(2);
    expect(chat.mensagens().at(-1)).toMatchObject({ estado: 'pronta', texto: 'R$ 20 bi' });
  });

  it('só vale para a última resposta com erro ou cancelada; sem isso não faz nada', async () => {
    const chat = criar(s);
    await chat.tentarDeNovo();
    expect(s.corpos).toHaveLength(0);
    await perguntar(chat, 'a', 'b');
    await chat.tentarDeNovo();
    expect(s.corpos).toHaveLength(1);
  });
});

describe('nova conversa', () => {
  it('troca o conversationId, esvazia a lista e cancela o que está em andamento', async () => {
    const chat = criar(s);
    const antes = chat.conversationId();
    const p = chat.enviar('oi');
    s.abrir();
    s.enviar(quadro('token', { t: 'a' }));
    await ateQue(() => chat.mensagens().at(-1)?.texto === 'a');
    chat.novaConversa();
    await p;
    expect(chat.mensagens()).toEqual([]);
    expect(chat.ocupado()).toBe(false);
    expect(chat.conversationId()).not.toBe(antes);
    expect(s.sinais[0]?.aborted).toBe(true);
  });

  it('a resposta que chega tarde de uma conversa antiga não aparece na nova', async () => {
    const chat = criar(s);
    const p = chat.enviar('velha');
    s.abrir();
    chat.novaConversa();
    try {
      s.enviar(quadro('token', { t: 'fantasma' }), fim('fantasma'));
    } catch {
      // fluxo cancelado
    }
    await p;
    await tick();
    expect(chat.mensagens()).toEqual([]);
  });
});
