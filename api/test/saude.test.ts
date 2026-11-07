import { describe, expect, it } from "vitest";
import { criarApp, VERSAO } from "../src/app.ts";

// O esqueleto da F0.8 respondia só { status, servico, versao }; o contrato completo (F7.6) está em test/http/rotas.test.ts.
describe("GET /api/saude", () => {
  it("sem Neo4j nem llama-swap configurados responde 200, com o nome do serviço, a versão e o estado degradado", async () => {
    const app = criarApp();
    const resposta = await app.inject({ method: "GET", url: "/api/saude" });
    expect(resposta.statusCode).toBe(200);
    expect(resposta.json()).toMatchObject({ status: "degradado", servico: "graphrag-api", versao: VERSAO });
    await app.close();
  });
});
