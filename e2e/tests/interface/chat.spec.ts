/**
 * E2E do chat (F8.2): o usuário pergunta e a resposta chega em SSE, pelo `ng serve` com o proxy `/api` de verdade, de uma API
 * falsa que fala o contrato. O que se prova é a jornada, não a implementação: o que aparece, o que o teclado faz, o que o
 * usuário lê quando algo dá errado e o que NUNCA pode aparecer (HTML vindo do modelo).
 */
import { expect, test } from "@playwright/test";
import { PaginaChat } from "../../paginas/chat.ts";

test.describe("antes da primeira pergunta", () => {
  test("explica o que perguntar e o botão Enviar começa desligado", async ({ page }) => {
    const chat = new PaginaChat(page);
    await chat.abrir();
    await expect(page.getByText(/Formulário de Referência 2026/)).toBeVisible();
    await expect(chat.enviar).toBeDisabled();
    await expect(chat.parar).toHaveCount(0);
    await expect(chat.novaConversa).toBeDisabled();
  });

  test("um único h1, caixa com rótulo, lista como log e status separado", async ({ page }) => {
    const chat = new PaginaChat(page);
    await chat.abrir();
    await expect(page.getByRole("heading", { level: 1 })).toHaveCount(1);
    await expect(page.getByRole("log", { name: "Mensagens da conversa" })).toBeVisible();
    await expect(chat.estado).toBeAttached();
  });
});

test.describe("enviar", () => {
  test("Enter envia: a pergunta aparece, a caixa esvazia e mantém o foco", async ({ page }) => {
    const chat = new PaginaChat(page);
    await chat.abrir();
    await chat.perguntar("Qual o lucro de 2025?");
    await expect(chat.perguntas).toHaveText(["Qual o lucro de 2025?"]);
    await expect(chat.caixa).toHaveValue("");
    await expect(chat.caixa).toBeFocused();
    await chat.esperarResposta();
    await expect(chat.respostas.first()).toContainText("O lucro foi R$ 20 bi");
  });

  test("Shift+Enter quebra a linha e não envia", async ({ page }) => {
    const chat = new PaginaChat(page);
    const pedidos = chat.gravarPedidos();
    await chat.abrir();
    await chat.caixa.fill("linha 1");
    await chat.caixa.press("Shift+Enter");
    await chat.caixa.pressSequentially("linha 2");
    await expect(chat.caixa).toHaveValue("linha 1\nlinha 2");
    await expect(chat.perguntas).toHaveCount(0);
    expect(pedidos).toHaveLength(0);
  });

  test("caixa vazia ou só com espaço não envia nem cria bolha", async ({ page }) => {
    const chat = new PaginaChat(page);
    const pedidos = chat.gravarPedidos();
    await chat.abrir();
    await chat.caixa.press("Enter");
    await chat.caixa.fill("   \n  ");
    await chat.caixa.press("Enter");
    await expect(chat.enviar).toBeDisabled();
    await expect(chat.perguntas).toHaveCount(0);
    expect(pedidos).toHaveLength(0);
  });

  test("o botão Enviar também envia; durante a geração fica desligado e Enter não manda outra", async ({ page }) => {
    const chat = new PaginaChat(page);
    const pedidos = chat.gravarPedidos();
    await chat.abrir();
    await chat.caixa.fill("pergunta lenta");
    await chat.enviar.click();
    await expect(chat.parar).toBeVisible();
    await chat.caixa.fill("segunda pergunta");
    await expect(chat.enviar).toBeDisabled();
    await chat.caixa.press("Enter");
    await chat.esperarResposta();
    expect(pedidos).toHaveLength(1);
    await expect(chat.perguntas).toHaveCount(1);
  });

  test("a caixa limita a 4.000 caracteres e o contador só aparece perto do limite", async ({ page }) => {
    const chat = new PaginaChat(page);
    await chat.abrir();
    await expect(chat.caixa).toHaveAttribute("maxlength", "4000");
    await expect(page.locator(".contador")).toHaveCount(0);
    await chat.caixa.fill("x".repeat(3600));
    await expect(page.locator(".contador")).toHaveText("3.600 / 4.000");
  });
});

test.describe("a resposta chega aos poucos", () => {
  test("pelo proxy do ng serve os tokens aparecem em pedaços, não de uma vez no fim", async ({ page }) => {
    const chat = new PaginaChat(page);
    await chat.abrir();
    // anota cada texto distinto que a bolha da resposta mostrou até o status virar "Resposta pronta."
    await page.evaluate(() => {
      const w = window as unknown as { __vistos: string[] };
      w.__vistos = [];
      new MutationObserver(() => {
        const t = document.querySelector('[data-papel="assistente"] app-resposta-markdown')?.textContent?.trim() ?? "";
        if (t !== "" && w.__vistos.at(-1) !== t) w.__vistos.push(t);
      }).observe(document.body, { childList: true, subtree: true, characterData: true });
    });
    await chat.perguntar("pergunta lenta");
    await chat.esperarResposta();
    const vistos = await page.evaluate(() => (window as unknown as { __vistos: string[] }).__vistos);
    expect(vistos.length, `textos vistos: ${JSON.stringify(vistos)}`).toBeGreaterThanOrEqual(4);
    expect(vistos[0]).not.toBe(vistos.at(-1));
    expect(vistos.at(-1)).toBe("O lucro líquido foi de R$ 20 bilhões p. 6.");
  });

  test("o status avisa 'Gerando a resposta…' e depois 'Resposta pronta.', sem ler os tokens", async ({ page }) => {
    const chat = new PaginaChat(page);
    await chat.abrir();
    await chat.perguntar("pergunta lenta");
    await expect(chat.estado).toHaveText("Gerando a resposta…");
    await expect(chat.estado).not.toContainText("lucro");
    await chat.esperarResposta();
  });

  test("durante o streaming o [E1] é a marca 'fonte' e no fim vira o chip da página, que abre a aba Fontes", async ({ page }) => {
    const chat = new PaginaChat(page);
    await chat.abrir();
    await chat.perguntar("pergunta lenta");
    await expect(chat.respostas.first().locator("span.citacao")).toHaveText("fonte");
    await chat.esperarResposta();
    await expect(chat.respostas.first().locator("span.citacao")).toHaveCount(0);
    const chip = chat.respostas.first().getByRole("button", { name: "Abrir a página 6 do documento" });
    await expect(chip).toHaveText("p. 6");
    await chip.click();
    await expect(page).toHaveURL(/\/chat\/fontes\?pagina=6&fonte=p1$/);
  });

  test("markdown: tabela, lista, cabeçalho sem h1..h6, chips por tipo e código sem chip", async ({ page }) => {
    const chat = new PaginaChat(page);
    await chat.abrir();
    await chat.perguntar("quero a tabela");
    await chat.esperarResposta();
    const r = chat.respostas.first();
    await expect(r.getByRole("table")).toBeVisible();
    await expect(r.getByRole("row")).toHaveCount(3);
    await expect(r.getByRole("listitem")).toHaveCount(2);
    await expect(page.getByRole("heading", { level: 1 })).toHaveCount(1); // o "# Resultado" da resposta não vira h1
    await expect(r.locator("strong", { hasText: "Resultado" })).toBeVisible();
    await expect(r.getByRole("button", { name: /Abrir a página/ })).toHaveText(["p. 6", "p. 9", "p. 10-12, 40"]);
    await expect(r.getByRole("button", { name: "Abrir a página 10 do documento" })).toBeVisible();
    await expect(r.locator("span.citacao")).toHaveText(["sem página"]);
    await expect(r.locator("code")).toHaveText("[p. 7]");
  });
});

test.describe("HTML vindo do modelo ou do usuário nunca vira elemento", () => {
  test("resposta com img onerror, script e link javascript:", async ({ page }) => {
    const chat = new PaginaChat(page);
    const pedidosDeRede: string[] = [];
    page.on("request", (r) => pedidosDeRede.push(r.url()));
    await chat.abrir();
    await chat.perguntar("teste xss");
    await chat.esperarResposta();
    const r = chat.respostas.first();
    await expect(r.locator("img, script, iframe, a, svg")).toHaveCount(0);
    await expect(r.locator("strong", { hasText: "seguro" })).toBeVisible();
    expect(await page.evaluate(() => (window as unknown as Record<string, unknown>)["__xss"])).toBeUndefined();
    expect(pedidosDeRede.some((u) => u.endsWith("/x"))).toBe(false); // o <img src=x> nem foi pedido
  });

  test("a pergunta do usuário é texto puro", async ({ page }) => {
    const chat = new PaginaChat(page);
    await chat.abrir();
    await chat.perguntar("<b>negrito</b><img src=x onerror=window.__xss=1>");
    await expect(chat.perguntas.first()).toContainText("<b>negrito</b>");
    await expect(chat.perguntas.first().locator("b, img")).toHaveCount(0);
    expect(await page.evaluate(() => (window as unknown as Record<string, unknown>)["__xss"])).toBeUndefined();
  });
});

test.describe("quando algo dá errado", () => {
  test("HTTP 429: mensagem da API num alerta e 'Tentar de novo' refaz a pergunta sem duplicar a bolha", async ({ page }) => {
    const chat = new PaginaChat(page);
    const pedidos = chat.gravarPedidos();
    await chat.abrir();
    await chat.perguntar("pergunta de limite");
    await expect(chat.alerta).toContainText("Há perguntas demais em andamento. Tente de novo em instantes.");
    await expect(page.locator("body")).not.toContainText(/undefined|\[object|stack/);
    await chat.tentarDeNovo.click();
    await expect(chat.alerta).toBeVisible();
    expect(pedidos).toHaveLength(2);
    expect(pedidos[1]?.["message"]).toBe("pergunta de limite");
    await expect(chat.perguntas).toHaveCount(1);
  });

  test("502 com uma página HTML do proxy: mensagem nossa, sem o HTML nem o alert(1)", async ({ page }) => {
    const chat = new PaginaChat(page);
    let dialogo = false;
    page.on("dialog", (d) => {
      dialogo = true;
      void d.dismiss();
    });
    await chat.abrir();
    await chat.perguntar("pergunta html502");
    await expect(chat.alerta).toContainText("A API do chat não respondeu como esperado");
    await expect(page.locator("body")).not.toContainText("Bad Gateway");
    expect(dialogo).toBe(false);
  });

  test("evento de erro no meio mantém o texto parcial e mostra a mensagem", async ({ page }) => {
    const chat = new PaginaChat(page);
    await chat.abrir();
    await chat.perguntar("pergunta com erro");
    await expect(chat.alerta).toContainText("O modelo de linguagem demorou demais");
    await expect(chat.respostas.first()).toContainText("Começo da resposta");
  });

  test("conexão que cai no meio: avisa que foi interrompida e mantém o parcial", async ({ page }) => {
    const chat = new PaginaChat(page);
    await chat.abrir();
    await chat.perguntar("a conexão cai");
    await expect(chat.alerta).toContainText("interrompida");
    await expect(chat.respostas.first()).toContainText("Metade da resposta");
    await expect(chat.enviar).toBeDisabled(); // caixa vazia, mas livre
    await chat.caixa.fill("outra");
    await expect(chat.enviar).toBeEnabled();
  });

  test("Parar: só existe durante a geração, mantém o parcial e libera a próxima pergunta", async ({ page }) => {
    const chat = new PaginaChat(page);
    await chat.abrir();
    await expect(chat.parar).toHaveCount(0);
    await chat.perguntar("a resposta trava");
    await expect(chat.respostas.first()).toContainText("Resposta parcial");
    await chat.parar.click();
    await expect(chat.parar).toHaveCount(0);
    await expect(chat.respostas.first()).toContainText("Resposta parcial");
    await expect(chat.respostas.first()).toContainText("Resposta interrompida.");
    await expect(chat.alerta).toHaveCount(0);
    await expect(chat.estado).toHaveText("Resposta interrompida.");
    await chat.perguntar("próxima pergunta");
    await chat.esperarResposta();
  });
});

test.describe("a conversa", () => {
  test("a 2ª pergunta leva a 1ª e a resposta no histórico; nova conversa troca o id e limpa a lista", async ({ page }) => {
    const chat = new PaginaChat(page);
    const pedidos = chat.gravarPedidos();
    await chat.abrir();
    await chat.perguntar("primeira");
    await chat.esperarResposta();
    await chat.perguntar("segunda");
    await expect(chat.perguntas).toHaveCount(2);
    await expect.poll(() => pedidos.length).toBe(2);
    expect(pedidos[0]).not.toHaveProperty("historico");
    expect(pedidos[1]?.["historico"]).toEqual([
      { papel: "usuario", texto: "primeira" },
      { papel: "assistente", texto: "O lucro foi R$ 20 bi [p. 6]." },
    ]);
    expect(pedidos[1]?.["conversationId"]).toBe(pedidos[0]?.["conversationId"]);
    await chat.novaConversa.click();
    await expect(chat.perguntas).toHaveCount(0);
    await expect(chat.respostas).toHaveCount(0);
    await chat.perguntar("terceira");
    await expect.poll(() => pedidos.length).toBe(3);
    expect(pedidos[2]?.["conversationId"]).not.toBe(pedidos[0]?.["conversationId"]);
    expect(pedidos[2]).not.toHaveProperty("historico");
  });

  test("uma resposta com falha fica de fora do histórico da pergunta seguinte", async ({ page }) => {
    const chat = new PaginaChat(page);
    const pedidos = chat.gravarPedidos();
    await chat.abrir();
    await chat.perguntar("pergunta de limite");
    await expect(chat.alerta).toBeVisible();
    await chat.perguntar("tudo certo agora");
    await chat.esperarResposta();
    expect(pedidos[1]).not.toHaveProperty("historico");
  });
});
