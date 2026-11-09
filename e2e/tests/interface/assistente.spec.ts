/**
 * E2E da tela do usuário final (F8.9), escritos antes do código. A tela inicial é `/assistente`: barra lateral (conversas recentes,
 * estado do sistema, tema, "Modo técnico"), a conversa ao centro e, ao lado, o painel da fonte (o mesmo visualizador pdf.js da aba
 * Fontes). Cada resposta traz o selo de estado, as fontes, a nota e "Como cheguei a esta resposta". A API falsa roteiriza pelo texto
 * da pergunta (ver `api-falsa/servidor.ts`): "parcial", "ausente", "olá", "fontes", "rastro", "modo teste", "xss", "lenta", "erro"…
 * O PDF de teste tem 12 páginas; p1 é pai da p. 6 e t1 é tabela das p. 9-10.
 */
import { expect, test, type Locator, type Page } from "@playwright/test";
import { PaginaAssistente } from "../../paginas/assistente.ts";

const TOTAL = 12;
const PERGUNTA = "Qual o lucro de 2025?";

async function responder(page: Page, pergunta = PERGUNTA): Promise<PaginaAssistente> {
  const a = new PaginaAssistente(page);
  await a.abrir();
  await a.perguntar(pergunta);
  await a.esperarResposta();
  return a;
}

/** Nada da tela fica cortado: o `overflow: hidden` da página esconderia um botão que passou da borda, então mede-se cada peça. */
async function cabeNaTela(page: Page, ...pecas: Locator[]): Promise<void> {
  const largura = page.viewportSize()?.width ?? 0;
  for (const peca of pecas) {
    const caixa = await peca.boundingBox();
    expect(caixa, "a peça precisa estar na tela").not.toBeNull();
    expect(caixa!.x).toBeGreaterThanOrEqual(-1);
    expect(caixa!.x + caixa!.width).toBeLessThanOrEqual(largura + 1);
  }
}

const posicao = (page: Page) => page.getByRole("complementary", { name: "Fonte aberta" }).getByText(/^Página \d+ de \d+$/);
const desenho = (page: Page) => page.getByRole("complementary", { name: "Fonte aberta" }).locator('canvas[role="img"]');

test.describe("a tela inicial", () => {
  test("a raiz leva a /assistente, sem o cabeçalho técnico, com o título e a caixa de pergunta em foco", async ({ page }) => {
    const a = new PaginaAssistente(page);
    await a.abrir();
    await expect(page).toHaveTitle("Pergunte ao Formulário · GraphRAG local");
    await expect(page.getByRole("heading", { level: 1, name: "Pergunte ao Formulário" })).toBeVisible();
    await expect(page.getByRole("navigation", { name: "Principal" })).toHaveCount(0);
    await expect(a.caixa).toBeFocused();
  });

  test("tem os marcos de página: menu lateral, conversa e área principal", async ({ page }) => {
    const a = new PaginaAssistente(page);
    await a.abrir();
    await expect(page.getByRole("main")).toBeVisible();
    await expect(a.menu).toBeVisible();
    await expect(a.recentes).toBeVisible();
    await expect(page.getByRole("region", { name: "Conversa" })).toBeVisible();
    await expect(page.getByRole("log", { name: "Mensagens da conversa" })).toBeAttached();
  });

  test("oferece perguntas para começar; clicar numa envia exatamente aquele texto", async ({ page }) => {
    const a = new PaginaAssistente(page);
    const pedidos = a.gravarPedidos();
    await a.abrir();
    const sugestoes = page.getByRole("group", { name: "Perguntas para começar" }).getByRole("button");
    await expect(sugestoes).toHaveCount(3);
    const texto = (await sugestoes.first().innerText()).trim();
    await sugestoes.first().click();
    await a.esperarResposta();
    expect(pedidos).toHaveLength(1);
    expect(pedidos[0]?.["message"]).toBe(texto);
    await expect(a.perguntas.first()).toHaveText(texto);
    await expect(page.getByRole("group", { name: "Perguntas para começar" })).toHaveCount(0);
  });

  test("Enter envia, Shift+Enter quebra a linha e o botão só vale com texto", async ({ page }) => {
    const a = new PaginaAssistente(page);
    const pedidos = a.gravarPedidos();
    await a.abrir();
    await expect(a.enviar).toBeDisabled();
    await a.caixa.fill("primeira linha");
    await expect(a.enviar).toBeEnabled();
    await a.caixa.press("Shift+Enter");
    await a.caixa.pressSequentially("segunda linha");
    await expect(a.caixa).toHaveValue("primeira linha\nsegunda linha");
    await a.caixa.press("Enter");
    await a.esperarResposta();
    expect(pedidos).toHaveLength(1);
    expect(pedidos[0]?.["message"]).toBe("primeira linha\nsegunda linha");
    await expect(a.caixa).toHaveValue("");
  });
});

test.describe("a resposta e o selo de estado", () => {
  test("mostra a pergunta, a resposta e o selo 'Encontrado no documento' quando há evidência", async ({ page }) => {
    const a = await responder(page);
    await expect(a.perguntas.first()).toHaveText(PERGUNTA);
    await expect(a.respostas.first()).toContainText("O lucro foi R$ 20 bi");
    await expect(a.respostas.first().getByText("Encontrado no documento", { exact: true })).toBeVisible();
  });

  for (const [pergunta, selo] of [
    ["resposta parcial", "Encontrei só em parte"],
    ["pergunta ausente", "Não consta no documento"],
  ] as const) {
    test(`"${pergunta}" mostra o selo "${selo}"`, async ({ page }) => {
      const a = await responder(page, pergunta);
      await expect(a.respostas.first().getByText(selo, { exact: true })).toBeVisible();
      await expect(a.respostas.first().getByText("Encontrado no documento", { exact: true })).toHaveCount(0);
    });
  }

  test("uma saudação (sem nenhuma evidência) não leva selo nenhum", async ({ page }) => {
    const a = await responder(page, "olá, tudo bem?");
    await expect(a.respostas.first()).toContainText("Sou o assistente");
    for (const selo of ["Encontrado no documento", "Encontrei só em parte", "Não consta no documento", "Não consegui responder"]) {
      await expect(a.respostas.first().getByText(selo, { exact: true })).toHaveCount(0);
    }
    await expect(a.fontes()).toHaveCount(0);
  });

  test("com erro: selo 'Não consegui responder', a mensagem da API e 'Tentar de novo' refaz a pergunta", async ({ page }) => {
    const a = new PaginaAssistente(page);
    const pedidos = a.gravarPedidos();
    await a.abrir();
    await a.perguntar("dá erro agora");
    const alerta = a.respostas.first().getByRole("alert");
    await expect(alerta).toContainText("O modelo de linguagem demorou demais. Tente novamente.");
    await expect(a.respostas.first().getByText("Não consegui responder", { exact: true })).toBeVisible();
    await expect(a.avaliacao()).toHaveCount(0);
    await a.respostas.first().getByRole("button", { name: "Tentar de novo" }).click();
    await expect.poll(() => pedidos.length).toBe(2);
    expect(pedidos[1]?.["message"]).toBe("dá erro agora");
    await expect(a.perguntas).toHaveCount(1);
  });

  test("durante a resposta: aviso 'Gerando', sem selo nem nota; 'Parar' interrompe e oferece tentar de novo", async ({ page }) => {
    const a = new PaginaAssistente(page);
    await a.abrir();
    await a.perguntar("resposta lenta");
    await expect(a.estado).toHaveText("Gerando a resposta…");
    await expect(a.parar).toBeVisible();
    await expect(a.avaliacao()).toHaveCount(0);
    await expect(a.respostas.first().getByText("Encontrado no documento", { exact: true })).toHaveCount(0);
    await a.parar.click();
    await expect(a.estado).toHaveText("Resposta interrompida.");
    await expect(a.respostas.first().getByRole("button", { name: "Tentar de novo" })).toBeVisible();
    await expect(a.parar).toHaveCount(0);
  });

  test("HTML hostil na resposta não executa nada", async ({ page }) => {
    const a = await responder(page, "teste xss");
    expect(await page.evaluate(() => (window as unknown as Record<string, unknown>)["__xss"])).toBeUndefined();
    await expect(a.respostas.first().locator("script, img")).toHaveCount(0);
  });

  test("uma tabela em markdown vira tabela de verdade", async ({ page }) => {
    const a = await responder(page, "mostre a tabela");
    await expect(a.respostas.first().getByRole("table")).toBeVisible();
  });
});

test.describe("as fontes da resposta", () => {
  test("um cartão por fonte com página, sem repetir; as sem página e o HTML delas não viram cartão", async ({ page }) => {
    const a = await responder(page, "mostre as fontes");
    const cartoes = a.fontes().getByRole("button");
    await expect(cartoes).toHaveCount(2);
    await expect(cartoes.nth(0)).toContainText("p. 6");
    await expect(cartoes.nth(1)).toContainText("p. 9-10");
    await expect(a.fontes().getByText("valor sem página")).toHaveCount(0);
    await expect(a.fontes().locator("img")).toHaveCount(0);
    expect(await page.evaluate(() => (window as unknown as Record<string, unknown>)["__xss"])).toBeUndefined();
  });

  test("sem nenhuma citação marcada, os cartões são as primeiras evidências com página (até três)", async ({ page }) => {
    const a = await responder(page, "texto sem marcar nada");
    const cartoes = a.fontes().getByRole("button");
    await expect(cartoes).toHaveCount(3);
    await expect(cartoes.nth(0)).toContainText("p. 6");
    await expect(cartoes.nth(1)).toContainText("p. 9-10");
    await expect(cartoes.nth(2)).toContainText("p. 3");
  });

  test("uma resposta com uma só evidência tem um só cartão; sem evidência, nenhuma seção de fontes", async ({ page }) => {
    const a = await responder(page);
    await expect(a.fontes().getByRole("button")).toHaveCount(1);
    await a.novaConversa.click();
    await a.perguntar("pergunta ausente");
    await a.esperarResposta();
    await expect(a.fontes()).toHaveCount(0);
  });

  test("clicar no cartão abre o painel na página certa, com o desenho da página", async ({ page }) => {
    const a = await responder(page, "mostre as fontes");
    await expect(a.painel).toHaveCount(0);
    const cartao = a.cartao(/p\. 6/);
    await cartao.click();
    await expect(a.painel).toBeVisible();
    await expect(posicao(page)).toHaveText(`Página 6 de ${TOTAL}`);
    await expect(desenho(page)).toHaveAttribute("aria-label", "Página 6 do documento");
    await expect(cartao).toHaveAttribute("aria-pressed", "true");
    await expect(a.painel.locator(".camada-texto .destaque").first()).toBeVisible();
  });

  test("a tabela das páginas 9-10 abre na página 9 e o outro cartão deixa de estar marcado", async ({ page }) => {
    const a = await responder(page, "mostre as fontes");
    await a.cartao(/p\. 6/).click();
    await expect(posicao(page)).toHaveText(`Página 6 de ${TOTAL}`);
    await a.cartao(/p\. 9-10/).click();
    await expect(posicao(page)).toHaveText(`Página 9 de ${TOTAL}`);
    await expect(desenho(page)).toHaveAttribute("aria-label", "Página 9 do documento");
    await expect(a.cartao(/p\. 9-10/)).toHaveAttribute("aria-pressed", "true");
    await expect(a.cartao(/p\. 6/)).toHaveAttribute("aria-pressed", "false");
  });

  test("'Fechar fonte' fecha o painel e desmarca o cartão; 'Nova conversa' também fecha", async ({ page }) => {
    const a = await responder(page);
    await a.cartao(/p\. 6/).click();
    await expect(a.painel).toBeVisible();
    await a.painel.getByRole("button", { name: "Fechar fonte" }).click();
    await expect(a.painel).toHaveCount(0);
    await expect(a.cartao(/p\. 6/)).toHaveAttribute("aria-pressed", "false");
    await a.cartao(/p\. 6/).click();
    await expect(a.painel).toBeVisible();
    await a.novaConversa.click();
    await expect(a.painel).toHaveCount(0);
  });

  test("a citação [p. 6] no texto da resposta também abre o painel na página 6", async ({ page }) => {
    const a = await responder(page);
    await a.respostas.first().getByRole("button", { name: "Abrir a página 6 do documento" }).click();
    await expect(a.painel).toBeVisible();
    await expect(posicao(page)).toHaveText(`Página 6 de ${TOTAL}`);
  });
});

test.describe("o encaixe na tela", () => {
  test("com a fonte aberta, a caixa de pergunta, o Enviar e as escolhas de busca cabem na coluna da conversa", async ({ page }) => {
    const a = await responder(page);
    await a.cartao(/p\. 6/).click();
    await expect(a.painel).toBeVisible();
    await cabeNaTela(page, a.caixa, a.enviar, a.modo("Dados organizados").locator("xpath=ancestor::*[@role='group']"));
    const conversa = await page.getByRole("region", { name: "Conversa" }).boundingBox();
    const painel = await a.painel.boundingBox();
    const enviar = await a.enviar.boundingBox();
    expect(enviar!.x + enviar!.width).toBeLessThanOrEqual(conversa!.x + conversa!.width + 1);
    expect(conversa!.x + conversa!.width).toBeLessThanOrEqual(painel!.x + 1);
  });
});

test.describe("Como cheguei a esta resposta", () => {
  test("começa fechado; abre com os passos em português simples, sem Cypher nem nomes de ferramenta", async ({ page }) => {
    const a = await responder(page, "mostre o rastro");
    const botao = a.botaoPassos();
    await expect(botao).toHaveAttribute("aria-expanded", "false");
    await expect(a.passos()).toBeHidden();
    await botao.click();
    await expect(botao).toHaveAttribute("aria-expanded", "true");
    const itens = a.passos().getByRole("listitem");
    expect(await itens.count()).toBeGreaterThanOrEqual(3);
    const passos = a.passos();
    await expect(passos).toContainText("Entendi a pergunta");
    await expect(passos).toContainText("Procurei nos textos do formulário");
    await expect(passos).toContainText("Não consegui consultar os dados organizados do documento");
    await expect(passos).toContainText("Faltava informação, então busquei de novo");
    await expect(passos).toContainText("Conferi que as informações bastavam");
    await expect(passos).toContainText("Corrigi frases sem base nas fontes");
    await expect(passos).toContainText("Pronto em 12 s");
    for (const tecnico of ["MATCH", "FinancialFact", "buscar_trechos", "consultar_grafo"]) await expect(passos).not.toContainText(tecnico);
    expect(await page.evaluate(() => (window as unknown as Record<string, unknown>)["__xss"])).toBeUndefined();
    await botao.click();
    await expect(botao).toHaveAttribute("aria-expanded", "false");
    await expect(a.passos()).toBeHidden();
  });

  test("uma resposta ausente conta que o documento não traz o dado", async ({ page }) => {
    const a = await responder(page, "pergunta ausente");
    await a.botaoPassos().click();
    await expect(a.passos()).toContainText("Concluí que o documento não traz esse dado");
  });

  test("a busca escolhida por você aparece no passo a passo", async ({ page }) => {
    const a = new PaginaAssistente(page);
    await a.abrir();
    await a.modo("Tabelas").click();
    await a.perguntar("modo teste");
    await a.esperarResposta();
    await a.botaoPassos().click();
    await expect(a.passos()).toContainText("Busca escolhida por você: Tabelas");
  });

  test("uma saudação, que não buscou nada, não oferece o passo a passo", async ({ page }) => {
    const a = await responder(page, "olá");
    await expect(a.botaoPassos()).toHaveCount(0);
  });
});

test.describe("a nota", () => {
  test("'Resposta útil' manda nota 1 com o mensagemId e confirma na tela", async ({ page }) => {
    const a = new PaginaAssistente(page);
    const feedbacks = a.gravarFeedbacks();
    await a.abrir();
    await a.perguntar(PERGUNTA);
    await a.esperarResposta();
    const g = a.avaliacao();
    await expect(g.getByRole("button", { name: "Resposta útil" })).toHaveAttribute("aria-pressed", "false");
    await g.getByRole("button", { name: "Resposta útil" }).click();
    await expect(g.getByText("Nota registrada.")).toBeVisible();
    await expect(g.getByRole("button", { name: "Resposta útil" })).toHaveAttribute("aria-pressed", "true");
    expect(feedbacks).toEqual([{ mensagemId: expect.stringMatching(/^m-\d+$/), nota: 1 }]);
  });

  test("'Não ajudou' manda nota -1 e abre o comentário opcional, que vai junto com a nota", async ({ page }) => {
    const a = new PaginaAssistente(page);
    const feedbacks = a.gravarFeedbacks();
    await a.abrir();
    await a.perguntar(PERGUNTA);
    await a.esperarResposta();
    const g = a.avaliacao();
    await expect(g.getByLabel("Comentário (opcional)")).toHaveCount(0);
    await g.getByRole("button", { name: "Não ajudou" }).click();
    await expect(g.getByText("Nota registrada.")).toBeVisible();
    await g.getByLabel("Comentário (opcional)").fill("faltou o valor de 2024");
    await g.getByRole("button", { name: "Enviar comentário" }).click();
    await expect(g.getByText("Comentário registrado.")).toBeVisible();
    expect(feedbacks.map((f) => [f["nota"], f["comentario"]])).toEqual([
      [-1, undefined],
      [-1, "faltou o valor de 2024"],
    ]);
    expect(feedbacks[0]?.["mensagemId"]).toBe(feedbacks[1]?.["mensagemId"]);
  });

  test("se o registro falha, a tela avisa e a nota não fica marcada", async ({ page }) => {
    await page.route("**/api/feedback", (route) => route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ codigo: "falha_interna", mensagem: "x" }) }));
    const a = await responder(page);
    const g = a.avaliacao();
    await g.getByRole("button", { name: "Resposta útil" }).click();
    await expect(g.getByRole("alert")).toBeVisible();
    await expect(g.getByRole("button", { name: "Resposta útil" })).toHaveAttribute("aria-pressed", "false");
    await expect(g.getByText("Nota registrada.")).toHaveCount(0);
  });
});

test.describe("as opções de busca", () => {
  test("começam em Completa e Automático, e o pedido sai sem modo nem perfil", async ({ page }) => {
    const a = new PaginaAssistente(page);
    const pedidos = a.gravarPedidos();
    await a.abrir();
    await expect(a.perfil("Completa")).toHaveAttribute("aria-pressed", "true");
    await expect(a.perfil("Rápida")).toHaveAttribute("aria-pressed", "false");
    await expect(a.modo("Automático")).toHaveAttribute("aria-pressed", "true");
    await expect(page.getByRole("group", { name: "Como buscar" }).getByRole("button")).toHaveCount(6);
    await a.perguntar(PERGUNTA);
    await a.esperarResposta();
    expect(pedidos[0]).not.toHaveProperty("mode");
    expect(pedidos[0]).not.toHaveProperty("profile");
  });

  test("Rápida e Tabelas vão no pedido, e só um botão de cada grupo fica marcado", async ({ page }) => {
    const a = new PaginaAssistente(page);
    const pedidos = a.gravarPedidos();
    await a.abrir();
    await a.perfil("Rápida").click();
    await a.modo("Tabelas").click();
    await expect(a.perfil("Rápida")).toHaveAttribute("aria-pressed", "true");
    await expect(a.perfil("Completa")).toHaveAttribute("aria-pressed", "false");
    await expect(a.modo("Tabelas")).toHaveAttribute("aria-pressed", "true");
    await expect(a.modo("Automático")).toHaveAttribute("aria-pressed", "false");
    await a.perguntar("modo teste");
    await a.esperarResposta();
    expect(pedidos[0]).toMatchObject({ mode: "tabelas", profile: "consultar-rapido" });
  });

  test("é a mesma escolha da tela Configurações e sobrevive ao recarregamento", async ({ page }) => {
    const a = new PaginaAssistente(page);
    await a.abrir();
    await a.perfil("Rápida").click();
    await a.modo("Visão geral").click();
    await page.goto("/configuracoes");
    await expect(page.getByRole("radio", { name: "Rápido", exact: true })).toBeChecked();
    await expect(page.getByRole("radio", { name: "Panorama (busca global)", exact: true })).toBeChecked();
    await page.getByRole("radio", { name: "Só trechos", exact: true }).check();
    await a.abrir();
    await expect(a.modo("Textos")).toHaveAttribute("aria-pressed", "true");
    await expect(a.perfil("Rápida")).toHaveAttribute("aria-pressed", "true");
    await page.reload();
    await expect(a.modo("Textos")).toHaveAttribute("aria-pressed", "true");
  });
});

test.describe("conversas recentes", () => {
  test("começa vazia; a conversa entra com o título da primeira pergunta; 'Nova conversa' limpa a tela e guarda a anterior", async ({ page }) => {
    const a = new PaginaAssistente(page);
    await a.abrir();
    await expect(a.recentes.getByText("Suas conversas aparecem aqui.")).toBeVisible();
    await a.perguntar(PERGUNTA);
    await a.esperarResposta();
    await expect(a.recente(PERGUNTA)).toBeVisible();
    await expect(a.recente(PERGUNTA)).toHaveAttribute("aria-current", "true");
    await a.novaConversa.click();
    await expect(a.perguntas).toHaveCount(0);
    await expect(a.recente(PERGUNTA)).toBeVisible();
    await expect(a.recente(PERGUNTA)).not.toHaveAttribute("aria-current", "true");
  });

  test("clicar numa conversa recente a devolve inteira: perguntas, respostas, selo e fontes", async ({ page }) => {
    const a = new PaginaAssistente(page);
    await a.abrir();
    await a.perguntar("mostre as fontes");
    await a.esperarResposta();
    await a.novaConversa.click();
    await a.perguntar("pergunta ausente");
    await a.esperarResposta();
    await a.recente("mostre as fontes").click();
    await expect(a.perguntas).toHaveCount(1);
    await expect(a.perguntas.first()).toHaveText("mostre as fontes");
    await expect(a.respostas.first().getByText("Encontrado no documento", { exact: true })).toBeVisible();
    await expect(a.fontes().getByRole("button")).toHaveCount(2);
    await a.cartao(/p\. 9-10/).click();
    await expect(posicao(page)).toHaveText(`Página 9 de ${TOTAL}`);
  });

  test("sobrevive ao recarregamento e a conversa restaurada continua com o mesmo conversationId", async ({ page }) => {
    const a = new PaginaAssistente(page);
    const pedidos = a.gravarPedidos();
    await a.abrir();
    await a.perguntar(PERGUNTA);
    await a.esperarResposta();
    await page.reload();
    await a.recente(PERGUNTA).click();
    await expect(a.respostas.first()).toContainText("O lucro foi R$ 20 bi");
    await a.perguntar("e a segunda pergunta?");
    await a.esperarResposta();
    expect(pedidos).toHaveLength(2);
    expect(pedidos[1]?.["conversationId"]).toBe(pedidos[0]?.["conversationId"]);
    await expect(a.perguntas).toHaveCount(2);
  });

  test("apagar tira da lista; apagar a que está aberta volta à tela inicial", async ({ page }) => {
    const a = new PaginaAssistente(page);
    await a.abrir();
    await a.perguntar("pergunta ausente");
    await a.esperarResposta();
    await a.novaConversa.click();
    await a.perguntar(PERGUNTA);
    await a.esperarResposta();
    await a.apagar("pergunta ausente").click();
    await expect(a.recente("pergunta ausente")).toHaveCount(0);
    await expect(a.recente(PERGUNTA)).toBeVisible();
    await a.apagar(PERGUNTA).click();
    await expect(a.recente(PERGUNTA)).toHaveCount(0);
    await expect(a.perguntas).toHaveCount(0);
    await expect(page.getByRole("group", { name: "Perguntas para começar" })).toBeVisible();
    await page.reload();
    await expect(a.recentes.getByText("Suas conversas aparecem aqui.")).toBeVisible();
  });

  test("um título comprido é cortado na lista, mas a pergunta inteira fica na conversa", async ({ page }) => {
    const longa = "Qual foi a evolução do lucro líquido ajustado, ano a ano, desde 2021 até 2025, segundo o formulário?";
    const a = await responder(page, longa);
    await expect(a.perguntas.first()).toHaveText(longa);
    const botao = a.recentes.getByRole("button").first();
    expect((await botao.innerText()).length).toBeLessThan(longa.length);
  });

  test("com o localStorage bloqueado a tela funciona; só não guarda as conversas", async ({ page }) => {
    await page.addInitScript(() => {
      Object.defineProperty(window, "localStorage", {
        get() {
          throw new DOMException("bloqueado", "SecurityError");
        },
      });
    });
    const a = await responder(page);
    await expect(a.respostas.first()).toContainText("O lucro foi R$ 20 bi");
    await a.perfil("Rápida").click();
    await expect(a.perfil("Rápida")).toHaveAttribute("aria-pressed", "true");
  });
});

test.describe("estado do sistema e tema", () => {
  test("com tudo no ar diz 'Tudo funcionando'", async ({ page }) => {
    const a = new PaginaAssistente(page);
    await a.abrir();
    await expect(a.menu.getByText("Tudo funcionando")).toBeVisible();
  });

  test("com uma parte fora diz 'Funcionando com limitações' e, sem a API, 'Sem conexão com o sistema'", async ({ page }) => {
    await page.route("**/api/saude", (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          status: "degradado",
          servico: "graphrag-api",
          versao: "0.1.0",
          llm: { estado: "ok", ms: 16 },
          modelos: [],
          neo4j: { estado: "indisponivel", ms: 2000 },
          indices: [],
        }),
      }),
    );
    const a = new PaginaAssistente(page);
    await a.abrir();
    await expect(a.menu.getByText("Funcionando com limitações")).toBeVisible();
    await page.unroute("**/api/saude");
    await page.route("**/api/saude", (route) => route.abort());
    await page.reload();
    await expect(a.menu.getByText("Sem conexão com o sistema")).toBeVisible();
    // o estado não bloqueia o uso: a caixa continua ativa
    await expect(a.caixa).toBeEnabled();
  });

  test("o botão de tema alterna e muda de verdade as cores da tela", async ({ page }) => {
    const a = new PaginaAssistente(page);
    await a.abrir();
    const botao = a.menu.getByRole("button", { name: /^Tema:/ });
    await expect(botao).toHaveText("Tema: sistema");
    await botao.click();
    await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
    const claro = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
    await botao.click();
    await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
    const escuro = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
    expect(escuro).not.toBe(claro);
    await page.reload();
    await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  });
});

test.describe("o modo técnico", () => {
  test("o link leva ao /chat, com o Rastro, e a conversa em andamento vai junto", async ({ page }) => {
    const a = await responder(page, "mostre o rastro");
    await a.menu.getByRole("link", { name: "Modo técnico" }).click();
    await expect(page).toHaveURL(/\/chat\/rastro$/);
    await expect(page).toHaveTitle("Chat · GraphRAG local");
    await expect(page.getByRole("navigation", { name: "Principal" })).toBeVisible();
    await expect(page.getByRole("heading", { level: 1, name: "Conversa" })).toBeVisible();
    await expect(page.locator('[data-papel="usuario"]')).toHaveText("mostre o rastro");
    await expect(page.locator('[data-papel="assistente"]')).toContainText("O lucro foi R$ 20 bi");
  });

  test("no cabeçalho técnico há o caminho de volta, 'Assistente', marcado quando se está nele", async ({ page }) => {
    await page.goto("/chat");
    const nav = page.getByRole("navigation", { name: "Principal" });
    await nav.getByRole("link", { name: "Assistente" }).click();
    await expect(page).toHaveURL(/\/assistente$/);
    await expect(page.getByRole("heading", { level: 1, name: "Pergunte ao Formulário" })).toBeVisible();
    await page.goto("/configuracoes");
    await expect(page.getByRole("navigation", { name: "Principal" }).getByRole("link", { name: "Assistente" })).toBeVisible();
  });
});

test.describe("celular", () => {
  for (const largura of [390, 320]) {
    test(`em ${largura} px não há rolagem horizontal, nem com resposta, fontes e passos abertos`, async ({ page }) => {
      await page.setViewportSize({ width: largura, height: 812 });
      const a = new PaginaAssistente(page);
      await a.abrir();
      const estoura = () => page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
      expect(await estoura()).toBe(false);
      await a.perguntar("mostre o rastro com uma pergunta bem comprida ".repeat(4));
      await a.esperarResposta();
      await a.botaoPassos().click();
      expect(await estoura()).toBe(false);
      await a.perguntar("mostre as fontes");
      await a.esperarResposta();
      expect(await estoura()).toBe(false);
      await cabeNaTela(page, a.caixa, a.enviar, a.respostas.last(), a.cartao(/p\. 6/, 1));
    });
  }

  test("a barra lateral vira um menu: 'Abrir menu' mostra a Nova conversa e as recentes, e escolher uma fecha o menu", async ({ page }) => {
    const a = await responder(page);
    await page.setViewportSize({ width: 390, height: 812 });
    await expect(a.menu).toBeHidden();
    await page.getByRole("button", { name: "Abrir menu" }).click();
    await expect(a.menu).toBeVisible();
    await expect(a.menu.getByRole("link", { name: "Modo técnico" })).toBeVisible();
    await expect(a.recente(PERGUNTA)).toBeVisible();
    await page.getByRole("button", { name: "Fechar menu" }).click();
    await expect(a.menu).toBeHidden();
    await page.getByRole("button", { name: "Abrir menu" }).click();
    await a.recente(PERGUNTA).click();
    await expect(a.menu).toBeHidden();
  });

  test("no desktop não existe o botão de menu", async ({ page }) => {
    const a = new PaginaAssistente(page);
    await a.abrir();
    await expect(page.getByRole("button", { name: "Abrir menu" })).toBeHidden();
  });

  test("a fonte abre numa folha que cobre a largura da tela e 'Fechar fonte' a fecha", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 812 });
    const a = await responder(page);
    await a.cartao(/p\. 6/).click();
    await expect(a.painel).toBeVisible();
    await expect(a.painel).toBeInViewport({ ratio: 0.9 });
    const caixa = await a.painel.boundingBox();
    expect(caixa?.width ?? 0).toBeGreaterThan(380);
    await expect(posicao(page)).toHaveText(`Página 6 de ${TOTAL}`);
    await a.painel.getByRole("button", { name: "Fechar fonte" }).click();
    await expect(a.painel).toHaveCount(0);
  });
});
