/**
 * `GET /api/arquivos/:id` (F8.10): devolve um arquivo que o próprio assistente gerou (gráfico em SVG, planilha, documento ou
 * apresentação). O id é um UUID que a API gerou; qualquer outra coisa é 400, e o que não existe ou venceu é 404. O SVG sai
 * `inline` (a tela o mostra numa imagem) e com uma política que o impede de rodar qualquer coisa; os demais saem como anexo.
 */
import type { FastifyInstance } from "fastify";
import { ID_VALIDO } from "../artefatos/armazem.ts";
import { responderErro } from "./erros.ts";
import type { DependenciasApp } from "./tipos.ts";

/** Só letras, números, ponto e hífen: o nome também é gerado aqui (`nomeDeArquivo`), mas o cabeçalho não depende disso. */
const nomeSeguro = (nome: string) => nome.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 100);

export function registrarArquivos(app: FastifyInstance, deps: DependenciasApp): void {
  app.get("/api/arquivos/:id", async (req, reply) => {
    const { id } = req.params as { id: string };
    if (!ID_VALIDO.test(id)) return responderErro(reply, 400, "requisicao_invalida", "O identificador do arquivo é inválido.");
    if (!deps.arquivos) return responderErro(reply, 404, "nao_encontrado", "Esse arquivo não existe ou já expirou.");
    const a = await deps.arquivos.ler(id);
    if (!a) return responderErro(reply, 404, "nao_encontrado", "Esse arquivo não existe ou já expirou.");
    const svg = a.tipo === "image/svg+xml";
    return reply
      .code(200)
      .header("content-type", a.tipo)
      .header("content-length", a.corpo.length)
      .header("content-disposition", `${svg ? "inline" : "attachment"}; filename="${nomeSeguro(a.nome)}"`)
      .header("x-content-type-options", "nosniff")
      .header("cache-control", "private, no-store")
      .header("content-security-policy", "default-src 'none'; style-src 'unsafe-inline'; sandbox")
      .send(a.corpo);
  });
}
