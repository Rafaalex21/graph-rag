/** `POST /api/feedback`: a nota de uma resposta, gravada em JSONL local (uma linha por registro). */
import { appendFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { responderErro } from "./erros.ts";
import type { DependenciasApp } from "./tipos.ts";

export const FeedbackSchema = z
  .object({
    mensagemId: z.string().min(1).max(100),
    nota: z.union([z.literal(1), z.literal(-1)]),
    comentario: z.string().max(1_000).optional(),
  })
  .strict();

export function registrarFeedback(app: FastifyInstance, deps: DependenciasApp): void {
  app.post("/api/feedback", async (req, reply) => {
    const lido = FeedbackSchema.safeParse(req.body);
    if (!lido.success) return responderErro(reply, 400, "requisicao_invalida", "Mande mensagemId, nota (1 ou -1) e, se quiser, comentario (até 1.000 caracteres).");
    if (!deps.arquivoDeFeedback) return responderErro(reply, 500, "feedback_nao_configurado", "Não foi possível registrar a nota agora.");
    try {
      await mkdir(dirname(deps.arquivoDeFeedback), { recursive: true });
      // JSON.stringify escapa quebra de linha e aspas: uma linha por registro
      await appendFile(deps.arquivoDeFeedback, `${JSON.stringify({ ts: new Date().toISOString(), ...lido.data })}\n`, "utf-8");
    } catch (e) {
      deps.registrarErro?.("feedback", e);
      return responderErro(reply, 500, "falha_ao_gravar", "Não foi possível registrar a nota agora.");
    }
    return reply.code(201).send({ registrado: true });
  });
}
