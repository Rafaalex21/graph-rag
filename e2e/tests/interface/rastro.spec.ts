/**
 * E2E do painel Rastro (F8.3): o caminho de cada resposta em linha do tempo, ao vivo. A API falsa manda o fluxo completo do
 * contrato (§11.1: `etapa` de todos os tipos, `cypher`, `evidencia`, `fim`, `erro`); o aceite é que todos apareçam, na ordem em
 * que chegaram, sem nunca virar HTML e sem tratar "o documento não tem" como erro.
 */
import { expect, test, type Locator, type Page } from "@playwright/test";
import { PaginaChat } from "../../paginas/chat.ts";

const linhaDoTempo = (page: Page): Locator => page.getByRole("list", { name: "Linha do tempo da resposta" });
const item = (page: Page, texto: string | RegExp): Locator => linhaDoTempo(page).getByRole("listitem").filter({ hasText: texto });

async function perguntarRastro(page: Page, pergunta = "mostre o rastro") {
  const chat = new PaginaChat(page);
  await chat.abrir();
  await chat.perguntar(pergunta);
  return chat;
}

test.describe("antes de qualquer pergunta", () => {
  test("a aba Rastro explica o que vai aparecer, sem linha do tempo vazia", async ({ page }) => {
    await page.goto("/chat/rastro");
    await expect(page.getByRole("heading", { level: 2, name: "Rastro" })).toBeVisible();
    await expect(page.getByText(/Aqui aparece o caminho de cada resposta/)).toBeVisible();
    await expect(linhaDoTempo(page)).toHaveCount(0);
  });
});

test.describe("todos os eventos da §11.1 aparecem", () => {
  test("etapas, Cypher, evidências, reparo e fim, na ordem em que chegaram", async ({ page }) => {
    const chat = await perguntarRastro(page);
    await chat.esperarResposta();
    const itens = linhaDoTempo(page).locator("> li");
    // a ordem do fluxo: recebida, reescrita, rotas e ferramentas da rodada 1, Cypher, crítica, rodada 2, evidências, reparo, fim
    const rotulos = await itens.evaluateAll((els) => els.map((e) => e.getAttribute("data-tipo")));
    expect(rotulos).toEqual([
      "reescrita-inicio",
      "reescrita",
      "rota",
      "ferramenta_inicio",
      "rota",
      "ferramenta_inicio",
      "ferramenta_fim",
      "ferramenta_fim",
      "cypher",
      "critica",
      "reescrita",
      "rota",
      "ferramenta_inicio",
      "ferramenta_fim",
      "critica",
      "evidencias",
      "reparo",
      "fim",
    ]);
  });

  test("pergunta recebida e reescrita (com a rodada e o número de subperguntas)", async ({ page }) => {
    const chat = await perguntarRastro(page);
    await chat.esperarResposta();
    await expect(item(page, "Pergunta recebida")).toHaveCount(1);
    const r1 = item(page, "Pergunta reescrita").first();
    await expect(r1).toContainText("Rodada 1");
    await expect(r1).toContainText("2 subperguntas");
    await expect(r1).toContainText("420 ms");
    await expect(item(page, "Pergunta reescrita").nth(1)).toContainText("1 subpergunta");
  });

  test("rota escolhida, ferramentas e o plano de reserva quando houve", async ({ page }) => {
    const chat = await perguntarRastro(page);
    await chat.esperarResposta();
    const rotas = item(page, "Rota: ferramentas");
    await expect(rotas).toHaveCount(3);
    await expect(rotas.first()).toContainText("buscar_trechos");
    await expect(rotas.nth(1)).toContainText("consultar_grafo");
    await expect(rotas.nth(1)).toContainText("Plano de reserva: chamada_invalida");
    await expect(rotas.first()).not.toContainText("Plano de reserva");
    await expect(item(page, "Executando buscar_trechos")).toHaveCount(2);
    await expect(item(page, "Executando consultar_grafo")).toHaveCount(1);
  });

  test("fim de cada ferramenta: evidências e tempo; a que falhou diz o erro, sem virar alerta", async ({ page }) => {
    const chat = await perguntarRastro(page);
    await chat.esperarResposta();
    await expect(item(page, "buscar_trechos: 5 evidências")).toContainText("340 ms");
    await expect(item(page, "buscar_trechos: 4 evidências")).toContainText("310 ms");
    const falha = item(page, "consultar_grafo falhou");
    await expect(falha).toContainText("tempo esgotado na consulta");
    await expect(falha).toContainText("2,1 s");
    await expect(chat.alerta).toHaveCount(0); // a ferramenta falhar não é um erro da resposta
  });

  test("Cypher: o texto da consulta, as linhas e o tempo; HTML dentro dela é só texto", async ({ page }) => {
    const chat = await perguntarRastro(page);
    await chat.esperarResposta();
    const c = item(page, "Consulta Cypher");
    await expect(c).toContainText("3 linhas");
    await expect(c).toContainText("45 ms");
    await c.getByText("Ver a consulta").click();
    await expect(c.locator("pre")).toContainText("MATCH (f:FinancialFact) WHERE f.metric = 'Lucro'");
    await expect(c.locator("pre")).toContainText("<script>window.__xss=1</script>");
    await expect(c.locator("script")).toHaveCount(0);
    expect(await page.evaluate(() => (window as unknown as Record<string, unknown>)["__xss"])).toBeUndefined();
  });

  test("crítica de cada rodada: buscar mais (com o que falta) e depois suficiente", async ({ page }) => {
    const chat = await perguntarRastro(page);
    await chat.esperarResposta();
    const criticas = item(page, /^Crítica/);
    await expect(criticas).toHaveCount(2);
    await expect(criticas.first()).toContainText("Crítica: buscar mais");
    await expect(criticas.first()).toContainText("Rodada 1");
    await expect(criticas.first()).toContainText("Faltando: o lucro de 2024");
    await expect(criticas.first()).toContainText("1 pergunta nova");
    await expect(criticas.nth(1)).toContainText("Crítica: suficiente");
    await expect(criticas.nth(1)).toContainText("Rodada 2");
    await expect(criticas.nth(1)).not.toContainText("Faltando");
  });

  test("evidências: tipo, página (chip que abre Fontes), trecho como texto e nota", async ({ page }) => {
    const chat = await perguntarRastro(page);
    await chat.esperarResposta();
    const ev = item(page, "Evidências recuperadas (3)");
    await expect(ev).toBeVisible();
    const pai = ev.getByRole("listitem").filter({ hasText: "Lucro líquido ajustado" });
    await expect(pai).toContainText("pai");
    await expect(pai).toContainText("0,91");
    await expect(pai.getByRole("button", { name: "Abrir a página 6 do documento" })).toHaveText("p. 6");
    const tabela = ev.getByRole("listitem").filter({ hasText: "| Ano | Lucro |" });
    await expect(tabela.getByRole("button", { name: "Abrir a página 9 do documento" })).toHaveText("p. 9-10");
    const semPagina = ev.getByRole("listitem").filter({ hasText: "valor sem página" });
    await expect(semPagina).toContainText("sem página");
    await expect(semPagina.getByRole("button")).toHaveCount(0);
    await expect(semPagina.locator("img")).toHaveCount(0); // o <img onerror> do trecho é texto
    await expect(semPagina).toContainText("<img src=x");
    expect(await page.evaluate(() => (window as unknown as Record<string, unknown>)["__xss"])).toBeUndefined();
  });

  test("clicar na página de uma evidência abre a aba Fontes naquela página", async ({ page }) => {
    const chat = await perguntarRastro(page);
    await chat.esperarResposta();
    await item(page, "Evidências recuperadas").getByRole("button", { name: "Abrir a página 9 do documento" }).click();
    await expect(page).toHaveURL(/\/chat\/fontes\?pagina=9$/);
  });

  test("reparo: quantas frases com número sem citação foram reescritas", async ({ page }) => {
    const chat = await perguntarRastro(page);
    await chat.esperarResposta();
    const r = item(page, "Reparo da resposta");
    await expect(r).toContainText("1 frase com número sem citação");
  });

  test("fim: tempo, tokens, rota e estado, com números em pt-BR", async ({ page }) => {
    const chat = await perguntarRastro(page);
    await chat.esperarResposta();
    const f = item(page, "Resposta pronta");
    await expect(f).toContainText("12,3 s");
    await expect(f).toContainText("1.234 tokens de entrada");
    await expect(f).toContainText("56 de saída");
    await expect(f).toContainText("buscar_trechos → consultar_grafo");
    await expect(f).toContainText("Estado: suficiente");
  });
});

test.describe("ao vivo", () => {
  test("os passos aparecem enquanto a resposta ainda está sendo gerada, e o fim só no fim", async ({ page }) => {
    const chat = await perguntarRastro(page);
    await expect(item(page, "Pergunta recebida")).toBeVisible();
    await expect(item(page, "Pergunta reescrita").first()).toBeVisible();
    await expect(chat.estado).toHaveText("Gerando a resposta…");
    await expect(item(page, "Resposta pronta")).toHaveCount(0);
    await expect(item(page, "Evidências recuperadas")).toHaveCount(0);
    await chat.esperarResposta();
    await expect(item(page, "Resposta pronta")).toHaveCount(1);
  });

  test("a linha do tempo não é uma região viva (o leitor de tela não lê cada passo)", async ({ page }) => {
    const chat = await perguntarRastro(page);
    await chat.esperarResposta();
    await expect(page.locator('[aria-live="polite"], [aria-live="assertive"], [role="alert"]').filter({ has: linhaDoTempo(page) })).toHaveCount(0);
  });
});

test.describe("o documento não tem o dado", () => {
  test("crítica 'ausente' sai com destaque neutro, sem alerta, e sem evidências", async ({ page }) => {
    const chat = await perguntarRastro(page, "pergunta ausente do documento");
    await chat.esperarResposta();
    const c = item(page, /^Crítica/);
    await expect(c).toContainText("Crítica: o documento não tem esse dado");
    await expect(c).toContainText("Faltando: o documento não traz esse dado");
    await expect(chat.alerta).toHaveCount(0);
    await expect(c).not.toHaveClass(/erro/);
    await expect(item(page, "Evidências recuperadas")).toHaveCount(0);
    await expect(item(page, "Nenhuma evidência")).toBeVisible();
    await expect(item(page, "Estado: ausente")).toBeVisible();
  });
});

test.describe("erro no meio", () => {
  test("o evento de erro vira um passo da linha do tempo, sem apagar o que já chegou", async ({ page }) => {
    const chat = await perguntarRastro(page, "pergunta com erro");
    await expect(chat.alerta).toContainText("demorou demais");
    await expect(item(page, "Pergunta recebida")).toBeVisible();
    const e = item(page, "Erro");
    await expect(e).toContainText("O modelo de linguagem demorou demais. Tente novamente.");
    await expect(e).toContainText("llm_timeout");
    await expect(item(page, "Resposta pronta")).toHaveCount(0);
  });

  test("HTTP 429: sem passos, o Rastro continua explicando o que aparecerá", async ({ page }) => {
    const chat = await perguntarRastro(page, "pergunta de limite");
    await expect(chat.alerta).toBeVisible();
    await expect(linhaDoTempo(page)).toHaveCount(0);
    await expect(page.getByText(/Aqui aparece o caminho de cada resposta/)).toBeVisible();
  });
});

test.describe("a conversa", () => {
  test("mostra o rastro da pergunta mais recente e Nova conversa o limpa", async ({ page }) => {
    const chat = await perguntarRastro(page);
    await chat.esperarResposta();
    await expect(item(page, "Resposta pronta")).toContainText("12,3 s");
    await chat.perguntar("outra pergunta qualquer");
    await expect(chat.estado).toHaveText("Resposta pronta.");
    await expect(item(page, "Pergunta recebida")).toHaveCount(1);
    await expect(item(page, "Evidências recuperadas (1)")).toBeVisible(); // o roteiro padrão manda uma evidência; as 3 do rastro anterior saíram
    await expect(item(page, "Evidências recuperadas (3)")).toHaveCount(0);
    await chat.novaConversa.click();
    await expect(linhaDoTempo(page)).toHaveCount(0);
    await expect(page.getByText(/Aqui aparece o caminho de cada resposta/)).toBeVisible();
  });

  test("trocar de aba e voltar não perde o rastro", async ({ page }) => {
    const chat = await perguntarRastro(page);
    await chat.esperarResposta();
    const abas = page.getByRole("navigation", { name: "Painel" });
    await abas.getByRole("link", { name: "Fontes" }).click();
    await expect(linhaDoTempo(page)).toHaveCount(0);
    await abas.getByRole("link", { name: "Rastro" }).click();
    await expect(item(page, "Resposta pronta")).toBeVisible();
    await expect(linhaDoTempo(page).locator("> li")).toHaveCount(18);
  });

  test("entrar direto em /chat/rastro com uma resposta em andamento não quebra", async ({ page }) => {
    const chat = await perguntarRastro(page);
    await page.getByRole("navigation", { name: "Painel" }).getByRole("link", { name: "Grafo" }).click();
    await chat.esperarResposta();
    await page.getByRole("navigation", { name: "Painel" }).getByRole("link", { name: "Rastro" }).click();
    await expect(item(page, "Resposta pronta")).toBeVisible();
  });
});

test.describe("celular", () => {
  test("em 375 px o Cypher e o trecho longos não geram rolagem horizontal da página", async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 812 });
    const chat = await perguntarRastro(page);
    await chat.esperarResposta();
    await item(page, "Consulta Cypher").getByText("Ver a consulta").click();
    expect(await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth)).toBe(false);
  });
});
