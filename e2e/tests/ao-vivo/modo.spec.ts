/**
 * F8.6 ao vivo: o aceite "trocar o modo muda a rota observada no Rastro", medido como está em `eval/f86-medida-modo.md`
 * (definição fixada ANTES de rodar). Contra a pilha real. Três perguntas (T15, N01, G03) × seis modos (auto e os cinco forçados),
 * sempre trocando o modo pela página Configurações. A rota observada vem do atributo `data-ferramentas` dos passos "Rota" do
 * Rastro. Grava `eval/resultados/f86-modo.json` (ids, rotas, estados e tempos; sem texto do documento, ADR-009).
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { expect, test, type Page } from "@playwright/test";
import { PaginaChat } from "../../paginas/chat.ts";
import { perguntaDoGolden } from "../../paginas/golden.ts";

const ALVO = new URL("../../../eval/resultados/f86-modo.json", import.meta.url);
const PERGUNTAS = ["T15", "N01", "G03"];
const MODOS = [
  { valor: "auto", rotulo: "Automático", esperado: null },
  { valor: "trechos", rotulo: "Só trechos", esperado: "buscar_trechos" },
  { valor: "tabelas", rotulo: "Só tabelas", esperado: "buscar_tabelas" },
  { valor: "local", rotulo: "Entidades (busca local)", esperado: "entidade" },
  { valor: "global", rotulo: "Panorama (busca global)", esperado: "panorama" },
  { valor: "cypher", rotulo: "Consulta ao grafo (Cypher)", esperado: "consultar_grafo" },
] as const;

interface Execucao {
  pergunta: string;
  modo: string;
  perfil: string;
  esperado: string | null;
  rotaObservada: string[];
  exata: boolean | null;
  modoNoCorpo: string;
  perfilNoCorpo: string;
  terminou: "pronta" | "erro";
  estadoDoCiclo: string | null;
  evidencias: number | null;
  passosDeRota: number;
  temRodada2: boolean;
  ms: number;
}

async function executar(page: Page, id: string, modo: string, rotuloModo: string, perfil: "Padrão" | "Rápido"): Promise<Execucao> {
  await page.goto("/configuracoes");
  await page.getByRole("radio", { name: rotuloModo, exact: true }).check();
  await page.getByRole("radio", { name: perfil, exact: true }).check();
  await page.getByRole("navigation", { name: "Principal" }).getByRole("link", { name: "Chat" }).click();
  const chat = new PaginaChat(page);
  await expect(page.getByRole("heading", { level: 1, name: "Conversa" })).toBeVisible();
  const pedidos = chat.gravarPedidos();
  const t0 = Date.now();
  await chat.perguntar(perguntaDoGolden(id));
  await expect(chat.estado).toHaveText(/Resposta pronta\.|Não foi possível/, { timeout: 300_000 });
  const ms = Date.now() - t0;
  const terminou = /Resposta pronta\./.test(await chat.estado.innerText()) ? "pronta" : "erro";

  const lista = page.getByRole("list", { name: "Linha do tempo da resposta" });
  const rotas = await lista.locator('li[data-tipo="rota"]').evaluateAll((els) => els.map((e) => e.getAttribute("data-ferramentas") ?? ""));
  const observada: string[] = [];
  for (const r of rotas) for (const f of r.split(",")) if (f !== "" && !observada.includes(f)) observada.push(f);
  const texto = await lista.innerText();
  const esperado = MODOS.find((m) => m.valor === modo)?.esperado ?? null;
  const corpo = pedidos[0] ?? {};
  return {
    pergunta: id,
    modo,
    perfil: perfil === "Rápido" ? "consultar-rapido" : "consultar",
    esperado,
    rotaObservada: observada,
    exata: esperado === null ? null : observada.length === 1 && observada[0] === esperado,
    modoNoCorpo: String(corpo["mode"] ?? "auto"),
    perfilNoCorpo: String(corpo["profile"] ?? "consultar"),
    terminou,
    estadoDoCiclo: /Estado: (\S+)/.exec(texto)?.[1] ?? null,
    evidencias: Number(/Evidências recuperadas \((\d+)\)/.exec(texto)?.[1] ?? 0) || null,
    passosDeRota: rotas.length,
    temRodada2: /Rodada 2/.test(texto),
    ms,
  };
}

test("trocar o modo pela interface muda a rota observada no Rastro", async ({ page }) => {
  test.setTimeout(3_000_000);
  const execucoes: Execucao[] = [];
  for (const id of PERGUNTAS) {
    for (const m of MODOS) {
      const e = await executar(page, id, m.valor, m.rotulo, "Padrão");
      execucoes.push(e);
      console.log(`${id} ${m.valor}: rota=${e.rotaObservada.join("+")} corpo=${e.modoNoCorpo} ${e.terminou} ${e.ms} ms`);
    }
  }
  const rapido = await executar(page, "T15", "auto", "Automático", "Rápido");
  console.log(`T15 rápido: rotas=${rapido.passosDeRota} corpo=${rapido.perfilNoCorpo} rodada2=${rapido.temRodada2} ${rapido.ms} ms`);

  const forcadas = execucoes.filter((e) => e.esperado !== null);
  const exatas = forcadas.filter((e) => e.exata).length;
  const modoNoCorpoOk = execucoes.every((e) => e.modoNoCorpo === e.modo);
  const porPergunta = PERGUNTAS.map((id) => {
    const doId = execucoes.filter((e) => e.pergunta === id);
    const auto = doId.find((e) => e.modo === "auto");
    const f = doId.filter((e) => e.esperado !== null);
    const rotasForcadas = f.map((e) => e.rotaObservada.join("+"));
    const diferentesEntreSi = new Set(rotasForcadas).size === f.length;
    const diferentesDoAuto = rotasForcadas.filter((r) => r !== (auto?.rotaObservada.join("+") ?? "")).length;
    return { pergunta: id, rotaAuto: auto?.rotaObservada ?? [], diferentesEntreSi, diferentesDoAuto, ok: diferentesEntreSi && diferentesDoAuto >= 4 };
  });
  const perfilOk = rapido.perfilNoCorpo === "consultar-rapido" && !rapido.temRodada2;
  const cumprido = exatas === 15 && porPergunta.every((p) => p.ok) && modoNoCorpoOk;

  const resumo = {
    perguntas: PERGUNTAS,
    execucoes,
    rapido,
    resumo: { forcadasExatas: `${exatas} de ${forcadas.length}`, modoNoCorpoOk, porPergunta, perfilRapidoOk: perfilOk, aceiteCumprido: cumprido },
  };
  mkdirSync(new URL("./", ALVO), { recursive: true });
  writeFileSync(ALVO, `${JSON.stringify(resumo, null, 2)}\n`);
  console.log(JSON.stringify(resumo.resumo));
  expect(exatas, "execuções forçadas com a rota exata do modo (de 15)").toBe(15);
  expect(modoNoCorpoOk, "o mode do corpo de POST /api/chat é o escolhido").toBe(true);
  expect(porPergunta.filter((p) => !p.ok), "perguntas cujas rotas forçadas não são diferentes entre si e de auto").toEqual([]);
});
