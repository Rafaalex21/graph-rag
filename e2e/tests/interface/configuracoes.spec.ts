/**
 * E2E das Configurações (F8.6), escritos antes do código: o modo de recuperação e o perfil são escolhidos na página
 * /configuracoes, guardados no navegador, mandados no corpo de `POST /api/chat` e visíveis no Rastro (a rota muda com o modo).
 * A API falsa tem o roteiro "modo teste": a rota segue o `mode` do pedido e o perfil rápido faz só a rodada 1.
 */
import { expect, test, type Page } from "@playwright/test";
import { PaginaChat } from "../../paginas/chat.ts";

const MODOS = [
  { rotulo: "Automático", valor: "auto", ferramenta: "buscar_trechos" },
  { rotulo: "Só trechos", valor: "trechos", ferramenta: "buscar_trechos" },
  { rotulo: "Só tabelas", valor: "tabelas", ferramenta: "buscar_tabelas" },
  { rotulo: "Entidades (busca local)", valor: "local", ferramenta: "entidade" },
  { rotulo: "Panorama (busca global)", valor: "global", ferramenta: "panorama" },
  { rotulo: "Consulta ao grafo (Cypher)", valor: "cypher", ferramenta: "consultar_grafo" },
] as const;

const PERGUNTA = "modo teste: qual o lucro?";

const modo = (page: Page, rotulo: string) => page.getByRole("radio", { name: rotulo, exact: true });
const salvo = (page: Page) => page.getByRole("status").filter({ hasText: "Configuração salva." });
const passosDeRota = (page: Page) => page.locator('li[data-tipo="rota"]');

async function abrirConfig(page: Page): Promise<void> {
  await page.goto("/configuracoes");
  await expect(page.getByRole("heading", { level: 1, name: "Configurações" })).toBeVisible();
}

async function perguntarNoModo(page: Page, rotulo: string, pergunta = PERGUNTA): Promise<PaginaChat> {
  await abrirConfig(page);
  await modo(page, rotulo).check();
  await page.getByRole("navigation", { name: "Principal" }).getByRole("link", { name: "Chat" }).click();
  const chat = new PaginaChat(page);
  await expect(page.getByRole("heading", { level: 1, name: "Conversa" })).toBeVisible();
  await chat.perguntar(pergunta);
  await chat.esperarResposta();
  return chat;
}

test.describe("a página de configurações", () => {
  test("tem o modo (6 opções) e o perfil (2), com o padrão marcado e uma explicação de cada", async ({ page }) => {
    await abrirConfig(page);
    const modos = page.getByRole("radiogroup", { name: "Modo de recuperação" });
    await expect(modos.getByRole("radio")).toHaveCount(6);
    for (const m of MODOS) await expect(modo(page, m.rotulo)).toBeVisible();
    await expect(modo(page, "Automático")).toBeChecked();
    await expect(modo(page, "Só tabelas")).toHaveAccessibleDescription(/buscar_tabelas/);
    const perfis = page.getByRole("radiogroup", { name: "Perfil" });
    await expect(perfis.getByRole("radio")).toHaveCount(2);
    await expect(page.getByRole("radio", { name: "Padrão", exact: true })).toBeChecked();
    await expect(page.getByRole("radio", { name: "Rápido", exact: true })).toHaveAccessibleDescription(/uma rodada/);
    await expect(page.getByText(/O tema se troca pelo botão do topo/)).toBeVisible();
  });

  test("escolher avisa que salvou e a escolha sobrevive ao recarregamento", async ({ page }) => {
    await abrirConfig(page);
    await modo(page, "Só tabelas").check();
    await page.getByRole("radio", { name: "Rápido", exact: true }).check();
    await expect(salvo(page)).toBeVisible();
    await page.reload();
    await expect(modo(page, "Só tabelas")).toBeChecked();
    await expect(page.getByRole("radio", { name: "Rápido", exact: true })).toBeChecked();
  });

  test("Restaurar o padrão volta ao modo automático e ao perfil padrão", async ({ page }) => {
    await abrirConfig(page);
    await modo(page, "Panorama (busca global)").check();
    await page.getByRole("radio", { name: "Rápido", exact: true }).check();
    await page.getByRole("button", { name: "Restaurar o padrão" }).click();
    await expect(modo(page, "Automático")).toBeChecked();
    await expect(page.getByRole("radio", { name: "Padrão", exact: true })).toBeChecked();
  });

  test("valor guardado inválido é ignorado e o padrão vale", async ({ page }) => {
    await page.addInitScript(() => localStorage.setItem("graphrag.config", JSON.stringify({ modo: "magico", perfil: 42 })));
    await abrirConfig(page);
    await expect(modo(page, "Automático")).toBeChecked();
    await expect(page.getByRole("radio", { name: "Padrão", exact: true })).toBeChecked();
  });

  test("com o armazenamento do navegador bloqueado a página funciona (vale até recarregar)", async ({ page }) => {
    await page.addInitScript(() => {
      Object.defineProperty(window, "localStorage", { get: () => { throw new Error("bloqueado"); } });
    });
    await abrirConfig(page);
    await modo(page, "Só trechos").check();
    await expect(modo(page, "Só trechos")).toBeChecked();
    await expect(page.getByRole("alert")).toHaveCount(0);
  });

  test("as opções se movem pelo teclado (setas) e ficam em um único ponto de parada", async ({ page }) => {
    await abrirConfig(page);
    await modo(page, "Automático").focus();
    await page.keyboard.press("ArrowDown");
    await expect(modo(page, "Só trechos")).toBeChecked();
    await expect(modo(page, "Só trechos")).toBeFocused();
  });

  test("a 375 px não há rolagem horizontal", async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 812 });
    await abrirConfig(page);
    const { rolagem, largura } = await page.evaluate(() => ({ rolagem: document.documentElement.scrollWidth, largura: document.documentElement.clientWidth }));
    expect(rolagem).toBeLessThanOrEqual(largura);
  });
});

test.describe("o pedido ao chat", () => {
  test("no padrão o corpo não traz modo nem perfil diferentes do padrão", async ({ page }) => {
    const chat = new PaginaChat(page);
    const pedidos = chat.gravarPedidos();
    await chat.abrir();
    await chat.perguntar(PERGUNTA);
    await chat.esperarResposta();
    expect(pedidos[0]?.["mode"] ?? "auto").toBe("auto");
    expect(pedidos[0]?.["profile"] ?? "consultar").toBe("consultar");
  });

  test("o modo e o perfil escolhidos vão no corpo, e valem só para as perguntas seguintes", async ({ page }) => {
    const chat = new PaginaChat(page);
    const pedidos = chat.gravarPedidos();
    await chat.abrir();
    await chat.perguntar(PERGUNTA);
    await chat.esperarResposta();
    await page.getByRole("link", { name: "Configurações" }).click();
    await modo(page, "Panorama (busca global)").check();
    await page.getByRole("radio", { name: "Rápido", exact: true }).check();
    await page.getByRole("navigation", { name: "Principal" }).getByRole("link", { name: "Chat" }).click();
    await chat.perguntar(PERGUNTA);
    await expect(chat.respostas).toHaveCount(2);
    await chat.esperarResposta();
    expect(pedidos[0]?.["mode"] ?? "auto").toBe("auto");
    expect(pedidos[1]).toMatchObject({ mode: "global", profile: "consultar-rapido" });
  });

  test("o chat mostra o modo e o perfil em uso, com o caminho para mudá-los", async ({ page }) => {
    const chat = new PaginaChat(page);
    await chat.abrir();
    await expect(page.getByText("Modo: Automático · Perfil: Padrão")).toBeVisible();
    await page.getByRole("link", { name: "Alterar modo e perfil" }).click();
    await expect(page).toHaveURL(/\/configuracoes$/);
    await modo(page, "Só tabelas").check();
    await page.getByRole("navigation", { name: "Principal" }).getByRole("link", { name: "Chat" }).click();
    await expect(page.getByText("Modo: Só tabelas · Perfil: Padrão")).toBeVisible();
  });
});

test.describe("trocar o modo muda a rota no Rastro", () => {
  for (const m of MODOS.filter((x) => x.valor !== "auto")) {
    test(`modo ${m.rotulo}: a rota é ${m.ferramenta}, marcada como forçada`, async ({ page }) => {
      await perguntarNoModo(page, m.rotulo);
      const rotas = passosDeRota(page);
      await expect(rotas.first()).toHaveAttribute("data-ferramentas", m.ferramenta);
      await expect(rotas.first()).toContainText(`Modo forçado: ${m.rotulo}`);
      await expect(page.getByRole("list", { name: "Linha do tempo da resposta" })).toContainText(`Executando ${m.ferramenta}`);
    });
  }

  test("no modo automático a rota é a do roteador e não tem a marca de modo forçado", { tag: "@fluxo-modo" }, async ({ page }) => {
    await perguntarNoModo(page, "Automático");
    await expect(passosDeRota(page).first()).toHaveAttribute("data-ferramentas", "buscar_trechos");
    await expect(passosDeRota(page).first()).not.toContainText("Modo forçado");
  });

  test("as rotas dos cinco modos forçados são diferentes entre si e do automático", { tag: "@fluxo-modo" }, async ({ page }) => {
    const rotas: string[] = [];
    for (const m of MODOS) {
      await perguntarNoModo(page, m.rotulo);
      rotas.push((await passosDeRota(page).first().getAttribute("data-ferramentas")) ?? "");
    }
    // trechos e automático coincidem (o roteador falso escolhe buscar_trechos); os outros quatro são todos diferentes
    expect(new Set(rotas.slice(1)).size).toBe(5);
    expect(rotas.slice(2)).not.toContain(rotas[0]);
  });

  test("trocar o modo no meio da conversa muda a rota da pergunta seguinte, e o Rastro mostra a mais recente", { tag: "@fluxo-modo" }, async ({ page }) => {
    const chat = await perguntarNoModo(page, "Só tabelas");
    await expect(passosDeRota(page).first()).toHaveAttribute("data-ferramentas", "buscar_tabelas");
    await page.getByRole("link", { name: "Configurações" }).click();
    await modo(page, "Consulta ao grafo (Cypher)").check();
    await page.getByRole("navigation", { name: "Principal" }).getByRole("link", { name: "Chat" }).click();
    await chat.perguntar(PERGUNTA);
    await expect(chat.respostas).toHaveCount(2);
    await chat.esperarResposta();
    await expect(passosDeRota(page).first()).toHaveAttribute("data-ferramentas", "consultar_grafo");
  });

  test("o perfil rápido faz só a rodada 1 e o padrão faz duas", async ({ page }) => {
    await perguntarNoModo(page, "Automático");
    await expect(passosDeRota(page)).toHaveCount(2);
    await page.getByRole("link", { name: "Configurações" }).click();
    await page.getByRole("radio", { name: "Rápido", exact: true }).check();
    await page.getByRole("navigation", { name: "Principal" }).getByRole("link", { name: "Chat" }).click();
    const chat = new PaginaChat(page);
    await chat.novaConversa.click();
    await chat.perguntar(PERGUNTA);
    await chat.esperarResposta();
    await expect(passosDeRota(page)).toHaveCount(1);
  });
});
