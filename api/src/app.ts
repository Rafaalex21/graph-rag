import Fastify, { type FastifyInstance } from "fastify";

export const VERSAO = "0.1.0";

/** Monta a aplicação sem abrir porta, para poder ser testada com `inject`. */
export function criarApp(): FastifyInstance {
  const app = Fastify({ logger: false });

  // Esqueleto da F0.8: o contrato completo de /api/saude (modelos, Neo4j, índices) vem na F7.6.
  app.get("/api/saude", async () => ({ status: "ok", servico: "graphrag-api", versao: VERSAO }));

  return app;
}
