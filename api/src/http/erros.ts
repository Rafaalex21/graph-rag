import type { FastifyReply } from "fastify";

/** O corpo de erro do contrato (`Erro`). */
export interface Erro {
  codigo: string;
  mensagem: string;
}

/** Responde com o `Erro` do contrato. A mensagem é sempre uma frase nossa: nunca a do driver, do disco ou do Fastify. */
export function responderErro(reply: FastifyReply, status: number, codigo: string, mensagem: string): FastifyReply {
  return reply.code(status).type("application/json; charset=utf-8").send({ codigo, mensagem } satisfies Erro);
}
