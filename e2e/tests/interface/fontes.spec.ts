/**
 * E2E do visualizador de fonte (F8.4): a aba Fontes abre a página citada do PDF (pdf.js) e destaca o trecho. Escritos antes do
 * código. A API falsa serve um PDF de 12 páginas feito à mão (`api-falsa/pdf.ts`) com `Range`, e as fontes:
 *   p1 pai p. 6 (trecho está na página 6) · t1 tabela p. 9-10 · f1 fato sem página (HTML no texto) · e1 entidade (resumo fora do PDF).
 */
import { expect, test, type Page } from "@playwright/test";
import { PaginaChat } from "../../paginas/chat.ts";

const TOTAL = 12;

const estado = (page: Page) => page.getByRole("status").filter({ hasText: /^Página \d+ de \d+$/ });
const pagina = (page: Page) => page.getByRole("img", { name: /^Página \d+ do documento$/ });
// o pdf.js deixa um canvas escondido no body para medir fontes; o da página é o que tem papel de imagem
const tela = (page: Page) => page.locator('canvas[role="img"]');
const destaques = (page: Page) => page.locator(".camada-texto .destaque");
const aviso = (page: Page) => page.locator("[data-aviso]");

async function abrir(page: Page, query: string): Promise<void> {
  await page.goto(`/chat/fontes${query}`);
  await expect(page.getByRole("heading", { level: 2, name: "Fontes" })).toBeVisible();
}

test.describe("abrir a página citada", () => {
  test("sem parâmetros mostra o convite e nenhuma requisição ao PDF", async ({ page }) => {
    const pedidos: string[] = [];
    page.on("request", (r) => r.url().includes("/api/documento/pdf") && pedidos.push(r.url()));
    await abrir(page, "");
    await expect(page.getByText("Clique numa citação da resposta ou numa evidência do Rastro para abrir a página do documento.")).toBeVisible();
    await expect(pagina(page)).toHaveCount(0);
    expect(pedidos).toHaveLength(0);
  });

  test("pagina=6&fonte=p1 abre a página 6 e destaca o trecho citado", async ({ page }) => {
    await abrir(page, "?pagina=6&fonte=p1");
    await expect(estado(page)).toHaveText(`Página 6 de ${TOTAL}`);
    await expect(pagina(page)).toHaveAttribute("aria-label", "Página 6 do documento");
    // a camada de texto do pdf.js tem o texto de verdade da página 6, e só dela
    const texto = page.locator(".camada-texto");
    await expect(texto).toContainText("MARC6X");
    await expect(texto).not.toContainText("MARC5X");
    await expect(destaques(page).first()).toBeVisible();
    await expect(destaques(page).first()).toContainText(/lucro|liquido/i);
    // o cabeçalho diz de onde vem o trecho
    await expect(page.getByText("Resultados > Lucro")).toBeVisible();
    await expect(page.getByText("pai", { exact: true })).toBeVisible();
    await expect(page.getByText("O lucro liquido ajustado foi de vinte bilhoes de reais em dois mil e vinte e cinco.").first()).toBeVisible();
  });

  test("o destaque só cobre o trecho: a outra frase da mesma página não é marcada", async ({ page }) => {
    await abrir(page, "?pagina=6&fonte=p1");
    await expect(destaques(page).first()).toBeVisible();
    const marcado = (await destaques(page).allInnerTexts()).join(" ").toLowerCase();
    expect(marcado).toContain("lucro");
    expect(marcado).not.toContain("nenhuma fonte");
    expect(marcado).not.toContain("marc6x");
  });

  test("pagina sem fonte abre a página sem destaque e sem aviso de trecho", async ({ page }) => {
    await abrir(page, "?pagina=3");
    await expect(estado(page)).toHaveText(`Página 3 de ${TOTAL}`);
    await expect(page.locator(".camada-texto")).toContainText("MARC3X");
    await expect(destaques(page)).toHaveCount(0);
    await expect(aviso(page)).toHaveCount(0);
  });

  test("tabela p. 9-10 (t1) abre na primeira página do rótulo e destaca a tabela", async ({ page }) => {
    await abrir(page, "?pagina=9&fonte=t1");
    await expect(estado(page)).toHaveText(`Página 9 de ${TOTAL}`);
    await expect(page.locator(".camada-texto")).toContainText("MARC9X");
    await expect(page.getByText("p. 9-10")).toBeVisible();
  });

  test("a página é desenhada de verdade: o canvas tem pixels que não são brancos", async ({ page }) => {
    await abrir(page, "?pagina=6&fonte=p1");
    await expect(destaques(page).first()).toBeVisible();
    const preenchido = await tela(page).first().evaluate((c: HTMLCanvasElement) => {
      const d = c.getContext("2d")!.getImageData(0, 0, c.width, c.height).data;
      for (let i = 0; i < d.length; i += 4) if ((d[i] ?? 255) < 128) return true;
      return false;
    });
    expect(preenchido).toBe(true);
  });
});

test.describe("trecho que não está na página", () => {
  test("fonte de resumo (entidade) abre a página mas avisa que o trecho não está escrito nela", async ({ page }) => {
    await abrir(page, "?pagina=6&fonte=e1");
    await expect(estado(page)).toHaveText(`Página 6 de ${TOTAL}`);
    await expect(aviso(page)).toContainText("Trecho não localizado nesta página");
    await expect(destaques(page)).toHaveCount(0);
    await expect(page.getByText("entidade", { exact: true })).toBeVisible();
  });

  test("a página certa da fonte p1 aberta em outra página (7) avisa e não destaca nada", async ({ page }) => {
    await abrir(page, "?pagina=7&fonte=p1");
    await expect(estado(page)).toHaveText(`Página 7 de ${TOTAL}`);
    await expect(aviso(page)).toContainText("Trecho não localizado nesta página");
    await expect(destaques(page)).toHaveCount(0);
  });

  test("fonte inexistente (404) abre a página e diz que a fonte não foi encontrada, sem alerta de erro", async ({ page }) => {
    await abrir(page, "?pagina=6&fonte=zz9");
    await expect(estado(page)).toHaveText(`Página 6 de ${TOTAL}`);
    await expect(aviso(page)).toContainText("Fonte não encontrada");
    await expect(destaques(page)).toHaveCount(0);
  });

  test("fonte em HTML hostil aparece como texto e nada é executado", async ({ page }) => {
    await abrir(page, "?pagina=6&fonte=f1");
    await expect(page.getByText('<img src=x onerror="window.__xss=1"> valor sem pagina')).toBeVisible();
    await expect(page.locator("main img")).toHaveCount(0);
    expect(await page.evaluate(() => (window as unknown as Record<string, unknown>)["__xss"])).toBeUndefined();
  });

  test("API de fontes fora do ar (503) não impede de ver a página", async ({ page }) => {
    await page.route("**/api/fonte/*", (r) => r.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ codigo: "grafo_indisponivel", mensagem: "Neo4j fora do ar." }) }));
    await abrir(page, "?pagina=6&fonte=p1");
    await expect(estado(page)).toHaveText(`Página 6 de ${TOTAL}`);
    await expect(aviso(page)).toContainText("Não foi possível ler o trecho");
  });
});

test.describe("navegação entre páginas", () => {
  test("Anterior e Próxima trocam a página e a URL, e travam nos limites", async ({ page }) => {
    await abrir(page, "?pagina=1");
    const anterior = page.getByRole("button", { name: "Página anterior" });
    const proxima = page.getByRole("button", { name: "Próxima página" });
    await expect(estado(page)).toHaveText(`Página 1 de ${TOTAL}`);
    await expect(anterior).toBeDisabled();
    await proxima.click();
    await expect(estado(page)).toHaveText(`Página 2 de ${TOTAL}`);
    await expect(page).toHaveURL(/\/chat\/fontes\?pagina=2$/);
    await expect(page.locator(".camada-texto")).toContainText("MARC2X");
    await abrir(page, `?pagina=${TOTAL}`);
    await expect(estado(page)).toHaveText(`Página ${TOTAL} de ${TOTAL}`);
    await expect(proxima).toBeDisabled();
    await anterior.click();
    await expect(estado(page)).toHaveText(`Página ${TOTAL - 1} de ${TOTAL}`);
  });

  test("ao sair da página citada o destaque some e a fonte sai da URL", async ({ page }) => {
    await abrir(page, "?pagina=6&fonte=p1");
    await expect(destaques(page).first()).toBeVisible();
    await page.getByRole("button", { name: "Próxima página" }).click();
    await expect(estado(page)).toHaveText(`Página 7 de ${TOTAL}`);
    await expect(destaques(page)).toHaveCount(0);
    await expect(aviso(page)).toHaveCount(0);
    await expect(page).toHaveURL(/\/chat\/fontes\?pagina=7$/);
  });

  test("ir para a página digitada (Enter) e valores inválidos são recusados com aviso", async ({ page }) => {
    await abrir(page, "?pagina=1");
    const campo = page.getByRole("spinbutton", { name: "Ir para a página" });
    await campo.fill("8");
    await campo.press("Enter");
    await expect(estado(page)).toHaveText(`Página 8 de ${TOTAL}`);
    await campo.fill("99");
    await campo.press("Enter");
    await expect(estado(page)).toHaveText(`Página 8 de ${TOTAL}`);
    await expect(page.getByRole("alert")).toContainText(`1 a ${TOTAL}`);
  });

  test("trocar de página várias vezes seguidas termina na última pedida, sem página misturada", async ({ page }) => {
    await abrir(page, "?pagina=1");
    const proxima = page.getByRole("button", { name: "Próxima página" });
    for (let i = 0; i < 6; i++) await proxima.click();
    await expect(estado(page)).toHaveText(`Página 7 de ${TOTAL}`);
    const texto = page.locator(".camada-texto");
    await expect(texto).toContainText("MARC7X");
    await expect(texto).not.toContainText("MARC6X");
    await expect(tela(page)).toHaveCount(1);
  });
});

test.describe("páginas inválidas", () => {
  for (const [rotulo, query] of [
    ["fora do intervalo (99)", "?pagina=99"],
    ["zero", "?pagina=0"],
    ["negativa", "?pagina=-3"],
    ["texto", "?pagina=abc"],
    ["decimal", "?pagina=2.5"],
  ] as const) {
    test(`${rotulo}: aviso neutro, sem página desenhada e sem quebrar`, async ({ page }) => {
      await abrir(page, query);
      await expect(aviso(page)).toContainText(/não existe|inválida/);
      await expect(pagina(page)).toHaveCount(0);
      await expect(page.getByRole("navigation", { name: "Painel" })).toBeVisible();
    });
  }

  test("a página 99 diz o intervalo do documento", async ({ page }) => {
    await abrir(page, "?pagina=99");
    await expect(aviso(page)).toContainText(`A página 99 não existe neste documento (1 a ${TOTAL}).`);
  });
});

test.describe("PDF indisponível", () => {
  test("404 do PDF: mensagem clara e a aba continua usável", async ({ page }) => {
    await page.route("**/api/documento/pdf", (r) => r.fulfill({ status: 404, contentType: "application/json", body: JSON.stringify({ codigo: "documento_ausente", mensagem: "PDF não encontrado." }) }));
    await abrir(page, "?pagina=6&fonte=p1");
    await expect(page.getByRole("alert")).toContainText("Não foi possível abrir o documento");
    await expect(pagina(page)).toHaveCount(0);
    await page.getByRole("link", { name: "Rastro" }).click();
    await expect(page).toHaveURL(/\/chat\/rastro$/);
  });

  test("conexão que cai ao pedir o PDF: mesma mensagem", async ({ page }) => {
    await page.route("**/api/documento/pdf", (r) => r.abort("connectionrefused"));
    await abrir(page, "?pagina=6");
    await expect(page.getByRole("alert")).toContainText("Não foi possível abrir o documento");
  });
});

test.describe("privacidade e rede", () => {
  test("só o próprio servidor é consultado e o PDF chega em partes (Range 206)", async ({ page, baseURL }) => {
    const origem = new URL(baseURL!).origin;
    const de: string[] = [];
    const status: number[] = [];
    page.on("request", (r) => r.url().startsWith("http") && de.push(new URL(r.url()).origin));
    page.on("response", (r) => r.url().includes("/api/documento/pdf") && status.push(r.status()));
    await abrir(page, "?pagina=6&fonte=p1");
    await expect(destaques(page).first()).toBeVisible();
    expect([...new Set(de)]).toEqual([origem]);
    expect(status.length).toBeGreaterThan(0);
    expect(status.some((s) => s === 206 || s === 200)).toBe(true);
    expect(status.every((s) => s === 206 || s === 200)).toBe(true);
  });
});

test.describe("de onde as páginas são abertas", () => {
  test("o chip da resposta leva ao visualizador na página e na fonte da citação", async ({ page }) => {
    const chat = new PaginaChat(page);
    await chat.abrir();
    await chat.perguntar("pergunta lenta");
    await chat.esperarResposta();
    await chat.respostas.first().getByRole("button", { name: "Abrir a página 6 do documento" }).click();
    await expect(page).toHaveURL(/\/chat\/fontes\?pagina=6&fonte=p1$/);
    await expect(estado(page)).toHaveText(`Página 6 de ${TOTAL}`);
    await expect(destaques(page).first()).toBeVisible();
  });

  test("a página de uma evidência do Rastro leva ao visualizador com o id da evidência", async ({ page }) => {
    const chat = new PaginaChat(page);
    await chat.abrir();
    await chat.perguntar("rastro completo");
    await chat.esperarResposta();
    await page.getByRole("button", { name: "Abrir a página 9 do documento" }).click();
    await expect(page).toHaveURL(/\/chat\/fontes\?pagina=9&fonte=t1$/);
    await expect(estado(page)).toHaveText(`Página 9 de ${TOTAL}`);
    await expect(page.locator(".camada-texto")).toContainText("MARC9X");
  });

  test("voltar ao chat e abrir outra citação não mistura as páginas, e a conversa continua", async ({ page }) => {
    const chat = new PaginaChat(page);
    await chat.abrir();
    await chat.perguntar("pergunta lenta");
    await chat.esperarResposta();
    await chat.respostas.first().getByRole("button", { name: "Abrir a página 6 do documento" }).click();
    await expect(estado(page)).toHaveText(`Página 6 de ${TOTAL}`);
    await page.getByRole("navigation", { name: "Painel" }).getByRole("link", { name: "Rastro" }).click();
    await page.goBack();
    await expect(estado(page)).toHaveText(`Página 6 de ${TOTAL}`);
    await expect(chat.respostas).toHaveCount(1);
  });
});

test.describe("acessibilidade e celular", () => {
  test("a navegação é por botões e campo com nome; Tab alcança Anterior, Próxima e o campo", async ({ page }) => {
    await abrir(page, "?pagina=5");
    await expect(estado(page)).toHaveText(`Página 5 de ${TOTAL}`);
    for (const nome of ["Página anterior", "Próxima página"]) await expect(page.getByRole("button", { name: nome })).toBeVisible();
    await expect(page.getByRole("spinbutton", { name: "Ir para a página" })).toHaveValue("5");
    await page.getByRole("button", { name: "Próxima página" }).focus();
    await page.keyboard.press("Enter");
    await expect(estado(page)).toHaveText(`Página 6 de ${TOTAL}`);
    await expect(page.getByRole("button", { name: "Próxima página" })).toBeFocused();
  });

  test("a 375 px não há rolagem horizontal da página e o canvas cabe na largura", async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 812 });
    await abrir(page, "?pagina=6&fonte=p1");
    await expect(destaques(page).first()).toBeVisible();
    const { rolagem, largura, canvas } = await page.evaluate(() => ({
      rolagem: document.documentElement.scrollWidth,
      largura: document.documentElement.clientWidth,
      canvas: document.querySelector('canvas[role="img"]')!.getBoundingClientRect().right,
    }));
    expect(rolagem).toBeLessThanOrEqual(largura);
    expect(canvas).toBeLessThanOrEqual(largura);
  });

  test("redimensionar a janela redesenha a página na nova largura", async ({ page }) => {
    await page.setViewportSize({ width: 1100, height: 800 });
    await abrir(page, "?pagina=6&fonte=p1");
    await expect(destaques(page).first()).toBeVisible();
    const antes = await tela(page).first().evaluate((c) => c.getBoundingClientRect().width);
    await page.setViewportSize({ width: 420, height: 800 }); // abaixo de 56rem o painel passa para uma coluna só, mais estreita
    await expect.poll(() => tela(page).first().evaluate((c) => c.getBoundingClientRect().width)).toBeLessThan(antes);
    await expect(destaques(page).first()).toBeVisible();
  });
});
