/**
 * F8.2, aceite: "tokens aparecem em ≤ 5 s numa pergunta simples". A medida segue `eval/f82-medida-primeiro-token.md`, fixada
 * ANTES de rodar: T15 só esquenta os modelos; T01 a T05 contam, uma vez cada, numa conversa nova; o primeiro token na tela é
 * o primeiro instante em que a bolha da resposta tem texto visível, visto por um MutationObserver, a partir do Enter.
 * O aceite original (5 de 5 com o primeiro token em ≤ 5 s) não foi cumprido; o aceite vigente é o reescrito abaixo. Os tempos saem em `eval/resultados/f82-primeiro-token.json` (só ids e números).
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { expect, test } from "@playwright/test";
import { PaginaChat } from "../../paginas/chat.ts";
import { perguntaDoGolden } from "../../paginas/golden.ts";

const LIMITE_MS = 5000;
const ALVO = new URL("../../../eval/resultados/f82-primeiro-token.json", import.meta.url);

interface Medida {
  id: string;
  primeiroSinalMs: number | null;
  primeiroTokenMs: number | null;
  fimMs: number | null;
  textosDistintosAntesDoFim: number;
  estadoFinal: string;
}

async function medir(chat: PaginaChat, id: string): Promise<Medida> {
  const { page } = chat;
  await chat.abrir();
  await page.evaluate(() => {
    interface M {
      t0: number | null;
      sinal: number | null;
      token: number | null;
      fim: number | null;
      textos: string[];
      estado: string;
    }
    const m: M = { t0: null, sinal: null, token: null, fim: null, textos: [], estado: "" };
    (window as unknown as { __m: M }).__m = m;
    document.querySelector("textarea")?.addEventListener("keydown", (e) => {
      if ((e as KeyboardEvent).key === "Enter" && m.t0 === null) m.t0 = performance.now();
    }, true);
    new MutationObserver(() => {
      if (m.t0 === null) return;
      const agora = performance.now() - m.t0;
      const resposta = document.querySelector('[data-papel="assistente"]');
      if (resposta && m.sinal === null) m.sinal = agora;
      const texto = resposta?.querySelector("app-resposta-markdown")?.textContent?.trim() ?? "";
      if (texto !== "") {
        if (m.token === null) m.token = agora;
        if (m.textos.at(-1) !== texto) m.textos.push(texto);
      }
      const estado = document.querySelector('[role="status"]')?.textContent?.trim() ?? "";
      if (m.fim === null && /Resposta pronta|Não foi possível|Resposta interrompida/.test(estado)) {
        m.fim = agora;
        m.estado = estado;
      }
    }).observe(document.body, { childList: true, subtree: true, characterData: true });
  });
  await chat.caixa.fill(perguntaDoGolden(id));
  await chat.caixa.press("Enter");
  await page.waitForFunction(() => (window as unknown as { __m: { fim: number | null } }).__m.fim !== null, undefined, { timeout: 150_000 });
  const m = await page.evaluate(() => (window as unknown as { __m: { sinal: number | null; token: number | null; fim: number | null; textos: string[]; estado: string } }).__m);
  return { id, primeiroSinalMs: m.sinal, primeiroTokenMs: m.token, fimMs: m.fim, textosDistintosAntesDoFim: Math.max(0, m.textos.length - 1), estadoFinal: m.estado };
}

test("T01 a T05: sinal de vida na hora, texto em pedaços e fim em até 5 s do primeiro token (aceite reescrito da F8.2)", async ({ page }) => {
  test.setTimeout(1_200_000); // 6 perguntas em sequência, cada uma até ~2 min no pior caso
  const chat = new PaginaChat(page);
  await medir(chat, "T15"); // esquenta os modelos; não conta
  const medidas: Medida[] = [];
  for (const id of ["T01", "T02", "T03", "T04", "T05"]) medidas.push(await medir(chat, id));

  const tokens = medidas.map((m) => m.primeiroTokenMs).filter((x): x is number => x !== null).sort((a, b) => a - b);
  const resumo = {
    medida: "eval/f82-medida-primeiro-token.md",
    limiteMs: LIMITE_MS,
    perguntas: medidas.map((m) => ({ ...m, primeiroSinalMs: m.primeiroSinalMs === null ? null : Math.round(m.primeiroSinalMs), primeiroTokenMs: m.primeiroTokenMs === null ? null : Math.round(m.primeiroTokenMs), fimMs: m.fimMs === null ? null : Math.round(m.fimMs) })),
    dentroDoLimite: medidas.filter((m) => m.primeiroTokenMs !== null && m.primeiroTokenMs <= LIMITE_MS).length,
    de: medidas.length,
    medianaMs: tokens.length ? Math.round(tokens[Math.floor(tokens.length / 2)] as number) : null,
    maximoMs: tokens.length ? Math.round(tokens.at(-1) as number) : null,
  };
  mkdirSync(new URL("./", ALVO), { recursive: true });
  writeFileSync(ALVO, `${JSON.stringify(resumo, null, 2)}\n`);
  console.log(JSON.stringify(resumo));

  // Aceite REESCRITO pós-hoc pelo dono (09/11/2026): sinal de vida em ≤ 1 s, texto em pedaços e resposta terminando em ≤ 5 s
  // depois do primeiro token. O critério original (primeiro token ≤ 5 s) não é cumprido (0 de 5 na primeira medida): fica
  // registrado em `dentroDoLimite` no JSON, sem ser afirmado aqui.
  for (const m of medidas) {
    expect(m.primeiroSinalMs, `${m.id}: sinal de vida (ms)`).toBeLessThanOrEqual(1000);
    expect(m.primeiroTokenMs, `${m.id}: houve primeiro token`).not.toBeNull();
    expect(m.textosDistintosAntesDoFim, `${m.id}: estados intermediários do texto`).toBeGreaterThanOrEqual(2);
    expect((m.fimMs as number) - (m.primeiroTokenMs as number), `${m.id}: do primeiro token ao fim (ms)`).toBeLessThanOrEqual(5000);
    expect(m.estadoFinal, `${m.id}: estado final`).toBe("Resposta pronta.");
  }
});
