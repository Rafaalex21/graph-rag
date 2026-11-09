/**
 * E2E do explorador do subgrafo (F8.5), escritos antes do código. A API falsa tem um grafo de 7 entidades (`ENTIDADES` em
 * `api-falsa/servidor.ts`) e um roteiro "quem é" que devolve evidências com id de entidade (Banco do Brasil e Marco).
 *   bb: vizinhos uniao, marco, bbseg · uniao: bb, tesouro, bndes · marco: bb · bbseg: bb · ent:grande: 99 vizinhos (truncado)
 */
import { expect, test, type Page } from "@playwright/test";
import { PaginaChat } from "../../paginas/chat.ts";

const PERGUNTA = "Quem é o Banco do Brasil e o diretor de relações com investidores?";

const grupo = (page: Page) => page.getByRole("group", { name: "Subgrafo da resposta" });
const nos = (page: Page) => grupo(page).getByRole("button");
const no = (page: Page, nome: string | RegExp) => grupo(page).getByRole("button", { name: nome });
const resumo = (page: Page) => page.getByRole("status").filter({ hasText: /^\d+ entidades? e \d+ ligaç(ão|ões)/ });
const arestas = (page: Page) => grupo(page).locator("[data-aresta]");
const aviso = (page: Page) => page.locator("[data-aviso]");
const aba = (page: Page) => page.getByRole("navigation", { name: "Painel" }).getByRole("link", { name: "Grafo" });

async function pedidosDeGrafo(page: Page): Promise<URL[]> {
  const lista: URL[] = [];
  page.on("request", (r) => {
    const u = new URL(r.url());
    if (u.pathname === "/api/grafo/vizinhanca") lista.push(u);
  });
  return lista;
}

async function perguntar(page: Page, texto = PERGUNTA): Promise<PaginaChat> {
  const chat = new PaginaChat(page);
  await chat.abrir();
  await chat.perguntar(texto);
  await chat.esperarResposta();
  return chat;
}

async function explorar(page: Page, entidade: string): Promise<void> {
  await page.getByRole("textbox", { name: "Explorar uma entidade" }).fill(entidade);
  await page.getByRole("button", { name: "Explorar" }).click();
}

test.describe("subgrafo da resposta", () => {
  test("sem resposta com entidades a aba explica e oferece explorar pelo nome, sem consultar a API", async ({ page }) => {
    const pedidos = await pedidosDeGrafo(page);
    await page.goto("/chat/grafo");
    await expect(page.getByRole("heading", { level: 2, name: "Grafo" })).toBeVisible();
    await expect(page.getByText(/Faça uma pergunta como .Quem é…. ou explore uma entidade pelo nome/)).toBeVisible();
    await expect(grupo(page)).toHaveCount(0);
    expect(pedidos).toHaveLength(0);
  });

  test("uma resposta sem entidades (só trechos) deixa a aba no convite", async ({ page }) => {
    const chat = await perguntar(page, "qual o lucro?");
    await aba(page).click();
    await expect(page.getByText(/Nenhuma entidade nesta resposta/)).toBeVisible();
    await expect(grupo(page)).toHaveCount(0);
    await expect(chat.alerta).toHaveCount(0);
  });

  test("a resposta 'quem é' vira o subgrafo: entidades-semente, vizinhos e ligações, uma consulta por semente", async ({ page }) => {
    const pedidos = await pedidosDeGrafo(page);
    await perguntar(page);
    await aba(page).click();
    await expect(resumo(page)).toHaveText("4 entidades e 3 ligações");
    await expect(nos(page)).toHaveCount(4);
    await expect(arestas(page)).toHaveCount(3);
    for (const nome of ["Banco do Brasil", "União Federal", "Marco Geovanne Tobias da Silva", "BB Seguridade"]) await expect(no(page, new RegExp(nome))).toBeVisible();
    await expect(grupo(page).locator("[data-semente]")).toHaveCount(2); // bb e marco vieram da resposta
    expect(pedidos.map((u) => u.searchParams.get("entidade")).sort()).toEqual(["ent:org:bb", "ent:pessoa:marco"]);
    expect(pedidos.every((u) => u.searchParams.get("profundidade") === "1")).toBe(true);
  });

  test("com a aba já aberta, o subgrafo aparece quando a resposta termina", async ({ page }) => {
    const chat = new PaginaChat(page);
    await chat.abrir();
    await aba(page).click();
    await chat.perguntar(PERGUNTA);
    await chat.esperarResposta();
    await expect(resumo(page)).toHaveText("4 entidades e 3 ligações");
  });

  test("renderiza em menos de 1 s depois de abrir a aba (a API falsa responde na hora)", async ({ page }) => {
    await perguntar(page);
    const t0 = Date.now();
    await aba(page).click();
    await expect(resumo(page)).toBeVisible();
    await expect(nos(page)).toHaveCount(4);
    expect(Date.now() - t0).toBeLessThan(1000);
  });

  test("o tipo de cada entidade aparece como texto na legenda e no nome acessível, não só por cor", async ({ page }) => {
    await perguntar(page);
    await aba(page).click();
    const legenda = page.getByRole("list", { name: "Tipos de entidade" });
    await expect(legenda).toContainText("organizacao");
    await expect(legenda).toContainText("pessoa");
    await expect(no(page, /Marco Geovanne.*pessoa/)).toBeVisible();
  });

  test("uma nova resposta troca o subgrafo; Nova conversa o esvazia", async ({ page }) => {
    const chat = await perguntar(page);
    await aba(page).click();
    await no(page, /União Federal/).click();
    await expect(resumo(page)).toHaveText("6 entidades e 5 ligações");
    await chat.perguntar(PERGUNTA);
    await chat.esperarResposta();
    await expect(resumo(page)).toHaveText("4 entidades e 3 ligações"); // recomeça da nova resposta
    await chat.novaConversa.click();
    await expect(grupo(page)).toHaveCount(0);
    await expect(page.getByText(/Aqui aparece o subgrafo/)).toBeVisible();
  });
});

test.describe("expandir por clique", () => {
  test("clicar numa entidade traz a vizinhança dela e junta ao que já estava, sem repetir nós", async ({ page }) => {
    const pedidos = await pedidosDeGrafo(page);
    await perguntar(page);
    await aba(page).click();
    await expect(nos(page)).toHaveCount(4);
    pedidos.length = 0;
    await expect(no(page, /União Federal.*expandir vizinhança/)).toBeVisible();
    await no(page, /União Federal/).click();
    await expect(resumo(page)).toHaveText("6 entidades e 5 ligações");
    await expect(no(page, /Tesouro Nacional/)).toBeVisible();
    await expect(no(page, /BNDES/)).toBeVisible();
    await expect(no(page, /Banco do Brasil/)).toHaveCount(1);
    await expect(no(page, /União Federal.*vizinhança expandida/)).toBeVisible();
    expect(pedidos.map((u) => u.searchParams.get("entidade"))).toEqual(["ent:org:uniao"]);
  });

  test("clicar de novo numa entidade já expandida (ou numa semente) não consulta a API", async ({ page }) => {
    const pedidos = await pedidosDeGrafo(page);
    await perguntar(page);
    await aba(page).click();
    await no(page, /União Federal/).click();
    await expect(resumo(page)).toHaveText("6 entidades e 5 ligações");
    pedidos.length = 0;
    await no(page, /União Federal/).click();
    await no(page, /Banco do Brasil/).click(); // semente: a vizinhança já veio
    await expect(resumo(page)).toHaveText("6 entidades e 5 ligações");
    expect(pedidos).toHaveLength(0);
  });

  test("a entidade que não tem ligação nova avisa, sem erro", async ({ page }) => {
    await perguntar(page);
    await aba(page).click();
    await no(page, /BB Seguridade/).click();
    await expect(aviso(page)).toContainText("Nenhuma ligação nova para BB Seguridade");
    await expect(resumo(page)).toHaveText("4 entidades e 3 ligações");
    await expect(page.getByRole("alert")).toHaveCount(0);
  });

  test("as entidades que já estavam não se mexem quando entram as novas", async ({ page }) => {
    await perguntar(page);
    await aba(page).click();
    // as coordenadas do desenho (a área vista se reajusta ao conteúdo, então a posição na tela muda; a no desenho, não)
    const centro = async (nome: RegExp) => no(page, nome).locator("circle").evaluate((c) => [c.getAttribute("cx"), c.getAttribute("cy")]);
    const antes = await centro(/Marco Geovanne/);
    await no(page, /União Federal/).click();
    await expect(nos(page)).toHaveCount(6);
    expect(await centro(/Marco Geovanne/)).toEqual(antes);
  });

  test("pelo teclado: Tab chega ao nó, Enter e Espaço expandem", async ({ page }) => {
    await perguntar(page);
    await aba(page).click();
    await expect(nos(page)).toHaveCount(4);
    const uniao = no(page, /União Federal/);
    await uniao.focus();
    await expect(uniao).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(resumo(page)).toHaveText("6 entidades e 5 ligações");
    await expect(uniao).toBeFocused(); // o foco continua no nó
    const bndes = no(page, /BNDES/);
    await bndes.focus();
    await page.keyboard.press("Space");
    await expect(aviso(page)).toContainText("Nenhuma ligação nova para BNDES");
    await expect(nos(page).first()).toHaveAttribute("tabindex", "0");
  });

  test("a consulta da expansão que falha mostra o erro e deixa o grafo como estava", async ({ page }) => {
    await perguntar(page);
    await aba(page).click();
    await expect(nos(page)).toHaveCount(4);
    await page.route("**/api/grafo/vizinhanca?entidade=ent%3Aorg%3Auniao*", (r) => r.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ codigo: "neo4j_indisponivel", mensagem: "O banco de grafos não está disponível." }) }));
    await no(page, /União Federal/).click();
    await expect(page.getByRole("alert")).toContainText("Não foi possível expandir União Federal");
    await expect(resumo(page)).toHaveText("4 entidades e 3 ligações");
    await expect(no(page, /União Federal.*expandir vizinhança/)).toBeVisible(); // dá para tentar de novo
  });
});

test.describe("explorar pelo nome", () => {
  test("pelo nome (sem acento de caixa) abre o subgrafo da entidade", async ({ page }) => {
    await page.goto("/chat/grafo");
    await expect(page.getByRole("button", { name: "Explorar" })).toBeDisabled();
    await explorar(page, "união federal");
    await expect(resumo(page)).toHaveText("4 entidades e 3 ligações");
    await expect(grupo(page).locator("[data-semente]")).toHaveCount(1);
    await expect(no(page, /Tesouro Nacional/)).toBeVisible();
  });

  test("entidade inexistente: aviso neutro, e o que estava na tela continua", async ({ page }) => {
    await page.goto("/chat/grafo");
    await explorar(page, "união federal");
    await expect(nos(page)).toHaveCount(4);
    await explorar(page, "entidade que não existe");
    await expect(aviso(page)).toContainText("Entidade não encontrada");
    await expect(nos(page)).toHaveCount(4);
    await expect(page.getByRole("alert")).toHaveCount(0);
  });

  test("banco de grafos fora do ar (503): alerta claro", async ({ page }) => {
    await page.goto("/chat/grafo");
    await explorar(page, "ent:erro");
    await expect(page.getByRole("alert")).toContainText("Não foi possível consultar o grafo");
    await expect(grupo(page)).toHaveCount(0);
  });

  test("mais de 100 vizinhos: mostra 100 e avisa que havia mais, sem travar", async ({ page }) => {
    await page.goto("/chat/grafo");
    const t0 = Date.now();
    await explorar(page, "ent:grande");
    await expect(resumo(page)).toHaveText("100 entidades e 99 ligações");
    await expect(nos(page)).toHaveCount(100);
    expect(Date.now() - t0).toBeLessThan(1000);
    await expect(aviso(page)).toContainText("100");
    await expect(aviso(page)).toContainText("mais ligações");
  });

  test("rótulo e tipo em HTML aparecem como texto e nada é executado", async ({ page }) => {
    await page.goto("/chat/grafo");
    await explorar(page, "ent:org:hostil");
    await expect(resumo(page)).toBeVisible();
    await expect(grupo(page).locator("text", { hasText: '<img src=x onerror="window.__xss=1">' })).toBeVisible();
    await expect(page.getByRole("list", { name: "Tipos de entidade" })).toContainText("<script>window.__xss=1</script>");
    await expect(page.locator("main img, main script")).toHaveCount(0);
    expect(await page.evaluate(() => (window as unknown as Record<string, unknown>)["__xss"])).toBeUndefined();
  });
});

test.describe("limites e estado", () => {
  test("no máximo 6 entidades da resposta viram semente, e as que não existem são ignoradas", async ({ page }) => {
    const pedidos = await pedidosDeGrafo(page);
    await perguntar(page, "Quem é o Banco do Brasil? Liste todas as entidades.");
    await aba(page).click();
    await expect(resumo(page)).toHaveText("4 entidades e 3 ligações");
    expect(pedidos).toHaveLength(6);
    await expect(page.getByRole("alert")).toHaveCount(0);
  });

  test("trocar de aba e voltar mantém o subgrafo expandido, sem nova consulta", async ({ page }) => {
    const pedidos = await pedidosDeGrafo(page);
    await perguntar(page);
    await aba(page).click();
    await no(page, /União Federal/).click();
    await expect(resumo(page)).toHaveText("6 entidades e 5 ligações");
    pedidos.length = 0;
    await page.getByRole("navigation", { name: "Painel" }).getByRole("link", { name: "Rastro" }).click();
    await aba(page).click();
    await expect(resumo(page)).toHaveText("6 entidades e 5 ligações");
    expect(pedidos).toHaveLength(0);
  });

  test("as entidades não se sobrepõem e o desenho cabe na área", async ({ page }) => {
    await perguntar(page);
    await aba(page).click();
    await no(page, /União Federal/).click();
    await expect(nos(page)).toHaveCount(6);
    const caixas = await nos(page).locator("circle").evaluateAll((cs) => cs.map((c) => c.getBoundingClientRect()).map((r) => ({ x: r.x + r.width / 2, y: r.y + r.height / 2, r: r.width / 2 })));
    for (let i = 0; i < caixas.length; i++)
      for (let j = i + 1; j < caixas.length; j++) expect(Math.hypot(caixas[i]!.x - caixas[j]!.x, caixas[i]!.y - caixas[j]!.y), `nós ${i} e ${j}`).toBeGreaterThan(caixas[i]!.r + caixas[j]!.r);
    const area = await grupo(page).boundingBox();
    for (const c of caixas) {
      expect(c.x).toBeGreaterThanOrEqual(area!.x);
      expect(c.x).toBeLessThanOrEqual(area!.x + area!.width);
    }
  });

  test("Aproximar, Afastar e Ajustar à tela mudam a área vista e voltam", async ({ page }) => {
    await perguntar(page);
    await aba(page).click();
    await expect(nos(page)).toHaveCount(4);
    const larguraVista = async () => Number((await grupo(page).getAttribute("viewBox"))!.split(/\s+/)[2]);
    const inicial = await larguraVista();
    await page.getByRole("button", { name: "Aproximar" }).click();
    await expect.poll(larguraVista).toBeLessThan(inicial);
    await page.getByRole("button", { name: "Afastar" }).click();
    await page.getByRole("button", { name: "Afastar" }).click();
    await expect.poll(larguraVista).toBeGreaterThan(inicial);
    await page.getByRole("button", { name: "Ajustar à tela" }).click();
    await expect.poll(larguraVista).toBeCloseTo(inicial, 1);
  });

  test("a 375 px não há rolagem horizontal da página e o grafo cabe", async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 812 });
    await perguntar(page);
    await aba(page).click();
    await expect(nos(page)).toHaveCount(4);
    await expect(resumo(page)).toBeVisible();
    const { rolagem, largura, direita } = await page.evaluate(() => ({
      rolagem: document.documentElement.scrollWidth,
      largura: document.documentElement.clientWidth,
      direita: document.querySelector('svg[role="group"]')!.getBoundingClientRect().right,
    }));
    expect(rolagem).toBeLessThanOrEqual(largura);
    expect(direita).toBeLessThanOrEqual(largura);
  });
});
