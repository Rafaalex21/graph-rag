/**
 * F10.3: grava os quadros do vídeo de demonstração (roteiro em `eval/f103-roteiro-video.md`, fixado antes) contra a pilha REAL.
 * Não é teste de aceite: conduz a interface pelas três cenas do roteiro e tira uma captura JPEG a cada 250 ms em
 * `data/video/quadros/` (fora do git, ADR-009), com `marcas.json` (em que quadro começa cada cena e a legenda dela) e
 * `checagens.json` (o que o roteiro exige ver: rota, Cypher, página citada aberta, respostas prontas). O vídeo sai de
 * `e2e/ferramentas/montar-video.ts`. Desde a g4 (errata 3 do roteiro) as cenas são no `/assistente` com a visão dev ligada
 * (F8.11); a g3, no `/chat`, foi gravada com este arquivo no commit `95c991e`.
 *
 *   npx playwright test --project=ao-vivo --grep @video
 */
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { expect, test, type Page } from "@playwright/test";
import { PaginaAssistente } from "../../paginas/assistente.ts";
import { perguntaDoGolden } from "../../paginas/golden.ts";

const PASTA = new URL("../../../data/video/quadros/", import.meta.url);
const INTERVALO_MS = 250;

/** Cada pergunta numa conversa nova (errata 3), digitada para o espectador ver; devolve o estado final. */
async function perguntar(page: Page, a: PaginaAssistente, id: string): Promise<string> {
  if (await a.novaConversa.isEnabled().catch(() => false)) await a.novaConversa.click();
  await page.waitForTimeout(800);
  await a.caixa.pressSequentially(perguntaDoGolden(id), { delay: 30 });
  await page.waitForTimeout(500);
  await a.caixa.press("Enter");
  await expect(a.estado).toHaveText(/Resposta pronta\.|Não foi possível/, { timeout: 300_000 });
  return (await a.estado.innerText()).trim();
}

test("vídeo: rota, Cypher e citações em três perguntas", { tag: "@video" }, async ({ page }) => {
  test.setTimeout(1_200_000);
  await page.setViewportSize({ width: 1440, height: 900 });
  rmSync(PASTA, { recursive: true, force: true });
  mkdirSync(PASTA, { recursive: true });

  const a = new PaginaAssistente(page);
  await a.abrir();
  await expect(page.getByText("Tudo funcionando")).toBeVisible({ timeout: 60_000 });
  // o automático, qualquer que seja o modo salvo neste navegador
  await a.modo("Automático").click();
  await expect(a.modo("Automático")).toHaveAttribute("aria-pressed", "true");
  await expect(a.visaoDev).toHaveAttribute("aria-checked", "false");

  let n = 0;
  let gravando = true;
  const marcas: { quadro: number; cena: number; legenda: string; segurarS?: number }[] = [];
  const marcar = (cena: number, legenda: string) => marcas.push({ quadro: n, cena, legenda });
  // espera feita para o espectador ler: marca própria, e o montador não a encurta (errata 1 do roteiro)
  const segurar = async (segundos: number) => {
    const ultima = marcas.at(-1)!;
    marcas.push({ quadro: n, cena: ultima.cena, legenda: ultima.legenda, segurarS: segundos });
    await page.waitForTimeout(segundos * 1000);
    marcas.push({ quadro: n, cena: ultima.cena, legenda: ultima.legenda });
  };
  const gravar = (async () => {
    while (gravando) {
      const t0 = Date.now();
      await page
        .screenshot({ type: "jpeg", quality: 85, path: fileURLToPath(new URL(`${String(n).padStart(5, "0")}.jpg`, PASTA)) })
        .then(() => n++)
        .catch(() => {});
      await page.waitForTimeout(Math.max(0, INTERVALO_MS - (Date.now() - t0)));
    }
  })();
  const rotas = () => a.caminho.locator('li[data-tipo="rota"]').allInnerTexts();
  const checagens: Record<string, unknown> = {};

  // ---- cena 1: liga a visão dev e pergunta a T01; os Bastidores se enchem ao vivo; a citação abre a página ao lado
  marcar(1, "A tela do usuário, com a visão dev ligada: os Bastidores mostram ao vivo a rota, as ferramentas e a crítica");
  await page.waitForTimeout(1_200);
  await a.visaoDev.click();
  await expect(a.bastidores).toBeVisible();
  await page.waitForTimeout(1_200);
  checagens["t01Estado"] = await perguntar(page, a, "T01");
  checagens["t01Resposta"] = await a.respostas.last().innerText();
  checagens["t01Uniao"] = /Uni[aã]o/.test(checagens["t01Resposta"] as string);
  checagens["rotas"] = await rotas();
  await a.caminho.locator('li[data-tipo="rota"]').first().scrollIntoViewIfNeeded();
  await page.waitForTimeout(3_000);
  marcar(1, "Cada afirmação traz a página · um clique abre o documento na página citada");
  const chip = a.respostas.last().getByRole("button", { name: /^Abrir a página \d+ do documento$/ }).first();
  const pagina = Number(((await chip.getAttribute("aria-label")) ?? "").match(/\d+/)?.[0]);
  await chip.click();
  await expect(a.painel.getByRole("status").filter({ hasText: new RegExp(`^Página ${pagina} de \\d+$`) })).toBeVisible({ timeout: 60_000 });
  checagens["paginaAberta"] = pagina;
  await segurar(4);

  // ---- cena 2: conversa nova, G03 no automático (errata 2); nos Bastidores, a consulta Cypher que o roteador escolheu
  marcar(2, "Pergunta de soma: o roteador escolhe consultar o grafo, o modelo escreve Cypher só de leitura e o Neo4j responde");
  checagens["g03Estado"] = await perguntar(page, a, "G03");
  checagens["g03Rotas"] = await rotas();
  checagens["g03Resposta"] = await a.respostas.last().innerText();
  const cypher = a.caminho.getByRole("figure", { name: "Consulta Cypher" }).first();
  checagens["cypherVisto"] = (await cypher.count()) > 0;
  if (checagens["cypherVisto"]) {
    marcar(2, "A consulta Cypher gerada para a pergunta, com as linhas devolvidas e o tempo");
    await cypher.scrollIntoViewIfNeeded();
    checagens["cypher"] = await cypher.locator("code").innerText();
    await segurar(6);
  }

  // ---- cena 3: conversa nova, E07; a aba Grafo dos Bastidores com o subgrafo da resposta
  marcar(3, "Pergunta sobre uma entidade · resposta citada e, na aba Grafo dos Bastidores, o subgrafo usado");
  checagens["e07Estado"] = await perguntar(page, a, "E07");
  checagens["e07Resposta"] = await a.respostas.last().innerText();
  await page.waitForTimeout(2_000);
  await a.abaDosBastidores("Grafo").click();
  const subgrafo = a.bastidores.getByRole("group", { name: "Subgrafo da resposta" });
  checagens["subgrafo"] = await subgrafo.waitFor({ timeout: 10_000 }).then(() => true, () => false);
  checagens["subgrafoResumo"] = await a.bastidores.getByRole("status").first().innerText().catch(() => "");
  await segurar(5);

  gravando = false;
  await gravar;
  writeFileSync(fileURLToPath(new URL("marcas.json", PASTA)), `${JSON.stringify({ intervaloMs: INTERVALO_MS, quadros: n, marcas }, null, 2)}\n`);
  writeFileSync(fileURLToPath(new URL("checagens.json", PASTA)), `${JSON.stringify(checagens, null, 2)}\n`);
  console.log(JSON.stringify(checagens));
  expect(n, "quadros gravados").toBeGreaterThan(100);
});
