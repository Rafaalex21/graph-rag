import { describe, expect, it } from "vitest";
import { criarApp, VERSAO } from "../src/app.ts";

describe("GET /api/saude", () => {
  it("responde ok com o nome do serviço e a versão", async () => {
    const app = criarApp();
    const resposta = await app.inject({ method: "GET", url: "/api/saude" });
    expect(resposta.statusCode).toBe(200);
    expect(resposta.json()).toEqual({ status: "ok", servico: "graphrag-api", versao: VERSAO });
    await app.close();
  });
});
