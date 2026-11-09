/**
 * F8.3 ao vivo: o Rastro de perguntas de verdade contra a pilha real. Três perguntas do golden (T15 factual, N01 numérica, G03 de
 * grafo); em cada uma a linha do tempo tem de ter os passos que toda pergunta atravessa, e a união das três diz quais tipos de passo
 * da §11.1 a pilha real emitiu. Grava `eval/resultados/f83-rastro.json` (ids, contagens e tipos; sem texto do documento, ADR-009).
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { expect, test } from "@playwright/test";
import { PaginaChat } from "../../paginas/chat.ts";
import { perguntaDoGolden } from "../../paginas/golden.ts";

const ALVO = new URL("../../../eval/resultados/f83-rastro.json", import.meta.url);
const SEMPRE = ["reescrita-inicio", "reescrita", "rota", "ferramenta_inicio", "ferramenta_fim", "critica", "evidencias", "fim"];

test("Rastro de T15, N01 e G03: os passos de toda pergunta aparecem e o resto é registrado", async ({ page }) => {
  test.setTimeout(900_000);
  const chat = new PaginaChat(page);
  const uniao = new Set<string>();
  const porPergunta: { id: string; passos: number; tipos: string[]; estado: string }[] = [];
  for (const id of ["T15", "N01", "G03"]) {
    await chat.abrir();
    await chat.perguntar(perguntaDoGolden(id));
    await expect(chat.estado).toHaveText(/Resposta pronta\.|Não foi possível/, { timeout: 240_000 });
    const lista = page.getByRole("list", { name: "Linha do tempo da resposta" });
    await expect(lista).toBeVisible();
    const tipos = await lista.locator("> li").evaluateAll((els) => els.map((e) => e.getAttribute("data-tipo") ?? ""));
    for (const t of SEMPRE) expect(tipos, `${id}: passo ${t}`).toContain(t);
    expect(tipos.at(-1), `${id}: o último passo é o fim`).toBe("fim");
    expect(tipos.indexOf("reescrita-inicio"), `${id}: a pergunta recebida vem primeiro`).toBe(0);
    await expect(page.getByRole("alert")).toHaveCount(0);
    // nada de HTML na linha do tempo e o texto não vaza "undefined" nem "[object"
    await expect(lista.locator("script, img, iframe")).toHaveCount(0);
    expect(await lista.innerText()).not.toMatch(/undefined|\[object|NaN/);
    const estado = (await lista.locator('li[data-tipo="fim"]').innerText()).match(/Estado: (\S+)/)?.[1] ?? "";
    tipos.forEach((t) => uniao.add(t));
    porPergunta.push({ id, passos: tipos.length, tipos: [...new Set(tipos)], estado });
  }
  mkdirSync(new URL("./", ALVO), { recursive: true });
  const resumo = { porPergunta, uniao: [...uniao].sort(), cypherVisto: uniao.has("cypher"), reparoVisto: uniao.has("reparo") };
  writeFileSync(ALVO, `${JSON.stringify(resumo, null, 2)}\n`);
  console.log(JSON.stringify(resumo));
});
