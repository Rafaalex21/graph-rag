/**
 * E2E do material gerado pelo assistente (F8.10), escritos antes do código. O pedido de gráfico, tabela, planilha, documento ou
 * apresentação volta, ANTES do `fim`, o evento SSE `artefato` (título, unidade, gráfico em SVG, tabela, arquivos e quantos pontos o
 * servidor removeu por falta de lastro). A tela mostra o gráfico (imagem com texto alternativo), a tabela com a página de cada número
 * e os links para baixar. A API falsa roteiriza pelo texto da pergunta (ver `api-falsa/servidor.ts`): "gráfico", "planilha", "word",
 * "apresentação", "santander", "artefato hostil|removido|quebrado". O PDF de teste tem 12 páginas.
 */
import { readFileSync } from "node:fs";
import { expect, test, type Page } from "@playwright/test";
import { PaginaAssistente } from "../../paginas/assistente.ts";

async function pedir(page: Page, pergunta: string): Promise<PaginaAssistente> {
  const a = new PaginaAssistente(page);
  await a.abrir();
  await a.perguntar(pergunta);
  await a.esperarResposta();
  return a;
}

const posicao = (page: Page) => page.getByRole("complementary", { name: "Fonte aberta" }).getByText(/^Página \d+ de \d+$/);
const GRAFICO = "Faça um gráfico do lucro líquido do exercício";

test.describe("gráfico e tabela na resposta", () => {
  test("o pedido de gráfico mostra a imagem com texto alternativo, a tabela com a página de cada valor e o título", async ({ page }) => {
    const a = await pedir(page, GRAFICO);
    const m = a.artefato();
    await expect(m).toBeVisible();
    await expect(m).toContainText("Lucro líquido do exercício");
    const imagem = m.getByRole("img", { name: /Gráfico de barras do lucro líquido do exercício: 2023, 33\.166/ });
    await expect(imagem).toBeVisible();
    await expect.poll(() => imagem.evaluate((i: HTMLImageElement) => i.complete && i.naturalWidth > 0)).toBe(true);

    const tabela = m.getByRole("table", { name: /Lucro líquido do exercício/ });
    await expect(tabela.getByRole("columnheader")).toHaveText(["Ano", "Lucro líquido (R$ milhões)", "Fonte"]);
    await expect(tabela.getByRole("row")).toHaveCount(4); // cabeçalho + 3 anos
    await expect(tabela.getByRole("row").nth(1).getByRole("cell")).toHaveText(["2023", "33.166", "p. 6"]);
    await expect(tabela.getByRole("row").nth(3).getByRole("cell")).toHaveText(["2025", "16.782", "p. 9"]);
  });

  test("a página da tabela abre o visualizador da fonte nessa página", async ({ page }) => {
    const a = await pedir(page, GRAFICO);
    await a.artefato().getByRole("button", { name: "p. 9" }).click();
    await expect(posicao(page)).toHaveText("Página 9 de 12");
  });

  test("o gráfico pode ser baixado em SVG, com o nome do arquivo", async ({ page }) => {
    const a = await pedir(page, GRAFICO);
    const [baixado] = await Promise.all([page.waitForEvent("download"), a.baixar(/Baixar gráfico \(\.svg\)/).click()]);
    expect(baixado.suggestedFilename()).toBe("lucro-liquido.svg");
    expect(readFileSync((await baixado.path()) as string, "utf8")).toContain("<svg");
  });

  test("a resposta comum não traz material gerado", async ({ page }) => {
    const a = await pedir(page, "Qual o lucro de 2025?");
    await expect(a.artefato()).toHaveCount(0);
  });

  test("se a imagem do gráfico não carrega, a tela avisa e a tabela continua lá", async ({ page }) => {
    const a = await pedir(page, "artefato quebrado");
    await expect(a.artefato().getByText("Não foi possível carregar o gráfico.")).toBeVisible();
    await expect(a.artefato().getByRole("table")).toBeVisible();
  });
});

test.describe("arquivos do pacote Office", () => {
  const casos = [
    { pergunta: "Monte uma tabela e uma planilha da receita líquida de juros", link: /Baixar planilha \(\.xlsx\)/, arquivo: "receita-liquida-de-juros.xlsx", titulo: "Receita líquida de juros", grafico: false },
    { pergunta: "Gere um documento Word com o lucro líquido", link: /Baixar documento \(\.docx\)/, arquivo: "lucro-liquido.docx", titulo: "Lucro líquido do exercício", grafico: false },
    { pergunta: "Faça uma apresentação com o lucro líquido", link: /Baixar apresentação \(\.pptx\)/, arquivo: "lucro-liquido.pptx", titulo: "Lucro líquido do exercício", grafico: true },
  ];
  for (const c of casos) {
    test(`"${c.pergunta}" oferece o arquivo e ele baixa inteiro`, async ({ page }) => {
      const a = await pedir(page, c.pergunta);
      await expect(a.artefato()).toContainText(c.titulo);
      await expect(a.artefato().getByRole("table")).toBeVisible();
      await expect(a.artefato().getByRole("img")).toHaveCount(c.grafico ? 1 : 0);
      const [baixado] = await Promise.all([page.waitForEvent("download"), a.baixar(c.link).click()]);
      expect(baixado.suggestedFilename()).toBe(c.arquivo);
      expect(readFileSync((await baixado.path()) as string).subarray(0, 2).toString()).toBe("PK"); // todo arquivo Office é um zip
    });
  }

  test("o link mostra o tamanho do arquivo", async ({ page }) => {
    const a = await pedir(page, "Monte uma planilha da receita líquida de juros");
    await expect(a.baixar(/Baixar planilha/)).toContainText(/\d+ (bytes|KB)/);
  });
});

test.describe("o que o documento não tem, e o que o servidor tirou", () => {
  test("pedido sem dado no documento: 'não consta', nenhum gráfico, tabela ou arquivo", { tag: "@fluxo-nao-consta" }, async ({ page }) => {
    const a = await pedir(page, "Faça um gráfico do lucro líquido do Santander");
    await expect(a.respostas.first()).toContainText("Não consta no documento");
    await expect(a.respostas.first().getByText("Não consta no documento", { exact: true })).toBeVisible(); // o selo
    await expect(a.artefato()).toHaveCount(0);
    await expect(a.respostas.first().getByRole("table")).toHaveCount(0);
    await expect(a.respostas.first().getByRole("link", { name: /Baixar/ })).toHaveCount(0);
  });

  test("valores tirados por falta de lastro: aviso claro com o número", async ({ page }) => {
    const a = await pedir(page, "artefato removido");
    await expect(a.artefato().getByRole("note")).toHaveText(/2 valores sem lastro no documento/);
    await expect(a.artefato().getByRole("row")).toHaveCount(2); // cabeçalho + o que sobrou
  });

  test("sem pontos removidos, não há aviso", async ({ page }) => {
    const a = await pedir(page, GRAFICO);
    await expect(a.artefato().getByRole("note")).toHaveCount(0);
  });
});

test.describe("segurança do que vem da API", () => {
  test("título, células e texto alternativo em HTML aparecem como texto e nada é executado", async ({ page }) => {
    const a = await pedir(page, "artefato hostil");
    await expect(a.artefato()).toContainText('<img src=x onerror="window.__xss=1">Lucro');
    await expect(a.artefato().getByRole("cell", { name: '<b onclick="window.__xss=1">2025</b>' })).toBeVisible();
    expect(await page.evaluate(() => (window as unknown as Record<string, unknown>)["__xss"])).toBeUndefined();
    await expect(a.artefato().locator("b, script, img[src='x']")).toHaveCount(0);
  });

  test("endereço de fora, 'javascript:' e formato desconhecido não viram imagem nem link; o link válido continua", async ({ page }) => {
    const pedidos: string[] = [];
    page.on("request", (r) => pedidos.push(r.url()));
    const a = await pedir(page, "artefato hostil");
    await expect(a.artefato().getByRole("img")).toHaveCount(0);
    await expect(a.artefato().getByRole("link")).toHaveCount(1);
    await expect(a.baixar(/Baixar planilha \(\.xlsx\)/)).toHaveAttribute("href", "/api/arquivos/x1");
    expect(pedidos.some((u) => u.includes("exemplo.invalid"))).toBe(false);
  });
});

test.describe("histórico e modo técnico", () => {
  test("a conversa restaurada da lista de recentes traz a tabela e os links de volta", async ({ page }) => {
    const pergunta = "Monte uma planilha da receita líquida de juros";
    const a = await pedir(page, pergunta);
    await a.novaConversa.click();
    await expect(a.respostas).toHaveCount(0);
    await a.recente(pergunta).click();
    await expect(a.artefato().getByRole("table")).toBeVisible();
    await expect(a.baixar(/Baixar planilha \(\.xlsx\)/)).toBeVisible();
  });

  test("no modo técnico (/chat) o evento novo não quebra a resposta nem o Rastro", async ({ page }) => {
    await page.goto("/chat/rastro");
    const caixa = page.getByRole("textbox", { name: "Sua pergunta" });
    await caixa.fill(GRAFICO);
    await caixa.press("Enter");
    await expect(page.getByText("Os valores estão na tabela").first()).toBeVisible();
    await expect(page.getByRole("alert")).toHaveCount(0);
  });
});

test.describe("no celular", () => {
  for (const largura of [390, 320]) {
    test(`a ${largura} px o gráfico, a tabela e os links cabem na tela`, async ({ page }) => {
      await page.setViewportSize({ width: largura, height: 800 });
      const a = await pedir(page, "Faça uma apresentação com o lucro líquido");
      for (const peca of [a.artefato(), a.artefato().getByRole("img"), a.artefato().getByRole("table"), a.baixar(/pptx/)]) {
        const caixa = await peca.boundingBox();
        expect(caixa, "a peça precisa estar na tela").not.toBeNull();
        expect(caixa!.x).toBeGreaterThanOrEqual(-1);
        expect(caixa!.x + caixa!.width).toBeLessThanOrEqual(largura + 1);
      }
    });
  }
});
