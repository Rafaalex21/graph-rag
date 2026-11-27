/**
 * E2E da visão dev da tela do assistente (F8.11), escritos antes do código. Com o interruptor "Visão dev" ligado, o `/assistente`
 * mostra, com o próprio design, tudo o que o modo técnico mostra de uma resposta: no cartão, o resumo técnico (rota, tempo,
 * tokens, estado); num painel "Bastidores" ao lado, o caminho ao vivo (reescrita, rota, ferramentas, Cypher sempre à vista,
 * crítica, reparo, fim), as evidências (tipo, nota, página que abre a fonte) e o subgrafo. Desligado, nada disso aparece.
 * A API falsa roteiriza pela pergunta: "rastro" é o fluxo completo do contrato, com 120 ms entre eventos; "quem é" acha entidades.
 */
import { expect, test, type Page } from "@playwright/test";
import { PaginaAssistente } from "../../paginas/assistente.ts";

const RASTRO = "Mostre o rastro do lucro";
const QUEM_E = "Quem é o Banco do Brasil e o diretor de relações com investidores?";

async function comVisaoDev(page: Page): Promise<PaginaAssistente> {
  const a = new PaginaAssistente(page);
  await a.abrir();
  await a.visaoDev.click();
  await expect(a.visaoDev).toHaveAttribute("aria-checked", "true");
  return a;
}

test.describe("desligada", () => {
  test("vem desligada e a tela fica como a do usuário: sem Bastidores e sem resumo técnico", async ({ page }) => {
    const a = new PaginaAssistente(page);
    await a.abrir();
    await expect(a.visaoDev).toHaveAttribute("aria-checked", "false");
    await a.perguntar(RASTRO);
    await a.esperarResposta();
    await expect(a.bastidores).toHaveCount(0);
    await expect(a.resumoTecnico()).toHaveCount(0);
    await expect(page.getByText("MATCH (f:FinancialFact)")).toHaveCount(0);
    await expect(a.botaoPassos()).toBeVisible(); // o passo a passo do usuário continua
  });

  test("desligar de novo some com os Bastidores e o resumo", async ({ page }) => {
    const a = await comVisaoDev(page);
    await a.perguntar(RASTRO);
    await a.esperarResposta();
    await expect(a.bastidores).toBeVisible();
    await a.visaoDev.click();
    await expect(a.visaoDev).toHaveAttribute("aria-checked", "false");
    await expect(a.bastidores).toHaveCount(0);
    await expect(a.resumoTecnico()).toHaveCount(0);
  });
});

test.describe("ligada", () => {
  test("a escolha sobrevive ao recarregar", async ({ page }) => {
    const a = await comVisaoDev(page);
    await page.reload();
    await expect(a.visaoDev).toHaveAttribute("aria-checked", "true");
    await expect(a.bastidores).toBeVisible();
  });

  test("antes da primeira pergunta, os Bastidores explicam o que vai aparecer", async ({ page }) => {
    const a = await comVisaoDev(page);
    await expect(a.bastidores).toContainText("Faça uma pergunta");
  });

  test("o caminho se enche ao vivo, antes de a resposta ficar pronta", async ({ page }) => {
    const a = await comVisaoDev(page);
    await a.perguntar(RASTRO);
    await expect(a.caminho.getByText("Rota: ferramentas").first()).toBeVisible();
    await expect(a.estado).toHaveText("Gerando a resposta…"); // ainda chegando
    await a.esperarResposta();
    await expect(a.caminho.getByText("Resposta pronta")).toBeVisible();
  });

  test("o caminho tem todos os passos do contrato, com rodadas, tempos e o que faltou", async ({ page }) => {
    const a = await comVisaoDev(page);
    await a.perguntar(RASTRO);
    await a.esperarResposta();
    const c = a.caminho;
    await expect(c.getByText("Pergunta reescrita").first()).toBeVisible();
    await expect(c.getByText("2 subperguntas")).toBeVisible();
    await expect(c.getByText("Rota: ferramentas").first()).toBeVisible();
    await expect(c.getByText("buscar_trechos: 5 evidências")).toBeVisible();
    await expect(c.getByText("consultar_grafo falhou")).toBeVisible();
    await expect(c.getByText("tempo esgotado na consulta")).toBeVisible();
    await expect(c.getByText("Crítica: buscar mais")).toBeVisible();
    await expect(c.getByText("Faltando: o lucro de 2024")).toBeVisible();
    await expect(c.getByText("Rodada 2").first()).toBeVisible();
    await expect(c.getByText("Crítica: suficiente")).toBeVisible();
    await expect(c.getByText(/Reparo da resposta/)).toBeVisible();
    await expect(c.getByText("Resposta pronta")).toBeVisible();
    await expect(c.getByText(/12,3 s/).first()).toBeVisible();
  });

  test("a consulta Cypher fica à vista, sem clicar, com as linhas e o tempo, e o que veio da API é só texto", async ({ page }) => {
    const a = await comVisaoDev(page);
    await a.perguntar(RASTRO);
    await a.esperarResposta();
    const cypher = a.caminho.getByRole("figure", { name: "Consulta Cypher" });
    await expect(cypher).toBeVisible();
    await expect(cypher).toContainText("MATCH (f:FinancialFact) WHERE f.metric = 'Lucro'");
    await expect(cypher).toContainText("<script>window.__xss=1</script>");
    await expect(cypher).toContainText("3 linhas");
    await expect(cypher).toContainText("45 ms");
    expect(await page.evaluate(() => (window as unknown as { __xss?: number }).__xss)).toBeUndefined();
  });

  test("o cartão traz o resumo técnico: ferramentas, tempo, tokens e estado", async ({ page }) => {
    const a = await comVisaoDev(page);
    await a.perguntar(RASTRO);
    await a.esperarResposta();
    const r = a.resumoTecnico();
    await expect(r).toContainText("buscar_trechos → consultar_grafo");
    await expect(r).toContainText("12,3 s");
    await expect(r).toContainText("1.234 tokens de entrada");
    await expect(r).toContainText("56 de saída");
    await expect(r).toContainText("suficiente");
  });

  test("evidências: tipo, nota e página; a página abre a fonte, e fechar a fonte volta aos Bastidores", async ({ page }) => {
    const a = await comVisaoDev(page);
    await a.perguntar(RASTRO);
    await a.esperarResposta();
    await a.abaDosBastidores("Evidências").click();
    await expect(a.abaDosBastidores("Evidências")).toHaveAttribute("aria-selected", "true");
    const lista = a.bastidores.getByRole("list", { name: "Evidências recuperadas" });
    await expect(lista.getByRole("listitem")).toHaveCount(3);
    await expect(lista).toContainText("nota 0,91");
    await expect(lista).toContainText("sem página");
    await expect(lista).toContainText('<img src=x onerror="window.__xss=1"> valor sem página');
    await lista.getByRole("button", { name: "Abrir a página 6 do documento" }).click();
    await expect(a.painel.getByText(/^Página 6 de 12$/)).toBeVisible();
    await expect(a.bastidores).toHaveCount(0);
    await a.painel.getByRole("button", { name: "Fechar fonte" }).click();
    await expect(a.bastidores).toBeVisible();
    expect(await page.evaluate(() => (window as unknown as { __xss?: number }).__xss)).toBeUndefined();
  });

  test("a aba Grafo mostra o subgrafo das entidades da resposta", async ({ page }) => {
    const a = await comVisaoDev(page);
    await a.perguntar(QUEM_E);
    await a.esperarResposta();
    await a.abaDosBastidores("Grafo").click();
    await expect(a.bastidores.getByRole("group", { name: "Subgrafo da resposta" })).toBeVisible();
    await expect(a.bastidores.getByText("4 entidades e 3 ligações")).toBeVisible();
  });

  test("ligar depois de responder mostra os Bastidores da resposta que já está na tela", async ({ page }) => {
    const a = new PaginaAssistente(page);
    await a.abrir();
    await a.perguntar(RASTRO);
    await a.esperarResposta();
    await a.visaoDev.click();
    await expect(a.caminho.getByText("Crítica: suficiente")).toBeVisible();
    await expect(a.resumoTecnico()).toBeVisible();
  });

  test("com duas respostas, 'Ver bastidores' no cartão escolhe qual resposta o painel mostra", async ({ page }) => {
    const a = await comVisaoDev(page);
    await a.perguntar(RASTRO);
    await a.esperarResposta();
    await a.perguntar(QUEM_E);
    await a.esperarResposta();
    await expect(a.caminho.getByText("Rota: entidade")).toBeVisible(); // a mais recente
    await a.respostas.nth(0).getByRole("button", { name: "Ver bastidores" }).click();
    await expect(a.caminho.getByText("Crítica: buscar mais")).toBeVisible();
    await expect(a.caminho.getByText("Rota: entidade")).toHaveCount(0);
  });

  test("Nova conversa limpa os Bastidores", async ({ page }) => {
    const a = await comVisaoDev(page);
    await a.perguntar(RASTRO);
    await a.esperarResposta();
    await a.novaConversa.click();
    await expect(a.caminho).toHaveCount(0);
    await expect(a.bastidores).toContainText("Faça uma pergunta");
  });
});

test.describe("celular", () => {
  test("em 375 px: o interruptor cabe, os Bastidores abrem por cima pelo cartão e fecham, e nada gera rolagem horizontal", async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 812 });
    const a = new PaginaAssistente(page);
    await a.abrir();
    await expect(a.visaoDev).toBeVisible();
    const caixa = await a.visaoDev.boundingBox();
    expect(caixa!.x + caixa!.width).toBeLessThanOrEqual(376);
    await a.visaoDev.click();
    await expect(a.bastidores).toHaveCount(0); // no celular o painel cobriria a conversa: só abre quando pedido
    await a.perguntar(RASTRO);
    await a.esperarResposta();
    await expect(a.resumoTecnico()).toBeVisible();
    await a.respostas.nth(0).getByRole("button", { name: "Ver bastidores" }).click();
    await expect(a.bastidores).toBeVisible();
    await expect(a.caminho.getByRole("figure", { name: "Consulta Cypher" })).toBeVisible();
    const estoura = () => page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
    expect(await estoura()).toBe(false);
    for (const peca of [a.caminho.getByRole("figure", { name: "Consulta Cypher" }), a.bastidores]) {
      const b = await peca.boundingBox();
      expect(b!.x).toBeGreaterThanOrEqual(-1);
      expect(b!.x + b!.width).toBeLessThanOrEqual(376);
    }
    await a.bastidores.getByRole("button", { name: "Fechar bastidores" }).click();
    await expect(a.bastidores).toHaveCount(0);
    await expect(a.visaoDev).toHaveAttribute("aria-checked", "true"); // fechar o painel não desliga a visão
    await a.respostas.nth(0).getByRole("button", { name: "Ver bastidores" }).click();
    await expect(a.bastidores).toBeVisible();
  });
});
