import { randomUUID } from "node:crypto";
import Fastify, { type FastifyInstance } from "fastify";
import { registrarChat, registradasNoChat } from "./http/chat.ts";
import { responderErro } from "./http/erros.ts";
import { registrarFeedback } from "./http/feedback.ts";
import { registrarFonte } from "./http/fonte.ts";
import { registrarGrafo } from "./http/grafo.ts";
import { registrarPdf } from "./http/pdf.ts";
import { registrarSaude } from "./http/saude.ts";
import type { DependenciasApp } from "./http/tipos.ts";
import { VERSAO_DO_REGISTRO } from "./telemetria/tipos.ts";

export const VERSAO = "0.1.0";

export type { DependenciasApp } from "./http/tipos.ts";

/**
 * Monta a aplicação sem abrir porta, para poder ser testada com `inject`. As rotas e os esquemas estão em
 * `contracts/api.openapi.yaml`; todo erro sai no formato `Erro` do contrato, com frase nossa (nunca a do Fastify, do driver
 * ou do disco).
 */
export function criarApp(deps: DependenciasApp = {}): FastifyInstance {
  // maxParamLength acima do limite do id, para o id enorme chegar à rota e voltar 400 em vez de 404 do roteador
  const app = Fastify({ logger: false, routerOptions: { maxParamLength: 500 } });

  app.setErrorHandler((erro, req, reply) => {
    const status = (erro as { statusCode?: number }).statusCode;
    if (status !== undefined && status >= 400 && status < 500) return responderErro(reply, 400, "requisicao_invalida", "A requisição está malformada.");
    deps.registrarErro?.(`${req.method} ${req.url}`, erro);
    return responderErro(reply, 500, "falha_interna", "Não foi possível responder agora.");
  });
  app.setNotFoundHandler((_req, reply) => responderErro(reply, 404, "rota_inexistente", "Essa rota não existe."));

  // F7.7: toda rota que não é o /api/chat (que registra a própria pergunta) vira um registro `http`, pelo PADRÃO da rota
  // (`/api/fonte/:id`), nunca pela URL: o id e a query podem ser nome de entidade e cada URL inventada seria uma linha.
  if (deps.telemetria) {
    const telemetria = deps.telemetria;
    app.addHook("onResponse", async (req, reply) => {
      if (registradasNoChat.has(req)) return;
      try {
        const ms = Math.round(reply.elapsedTime * 10) / 10;
        telemetria.registrar({ v: VERSAO_DO_REGISTRO, tipo: "http", ts: new Date(Date.now() - ms).toISOString(), id: randomUUID(), metodo: req.method, rota: req.routeOptions.url ?? "desconhecida", status: reply.statusCode, ms });
      } catch (e) {
        deps.registrarErro?.("telemetria", e);
      }
    });
  }

  registrarSaude(app, deps, VERSAO);
  registrarChat(app, deps);
  registrarFonte(app, deps);
  registrarPdf(app, deps);
  registrarGrafo(app, deps);
  registrarFeedback(app, deps);

  return app;
}
