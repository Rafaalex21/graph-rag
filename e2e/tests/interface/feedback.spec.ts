/**
 * E2E do feedback por resposta (F8.7), escritos antes do código: cada resposta pronta tem "Resposta útil" e "Resposta não útil"
 * (nota 1 ou -1 em `POST /api/feedback`, com o `mensagemId` do evento `fim`) e um comentário opcional. A API falsa valida o corpo
 * como a real; as falhas se simulam com `page.route`.
 */
import { expect, test, type Locator, type Page } from "@playwright/test";
import { PaginaChat } from "../../paginas/chat.ts";

const PERGUNTA = "Qual o lucro de 2025?";

const util = (g: Locator) => g.getByRole("button", { name: "Resposta útil", exact: true });
const naoUtil = (g: Locator) => g.getByRole("button", { name: "Resposta não útil", exact: true });

async function responder(page: Page, pergunta = PERGUNTA): Promise<PaginaChat> {
  const chat = new PaginaChat(page);
  await chat.abrir();
  await chat.perguntar(pergunta);
  await chat.esperarResposta();
  return chat;
}

test.describe("os botões de nota", () => {
  test("só a resposta pronta tem; a pergunta, a resposta em andamento e a que deu erro não", async ({ page }) => {
    const chat = new PaginaChat(page);
    await chat.abrir();
    await chat.perguntar("resposta lenta");
    await expect(chat.respostas.first()).toBeVisible();
    await expect(page.getByRole("group", { name: "Avaliar a resposta" })).toHaveCount(0);
    await chat.esperarResposta();
    await expect(chat.avaliacao()).toBeVisible();
    await expect(chat.perguntas.first().getByRole("button")).toHaveCount(0);
    await chat.novaConversa.click();
    await chat.perguntar("dá erro agora");
    await expect(chat.alerta).toBeVisible();
    await expect(page.getByRole("group", { name: "Avaliar a resposta" })).toHaveCount(0);
  });

  test("começam sem nota marcada e com nomes claros", async ({ page }) => {
    const chat = await responder(page);
    const g = chat.avaliacao();
    await expect(util(g)).toHaveAttribute("aria-pressed", "false");
    await expect(naoUtil(g)).toHaveAttribute("aria-pressed", "false");
    await expect(g.getByText("Nota registrada.")).toHaveCount(0);
  });

  test("Resposta útil manda nota 1 com o mensagemId da resposta e confirma na tela", async ({ page }) => {
    const chat = new PaginaChat(page);
    const feedbacks = chat.gravarFeedbacks();
    await chat.abrir();
    await chat.perguntar(PERGUNTA);
    await chat.esperarResposta();
    await util(chat.avaliacao()).click();
    await expect(chat.avaliacao().getByText("Nota registrada.")).toBeVisible();
    await expect(util(chat.avaliacao())).toHaveAttribute("aria-pressed", "true");
    await expect(naoUtil(chat.avaliacao())).toHaveAttribute("aria-pressed", "false");
    expect(feedbacks).toHaveLength(1);
    expect(feedbacks[0]).toEqual({ mensagemId: expect.stringMatching(/^m-\d+$/), nota: 1 });
  });

  test("Resposta não útil manda nota -1; trocar de ideia manda a nova nota e marca só a última", async ({ page }) => {
    const chat = new PaginaChat(page);
    const feedbacks = chat.gravarFeedbacks();
    await chat.abrir();
    await chat.perguntar(PERGUNTA);
    await chat.esperarResposta();
    await naoUtil(chat.avaliacao()).click();
    await expect(naoUtil(chat.avaliacao())).toHaveAttribute("aria-pressed", "true");
    await util(chat.avaliacao()).click();
    await expect(util(chat.avaliacao())).toHaveAttribute("aria-pressed", "true");
    await expect(naoUtil(chat.avaliacao())).toHaveAttribute("aria-pressed", "false");
    expect(feedbacks.map((f) => f["nota"])).toEqual([-1, 1]);
    expect(feedbacks[0]?.["mensagemId"]).toBe(feedbacks[1]?.["mensagemId"]);
  });

  test("clicar de novo na nota que já está marcada não manda outro pedido", async ({ page }) => {
    const chat = new PaginaChat(page);
    const feedbacks = chat.gravarFeedbacks();
    await chat.abrir();
    await chat.perguntar(PERGUNTA);
    await chat.esperarResposta();
    await util(chat.avaliacao()).click();
    await expect(chat.avaliacao().getByText("Nota registrada.")).toBeVisible();
    await util(chat.avaliacao()).click();
    await expect(util(chat.avaliacao())).toHaveAttribute("aria-pressed", "true");
    expect(feedbacks).toHaveLength(1);
  });

  test("duas respostas têm notas independentes, cada uma com o seu mensagemId", async ({ page }) => {
    const chat = new PaginaChat(page);
    const feedbacks = chat.gravarFeedbacks();
    await chat.abrir();
    await chat.perguntar(PERGUNTA);
    await chat.esperarResposta();
    await chat.perguntar("Qual o lucro de 2024?");
    await expect(chat.respostas).toHaveCount(2);
    await expect(chat.avaliacao(1)).toBeVisible();
    await util(chat.avaliacao(0)).click();
    await naoUtil(chat.avaliacao(1)).click();
    await expect(chat.avaliacao(1).getByText("Nota registrada.")).toBeVisible();
    await expect(util(chat.avaliacao(0))).toHaveAttribute("aria-pressed", "true");
    await expect(naoUtil(chat.avaliacao(0))).toHaveAttribute("aria-pressed", "false");
    await expect(naoUtil(chat.avaliacao(1))).toHaveAttribute("aria-pressed", "true");
    expect(feedbacks).toHaveLength(2);
    expect(feedbacks[0]?.["mensagemId"]).not.toBe(feedbacks[1]?.["mensagemId"]);
    expect(feedbacks.map((f) => f["nota"])).toEqual([1, -1]);
  });

  test("funciona pelo teclado (Tab até o botão e Enter)", async ({ page }) => {
    const chat = new PaginaChat(page);
    const feedbacks = chat.gravarFeedbacks();
    await chat.abrir();
    await chat.perguntar(PERGUNTA);
    await chat.esperarResposta();
    await util(chat.avaliacao()).focus();
    await page.keyboard.press("Enter");
    await expect(chat.avaliacao().getByText("Nota registrada.")).toBeVisible();
    expect(feedbacks).toHaveLength(1);
  });

  test("dois cliques seguidos enquanto envia mandam um pedido só", async ({ page }) => {
    await page.route("**/api/feedback", async (route) => {
      await new Promise((ok) => setTimeout(ok, 600));
      await route.continue();
    });
    const chat = new PaginaChat(page);
    const feedbacks = chat.gravarFeedbacks();
    await chat.abrir();
    await chat.perguntar(PERGUNTA);
    await chat.esperarResposta();
    await util(chat.avaliacao()).dblclick();
    await expect(chat.avaliacao().getByText("Nota registrada.")).toBeVisible();
    expect(feedbacks).toHaveLength(1);
  });
});

test.describe("o comentário opcional", () => {
  test("aparece depois da nota; vazio não envia; enviado vai junto com a mesma nota, como texto", async ({ page }) => {
    const chat = new PaginaChat(page);
    const feedbacks = chat.gravarFeedbacks();
    await chat.abrir();
    await chat.perguntar(PERGUNTA);
    await chat.esperarResposta();
    const g = chat.avaliacao();
    await expect(g.getByRole("textbox", { name: "Comentário (opcional)" })).toHaveCount(0);
    await naoUtil(g).click();
    const caixa = g.getByRole("textbox", { name: "Comentário (opcional)" });
    await expect(caixa).toBeVisible();
    await expect(caixa).toHaveAttribute("maxlength", "1000");
    const enviar = g.getByRole("button", { name: "Enviar comentário" });
    await expect(enviar).toBeDisabled();
    await caixa.fill('<b>sem citação</b> & "aspas"');
    await enviar.click();
    await expect(g.getByText("Comentário registrado.")).toBeVisible();
    expect(feedbacks).toHaveLength(2);
    expect(feedbacks[1]).toEqual({ mensagemId: feedbacks[0]?.["mensagemId"], nota: -1, comentario: '<b>sem citação</b> & "aspas"' });
    await expect(page.locator("article b")).toHaveCount(0);
  });

  test("trocar a nota depois do comentário manda a nova nota sem o comentário antigo", async ({ page }) => {
    const chat = new PaginaChat(page);
    const feedbacks = chat.gravarFeedbacks();
    await chat.abrir();
    await chat.perguntar(PERGUNTA);
    await chat.esperarResposta();
    const g = chat.avaliacao();
    await naoUtil(g).click();
    await g.getByRole("textbox", { name: "Comentário (opcional)" }).fill("faltou a fonte");
    await g.getByRole("button", { name: "Enviar comentário" }).click();
    await expect(g.getByText("Comentário registrado.")).toBeVisible();
    await util(g).click();
    await expect(util(g)).toHaveAttribute("aria-pressed", "true");
    expect(feedbacks.at(-1)).toEqual({ mensagemId: feedbacks[0]?.["mensagemId"], nota: 1 });
    await expect(g.getByRole("textbox", { name: "Comentário (opcional)" })).toHaveValue("");
  });
});

test.describe("quando o registro falha", () => {
  test("erro da API: mostra a mensagem num alerta, não marca a nota e deixa tentar de novo", async ({ page }) => {
    await page.route("**/api/feedback", (route) => route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ codigo: "falha_ao_gravar", mensagem: "Não foi possível registrar a nota agora." }) }));
    const chat = await responder(page);
    const g = chat.avaliacao();
    await util(g).click();
    await expect(chat.respostas.first().getByRole("alert")).toHaveText("Não foi possível registrar a nota agora.");
    await expect(util(g)).toHaveAttribute("aria-pressed", "false");
    await expect(g.getByText("Nota registrada.")).toHaveCount(0);
    await page.unroute("**/api/feedback");
    await util(g).click();
    await expect(g.getByText("Nota registrada.")).toBeVisible();
    await expect(chat.respostas.first().getByRole("alert")).toHaveCount(0);
    await expect(util(g)).toHaveAttribute("aria-pressed", "true");
  });

  test("rede caída: mensagem nossa, sem pilha", async ({ page }) => {
    await page.route("**/api/feedback", (route) => route.abort("connectionrefused"));
    const chat = await responder(page);
    await util(chat.avaliacao()).click();
    await expect(chat.respostas.first().getByRole("alert")).toHaveText("Não foi possível registrar a nota agora.");
  });

  test("HTML de um proxy (502) nunca vai para a tela", async ({ page }) => {
    await page.route("**/api/feedback", (route) => route.fulfill({ status: 502, contentType: "text/html", body: "<html><body><h1>Bad Gateway</h1></body></html>" }));
    const chat = await responder(page);
    await naoUtil(chat.avaliacao()).click();
    await expect(chat.respostas.first().getByRole("alert")).toHaveText("Não foi possível registrar a nota agora.");
    await expect(page.getByText("Bad Gateway")).toHaveCount(0);
  });

  test("falha ao enviar o comentário: alerta, a nota continua marcada e o texto digitado fica", async ({ page }) => {
    const chat = await responder(page);
    const g = chat.avaliacao();
    await util(g).click();
    await expect(g.getByText("Nota registrada.")).toBeVisible();
    await page.route("**/api/feedback", (route) => route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ codigo: "falha_ao_gravar", mensagem: "Não foi possível registrar a nota agora." }) }));
    await g.getByRole("textbox", { name: "Comentário (opcional)" }).fill("ótima");
    await g.getByRole("button", { name: "Enviar comentário" }).click();
    await expect(chat.respostas.first().getByRole("alert")).toBeVisible();
    await expect(util(g)).toHaveAttribute("aria-pressed", "true");
    await expect(g.getByRole("textbox", { name: "Comentário (opcional)" })).toHaveValue("ótima");
  });
});

test.describe("celular", () => {
  test("a 375 px os botões e o comentário não geram rolagem horizontal", async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 812 });
    const chat = await responder(page);
    await naoUtil(chat.avaliacao()).click();
    await chat.avaliacao().getByRole("textbox", { name: "Comentário (opcional)" }).fill("x".repeat(400));
    const { rolagem, largura } = await page.evaluate(() => ({ rolagem: document.documentElement.scrollWidth, largura: document.documentElement.clientWidth }));
    expect(rolagem).toBeLessThanOrEqual(largura);
  });
});
