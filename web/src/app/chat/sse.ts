/**
 * Leitor de Server-Sent Events sobre um `ReadableStream` (F8.2). O `EventSource` do navegador só faz GET, e o chat é um POST,
 * então o corpo da resposta do `fetch` é lido aqui, seguindo o algoritmo do SSE (WHATWG HTML §9.2.6): linhas terminadas em
 * `\n`, `\r` ou `\r\n` (o `\r\n` pode chegar partido entre dois pedaços), linha em branco fecha o quadro, `:` abre comentário,
 * só `event` e `data` interessam. O texto é decodificado como UTF-8 em fluxo (um caractere de vários bytes pode vir partido).
 * O trabalho é linear no tamanho do fluxo: cada pedaço é percorrido uma vez.
 */

export interface QuadroSse {
  /** O `event:` do quadro; `message` quando não há. */
  evento: string;
  /** As linhas `data:` juntas por `\n`. */
  dados: string;
}

class Montador {
  private evento = '';
  private dados: string[] = [];
  /** O fim do pedaço anterior era um `\r`: um `\n` logo no começo deste completa o `\r\n`. */
  private aposCR = false;
  /** O começo da linha que ainda não terminou. */
  private resto = '';

  private linha(l: string): QuadroSse | null {
    if (l === '') {
      const q = this.dados.length > 0 ? { evento: this.evento || 'message', dados: this.dados.join('\n') } : null;
      this.evento = '';
      this.dados = [];
      return q;
    }
    if (l.startsWith(':')) return null;
    const i = l.indexOf(':');
    const campo = i < 0 ? l : l.slice(0, i);
    let valor = i < 0 ? '' : l.slice(i + 1);
    if (valor.startsWith(' ')) valor = valor.slice(1);
    if (campo === 'event') this.evento = valor;
    else if (campo === 'data') this.dados.push(valor);
    return null;
  }

  *alimentar(texto: string): Generator<QuadroSse> {
    let inicio = 0;
    if (this.aposCR && texto.startsWith('\n')) inicio = 1;
    this.aposCR = false;
    const fim = /\r\n|\r|\n/g;
    fim.lastIndex = inicio;
    for (let m = fim.exec(texto); m !== null; m = fim.exec(texto)) {
      const q = this.linha(this.resto + texto.slice(inicio, m.index));
      this.resto = '';
      inicio = m.index + m[0].length;
      if (m[0] === '\r' && inicio === texto.length) this.aposCR = true;
      if (q) yield q;
    }
    this.resto += texto.slice(inicio);
  }
}

/**
 * Os quadros do fluxo, na ordem. Um quadro incompleto no fim (sem a linha em branco) é descartado, como manda o SSE: o servidor
 * caiu no meio. Se o consumidor parar antes do fim, o fluxo é cancelado para a conexão não ficar aberta.
 */
export async function* lerQuadros(corpo: ReadableStream<Uint8Array>, signal?: AbortSignal): AsyncGenerator<QuadroSse> {
  const leitor = corpo.getReader();
  const decodificador = new TextDecoder('utf-8');
  const montador = new Montador();
  // Abortar com a leitura parada esperando dados: sem isto o `read()` só acordaria com o próximo byte do servidor.
  const aoAbortar = () => void leitor.cancel().catch(() => undefined);
  if (signal?.aborted) aoAbortar();
  else signal?.addEventListener('abort', aoAbortar, { once: true });
  try {
    for (;;) {
      const { done, value } = await leitor.read();
      if (done) break;
      yield* montador.alimentar(decodificador.decode(value, { stream: true }));
    }
    yield* montador.alimentar(decodificador.decode());
  } finally {
    signal?.removeEventListener('abort', aoAbortar);
    await leitor.cancel().catch(() => undefined);
    leitor.releaseLock();
  }
}
