/**
 * F10.3: monta o vídeo de demonstração a partir dos quadros de `tests/ao-vivo/video.spec.ts` (roteiro em
 * `eval/f103-roteiro-video.md`). Sem ffmpeg e sem baixar nada: o Edge do Windows desenha os quadros num <canvas> e o
 * `MediaRecorder` grava o WebM (VP9) em tempo real.
 *
 * - Quadros iguais em sequência viram um só, e nenhum quadro parado fica mais que `--pausa` segundos (padrão 1,2 s).
 * - Depois disso, se ainda passar de `--alvo` segundos (padrão 165, fora os cartões), tudo é acelerado por igual e a faixa
 *   diz quanto ("acelerado N×"). Se nem assim couber em 3:00 (acelerando no máximo 4×), falha.
 * - Cartão de abertura e cartão final com os números da v1; faixa no rodapé com a legenda da cena e a fonte do documento.
 *
 *   node ferramentas/montar-video.ts [--pausa 1.2] [--alvo 165]       (a partir de e2e/)
 *
 * Grava `data/video/graphrag-local.webm` e `data/video/montagem.json` (duração, aceleração, quadros), fora do git (ADR-009).
 */
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { chromium } from "@playwright/test";

const argumento = (nome: string, padrao: number) => {
  const i = process.argv.indexOf(`--${nome}`);
  return i > 0 ? Number(process.argv[i + 1]) : padrao;
};
const PAUSA_S = argumento("pausa", 1.2);
const ALVO_S = argumento("alvo", 165);
const CARTAO_S = 5;
const LIMITE_S = 180;
const MAX_ACELERACAO = 4;

const VIDEO = new URL("../../data/video/", import.meta.url);
const QUADROS = new URL("quadros/", VIDEO);
const { intervaloMs, marcas } = JSON.parse(readFileSync(new URL("marcas.json", QUADROS), "utf-8")) as {
  intervaloMs: number;
  marcas: { quadro: number; cena: number; legenda: string; segurarS?: number }[];
};
const arquivos = readdirSync(QUADROS)
  .filter((f) => f.endsWith(".jpg"))
  .sort();
if (arquivos.length === 0) throw new Error("Sem quadros em data/video/quadros: rode antes o @video.");

// 1) quadros iguais em sequência (da mesma marca) viram um só; a pausa máxima vale para cada quadro: o `segurarS` da marca
//    (espera feita para o espectador ler, errata 1 do roteiro) ou, sem ele, `--pausa`
const marcaDo = (i: number) => marcas.findLastIndex((m) => m.quadro <= i);
const unicos: { arquivo: string; ms: number; legenda: string; marca: number }[] = [];
let anterior: Buffer | null = null;
arquivos.forEach((arquivo, i) => {
  const bytes = readFileSync(new URL(arquivo, QUADROS));
  const ultimo = unicos.at(-1);
  const marca = marcaDo(i);
  if (anterior && ultimo && bytes.equals(anterior) && marca === ultimo.marca) ultimo.ms += intervaloMs;
  else unicos.push({ arquivo, ms: intervaloMs, legenda: marcas[marca]?.legenda ?? "", marca });
  anterior = bytes;
});
for (const u of unicos) u.ms = Math.min(u.ms, (marcas[u.marca]?.segurarS ?? PAUSA_S) * 1000);

// 2) aceleração uniforme até caber no alvo
const realS = unicos.reduce((s, u) => s + u.ms, 0) / 1000;
const aceleracao = Math.max(1, Math.ceil((realS / ALVO_S) * 10) / 10);
if (aceleracao > MAX_ACELERACAO) throw new Error(`Precisaria acelerar ${aceleracao}× (máx. ${MAX_ACELERACAO}×): grave cenas mais curtas.`);
for (const u of unicos) u.ms = u.ms / aceleracao;
const totalS = unicos.reduce((s, u) => s + u.ms, 0) / 1000 + 2 * CARTAO_S;
if (totalS > LIMITE_S) throw new Error(`O vídeo daria ${totalS.toFixed(1)} s (limite ${LIMITE_S}).`);

const FONTE = `Banco do Brasil S.A., Formulário de Referência 2026 (v7, CVM)  ·  modelos locais, sem rede  ·  esperas encurtadas${aceleracao > 1 ? `, acelerado ${aceleracao.toLocaleString("pt-BR")}×` : ""}`;
const ABERTURA = ["GraphRAG 100% local", "perguntas sobre um documento de 423 páginas, com a página de cada afirmação", "Radeon RX 9070 16 GB · 32 GB de RAM · nada sai da máquina na consulta"];
const FIM = ["Correção no golden de 60 perguntas: busca vetorial 0,54 → agente com grafo 0,87", "Em 24 perguntas novas, nunca usadas para ajustar: 0,48 → 0,77", "Código, decisões (ADRs) e medidas no repositório"];

const navegador = await chromium.launch({ channel: process.env["CI"] ? undefined : "msedge" });
const pagina = await navegador.newPage({ acceptDownloads: true });
await pagina.route("http://video.local/**", async (rota) => {
  const nome = new URL(rota.request().url()).pathname.slice(1);
  if (nome === "") return rota.fulfill({ contentType: "text/html", body: "<!doctype html><meta charset=utf-8><body style=margin:0;background:#000>" });
  return rota.fulfill({ contentType: "image/jpeg", body: readFileSync(new URL(nome, QUADROS)) });
});
await pagina.goto("http://video.local/");
pagina.setDefaultTimeout(0);

const download = pagina.waitForEvent("download", { timeout: (totalS + 120) * 1000 });
await pagina.evaluate(
  async ({ unicos, FONTE, ABERTURA, FIM, CARTAO_S }) => {
    const L = 1440;
    const A = 900;
    const FAIXA = 64;
    const canvas = document.createElement("canvas");
    canvas.width = L;
    canvas.height = A + FAIXA;
    document.body.append(canvas);
    const g = canvas.getContext("2d")!;
    const fundo = "#131a25";
    const claro = "#e5e9f1";

    const cartao = (linhas: string[]) => {
      g.fillStyle = fundo;
      g.fillRect(0, 0, L, A + FAIXA);
      g.fillStyle = claro;
      g.textAlign = "center";
      linhas.forEach((t, i) => {
        // diminui a fonte até a linha caber, com 60 px de margem de cada lado (errata 1: o título da g1 passava das bordas)
        let px = i === 0 ? 52 : 28;
        do g.font = `${i === 0 ? "600 " : ""}${px}px 'Segoe UI', sans-serif`;
        while (g.measureText(t).width > L - 120 && --px > 12);
        g.fillText(t, L / 2, (A + FAIXA) / 2 - 60 + i * 64);
      });
      g.textAlign = "left";
    };
    const quadro = (img: HTMLImageElement, legenda: string) => {
      g.drawImage(img, 0, 0, L, A);
      g.fillStyle = fundo;
      g.fillRect(0, A, L, FAIXA);
      g.fillStyle = claro;
      g.font = "600 21px 'Segoe UI', sans-serif";
      g.fillText(legenda, 14, A + 27);
      g.font = "14px 'Segoe UI', sans-serif";
      g.fillStyle = "#aab3c2";
      g.fillText(FONTE, 14, A + 51);
    };
    const carregar = (arquivo: string) =>
      new Promise<HTMLImageElement>((ok, erro) => {
        const img = new Image();
        img.onload = () => ok(img);
        img.onerror = erro;
        img.src = `http://video.local/${arquivo}`;
      });
    const espera = (ms: number) => new Promise((ok) => setTimeout(ok, ms));
    // o captureStream só manda quadro quando o canvas é pintado: sem repintar, o último cartão ficaria com duração zero
    let pintar = () => {};
    const repintura = setInterval(() => pintar(), 100);

    const fluxo = canvas.captureStream(30);
    const gravador = new MediaRecorder(fluxo, { mimeType: "video/webm;codecs=vp9", videoBitsPerSecond: 3_000_000 });
    const pedacos: Blob[] = [];
    gravador.ondataavailable = (e) => e.data.size && pedacos.push(e.data);
    const parado = new Promise((ok) => (gravador.onstop = ok));

    // pré-carrega à frente para não travar a reprodução
    const fila = new Map<number, Promise<HTMLImageElement>>();
    const pedir = (i: number) => {
      if (i < unicos.length && !fila.has(i)) fila.set(i, carregar(unicos[i]!.arquivo));
    };
    for (let i = 0; i < 30; i++) pedir(i);
    await fila.get(0);

    pintar = () => cartao(ABERTURA);
    pintar();
    gravador.start(1000);
    await espera(CARTAO_S * 1000);
    const t0 = performance.now();
    let fimPrevisto = 0;
    for (let i = 0; i < unicos.length; i++) {
      pedir(i + 30);
      const img = await fila.get(i)!;
      fila.delete(i);
      const legenda = unicos[i]!.legenda;
      pintar = () => quadro(img, legenda);
      pintar();
      fimPrevisto += unicos[i]!.ms;
      await espera(Math.max(0, fimPrevisto - (performance.now() - t0)));
    }
    pintar = () => cartao(FIM);
    pintar();
    await espera(CARTAO_S * 1000);
    clearInterval(repintura);
    gravador.stop();
    await parado;
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob(pedacos, { type: "video/webm" }));
    a.download = "graphrag-local.webm";
    a.click();
  },
  { unicos, FONTE, ABERTURA, FIM, CARTAO_S },
);
const destino = fileURLToPath(new URL("graphrag-local.webm", VIDEO));
await (await download).saveAs(destino);
await navegador.close();

const resumo = { quadrosGravados: arquivos.length, quadrosUnicos: unicos.length, tempoRealS: realS, aceleracao, pausaMaxS: PAUSA_S, duracaoS: Number(totalS.toFixed(1)), arquivo: "data/video/graphrag-local.webm" };
writeFileSync(new URL("montagem.json", VIDEO), `${JSON.stringify(resumo, null, 2)}\n`);
console.log(JSON.stringify(resumo));
