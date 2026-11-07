/** `GET /api/documento/pdf`: o PDF original, com `Range` (o pdf.js pede o arquivo por faixas). */
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import type { FastifyInstance } from "fastify";
import { responderErro } from "./erros.ts";
import type { DependenciasApp } from "./tipos.ts";

type Faixa = { inicio: number; fim: number } | "fora" | null;

/**
 * `bytes=a-b`, `bytes=a-` e `bytes=-n`. Cabeçalho que não é isso (várias faixas, unidade desconhecida, `5-2`) vale como sem
 * cabeçalho (RFC 9110: o servidor pode ignorar `Range`); faixa que começa depois do fim é "fora" (416).
 */
export function lerFaixa(cabecalho: string | undefined, tamanho: number): Faixa {
  const m = /^bytes=(\d*)-(\d*)$/.exec(cabecalho ?? "");
  if (!m || (m[1] === "" && m[2] === "")) return null;
  if (m[1] === "") {
    const n = Number(m[2]);
    if (n === 0) return "fora";
    return { inicio: Math.max(0, tamanho - n), fim: tamanho - 1 };
  }
  const inicio = Number(m[1]);
  const fim = m[2] === "" ? tamanho - 1 : Math.min(Number(m[2]), tamanho - 1);
  if (m[2] !== "" && Number(m[2]) < inicio) return null;
  if (inicio >= tamanho) return "fora";
  return { inicio, fim };
}

export function registrarPdf(app: FastifyInstance, deps: DependenciasApp): void {
  app.get("/api/documento/pdf", async (req, reply) => {
    const naoAchou = () => responderErro(reply, 404, "documento_nao_encontrado", "O PDF do documento não está disponível.");
    if (!deps.pdf) return naoAchou();
    let tamanho: number;
    try {
      const s = await stat(deps.pdf);
      if (!s.isFile()) return naoAchou();
      tamanho = s.size;
    } catch {
      return naoAchou();
    }
    const faixa = lerFaixa(typeof req.headers.range === "string" ? req.headers.range : undefined, tamanho);
    if (faixa === "fora") {
      reply.header("content-range", `bytes */${tamanho}`);
      return responderErro(reply, 416, "faixa_invalida", "A faixa pedida está fora do arquivo.");
    }
    reply.header("accept-ranges", "bytes").type("application/pdf");
    if (faixa === null) return reply.header("content-length", tamanho).send(createReadStream(deps.pdf));
    return reply
      .code(206)
      .header("content-range", `bytes ${faixa.inicio}-${faixa.fim}/${tamanho}`)
      .header("content-length", faixa.fim - faixa.inicio + 1)
      .send(createReadStream(deps.pdf, { start: faixa.inicio, end: faixa.fim }));
  });
}
