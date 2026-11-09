/**
 * F8.7 ao vivo: o aceite "5 perguntas do golden set feitas pela interface sem tocar no terminal", medido como está em
 * `eval/f87-medida-interface.md` (definição fixada ANTES de rodar). Contra a pilha real (que já está no ar) e só pelo navegador:
 * o selo de saúde, a caixa de pergunta e os botões de nota. Depois, o arquivo de feedback da API (`FEEDBACK_JSONL`) é lido para
 * conferir que as 5 notas foram gravadas. Grava `eval/resultados/f87-interface.json` (ids, contagens, estados e tempos; sem texto
 * do documento, ADR-009).
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";
import { PaginaChat } from "../../paginas/chat.ts";
import { perguntaDoGolden } from "../../paginas/golden.ts";

const ALVO = new URL("../../../eval/resultados/f87-interface.json", import.meta.url);
const ARQUIVO_FEEDBACK = process.env["FEEDBACK_JSONL"] ?? fileURLToPath(new URL("../../../data/avaliacao/f87-feedback.jsonl", import.meta.url));
const PERGUNTAS = ["T15", "N01", "G03", "P01", "F01"];
const COMENTARIO = "sem citação de página";

interface Registro {
  mensagemId?: string;
  nota?: number;
  comentario?: string;
}

test("5 perguntas do golden pela interface, com selo de saúde e nota em cada resposta", async ({ page }) => {
  test.setTimeout(1_800_000);
  const chat = new PaginaChat(page);
  const selo = page.getByRole("button", { name: /^Sistema:/ });
  const respostasDoFeedback: number[] = [];
  page.on("response", (r) => {
    if (r.url().endsWith("/api/feedback") && r.request().method() === "POST") respostasDoFeedback.push(r.status());
  });
  const corposDoFeedback: Record<string, unknown>[] = [];
  page.on("request", (r) => {
    if (r.url().endsWith("/api/feedback") && r.method() === "POST") corposDoFeedback.push(r.postDataJSON() as Record<string, unknown>);
  });

  await chat.abrir();
  await expect(selo).toHaveText("Sistema: no ar", { timeout: 30_000 });
  const seloAntes = await selo.innerText();

  const itens: Record<string, unknown>[] = [];
  for (const id of PERGUNTAS) {
    if (itens.length > 0) await chat.novaConversa.click();
    const t0 = Date.now();
    await chat.perguntar(perguntaDoGolden(id));
    await expect(chat.estado).toHaveText(/Resposta pronta\.|Não foi possível/, { timeout: 300_000 });
    const ms = Date.now() - t0;
    const terminou = /Resposta pronta\./.test(await chat.estado.innerText()) ? "pronta" : "erro";
    const resposta = chat.respostas.first();
    const chips = await resposta.getByRole("button", { name: /^Abrir a página \d+ do documento$/ }).count();
    const texto = (await resposta.innerText()).toLowerCase();
    const base = { pergunta: id, terminou, ms, citacoes: chips, textoNaoVazio: texto.trim().length > 0, dizNaoConsta: /não consta|não há|não encontr|não foi possível localizar/.test(texto) };
    if (terminou !== "pronta") {
      itens.push({ ...base, nota: null, registrada: false, motivo: "a resposta terminou em erro" });
      continue;
    }

    const nota = chips > 0 ? 1 : -1;
    const antes = respostasDoFeedback.length;
    const avaliacao = chat.avaliacao(0);
    await avaliacao.getByRole("button", { name: nota === 1 ? "Resposta útil" : "Resposta não útil", exact: true }).click();
    await expect(avaliacao.getByText("Nota registrada.")).toBeVisible({ timeout: 15_000 });
    if (nota === -1) {
      await avaliacao.getByRole("textbox", { name: "Comentário (opcional)" }).fill(COMENTARIO);
      await avaliacao.getByRole("button", { name: "Enviar comentário" }).click();
      await expect(avaliacao.getByText("Comentário registrado.")).toBeVisible({ timeout: 15_000 });
    }
    const statusDosPedidos = respostasDoFeedback.slice(antes);
    const mensagemId = String(corposDoFeedback.at(-1)?.["mensagemId"] ?? "");
    itens.push({ ...base, nota, mensagemId, pedidos: statusDosPedidos.length, todos201: statusDosPedidos.length > 0 && statusDosPedidos.every((s) => s === 201), registrada: true });
  }

  const seloDepois = await selo.innerText();

  // o arquivo de feedback, lido só depois do teste: a última linha de cada mensagemId vale
  const linhas = existsSync(ARQUIVO_FEEDBACK) ? readFileSync(ARQUIVO_FEEDBACK, "utf-8").split(/\r?\n/).filter((l) => l.trim() !== "") : [];
  const registros = linhas.map((l) => JSON.parse(l) as Registro);
  const gravados = itens.map((it) => {
    const doId = registros.filter((r) => r.mensagemId === it["mensagemId"]);
    const ultima = doId.at(-1);
    const notaOk = ultima?.nota === it["nota"];
    const comentarioOk = it["nota"] === -1 ? ultima?.comentario === COMENTARIO : ultima?.comentario === undefined;
    return { pergunta: it["pergunta"], linhasNoArquivo: doId.length, notaOk, comentarioOk, ok: it["registrada"] === true && notaOk && comentarioOk };
  });

  const cumpridas = itens.filter((it, i) => it["terminou"] === "pronta" && it["textoNaoVazio"] === true && it["registrada"] === true && it["todos201"] === true && gravados[i]?.ok === true).length;
  const resumo = {
    perguntas: PERGUNTAS,
    seloAntes,
    seloDepois,
    itens,
    gravados,
    resumo: { cumpridas: `${cumpridas} de ${PERGUNTAS.length}`, aceiteCumprido: cumpridas === PERGUNTAS.length && seloAntes === "Sistema: no ar", linhasNoArquivo: registros.length },
  };
  mkdirSync(new URL("./", ALVO), { recursive: true });
  writeFileSync(ALVO, `${JSON.stringify(resumo, null, 2)}\n`);
  console.log(JSON.stringify(resumo.resumo));
  expect(seloAntes).toBe("Sistema: no ar");
  expect(cumpridas, "perguntas que passaram pelos cinco passos (de 5)").toBe(PERGUNTAS.length);
});
