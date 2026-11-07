import type { FastifyReply } from "fastify";

export interface Quadro {
  evento: string;
  dados: unknown;
}

/** Um quadro SSE: `event:` e `data:` em uma linha só (o JSON não tem quebra de linha) e uma linha em branco. */
export const formatarQuadro = (q: Quadro): string => `event: ${q.evento}\ndata: ${JSON.stringify(q.dados)}\n\n`;

export interface Fluxo {
  enviar(q: Quadro): void;
  /** Fecha o fluxo (uma vez só). */
  encerrar(): void;
  readonly aberto: boolean;
}

/**
 * Abre o fluxo SSE no `reply` (o Fastify larga a resposta) e devolve quem escreve nele. `enviar` depois de o cliente sair
 * ou de `encerrar` não faz nada, para a pergunta que ainda roda não derrubar a API com "write after end".
 */
export function abrirFluxo(reply: FastifyReply): Fluxo {
  reply.hijack();
  const raw = reply.raw;
  raw.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache, no-transform",
    connection: "keep-alive",
    "x-accel-buffering": "no",
  });
  raw.flushHeaders();
  return {
    enviar(q) {
      if (raw.destroyed || raw.writableEnded) return;
      raw.write(formatarQuadro(q));
    },
    encerrar() {
      if (!raw.destroyed && !raw.writableEnded) raw.end();
    },
    get aberto() {
      return !raw.destroyed && !raw.writableEnded;
    },
  };
}
