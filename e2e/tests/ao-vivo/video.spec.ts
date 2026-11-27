/**
 * F10.3: grava os quadros do vídeo de demonstração (roteiro em `eval/f103-roteiro-video.md`, fixado antes) contra a pilha REAL.
 * Não é teste de aceite: conduz a interface pelas três cenas do roteiro e tira uma captura JPEG a cada 250 ms em
 * `data/video/quadros/` (fora do git, ADR-009), com `marcas.json` (em que quadro começa cada cena e a legenda dela) e
 * `checagens.json` (o que o roteiro exige ver: rota, Cypher, página citada aberta, respostas prontas). O vídeo sai de
 * `e2e/ferramentas/montar-video.ts`.
 *
 *   npx playwright test --project=ao-vivo --grep @video
 */
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { expect, test, type Page } from "@playwright/test";
import { PaginaChat } from "../../paginas/chat.ts";
import { perguntaDoGolden } from "../../paginas/golden.ts";

const PASTA = new URL("../../../data/video/quadros/", import.meta.url);
const INTERVALO_MS = 250;

async function escolherModo(page: Page, rotulo: string): Promise<void> {
  await page.getByRole("navigation", { name: "Principal" }).getByRole("link", { name: "Configurações" }).click();
  await page.getByRole("radio", { name: rotulo, exact: true }).check();
  await page.waitForTimeout(1_200);
  await page.getByRole("navigation", { name: "Principal" }).getByRole("link", { name: "Chat" }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Conversa" })).toBeVisible();
}

async function perguntar(page: Page, chat: PaginaChat, id: string): Promise<string> {
  if (await chat.novaConversa.isEnabled().catch(() => false)) await chat.novaConversa.click();
  await page.waitForTimeout(800);
  await chat.caixa.pressSequentially(perguntaDoGolden(id), { delay: 30 });
  await page.waitForTimeout(500);
  await chat.caixa.press("Enter");
  await expect(chat.estado).toHaveText(/Resposta pronta\.|Não foi possível/, { timeout: 300_000 });
  return (await chat.estado.innerText()).trim();
}

test("vídeo: rota, Cypher e citações em três perguntas", { tag: "@video" }, async ({ page }) => {
  test.setTimeout(1_200_000);
  await page.setViewportSize({ width: 1440, height: 900 });
  rmSync(PASTA, { recursive: true, force: true });
  mkdirSync(PASTA, { recursive: true });

  const chat = new PaginaChat(page);
  await chat.abrir();
  await expect(page.getByRole("button", { name: "Sistema: no ar" })).toBeVisible({ timeout: 60_000 });
  // começa no automático, qualquer que seja o modo salvo neste navegador
  await escolherModo(page, "Automático");

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
  const lista = page.getByRole("list", { name: "Linha do tempo da resposta" });
  const checagens: Record<string, unknown> = {};

  // ---- cena 1: T01 no automático; Rastro ao vivo, resposta com páginas, a citação abre o PDF na página
  marcar(1, "Pergunta em linguagem natural · o Rastro mostra a rota escolhida pelo agente, as ferramentas e a crítica");
  await page.waitForTimeout(1_500);
  checagens["t01Estado"] = await perguntar(page, chat, "T01");
  checagens["t01Resposta"] = await chat.respostas.last().innerText();
  checagens["t01Uniao"] = /Uni[aã]o/.test(checagens["t01Resposta"] as string);
  checagens["rotas"] = await lista.locator('li[data-tipo="rota"]').allInnerTexts();
  await lista.locator('li[data-tipo="rota"]').first().scrollIntoViewIfNeeded();
  await page.waitForTimeout(3_000);
  marcar(1, "Cada afirmação traz a página · um clique abre o documento na página citada");
  const chip = chat.respostas.last().getByRole("button", { name: /^Abrir a página \d+ do documento$/ }).first();
  const pagina = Number(((await chip.getAttribute("aria-label")) ?? "").match(/\d+/)?.[0]);
  await chip.click();
  await expect(page.getByRole("status").filter({ hasText: new RegExp(`^Página ${pagina} de \\d+$`) })).toBeVisible({ timeout: 60_000 });
  checagens["paginaAberta"] = pagina;
  await segurar(4);

  // ---- cena 2: G03 no automático (errata 2 do roteiro: no modo forçado a resposta saía errada); o roteador escolhe o grafo
  // e a consulta gerada fica à vista
  marcar(2, "Pergunta de soma: o roteador escolhe consultar o grafo, o modelo escreve Cypher só de leitura e o Neo4j responde");
  checagens["g03Estado"] = await perguntar(page, chat, "G03");
  checagens["g03Rotas"] = await lista.locator('li[data-tipo="rota"]').allInnerTexts();
  checagens["g03Resposta"] = await chat.respostas.last().innerText();
  await page.getByRole("navigation", { name: "Painel" }).getByRole("link", { name: "Rastro" }).click();
  const cypher = lista.locator('li[data-tipo="cypher"]').first();
  checagens["cypherVisto"] = (await cypher.count()) > 0;
  if (checagens["cypherVisto"]) {
    marcar(2, "A consulta Cypher gerada para a pergunta, com as linhas devolvidas e o tempo");
    await cypher.getByText("Ver a consulta").click();
    await cypher.scrollIntoViewIfNeeded();
    checagens["cypher"] = await cypher.locator("code").innerText();
    await segurar(6);
  }

  // ---- cena 3: E07 no automático; resposta com citação e o subgrafo da resposta
  marcar(3, "Pergunta sobre uma entidade · resposta citada e, na aba Grafo, o subgrafo usado");
  checagens["e07Estado"] = await perguntar(page, chat, "E07");
  checagens["e07Resposta"] = await chat.respostas.last().innerText();
  await page.waitForTimeout(2_000);
  await page.getByRole("navigation", { name: "Painel" }).getByRole("link", { name: "Grafo" }).click();
  const subgrafo = page.getByRole("group", { name: "Subgrafo da resposta" });
  checagens["subgrafo"] = await subgrafo.waitFor({ timeout: 10_000 }).then(() => true, () => false);
  await segurar(5);

  gravando = false;
  await gravar;
  writeFileSync(fileURLToPath(new URL("marcas.json", PASTA)), `${JSON.stringify({ intervaloMs: INTERVALO_MS, quadros: n, marcas }, null, 2)}\n`);
  writeFileSync(fileURLToPath(new URL("checagens.json", PASTA)), `${JSON.stringify(checagens, null, 2)}\n`);
  console.log(JSON.stringify(checagens));
  expect(n, "quadros gravados").toBeGreaterThan(100);
});
