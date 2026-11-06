/**
 * Roteador contra o llama-swap de verdade (F7.3): quatro casos do grupo `ajuste` de `eval/golden_rotas.json`
 * (texto, tabela/valor, panorama e fora do escopo) e a armadilha da memória (um fato conhecido da companhia
 * tem de ir a uma ferramenta, não ser respondido na hora). A medida completa é `npm run avaliar:rotas`.
 * Pulado sem o llama-swap em `LLAMA_SWAP_URL`.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { rotear } from "../../src/agente/roteador.ts";
import { avaliarRota, type CasoRota } from "../../src/avaliacao/rotas.ts";
import { ClienteLlm } from "../../src/llm/index.ts";

const BASE = process.env["LLAMA_SWAP_URL"] ?? "http://127.0.0.1:8080";
const vivo = await fetch(`${BASE}/v1/models`, { signal: AbortSignal.timeout(1500) })
  .then((r) => r.ok)
  .catch(() => false);
const casos = JSON.parse(readFileSync(new URL("../../../eval/golden_rotas.json", import.meta.url), "utf-8")) as CasoRota[];

describe.skipIf(!vivo)("roteador com o Qwen de verdade", () => {
  const llm = new ClienteLlm({ baseUrl: BASE });

  it.each(["T01", "N01", "P07", "F01"])("%s vai para uma rota aceita", async (id) => {
    const c = casos.find((x) => x.id === id) as CasoRota;
    const r = await rotear(llm, c.pergunta);
    expect(r.fallback, r.erro).toBeNull();
    const a = avaliarRota(c, { rotas: [r.chamadas.map((x) => x.nome)] });
    expect(a.aceito, `${id}: ${a.motivo}`).toBe(true);
    expect(r.uso.entrada).toBeGreaterThan(0);
  }, 300_000);

  it("um fato conhecido da companhia não é respondido de memória", async () => {
    const r = await rotear(llm, "Qual é o CNPJ do Banco do Brasil?");
    expect(r.rota).toBe("ferramentas");
    expect(r.chamadas.length).toBeGreaterThan(0);
  }, 300_000);
});
