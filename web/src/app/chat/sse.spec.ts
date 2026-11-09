/**
 * Testes do leitor de SSE (F8.2), escritos antes do código. O `EventSource` não aceita POST, então o chat lê o corpo da resposta
 * com `fetch` + `ReadableStream` e o quadro SSE é montado à mão: é aqui que a rede quebra o texto em pedaços onde quiser.
 * Modos de falha:
 *
 *  1. o fluxo cortado em QUALQUER posição (inclusive no meio de um nome de campo, de uma quebra de linha e de um caractere de
 *     vários bytes como "á" ou um emoji) dá os mesmos quadros que o fluxo inteiro, sem caractere corrompido;
 *  2. `\\n`, `\\r\\n` e `\\r` separam linhas; uma linha em branco fecha o quadro;
 *  3. vários quadros no mesmo pedaço saem todos, na ordem;
 *  4. comentário (`: ping`), `id:`, `retry:` e campo desconhecido não viram quadro nem quebram;
 *  5. `data` em várias linhas vira um texto com `\\n`; só UM espaço depois dos dois-pontos é retirado; `data:` sem espaço vale;
 *  6. sem `event:` o nome é `message`; quadro sem nenhuma linha `data` é descartado (SSE, §9.2.6);
 *  7. um quadro incompleto no fim do fluxo (sem a linha em branco) NÃO é entregue: o servidor caiu no meio;
 *  8. fluxo vazio e fluxo só de comentários terminam sem quadros e sem erro;
 *  9. milhares de quadros leem em tempo linear (um laço que refaz a busca desde o início do texto acumulado ficaria quadrático);
 * 10. o leitor libera o fluxo quando o consumidor para de ler antes do fim (senão a conexão fica aberta).
 */
import { describe, expect, it } from 'vitest';
import { lerQuadros, type QuadroSse } from './sse';

const enc = new TextEncoder();

function fluxoDe(pedacos: (string | Uint8Array)[]): { fluxo: ReadableStream<Uint8Array>; cancelado: () => boolean } {
  let cancelado = false;
  let i = 0;
  const fluxo = new ReadableStream<Uint8Array>({
    pull(c) {
      if (i < pedacos.length) {
        const p = pedacos[i++] as string | Uint8Array;
        c.enqueue(typeof p === 'string' ? enc.encode(p) : p);
      } else c.close();
    },
    cancel() {
      cancelado = true;
    },
  });
  return { fluxo, cancelado: () => cancelado };
}

async function ler(fluxo: ReadableStream<Uint8Array>): Promise<QuadroSse[]> {
  const out: QuadroSse[] = [];
  for await (const q of lerQuadros(fluxo)) out.push(q);
  return out;
}

const TEXTO = 'event: etapa\ndata: {"tipo":"reescrita"}\n\nevent: token\ndata: {"t":"Olá, açaí 😀"}\n\nevent: fim\ndata: {"ok":true}\n\n';
const ESPERADO: QuadroSse[] = [
  { evento: 'etapa', dados: '{"tipo":"reescrita"}' },
  { evento: 'token', dados: '{"t":"Olá, açaí 😀"}' },
  { evento: 'fim', dados: '{"ok":true}' },
];

describe('lerQuadros', () => {
  it('lê o fluxo inteiro', async () => {
    expect(await ler(fluxoDe([TEXTO]).fluxo)).toEqual(ESPERADO);
  });

  it('o fluxo cortado em qualquer byte dá o mesmo resultado (inclusive no meio de "á" e do emoji)', async () => {
    const bytes = enc.encode(TEXTO);
    for (let corte = 1; corte < bytes.length; corte++) {
      const r = await ler(fluxoDe([bytes.slice(0, corte), bytes.slice(corte)]).fluxo);
      expect(r, `corte em ${corte}`).toEqual(ESPERADO);
    }
  });

  it('um byte por vez também funciona', async () => {
    const bytes = enc.encode(TEXTO);
    expect(await ler(fluxoDe(Array.from(bytes, (b) => new Uint8Array([b]))).fluxo)).toEqual(ESPERADO);
  });

  it.each([
    ['\r\n', 'CRLF'],
    ['\r', 'CR'],
    ['\n', 'LF'],
  ])('quebra de linha %j (%s)', async (q) => {
    const t = `event: token${q}data: {"t":"a"}${q}${q}event: fim${q}data: {}${q}${q}`;
    expect(await ler(fluxoDe([t]).fluxo)).toEqual([
      { evento: 'token', dados: '{"t":"a"}' },
      { evento: 'fim', dados: '{}' },
    ]);
  });

  it('CRLF partido entre o CR e o LF não gera quadro duplicado nem linha em branco falsa', async () => {
    const r = await ler(fluxoDe(['event: token\r\ndata: 1\r', '\n\r', '\nevent: fim\r\ndata: 2\r\n\r\n']).fluxo);
    expect(r).toEqual([
      { evento: 'token', dados: '1' },
      { evento: 'fim', dados: '2' },
    ]);
  });

  it('comentário, id, retry e campo desconhecido são ignorados', async () => {
    const t = ': ping\n\nid: 7\nretry: 1000\nxis: 1\nevent: token\ndata: 1\n\n: outro comentário\n\n';
    expect(await ler(fluxoDe([t]).fluxo)).toEqual([{ evento: 'token', dados: '1' }]);
  });

  it('data em várias linhas junta com \\n; retira só um espaço depois dos dois-pontos', async () => {
    expect(await ler(fluxoDe(['event: x\ndata: a\ndata:  b\ndata:c\ndata\n\n']).fluxo)).toEqual([{ evento: 'x', dados: 'a\n b\nc\n' }]);
  });

  it('sem event: o nome é "message"; quadro sem data é descartado', async () => {
    expect(await ler(fluxoDe(['data: 1\n\nevent: vazio\n\nevent: so-nome\n\ndata: 2\n\n']).fluxo)).toEqual([
      { evento: 'message', dados: '1' },
      { evento: 'message', dados: '2' },
    ]);
  });

  it('o nome do evento não vaza para o quadro seguinte', async () => {
    expect(await ler(fluxoDe(['event: a\ndata: 1\n\ndata: 2\n\n']).fluxo)).toEqual([
      { evento: 'a', dados: '1' },
      { evento: 'message', dados: '2' },
    ]);
  });

  it('quadro incompleto no fim do fluxo não é entregue', async () => {
    expect(await ler(fluxoDe(['event: token\ndata: 1\n\nevent: fim\ndata: {"resp']).fluxo)).toEqual([{ evento: 'token', dados: '1' }]);
  });

  it('fluxo vazio e fluxo só de comentários não dão quadros nem erro', async () => {
    expect(await ler(fluxoDe([]).fluxo)).toEqual([]);
    expect(await ler(fluxoDe([': a\n\n', ': b\n\n']).fluxo)).toEqual([]);
  });

  it('5.000 quadros em tempo linear (menos de 1 s)', async () => {
    const pedaco = Array.from({ length: 5000 }, (_, i) => `event: token\ndata: {"t":"${i}"}\n\n`).join('');
    const t0 = performance.now();
    const r = await ler(fluxoDe([pedaco]).fluxo);
    expect(r).toHaveLength(5000);
    expect(performance.now() - t0).toBeLessThan(1000);
  });

  it('um quadro grande (200 kB) em pedaços de 1 kB sai inteiro', async () => {
    const grande = 'x'.repeat(200_000);
    const bytes = enc.encode(`event: fim\ndata: ${grande}\n\n`);
    const pedacos = Array.from({ length: Math.ceil(bytes.length / 1024) }, (_, i) => bytes.slice(i * 1024, (i + 1) * 1024));
    const r = await ler(fluxoDe(pedacos).fluxo);
    expect(r).toHaveLength(1);
    expect(r[0]?.dados.length).toBe(200_000);
  });

  it('o consumidor que para de ler antes do fim libera o fluxo', async () => {
    const { fluxo, cancelado } = fluxoDe([TEXTO, TEXTO, TEXTO]);
    for await (const q of lerQuadros(fluxo)) {
      expect(q.evento).toBe('etapa');
      break;
    }
    expect(cancelado()).toBe(true);
  });
});
