/**
 * F8.5 ao vivo: o aceite "subgrafo de uma pergunta 'quem é…' renderizado em ≤ 1 s", medido como está em
 * `eval/f85-medida-subgrafo.md` (definição fixada ANTES de rodar). Contra a pilha real. As perguntas são as 3 do golden que
 * começam com "Quem é" (T01, E04, E07). Grava `eval/resultados/f85-subgrafo.json` (ids de entidade, contagens e tempos; sem texto
 * do documento, ADR-009).
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { expect, test, type Page } from "@playwright/test";
import { PaginaChat } from "../../paginas/chat.ts";
import { perguntaDoGolden } from "../../paginas/golden.ts";

const ALVO = new URL("../../../eval/resultados/f85-subgrafo.json", import.meta.url);
const PERGUNTAS = ["T01", "E04", "E07"];
const REPETICOES = 5;
const LIMITE_MS = 1000;

const resumo = (page: Page) => page.getByRole("status").filter({ hasText: /^\d+ entidades? e \d+ ligaç(ão|ões)/ });
const grupo = (page: Page) => page.getByRole("group", { name: "Subgrafo da resposta" });

interface Evidencia {
  id: string;
  tipo: string;
}

function evidenciasDoSse(sse: string): Evidencia[] {
  const saida: Evidencia[] = [];
  for (const quadro of sse.split(/\r?\n\r?\n/)) {
    if (!/^event: evidencia$/m.test(quadro)) continue;
    const dados = /^data: (.*)$/m.exec(quadro)?.[1];
    if (!dados) continue;
    const d = JSON.parse(dados) as { id: string; tipo: string };
    saida.push({ id: d.id, tipo: d.tipo });
  }
  return saida;
}

const ehEntidade = (e: Evidencia) => e.tipo === "entidade" || e.id.startsWith("ent:");

/** O subgrafo está desenhado: o resumo está visível e há tantos nós quantos o resumo diz (pelo menos 2). */
async function esperarRenderizado(page: Page): Promise<{ entidades: number; ligacoes: number }> {
  await expect(resumo(page)).toBeVisible({ timeout: 10_000 });
  const m = /^(\d+) entidades? e (\d+) ligaç/.exec((await resumo(page).innerText()).trim());
  const entidades = Number(m?.[1] ?? 0);
  expect(entidades).toBeGreaterThanOrEqual(2);
  await expect(grupo(page).getByRole("button")).toHaveCount(entidades, { timeout: 10_000 });
  return { entidades, ligacoes: Number(m?.[2] ?? 0) };
}

test("subgrafo das perguntas 'Quem é…' renderizado em até 1 s", async ({ page }) => {
  test.setTimeout(1_500_000);
  const resultados: Record<string, unknown>[] = [];

  for (const id of PERGUNTAS) {
    let sse = "";
    await page.route("**/api/chat", async (route) => {
      const r = await route.fetch({ timeout: 280_000 });
      sse = await r.text();
      await route.fulfill({ response: r, body: sse });
    });
    const chat = new PaginaChat(page);
    await chat.abrir();
    await chat.perguntar(perguntaDoGolden(id));
    await expect(chat.estado).toHaveText(/Resposta pronta\.|Não foi possível/, { timeout: 300_000 });
    await page.unroute("**/api/chat");

    const evidencias = evidenciasDoSse(sse);
    const entidades = evidencias.filter(ehEntidade);
    const base = { pergunta: id, evidencias: evidencias.length, entidadesNaResposta: entidades.map((e) => e.id), tiposDeEvidencia: [...new Set(evidencias.map((e) => e.tipo))] };
    const aba = page.getByRole("navigation", { name: "Painel" }).getByRole("link", { name: "Grafo" });

    if (entidades.length === 0) {
      await aba.click();
      await expect(page.getByText("Nenhuma entidade nesta resposta.")).toBeVisible();
      resultados.push({ ...base, medida: false, motivo: "sem entidade na resposta" });
      continue;
    }

    // (a) abre a aba depois da resposta pronta
    const t0 = Date.now();
    await aba.click();
    const desenho = await esperarRenderizado(page);
    const msA = Date.now() - t0;
    const sementes = await grupo(page).locator("[data-semente]").count();

    // expansão (fora do aceite): o primeiro nó que não é semente
    let expansao: Record<string, unknown> | null = null;
    const candidato = grupo(page).locator("g[role=button]:not([data-semente])").first();
    if (await candidato.count()) {
      const antes = desenho.entidades;
      const te = Date.now();
      await candidato.click();
      let depois = antes;
      try {
        await expect.poll(async () => (await grupo(page).getByRole("button").count()) !== antes || (await page.locator("[data-aviso]").count()) > 0, { timeout: 10_000 }).toBe(true);
        depois = await grupo(page).getByRole("button").count();
      } catch {
        /* sem resposta em 10 s: fica registrado abaixo */
      }
      expansao = { ms: Date.now() - te, entidadesAntes: antes, entidadesDepois: depois };
    }

    // (b) repete a consulta pelo campo "Explorar" com o id da primeira semente, partindo de uma tela vazia
    const temposB: number[] = [];
    for (let i = 0; i < REPETICOES; i++) {
      await page.goto("/chat/grafo");
      await page.getByRole("textbox", { name: "Explorar uma entidade" }).fill(entidades[0]!.id);
      const tb = Date.now();
      await page.getByRole("button", { name: "Explorar" }).click();
      await esperarRenderizado(page);
      temposB.push(Date.now() - tb);
    }
    resultados.push({ ...base, medida: true, entidades: desenho.entidades, ligacoes: desenho.ligacoes, sementes, msA, temposB, msBMaximo: Math.max(...temposB), expansao });
  }

  const medidas = resultados.filter((r) => r["medida"]);
  const maximos = medidas.flatMap((r) => [r["msA"] as number, r["msBMaximo"] as number]);
  const resumoFinal = {
    perguntas: PERGUNTAS,
    resultados,
    resumo: { medidas: medidas.length, semEntidade: resultados.length - medidas.length, limiteMs: LIMITE_MS, msMaximoGeral: Math.max(0, ...maximos), todasDentroDoLimite: medidas.length > 0 && maximos.every((m) => m <= LIMITE_MS) },
  };
  mkdirSync(new URL("./", ALVO), { recursive: true });
  writeFileSync(ALVO, `${JSON.stringify(resumoFinal, null, 2)}\n`);
  console.log(JSON.stringify(resumoFinal.resumo));
  expect(medidas.length, "perguntas com subgrafo para medir (o aceite exige pelo menos 2)").toBeGreaterThanOrEqual(2);
  expect(maximos.filter((m) => m > LIMITE_MS), `tempos acima de ${LIMITE_MS} ms`).toEqual([]);
});
