/**
 * Atualizador de pergunta contra o llama-swap de verdade (F7.2): três casos do conjunto `ajuste` de
 * `eval/golden_decomposicao.json` (composta, simples e seguimento). A medida completa é
 * `npm run avaliar:decomposicao`. Pulado sem o llama-swap em `LLAMA_SWAP_URL`.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { atualizarPergunta } from "../../src/agente/atualizador.ts";
import { avaliarDecomposicao, type CasoDecomposicao } from "../../src/avaliacao/decomposicao.ts";
import { ClienteLlm } from "../../src/llm/index.ts";

const BASE = process.env["LLAMA_SWAP_URL"] ?? "http://127.0.0.1:8080";
const vivo = await fetch(`${BASE}/v1/models`, { signal: AbortSignal.timeout(1500) })
  .then((r) => r.ok)
  .catch(() => false);
const casos = JSON.parse(
  readFileSync(new URL("../../../eval/golden_decomposicao.json", import.meta.url), "utf-8"),
) as CasoDecomposicao[];

describe.skipIf(!vivo)("atualizador com o Qwen de verdade", () => {
  const llm = new ClienteLlm({ baseUrl: BASE });

  it.each(["D01", "D06", "D08"])("%s é decomposta como esperado", async (id) => {
    const c = casos.find((x) => x.id === id) as CasoDecomposicao;
    const r = await atualizarPergunta(llm, c.pergunta, c.historico);
    expect(r.fallback, r.erro).toBeNull();
    expect(avaliarDecomposicao(c, { autonoma: r.autonoma, subperguntas: r.subperguntas })).toEqual({
      ok: true,
      motivos: [],
    });
    expect(r.uso.entrada).toBeGreaterThan(0);
  }, 300_000);
});
