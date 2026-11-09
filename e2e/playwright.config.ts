import { defineConfig, devices } from "@playwright/test";

/**
 * Dois projetos (ADR-068):
 *  - `interface`: o navegador contra o `ng serve` (com o proxy `/api` de verdade) e uma API falsa que fala o contrato SSE.
 *    Determinístico, sem Neo4j nem modelos: é o que roda no CI. `npm test`.
 *  - `ao-vivo`: o navegador e o HTTP contra a pilha REAL (Neo4j + llama-swap + API em 127.0.0.1:3000). Precisa estar tudo no ar;
 *    não roda no CI. `npm run test:ao-vivo`.
 */
const aoVivo = process.argv.some((a) => a === "ao-vivo" || a === "--project=ao-vivo");

export const URL_API_FALSA = "http://127.0.0.1:3100";
export const URL_API_REAL = "http://127.0.0.1:3000";

export default defineConfig({
  testDir: "./tests",
  fullyParallel: true,
  forbidOnly: !!process.env["CI"],
  retries: process.env["CI"] ? 2 : 0,
  workers: process.env["CI"] ? 2 : undefined,
  reporter: [["html", { open: "never" }], ["json", { outputFile: "test-results/results.json" }], [process.env["CI"] ? "github" : "list"]],
  use: {
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    // sem vídeo: ele exige baixar o ffmpeg do Playwright; o trace e a captura de tela já mostram a falha
    actionTimeout: 10_000,
    navigationTimeout: 30_000,
    locale: "pt-BR",
    // Sem CI usa o Edge que já vem no Windows (nada para baixar); no CI, o Chromium do Playwright.
    ...(process.env["CI"] ? {} : { channel: "msedge" }),
  },
  projects: [
    { name: "interface", testDir: "./tests/interface", use: { ...devices["Desktop Chrome"], ...(process.env["CI"] ? {} : { channel: "msedge" }), baseURL: "http://127.0.0.1:4300" } },
    { name: "ao-vivo", testDir: "./tests/ao-vivo", timeout: 240_000, fullyParallel: false, workers: 1, use: { ...devices["Desktop Chrome"], ...(process.env["CI"] ? {} : { channel: "msedge" }), baseURL: "http://127.0.0.1:4200" } },
  ],
  webServer: aoVivo
    ? [{ command: "npx ng serve --port 4200 --host 127.0.0.1", cwd: "../web", url: "http://127.0.0.1:4200", reuseExistingServer: true, timeout: 240_000 }]
    : [
        { command: "node api-falsa/servidor.ts", url: `${URL_API_FALSA}/api/saude`, reuseExistingServer: !process.env["CI"], timeout: 30_000 },
        { command: "npx ng serve --port 4300 --host 127.0.0.1 --proxy-config ../e2e/proxy.falso.json", cwd: "../web", url: "http://127.0.0.1:4300", reuseExistingServer: !process.env["CI"], timeout: 240_000 },
      ],
});
