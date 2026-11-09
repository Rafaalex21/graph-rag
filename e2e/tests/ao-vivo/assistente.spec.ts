/**
 * F8.9 ao vivo: o aceite "as 5 perguntas do golden feitas só pela tela do assistente mostram, em cada resposta, o estado certo, a
 * fonte que abre a página certa, o passo a passo e a nota registrada; o modo técnico continua em /chat", medido como está em
 * `eval/f89-medida-assistente.md` (definição fixada ANTES de rodar). Contra a pilha real (que já está no ar) e só pelo navegador,
 * começando em `/`. O `estado` esperado do selo é lido do corpo do `POST /api/chat` (o evento `fim`), não da tela. Grava
 * `eval/resultados/f89-assistente.json` (ids, contagens, estados e tempos; sem texto do documento, ADR-009) e, fora do git, uma
 * captura de tela a 1280 px em `data/avaliacao/`.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";
import { PaginaAssistente } from "../../paginas/assistente.ts";
import { perguntaDoGolden } from "../../paginas/golden.ts";

const ALVO = new URL("../../../eval/resultados/f89-assistente.json", import.meta.url);
const CAPTURA = new URL("../../../data/avaliacao/f89-assistente-1280.png", import.meta.url);
const PERGUNTAS = ["T15", "N01", "G03", "P01", "F01"];
const PAGINAS_DO_DOCUMENTO = 423;
const SELOS = ["Encontrado no documento", "Encontrei só em parte", "Não consta no documento", "Não consegui responder"] as const;

interface Quadro {
  evento: string;
  dados: Record<string, unknown>;
}

/** O corpo SSE do `POST /api/chat`: um quadro por `event:`/`data:`. */
function lerQuadros(corpo: string): Quadro[] {
  return corpo
    .split(/\r?\n\r?\n/)
    .map((q) => {
      const evento = /^event: (.+)$/m.exec(q)?.[1];
      const dados = /^data: (.+)$/m.exec(q)?.[1];
      return evento && dados ? { evento, dados: JSON.parse(dados) as Record<string, unknown> } : null;
    })
    .filter((q): q is Quadro => q !== null);
}

function seloEsperado(estado: string | null, evidencias: number, terminouEmErro: boolean): string | null {
  if (terminouEmErro) return "Não consegui responder";
  if (estado === "ausente") return "Não consta no documento";
  if (estado === "incompleta") return "Encontrei só em parte";
  if (estado === "suficiente" && evidencias > 0) return "Encontrado no documento";
  return null;
}

test("5 perguntas do golden só pela tela do assistente: selo, fonte, passo a passo e nota; e o modo técnico", async ({ page }) => {
  test.setTimeout(1_800_000);
  const a = new PaginaAssistente(page);
  const statusDoFeedback: number[] = [];
  page.on("response", (r) => {
    if (r.url().endsWith("/api/feedback") && r.request().method() === "POST") statusDoFeedback.push(r.status());
  });

  // Só observa: copia o corpo SSE de cada `POST /api/chat` (o `fetch` entrega uma metade da cópia à tela e lê a outra); a tela
  // não muda. O `response.text()` do Playwright não serve: o corpo de uma resposta em fluxo não fica disponível depois.
  await page.addInitScript(() => {
    const w = window as unknown as { __sse: { texto: string; fim: boolean }[] };
    w.__sse = [];
    const original = window.fetch.bind(window);
    window.fetch = async (entrada, opcoes) => {
      const resposta = await original(entrada, opcoes);
      const url = typeof entrada === "string" ? entrada : entrada instanceof Request ? entrada.url : String(entrada);
      if (!url.endsWith("/api/chat") || !resposta.body) return resposta;
      const [paraATela, paraAMedida] = resposta.body.tee();
      const registro = { texto: "", fim: false };
      w.__sse.push(registro);
      void (async () => {
        const leitor = paraAMedida.getReader();
        const decodificador = new TextDecoder();
        for (;;) {
          const { done, value } = await leitor.read();
          if (done) break;
          registro.texto += decodificador.decode(value, { stream: true });
        }
        registro.fim = true;
      })();
      return new Response(paraATela, { status: resposta.status, statusText: resposta.statusText, headers: resposta.headers });
    };
  });

  await a.abrir();
  const itens: Record<string, unknown>[] = [];
  for (const id of PERGUNTAS) {
    if (itens.length > 0) await a.novaConversa.click();
    const t0 = Date.now();
    await a.perguntar(perguntaDoGolden(id));
    await expect(a.estado).toHaveText(/Resposta pronta\.|Não foi possível/, { timeout: 300_000 });
    const ms = Date.now() - t0;
    const terminou = /Resposta pronta\./.test(await a.estado.innerText()) ? "pronta" : "erro";
    const indice = itens.length;
    await page.waitForFunction((i) => (window as unknown as { __sse: { fim: boolean }[] }).__sse[i]?.fim === true, indice, { timeout: 60_000 });
    const quadros = lerQuadros(await page.evaluate((i) => (window as unknown as { __sse: { texto: string }[] }).__sse[i]?.texto ?? "", indice));
    const fim = quadros.find((q) => q.evento === "fim")?.dados as { citacoes?: { id: string; pagina: string | null }[]; metricas?: { estado?: string } } | undefined;
    const evidencias = quadros.filter((q) => q.evento === "evidencia").length;
    const buscou = quadros.some((q) => q.evento === "evidencia" || (q.evento === "etapa" && q.dados["tipo"] === "ferramenta_fim"));
    const estadoDoFim = fim?.metricas?.estado ?? null;
    const esperado = seloEsperado(estadoDoFim, evidencias, terminou === "erro");

    // o selo mostrado: qual dos quatro textos está no cartão da resposta
    const resposta = a.respostas.first();
    const mostrados: string[] = [];
    for (const s of SELOS) if ((await resposta.getByText(s, { exact: true }).count()) > 0) mostrados.push(s);
    const seloOk = esperado === null ? mostrados.length === 0 : mostrados.length === 1 && mostrados[0] === esperado;

    const base = { pergunta: id, terminou, ms, estadoDoFim, evidencias, buscou, seloEsperado: esperado, seloMostrado: mostrados, seloOk };
    if (terminou !== "pronta") {
      itens.push({ ...base, ok: false, motivo: "a resposta terminou em erro" });
      continue;
    }

    // a fonte: o primeiro cartão com página abre o painel na página do rótulo
    const cartoes = a.fontes().getByRole("button");
    const nCartoes = await a.fontes().count().then((n) => (n === 0 ? 0 : cartoes.count()));
    let fonteOk: boolean | null = null;
    let paginaEsperada: number | null = null;
    let msAteDesenho: number | null = null;
    if (nCartoes > 0) {
      const rotulo = (await cartoes.first().innerText()).match(/p\.\s*(\d+)/)?.[1];
      paginaEsperada = rotulo ? Number(rotulo) : null;
      const c0 = Date.now();
      await cartoes.first().click();
      try {
        await expect(a.painel.getByText(new RegExp(`^Página ${paginaEsperada} de ${PAGINAS_DO_DOCUMENTO}$`))).toBeVisible({ timeout: 60_000 });
        await expect(a.painel.locator('canvas[role="img"]')).toHaveAttribute("aria-label", `Página ${paginaEsperada} do documento`, { timeout: 60_000 });
        msAteDesenho = Date.now() - c0;
        fonteOk = true;
      } catch {
        fonteOk = false;
      }
      if (id === PERGUNTAS[0]) {
        mkdirSync(new URL("./", CAPTURA), { recursive: true });
        await page.screenshot({ path: fileURLToPath(CAPTURA) });
      }
      await a.painel.getByRole("button", { name: "Fechar fonte" }).click().catch(() => undefined);
    }

    // o passo a passo: abre com 3 ou mais passos (só se aplica a uma resposta que buscou algo; sem busca, a tela não oferece o botão)
    const botao = a.botaoPassos(0);
    const temBotao = (await botao.count()) > 0;
    let passos: number | null = null;
    if (temBotao) {
      await botao.click();
      await expect(a.passos(0)).toBeVisible(); // a lista aparece depois do clique: contar antes dava 0
      passos = await a.passos(0).getByRole("listitem").count();
    }
    const passosOk = buscou ? temBotao && (passos ?? 0) >= 3 : !temBotao;

    // a nota: útil se há citação de página, senão não ajudou; confirmada na tela e com 201
    const comCitacao = (fim?.citacoes ?? []).some((c) => c.pagina !== null);
    const antes = statusDoFeedback.length;
    await a.avaliacao(0).getByRole("button", { name: comCitacao ? "Resposta útil" : "Não ajudou", exact: true }).click();
    let notaNaTela = false;
    try {
      await expect(a.avaliacao(0).getByText("Nota registrada.")).toBeVisible({ timeout: 15_000 });
      notaNaTela = true;
    } catch {
      notaNaTela = false;
    }
    const status = statusDoFeedback.slice(antes);
    const notaOk = notaNaTela && status.length === 1 && status[0] === 201;

    const ok = seloOk && (fonteOk === null || fonteOk) && passosOk && notaOk;
    itens.push({ ...base, cartoes: nCartoes, paginaEsperada, fonteOk, msAteDesenho, botaoPassos: temBotao, passos, passosOk, nota: comCitacao ? 1 : -1, statusDaNota: status, notaOk, ok });
  }

  // o modo técnico continua em /chat
  await a.menu.getByRole("link", { name: "Modo técnico" }).click();
  let tecnicoOk = false;
  try {
    await expect(page).toHaveURL(/\/chat\/rastro$/);
    await expect(page).toHaveTitle("Chat · GraphRAG local");
    tecnicoOk = true;
  } catch {
    tecnicoOk = false;
  }

  const cumpridas = itens.filter((it) => it["ok"] === true).length;
  const resumo = {
    perguntas: PERGUNTAS,
    itens,
    modoTecnico: { link: tecnicoOk },
    resumo: { cumpridas: `${cumpridas} de ${PERGUNTAS.length}`, modoTecnicoOk: tecnicoOk, aceiteCumprido: cumpridas === PERGUNTAS.length && tecnicoOk },
  };
  mkdirSync(new URL("./", ALVO), { recursive: true });
  writeFileSync(ALVO, `${JSON.stringify(resumo, null, 2)}\n`);
  console.log(JSON.stringify(resumo.resumo));
  expect(tecnicoOk, "o link Modo técnico leva a /chat").toBe(true);
  expect(cumpridas, "perguntas que passaram por todos os itens que se aplicam (de 5)").toBe(PERGUNTAS.length);
});
