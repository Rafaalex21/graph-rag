/** E2E do shell (F8.1): rotas, marcos de acessibilidade, tema e largura de celular. */
import { expect, test } from "@playwright/test";

test.describe("rotas", () => {
  test("a raiz leva a /chat/rastro e o título da aba acompanha a rota", async ({ page }) => {
    await page.goto("/");
    await expect(page).toHaveURL(/\/chat\/rastro$/);
    await expect(page.getByRole("navigation", { name: "Painel" }).getByRole("link", { name: "Rastro" })).toHaveAttribute("aria-current", "page");
    await page.getByRole("link", { name: "Configurações" }).click();
    await expect(page).toHaveTitle("Configurações · GraphRAG local");
    await expect(page.getByRole("heading", { level: 1 })).toHaveCount(1);
  });

  test("as três abas do painel navegam entre si e marcam a ativa", async ({ page }) => {
    await page.goto("/chat/rastro");
    const abas = page.getByRole("navigation", { name: "Painel" });
    for (const nome of ["Fontes", "Grafo", "Rastro"]) {
      await abas.getByRole("link", { name: nome }).click();
      await expect(abas.getByRole("link", { name: nome })).toHaveAttribute("aria-current", "page");
      await expect(abas.locator('[aria-current="page"]')).toHaveCount(1);
    }
  });

  for (const url of ["/nao-existe", "/chat/outra", "/configuracoes/x/y"]) {
    test(`${url} mostra "Página não encontrada" com o caminho de volta`, async ({ page }) => {
      await page.goto(url);
      await expect(page.getByRole("heading", { level: 1, name: "Página não encontrada" })).toBeVisible();
      await page.getByRole("link", { name: "Voltar ao chat" }).click();
      await expect(page).toHaveURL(/\/chat/);
    });
  }
});

test.describe("acessibilidade do shell", () => {
  test("marcos header, nav e main, e o link 'Ir para o conteúdo' leva o foco ao main", async ({ page }) => {
    await page.goto("/chat");
    await expect(page.getByRole("banner")).toBeVisible();
    await expect(page.getByRole("navigation", { name: "Principal" })).toBeVisible();
    await page.keyboard.press("Tab");
    const pular = page.getByRole("link", { name: "Ir para o conteúdo" });
    await expect(pular).toBeFocused();
    await pular.press("Enter");
    await expect(page.getByRole("main")).toBeFocused();
    await expect(page).toHaveURL(/\/chat\/rastro$/); // o <base href> não recarregou a rota
  });
});

test.describe("tema", () => {
  test("o botão alterna sistema → claro → escuro e a escolha sobrevive ao recarregamento", async ({ page }) => {
    await page.goto("/chat");
    const botao = page.getByRole("button", { name: /^Tema:/ });
    await expect(botao).toHaveText("Tema: sistema");
    await botao.click();
    await expect(botao).toHaveText("Tema: claro");
    await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
    await botao.click();
    await expect(botao).toHaveText("Tema: escuro");
    await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
    await page.reload();
    await expect(page.getByRole("button", { name: /^Tema:/ })).toHaveText("Tema: escuro");
    await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
    await page.getByRole("button", { name: /^Tema:/ }).click();
    await expect(page.locator("html")).not.toHaveAttribute("data-theme", /.+/);
  });

  test("em 'sistema' segue o esquema de cores do navegador", async ({ browser }) => {
    const ctx = await browser.newContext({ colorScheme: "dark", baseURL: "http://127.0.0.1:4300" });
    const page = await ctx.newPage();
    await page.goto("/chat");
    const fundo = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
    await ctx.close();
    const claro = await browser.newContext({ colorScheme: "light", baseURL: "http://127.0.0.1:4300" });
    const pagina = await claro.newPage();
    await pagina.goto("/chat");
    const fundoClaro = await pagina.evaluate(() => getComputedStyle(document.body).backgroundColor);
    await claro.close();
    expect(fundo).not.toBe(fundoClaro);
  });

  test("com o localStorage bloqueado a página continua funcionando", async ({ page }) => {
    await page.addInitScript(() => {
      Object.defineProperty(window, "localStorage", {
        get() {
          throw new DOMException("bloqueado", "SecurityError");
        },
      });
    });
    await page.goto("/chat");
    await page.getByRole("button", { name: /^Tema:/ }).click();
    await expect(page.getByRole("button", { name: /^Tema:/ })).toHaveText("Tema: claro");
  });
});

test.describe("celular", () => {
  for (const largura of [375, 320]) {
    test(`em ${largura} px não há rolagem horizontal, com e sem resposta na tela`, async ({ page }) => {
      await page.setViewportSize({ width: largura, height: 812 });
      await page.goto("/chat");
      const estoura = () => page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
      expect(await estoura()).toBe(false);
      await page.getByRole("textbox", { name: "Sua pergunta" }).fill("quero a tabela com uma pergunta bem comprida ".repeat(5));
      await page.getByRole("textbox", { name: "Sua pergunta" }).press("Enter");
      await expect(page.getByRole("status")).toHaveText(/Resposta pronta\./);
      expect(await estoura()).toBe(false);
    });
  }
});
