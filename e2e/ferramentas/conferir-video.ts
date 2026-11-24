/**
 * F10.3: confere o vídeo montado por `montar-video.ts` (checagens 1 e 6 de `eval/f103-roteiro-video.md`). Toca o WebM no Edge
 * em 8× para medir a duração real (o WebM do MediaRecorder não grava a duração no cabeçalho) e depois, em 1×, tira uma captura
 * a cada `--cada` segundos em `data/video/conferencia/` para ver os quadros-chave.
 *
 *   node ferramentas/conferir-video.ts [--cada 10]       (a partir de e2e/)
 */
import { mkdirSync, readFileSync, rmSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { chromium, type Page } from "@playwright/test";

const i = process.argv.indexOf("--cada");
const CADA_S = i > 0 ? Number(process.argv[i + 1]) : 10;
const VIDEO = new URL("../../data/video/", import.meta.url);
const SAIDA = new URL("conferencia/", VIDEO);
const bytes = readFileSync(new URL("graphrag-local.webm", VIDEO));

const navegador = await chromium.launch({ channel: process.env["CI"] ? undefined : "msedge" });
async function abrir(): Promise<Page> {
  const p = await navegador.newPage({ viewport: { width: 1440, height: 964 } });
  await p.route("http://video.local/**", (r) =>
    r.request().url().endsWith(".webm")
      ? r.fulfill({ contentType: "video/webm", body: bytes })
      : r.fulfill({ contentType: "text/html", body: "<!doctype html><body style=margin:0><video src=/v.webm muted style=width:1440px></video>" }),
  );
  await p.goto("http://video.local/");
  return p;
}
const tempo = (p: Page) => p.locator("video").evaluate((e: HTMLVideoElement) => ({ t: e.currentTime, fim: e.ended }));

// 1) duração real, tocando em 8×
const rapida = await abrir();
await rapida.locator("video").evaluate((e: HTMLVideoElement) => {
  e.playbackRate = 8;
  return e.play();
});
let estado = await tempo(rapida);
while (!estado.fim) {
  await rapida.waitForTimeout(250);
  estado = await tempo(rapida);
}
const duracaoS = estado.t;
await rapida.close();

// 2) quadros-chave em 1×
rmSync(SAIDA, { recursive: true, force: true });
mkdirSync(SAIDA, { recursive: true });
const normal = await abrir();
await normal.locator("video").evaluate((e: HTMLVideoElement) => e.play());
const capturas: string[] = [];
for (let alvo = 1; alvo < duracaoS; alvo += CADA_S) {
  while ((await tempo(normal)).t < alvo && !(await tempo(normal)).fim) await normal.waitForTimeout(100);
  const nome = `t${String(Math.round(alvo)).padStart(3, "0")}.png`;
  await normal.screenshot({ path: fileURLToPath(new URL(nome, SAIDA)) });
  capturas.push(nome);
}
await navegador.close();
console.log(JSON.stringify({ duracaoS: Number(duracaoS.toFixed(1)), dentroDe3min: duracaoS <= 180, capturas: capturas.length, pasta: "data/video/conferencia" }));
