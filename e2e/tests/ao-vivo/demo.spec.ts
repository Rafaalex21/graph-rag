/**
 * F10.1: grava os quadros do GIF de demonstração do README contra a pilha REAL (Neo4j, llama-swap e a API no ar). Não é teste de
 * aceite: só conduz a tela do modo técnico (`/chat`) por uma pergunta, espera a resposta, deixa o Rastro à vista e abre a página
 * citada no visualizador, tirando uma captura a cada 500 ms em `data/demo/quadros/` (fora do git). O GIF sai de
 * `tools/montar_gif.py`.
 *
 *   npx playwright test --project=ao-vivo --grep @demo
 */
import { mkdirSync, rmSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";
import { PaginaChat } from "../../paginas/chat.ts";
import { perguntaDoGolden } from "../../paginas/golden.ts";

const PASTA = new URL("../../../data/demo/quadros/", import.meta.url);

test("demonstração: pergunta, resposta com citação, Rastro e a página citada", { tag: "@demo" }, async ({ page }) => {
  test.setTimeout(600_000);
  await page.setViewportSize({ width: 1440, height: 900 });
  rmSync(PASTA, { recursive: true, force: true });
  mkdirSync(PASTA, { recursive: true });

  const chat = new PaginaChat(page);
  await chat.abrir();
  await expect(page.getByRole("button", { name: "Sistema: no ar" })).toBeVisible({ timeout: 60_000 });

  let n = 0;
  let gravando = true;
  const gravar = (async () => {
    while (gravando) {
      const t0 = Date.now();
      await page.screenshot({ path: fileURLToPath(new URL(`${String(n++).padStart(4, "0")}.png`, PASTA)) }).catch(() => {});
      await page.waitForTimeout(Math.max(0, 500 - (Date.now() - t0)));
    }
  })();

  await page.waitForTimeout(1_500);
  await chat.caixa.pressSequentially(perguntaDoGolden("T01"), { delay: 35 });
  await page.waitForTimeout(600);
  await chat.caixa.press("Enter");
  await expect(chat.estado).toHaveText(/Resposta pronta\./, { timeout: 300_000 });
  await expect(page.getByRole("list", { name: "Linha do tempo da resposta" })).toBeVisible();
  await page.waitForTimeout(3_500);

  const chip = chat.respostas.first().getByRole("button", { name: /^Abrir a página \d+ do documento$/ }).first();
  const pagina = Number(((await chip.getAttribute("aria-label")) ?? "").match(/\d+/)?.[0]);
  await chip.click();
  await expect(page.getByRole("status").filter({ hasText: new RegExp(`^Página ${pagina} de \\d+$`) })).toBeVisible({ timeout: 60_000 });
  await page.waitForTimeout(4_500);

  gravando = false;
  await gravar;
  expect(n, "quadros gravados").toBeGreaterThan(20);
});
