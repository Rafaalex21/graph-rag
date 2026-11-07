/**
 * `POST /api/chat` (SSE, ARQUITETURA §11.1): roda o ciclo do agente e o redator e conta cada passo ao cliente. O primeiro
 * evento sai antes de qualquer chamada ao LLM; o fluxo termina sempre em `fim` ou em `erro`; o cliente que sai cancela o
 * trabalho; no máximo `maxPerguntas` perguntas ao mesmo tempo (a que passar disso leva 429 na hora).
 */
import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { ResultadoCiclo } from "../agente/ciclo.ts";
import type { Turno } from "../agente/atualizador.ts";
import type { RespostaRedator } from "../agente/redator.ts";
import { LlmAbortadoError, LlmIndisponivelError, LlmTimeoutError } from "../llm/index.ts";
import { montarRegistroChat } from "../telemetria/chat.ts";
import type { RegistroChat } from "../telemetria/tipos.ts";
import { responderErro } from "./erros.ts";
import { traduzirEvento } from "./eventos.ts";
import { abrirFluxo } from "./sse.ts";
import type { DependenciasApp } from "./tipos.ts";

export const MAX_PERGUNTAS_PADRAO = 2;
/** Requisições que o `/api/chat` já registrou; o gancho das rotas comuns pula essas (um registro por requisição). */
export const registradasNoChat = new WeakSet<object>();
const MAX_TRECHO = 400;

const TurnoSchema = z.object({ papel: z.enum(["usuario", "assistente"]), texto: z.string().max(8_000) }).strict();
export const ChatRequestSchema = z
  .object({
    conversationId: z.string().min(1).max(100),
    message: z
      .string()
      .max(4_000)
      .refine((m) => m.trim() !== ""),
    mode: z.enum(["auto", "trechos", "tabelas", "local", "global", "cypher"]).default("auto"),
    profile: z.enum(["consultar", "consultar-rapido"]).default("consultar"),
    historico: z.array(TurnoSchema).max(20).optional(),
  })
  .strict();

const compacta = (t: string) => t.replace(/\s+/g, " ").trim();
const trecho = (t: string) => {
  const c = compacta(t);
  return c.length > MAX_TRECHO ? `${c.slice(0, MAX_TRECHO - 1).trimEnd()}…` : c;
};

/** As ferramentas chamadas, sem repetir, na ordem em que apareceram. */
function rotaDoCiclo(r: ResultadoCiclo): string[] {
  const nomes = r.rodadas.flatMap((x) => x.agente.subperguntas.flatMap((s) => s.execucoes.map((e) => e.ferramenta)));
  return [...new Set(nomes)];
}

function erroParaCliente(e: unknown): { codigo: string; mensagem: string } {
  if (e instanceof LlmIndisponivelError) return { codigo: "llm_indisponivel", mensagem: "O modelo de linguagem não respondeu. Tente novamente em instantes." };
  if (e instanceof LlmTimeoutError) return { codigo: "llm_timeout", mensagem: "O modelo de linguagem demorou demais. Tente novamente." };
  return { codigo: "falha_interna", mensagem: "Não foi possível responder agora. Tente novamente." };
}

export function registrarChat(app: FastifyInstance, deps: DependenciasApp): void {
  const maximo = deps.maxPerguntas ?? MAX_PERGUNTAS_PADRAO;
  let ativas = 0;

  app.post("/api/chat", async (req, reply) => {
    const inicio = new Date();
    const t0 = performance.now();
    const id = randomUUID();
    const corpo = (req.body ?? {}) as { conversationId?: unknown; message?: unknown };
    const conversationId = typeof corpo.conversationId === "string" ? corpo.conversationId : null;
    const mensagem = typeof corpo.message === "string" ? corpo.message : "";
    let ciclo: ResultadoCiclo | null = null;
    let resposta: RespostaRedator | null = null;
    let primeiroEvento: number | null = null;
    let primeiroToken: number | null = null;

    // a telemetria nunca atrasa nem derruba a resposta: o registrador só enfileira, e se lançar a falha só é avisada
    const gravar = (resultado: RegistroChat["resultado"], codigo: string | null) => {
      registradasNoChat.add(req);
      if (!deps.telemetria) return;
      try {
        deps.telemetria.registrar(
          montarRegistroChat({ id, inicio, conversationId, mensagem, comTexto: deps.telemetriaComTexto ?? false, resultado, codigo, ciclo, resposta, ms: { total: Math.round(performance.now() - t0), primeiroEvento, primeiroToken } }),
        );
      } catch (e) {
        deps.registrarErro?.("telemetria", e);
      }
    };
    const recusar = (status: number, codigo: string, texto: string) => {
      gravar("recusada", codigo);
      return responderErro(reply, status, codigo, texto);
    };

    const lido = ChatRequestSchema.safeParse(req.body);
    if (!lido.success) return recusar(400, "requisicao_invalida", "Corpo inválido: mande conversationId e message (até 4.000 caracteres).");
    const { message, mode, profile, historico } = lido.data;
    if (mode !== "auto") return recusar(400, "modo_nao_implementado", `O modo "${mode}" ainda não existe; use "auto".`);
    if (profile !== "consultar") return recusar(400, "perfil_nao_implementado", `O perfil "${profile}" ainda não existe; use "consultar".`);
    if (!deps.ciclo || !deps.redator) return recusar(503, "agente_nao_configurado", "O agente não está configurado nesta API.");
    if (ativas >= maximo) return recusar(429, "ocupado", "Há perguntas demais em andamento. Tente de novo em instantes.");

    ativas++;
    const ac = new AbortController();
    const fluxo = abrirFluxo(reply);
    reply.raw.on("close", () => {
      if (!reply.raw.writableEnded) ac.abort();
    });
    let resultado: RegistroChat["resultado"] = "cancelada";
    let codigoDoErro: string | null = null;

    try {
      // antes de qualquer chamada ao LLM: o cliente já sabe que a pergunta foi aceita
      fluxo.enviar({ evento: "etapa", dados: { tipo: "reescrita", detalhe: { estado: "inicio" } } });
      primeiroEvento = Math.round(performance.now() - t0);

      const turnos: Turno[] = historico ?? [];
      ciclo = await deps.ciclo(message, {
        historico: turnos,
        signal: ac.signal,
        progresso: (e) => {
          for (const q of traduzirEvento(e)) fluxo.enviar(q);
        },
      });
      if (ac.signal.aborted) return;

      for (const e of ciclo.evidencias) {
        fluxo.enviar({ evento: "evidencia", dados: { id: e.id, tipo: e.tipo, pagina: e.paginas === "" ? null : e.paginas, trecho: trecho(e.texto), score: e.score } });
      }

      resposta = await deps.redator(
        { pergunta: ciclo.autonoma, estado: ciclo.estado, faltando: ciclo.faltando, evidencias: ciclo.evidencias, historico: turnos },
        {
          signal: ac.signal,
          progresso: (e) => {
            if (e.fase === "token") {
              primeiroToken ??= Math.round(performance.now() - t0);
              fluxo.enviar({ evento: "token", dados: { t: e.texto } });
            } else if (e.fase === "reparo") fluxo.enviar({ evento: "etapa", dados: { tipo: "reparo", detalhe: { frases: e.frases } } });
          },
        },
      );
      if (ac.signal.aborted) return;

      fluxo.enviar({
        evento: "fim",
        dados: {
          // o mesmo id do registro de telemetria: é o que o cliente manda em /api/feedback
          mensagemId: id,
          resposta: resposta.textoComPaginas,
          citacoes: resposta.citacoes.map((c) => ({ id: c.id, pagina: c.paginas === "" ? null : c.paginas })),
          metricas: {
            latenciaMs: Math.round(performance.now() - t0),
            tokensEntrada: ciclo.uso.entrada + resposta.uso.entrada,
            tokensSaida: ciclo.uso.saida + resposta.uso.saida,
            rota: rotaDoCiclo(ciclo),
            estado: ciclo.estado,
          },
        },
      });
      resultado = "fim";
    } catch (e) {
      if (!(e instanceof LlmAbortadoError) && !ac.signal.aborted) {
        deps.registrarErro?.("chat", e);
        const erro = erroParaCliente(e);
        resultado = "erro";
        codigoDoErro = erro.codigo;
        fluxo.enviar({ evento: "erro", dados: erro });
      }
    } finally {
      ativas--;
      gravar(resultado, codigoDoErro);
      fluxo.encerrar();
    }
    return reply;
  });
}
