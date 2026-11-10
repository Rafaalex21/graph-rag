/**
 * F8.8, `@smoke` (medida em `eval/f88-medida-suite.md`): o caminho curto de ponta a ponta contra a pilha REAL (Neo4j, llama-swap e a
 * API no ar), só pela tela do assistente. Não substitui as medidas de aceite das etapas anteriores: confere que o sistema inteiro
 * responde, que a citação leva à página certa do PDF e que o que o documento não traz (outra empresa) volta sem nenhum selo de "encontrado".
 * O selo "Não consta no documento" não é exercitado aqui (errata 1 de `eval/f88-medida-suite.md`): o F01 é uma saudação, sem selo.
 *
 * Roda com `npx playwright test --project=ao-vivo --grep @smoke`. Chama o modelo local de verdade, que tem variância; por isso confere
 * a presença do selo de uma resposta e a página citada, não o texto da resposta.
 */
import { expect, test } from "@playwright/test";
import { PaginaAssistente } from "../../paginas/assistente.ts";
import { perguntaDoGolden } from "../../paginas/golden.ts";

const PAGINAS_DO_DOCUMENTO = 423;

test("pergunta real: a resposta chega com selo, a citação abre a página certa do PDF e o que o documento não traz volta sem selo de encontrado", { tag: "@smoke" }, async ({ page }) => {
  test.setTimeout(600_000);
  const a = new PaginaAssistente(page);

  await a.abrir();
  await expect(page.getByText("Tudo funcionando")).toBeVisible({ timeout: 30_000 });

  // 1. uma pergunta que o documento responde (T15 do golden)
  await a.perguntar(perguntaDoGolden("T15"));
  await expect(a.estado).toHaveText(/Resposta pronta\.|Não foi possível/, { timeout: 300_000 });
  await expect(a.estado, "a resposta terminou sem erro").toHaveText(/Resposta pronta\./);
  const selo = a.respostas.first().getByText("Encontrado no documento", { exact: true }).or(a.respostas.first().getByText("Encontrei só em parte", { exact: true }));
  await expect(selo, "a resposta traz um selo de resposta").toHaveCount(1);

  // 2. a citação: o primeiro cartão de fonte abre o painel na página do rótulo, com a página desenhada
  const cartoes = a.fontes().getByRole("button");
  await expect(cartoes.first(), "a resposta traz ao menos uma fonte").toBeVisible();
  const pagina = Number((await cartoes.first().innerText()).match(/p\.\s*(\d+)/)?.[1]);
  expect(pagina, "o cartão diz a página").toBeGreaterThan(0);
  await cartoes.first().click();
  await expect(a.painel.getByText(`Página ${pagina} de ${PAGINAS_DO_DOCUMENTO}`, { exact: true })).toBeVisible({ timeout: 60_000 });
  await expect(a.painel.locator('canvas[role="img"]')).toHaveAttribute("aria-label", `Página ${pagina} do documento`, { timeout: 60_000 });
  await a.painel.getByRole("button", { name: "Fechar fonte" }).click();

  // 3. uma pergunta fora do documento (F02 do golden, o Itaú Unibanco): termina sem erro e sem nenhum selo de "encontrado"
  await a.novaConversa.click();
  await a.perguntar(perguntaDoGolden("F02"));
  await expect(a.estado).toHaveText(/Resposta pronta\.|Não foi possível/, { timeout: 300_000 });
  await expect(a.estado, "a resposta terminou sem erro").toHaveText(/Resposta pronta\./);
  await expect(a.respostas.first(), "a resposta fora do documento aparece").toBeVisible();
  await expect(a.respostas.first().getByText("Encontrado no documento", { exact: true })).toHaveCount(0);
  await expect(a.respostas.first().getByText("Encontrei só em parte", { exact: true })).toHaveCount(0);
});
