/**
 * E2E do selo de saúde (F8.7), escritos antes do código: um selo no topo de todas as páginas diz se o sistema está no ar,
 * degradado ou fora do ar, a partir de `GET /api/saude`; o painel mostra o estado de cada parte. A API falsa responde "tudo no ar";
 * as falhas se simulam com `page.route`.
 */
import { expect, test, type Page, type Route } from "@playwright/test";
import { PaginaChat } from "../../paginas/chat.ts";

const SAUDE_BASE = {
  status: "ok",
  servico: "graphrag-api",
  versao: "0.1.0",
  llm: { estado: "ok", ms: 16 },
  modelos: [
    { nome: "qwen36-35b-a3b", carregado: true },
    { nome: "qwen3-embed-0.6b", carregado: false },
    { nome: "qwen3-rerank-0.6b", carregado: false },
  ],
  neo4j: { estado: "ok", ms: 120 },
  indices: [
    { nome: "child_ft", estado: "ONLINE" },
    { nome: "entity_vec", estado: "ONLINE" },
    { nome: "fact_id", estado: "ONLINE" },
  ],
};

const selo = (page: Page) => page.getByRole("button", { name: /^Sistema:/ });
const painel = (page: Page) => page.getByRole("group", { name: "Detalhes da saúde do sistema" });
const json = (route: Route, corpo: unknown, status = 200) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(corpo) });
const responderCom = (page: Page, corpo: unknown, status = 200) => page.route("**/api/saude", (route) => json(route, corpo, status));

test.describe("o selo no topo", () => {
  test("aparece em todas as páginas e diz 'no ar' quando tudo responde", async ({ page }) => {
    await page.goto("/chat");
    await expect(selo(page)).toHaveText("Sistema: no ar");
    await page.getByRole("navigation", { name: "Principal" }).getByRole("link", { name: "Configurações" }).click();
    await expect(selo(page)).toHaveText("Sistema: no ar");
    await page.goto("/nao-existe");
    await expect(selo(page)).toHaveText("Sistema: no ar");
    await expect(page.getByRole("banner").getByRole("button", { name: /^Sistema:/ })).toBeVisible();
  });

  test("começa em 'verificando' e vira 'no ar' quando a resposta chega", async ({ page }) => {
    let liberar!: () => void;
    const portao = new Promise<void>((ok) => (liberar = ok));
    await page.route("**/api/saude", async (route) => {
      await portao;
      await json(route, SAUDE_BASE);
    });
    await page.goto("/chat");
    await expect(selo(page)).toHaveText("Sistema: verificando…");
    liberar();
    await expect(selo(page)).toHaveText("Sistema: no ar");
  });

  test("o painel abre e fecha pelo botão, e diz o estado de cada parte", async ({ page }) => {
    await page.goto("/chat");
    await expect(selo(page)).toHaveText("Sistema: no ar");
    await expect(selo(page)).toHaveAttribute("aria-expanded", "false");
    await expect(painel(page)).toBeHidden();
    await selo(page).click();
    await expect(selo(page)).toHaveAttribute("aria-expanded", "true");
    await expect(painel(page)).toBeVisible();
    await expect(painel(page)).toContainText("Modelos de linguagem (llama-swap): no ar · 16 ms");
    await expect(painel(page)).toContainText("Grafo (Neo4j): no ar · 120 ms");
    await expect(painel(page)).toContainText("Índices: 3 de 3 no ar");
    await expect(painel(page)).toContainText("Modelos na memória: 1 de 3");
    await selo(page).click();
    await expect(painel(page)).toBeHidden();
  });

  test("Escape fecha o painel e devolve o foco ao selo", async ({ page }) => {
    await page.goto("/chat");
    await selo(page).click();
    await expect(painel(page)).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(painel(page)).toBeHidden();
    await expect(selo(page)).toBeFocused();
  });

  test("a mudança de estado é anunciada (região viva educada), sem roubar o foco", async ({ page }) => {
    await page.goto("/chat");
    await expect(selo(page)).toHaveText("Sistema: no ar");
    await expect(page.locator('[aria-live="polite"]').filter({ hasText: "Sistema: no ar" })).toHaveCount(1);
  });
});

test.describe("quando algo não está bem", () => {
  test("Neo4j fora: 'degradado', com a parte que falhou e o que fazer", async ({ page }) => {
    await responderCom(page, { ...SAUDE_BASE, status: "degradado", neo4j: { estado: "indisponivel", ms: 2000 }, indices: [] });
    await page.goto("/chat");
    await expect(selo(page)).toHaveText("Sistema: degradado");
    await selo(page).click();
    await expect(painel(page)).toContainText("Grafo (Neo4j): fora do ar");
    await expect(painel(page)).toContainText("Modelos de linguagem (llama-swap): no ar");
    await expect(painel(page)).toContainText("Índices: não foi possível consultar");
    await expect(painel(page)).toContainText("infra\\neo4j.ps1 iniciar");
  });

  test("llama-swap fora: 'degradado' e o aviso do modelo de linguagem", async ({ page }) => {
    await responderCom(page, { ...SAUDE_BASE, status: "degradado", llm: { estado: "indisponivel", ms: 2001 }, modelos: [] });
    await page.goto("/chat");
    await expect(selo(page)).toHaveText("Sistema: degradado");
    await selo(page).click();
    await expect(painel(page)).toContainText("Modelos de linguagem (llama-swap): fora do ar");
    await expect(painel(page)).toContainText("infra\\swap.ps1");
  });

  test("índice que não está ONLINE: 'degradado' e o índice aparece pelo nome", async ({ page }) => {
    await responderCom(page, { ...SAUDE_BASE, indices: [{ nome: "child_ft", estado: "ONLINE" }, { nome: "entity_vec", estado: "POPULATING" }, { nome: "fact_id", estado: "ONLINE" }] });
    await page.goto("/chat");
    await expect(selo(page)).toHaveText("Sistema: degradado");
    await selo(page).click();
    await expect(painel(page)).toContainText("Índices: 2 de 3 no ar");
    await expect(painel(page)).toContainText("entity_vec (POPULATING)");
  });

  test("serviço 'não configurado' conta como degradado e é dito assim", async ({ page }) => {
    await responderCom(page, { ...SAUDE_BASE, status: "degradado", neo4j: { estado: "nao_configurado", ms: 0 }, indices: [] });
    await page.goto("/chat");
    await expect(selo(page)).toHaveText("Sistema: degradado");
    await selo(page).click();
    await expect(painel(page)).toContainText("Grafo (Neo4j): não configurado");
  });

  test("API que não responde (conexão recusada): 'fora do ar' e como subir", async ({ page }) => {
    await page.route("**/api/saude", (route) => route.abort("connectionrefused"));
    await page.goto("/chat");
    await expect(selo(page)).toHaveText("Sistema: fora do ar");
    await selo(page).click();
    await expect(painel(page)).toContainText("A API não respondeu");
    await expect(painel(page)).toContainText("node dist/server.js");
  });

  test("HTML de um proxy (502) e corpo inesperado também são 'fora do ar', sem HTML na tela", async ({ page }) => {
    await page.route("**/api/saude", (route) => route.fulfill({ status: 502, contentType: "text/html", body: "<html><body><h1>Bad Gateway</h1></body></html>" }));
    await page.goto("/chat");
    await expect(selo(page)).toHaveText("Sistema: fora do ar");
    await selo(page).click();
    await expect(page.getByText("Bad Gateway")).toHaveCount(0);
    await page.unroute("**/api/saude");
    await responderCom(page, { estado: "ok" });
    await painel(page).getByRole("button", { name: "Verificar de novo" }).click();
    await expect(selo(page)).toHaveText("Sistema: fora do ar");
    await expect(painel(page)).toContainText("resposta inesperada");
  });

  test("'Verificar de novo' consulta na hora e o selo acompanha a recuperação", async ({ page }) => {
    let chamadas = 0;
    await page.route("**/api/saude", (route) => {
      chamadas++;
      return chamadas === 1 ? route.abort("connectionrefused") : json(route, SAUDE_BASE);
    });
    await page.goto("/chat");
    await expect(selo(page)).toHaveText("Sistema: fora do ar");
    await selo(page).click();
    await painel(page).getByRole("button", { name: "Verificar de novo" }).click();
    await expect(selo(page)).toHaveText("Sistema: no ar");
    expect(chamadas).toBe(2);
  });

  test("o selo não impede de perguntar: avisa, mas o chat continua funcionando", async ({ page }) => {
    await page.route("**/api/saude", (route) => route.abort("connectionrefused"));
    const chat = new PaginaChat(page);
    await chat.abrir();
    await expect(selo(page)).toHaveText("Sistema: fora do ar");
    await chat.perguntar("Qual o lucro de 2025?");
    await chat.esperarResposta();
    await expect(chat.respostas.first()).toContainText("O lucro foi R$ 20 bi");
  });
});

test.describe("a consulta", () => {
  test("repete a cada 30 s sem recarregar a página", async ({ page }) => {
    await page.clock.install();
    let chamadas = 0;
    await page.route("**/api/saude", (route) => {
      chamadas++;
      return json(route, chamadas >= 2 ? { ...SAUDE_BASE, status: "degradado", neo4j: { estado: "indisponivel", ms: 2000 }, indices: [] } : SAUDE_BASE);
    });
    await page.goto("/chat");
    await expect(selo(page)).toHaveText("Sistema: no ar");
    await page.clock.fastForward(31_000);
    await expect(selo(page)).toHaveText("Sistema: degradado");
    expect(chamadas).toBe(2);
  });

  test("uma consulta presa não trava as seguintes: depois do tempo máximo a de 30 s acontece", async ({ page }) => {
    await page.clock.install();
    let chamadas = 0;
    await page.route("**/api/saude", () => {
      chamadas++; // nunca responde
    });
    await page.goto("/chat");
    await expect(selo(page)).toHaveText("Sistema: verificando…");
    await page.clock.fastForward(5_000);
    await page.clock.fastForward(5_000);
    await page.clock.fastForward(21_000);
    await expect(selo(page)).toHaveText("Sistema: fora do ar");
    await expect.poll(() => chamadas).toBe(2);
  });

  test("'Verificar de novo' clicado várias vezes seguidas dá uma consulta só enquanto a primeira não volta", async ({ page }) => {
    let chamadas = 0;
    let liberar!: () => void;
    const portao = new Promise<void>((ok) => (liberar = ok));
    await page.route("**/api/saude", async (route) => {
      chamadas++;
      if (chamadas > 1) await portao;
      await json(route, SAUDE_BASE);
    });
    await page.goto("/chat");
    await expect(selo(page)).toHaveText("Sistema: no ar");
    await selo(page).click();
    const botao = painel(page).getByRole("button", { name: "Verificar de novo" });
    await botao.dblclick();
    await botao.click();
    liberar();
    await expect.poll(() => chamadas).toBe(2);
  });

  test("o tempo máximo de espera existe: sem resposta em 10 s vira 'fora do ar'", async ({ page }) => {
    await page.clock.install();
    await page.route("**/api/saude", () => {
      /* nunca responde */
    });
    await page.goto("/chat");
    await expect(selo(page)).toHaveText("Sistema: verificando…");
    await page.clock.fastForward(11_000);
    await expect(selo(page)).toHaveText("Sistema: fora do ar");
  });
});

test.describe("segurança e celular", () => {
  test("nome de modelo e de índice em HTML aparecem como texto e nada é executado", async ({ page }) => {
    await responderCom(page, { ...SAUDE_BASE, modelos: [{ nome: '<img src=x onerror="window.__xss=1">', carregado: false }], indices: [{ nome: "<script>window.__xss=1</script>", estado: "FAILED" }] });
    await page.goto("/chat");
    await selo(page).click();
    await expect(painel(page)).toContainText("<script>window.__xss=1</script> (FAILED)");
    expect(await page.evaluate(() => (window as unknown as Record<string, unknown>)["__xss"])).toBeUndefined();
    await expect(painel(page).locator("img, script")).toHaveCount(0);
  });

  for (const largura of [375, 320]) {
    test(`a ${largura} px, com o painel aberto e degradado, não há rolagem horizontal`, async ({ page }) => {
      await page.setViewportSize({ width: largura, height: 812 });
      await responderCom(page, { ...SAUDE_BASE, status: "degradado", indices: [{ nome: "um_indice_com_um_nome_bem_comprido_para_forcar_quebra_de_linha_na_tela", estado: "POPULATING" }] });
      await page.goto("/chat");
      await selo(page).click();
      await expect(painel(page)).toBeVisible();
      const { rolagem, largura: cliente } = await page.evaluate(() => ({ rolagem: document.documentElement.scrollWidth, largura: document.documentElement.clientWidth }));
      expect(rolagem).toBeLessThanOrEqual(cliente);
    });
  }
});
