/**
 * F8.4 ao vivo: o aceite "10 citações sorteadas abrem na página certa", medido como está em `eval/f84-medida-citacoes.md`
 * (definição e emenda fixadas ANTES de rodar). Contra a pilha real: o PDF original servido por `/api/documento/pdf` com `Range`
 * e o texto de cada fonte vindo de `/api/fonte/:id`. Grava `eval/resultados/f84-citacoes.json` (ids, rótulos, números e
 * veredictos; sem texto do documento, ADR-009).
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { expect, test } from "@playwright/test";
import { URL_API_REAL } from "../../playwright.config.ts";
import { PaginaChat } from "../../paginas/chat.ts";
import { perguntaDoGolden } from "../../paginas/golden.ts";

const SEMENTE = 84;
const N = 10;
const ARQUIVOS = ["f75-redator-detalhes.json", "f712-redator-novas-detalhes.json"];
const LITERAIS = new Set(["pai", "filho", "tabela", "fato"]);
const ALVO = new URL("../../../eval/resultados/f84-citacoes.json", import.meta.url);

interface Par {
  id: string;
  rotulo: string;
}

/** mulberry32: o mesmo gerador das outras medidas do projeto, para o sorteio ser reproduzível. */
function mulberry32(semente: number): () => number {
  let a = semente >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function universo(): { comPagina: Par[]; semPagina: number } {
  const vistos = new Map<string, Par & { tem: boolean }>();
  for (const nome of ARQUIVOS) {
    const caminho = new URL(`../../../data/avaliacao/${nome}`, import.meta.url);
    if (!existsSync(caminho)) throw new Error(`falta ${nome} em data/avaliacao (rode as medidas F7.5 e F7.12)`);
    const dados = JSON.parse(readFileSync(caminho, "utf-8").replace(/^﻿/, "")) as Record<string, { resposta?: { citacoes?: { id: string; paginas?: string | null }[] } }>;
    for (const item of Object.values(dados)) {
      for (const c of item.resposta?.citacoes ?? []) {
        const rotulo = c.paginas ?? "";
        vistos.set(`${c.id}|${rotulo}`, { id: c.id, rotulo, tem: /\d/.test(rotulo) });
      }
    }
  }
  const todos = [...vistos.values()];
  const comPagina = todos.filter((p) => p.tem).map(({ id, rotulo }) => ({ id, rotulo }));
  comPagina.sort((x, y) => (x.id < y.id ? -1 : x.id > y.id ? 1 : x.rotulo < y.rotulo ? -1 : x.rotulo > y.rotulo ? 1 : 0));
  return { comPagina, semPagina: todos.length - comPagina.length };
}

function sortear(pares: Par[]): Par[] {
  const sorte = mulberry32(SEMENTE);
  const copia = [...pares];
  for (let i = copia.length - 1; i > 0; i--) {
    const j = Math.floor(sorte() * (i + 1));
    [copia[i], copia[j]] = [copia[j] as Par, copia[i] as Par];
  }
  return copia.slice(0, N);
}

const palavras = (t: string) => t.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
const mediana = (v: number[]) => [...v].sort((a, b) => a - b)[Math.floor(v.length / 2)] ?? 0;

test("as 10 citações sorteadas (semente 84) abrem na página certa", async ({ page, request }) => {
  test.setTimeout(900_000);
  const { comPagina, semPagina } = universo();
  const sorteadas = sortear(comPagina);
  expect(sortear(comPagina), "a mesma semente e o mesmo universo dão as mesmas 10").toEqual(sorteadas);
  expect(sorteadas).toHaveLength(N);

  const resultado: Record<string, unknown>[] = [];
  for (const { id, rotulo } of sorteadas) {
    const pagina = /\d+/.exec(rotulo)?.[0] ?? "";
    const r = await request.get(`${URL_API_REAL}/api/fonte/${id}`);
    const fonte = r.ok() ? ((await r.json()) as { tipo: string; texto: string }) : null;
    const tipoDaFonte = fonte?.tipo ?? `http_${r.status()}`;
    const literal = fonte !== null && LITERAIS.has(fonte.tipo);

    const t0 = Date.now();
    await page.goto(`/chat/fontes?pagina=${pagina}&fonte=${id}`);
    const estado = page.getByRole("status").filter({ hasText: /^Página \d+ de \d+$/ });
    let a = false;
    let motivo: string | null = null;
    let ms: number | null = null;
    let paginaAberta: string | null = null;
    let total: number | null = null;
    try {
      await expect(estado).toBeVisible({ timeout: 60_000 });
      const m = /^Página (\d+) de (\d+)$/.exec((await estado.innerText()).trim());
      paginaAberta = m?.[1] ?? null;
      total = m ? Number(m[2]) : null;
      a = paginaAberta === pagina;
      await expect(page.locator(".camada-texto > span").first()).toBeAttached({ timeout: 60_000 });
      ms = Date.now() - t0;
    } catch (e) {
      motivo = String((e as Error).message).split("\n")[0] ?? "erro";
      const aviso = await page.locator("[data-aviso], [role=alert]").allInnerTexts();
      if (aviso.length) motivo += ` | ${aviso.join(" / ").slice(0, 120)}`;
    }

    let b: boolean | null = null;
    let destacado: boolean | null = null;
    if (literal && fonte) {
      const camada = (await page.locator(".camada-texto > span").allTextContents()).join(" ");
      const inicio = palavras(fonte.texto).slice(0, 4).join(" ");
      b = inicio !== "" && palavras(camada).join(" ").includes(inicio);
      await page.waitForTimeout(500);
      destacado = (await page.locator(".camada-texto .destaque").count()) > 0;
    }
    const passou = a && (b === null || b);
    resultado.push({ id, rotulo, paginaPedida: pagina, paginaAberta, totalDePaginas: total, tipoDaFonte, avaliadaPor: literal ? "a+b" : "a", a, b, destacado, ms, passou, motivo });
  }

  const aprovadas = resultado.filter((x) => x["passou"]).length;
  const literais = resultado.filter((x) => x["avaliadaPor"] === "a+b");
  const tempos = resultado.map((x) => x["ms"]).filter((x): x is number => typeof x === "number");
  const resumo = {
    semente: SEMENTE,
    universo: { total: comPagina.length + semPagina, comPagina: comPagina.length, semPagina },
    sorteadas: resultado,
    resumo: {
      aprovadas,
      de: N,
      avaliadasPorAeB: literais.length,
      avaliadasSoPorA: N - literais.length,
      textoLiteralDestacado: literais.filter((x) => x["destacado"]).length,
      msMediana: mediana(tempos),
      msMaximo: Math.max(0, ...tempos),
    },
  };
  mkdirSync(new URL("./", ALVO), { recursive: true });
  writeFileSync(ALVO, `${JSON.stringify(resumo, null, 2)}\n`);
  console.log(JSON.stringify(resumo.resumo));
  expect(resultado.filter((x) => !x["passou"]).map((x) => `${String(x["id"])} ${String(x["rotulo"])} ${String(x["motivo"] ?? "")}`), "citações que não abriram na página certa").toEqual([]);
});

test("o chip de uma resposta real (T15) abre o visualizador na página e na fonte da citação", async ({ page }) => {
  test.setTimeout(400_000);
  const chat = new PaginaChat(page);
  await chat.abrir();
  await chat.perguntar(perguntaDoGolden("T15"));
  await expect(chat.estado).toHaveText(/Resposta pronta\./, { timeout: 300_000 });
  const chip = chat.respostas.first().getByRole("button", { name: /^Abrir a página \d+ do documento$/ }).first();
  await expect(chip).toBeVisible();
  const pagina = /\d+/.exec((await chip.getAttribute("aria-label")) ?? "")?.[0] ?? "";
  await chip.click();
  await expect(page).toHaveURL(new RegExp(`/chat/fontes\\?pagina=${pagina}&fonte=[^&#]+$`));
  await expect(page.getByRole("status").filter({ hasText: new RegExp(`^Página ${pagina} de \\d+$`) })).toBeVisible({ timeout: 60_000 });
  await expect(page.locator(".camada-texto > span").first()).toBeAttached({ timeout: 60_000 });
  await expect(page.getByRole("alert")).toHaveCount(0);
});
