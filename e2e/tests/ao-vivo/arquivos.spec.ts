/**
 * F8.10 ao vivo: o aceite "pedidos de gráfico, tabela, planilha, documento e apresentação voltam o material e o arquivo, todo número
 * de dado citado com a página, e 'não consta' quando o documento não tem o dado", medido como está em
 * `eval/f810-medida-geracao.md` (definição fixada ANTES de rodar). Contra a pilha real (que já está no ar) e só pelo navegador, pela
 * tela `/assistente`. Cada arquivo é baixado pelo link da tela e RELIDO por biblioteca (exceljs no `.xlsx`; zip + XML bem formado
 * no `.docx` e no `.pptx`). Grava `eval/resultados/f810-geracao.json` (ids, valores do gabarito, contagens e tempos; sem texto do
 * documento, ADR-009).
 */
import { readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import ExcelJS from "exceljs";
import JSZip from "jszip";
import { expect, test, type Page } from "@playwright/test";
import { problemas } from "../../../api/test/http/contrato.ts";
import { PaginaAssistente } from "../../paginas/assistente.ts";

/**
 * Conjunto de pedidos: "A" (padrão, `eval/f810-medida-geracao.md`, página fixa 93) ou "B" (`eval/f810b-medida-geracao.md`, páginas
 * aceitas = as das tabelas do PDF com a linha completa, calculadas antes de rodar). Escolhido por `F810_CONJUNTO=B`.
 */
const CONJUNTO = process.env["F810_CONJUNTO"] === "B" ? "B" : "A";
const ALVO = new URL(CONJUNTO === "B" ? "../../../eval/resultados/f810b-geracao.json" : "../../../eval/resultados/f810-geracao.json", import.meta.url);
const TABELAS = new URL("../../../data/parsed/banco_do_brasil_formulario_referencia_2026.tabelas.json", import.meta.url);

/**
 * Pós-hoc (rodada 3, ver `eval/f810-medida-geracao.md`): o valor da tela está numa tabela do PDF na página que a célula cita? Lê as
 * tabelas extraídas do próprio documento (`data/parsed`, fora do git). Só informativo: a regra de aceite continua pedindo `p. 93`.
 */
let tabelasDoPdf: { paginas: number[]; markdown: string }[] | null = null;
function valorNaPaginaCitada(rotuloDePagina: string, escrito: string): boolean | null {
  try {
    tabelasDoPdf ??= JSON.parse(readFileSync(TABELAS, "utf8").replace(/^﻿/, "")) as { paginas: number[]; markdown: string }[];
  } catch {
    return null;
  }
  const paginas = [...rotuloDePagina.matchAll(/\d+/g)].map((m) => Number(m[0]));
  return tabelasDoPdf.some((t) => t.paginas.some((p) => paginas.includes(p)) && t.markdown.includes(escrito));
}

/** O gabarito do golden (pág. 93, R$ milhões, 2023 / 2024 / 2025): N01 e G09 para o lucro, N02 para a receita de juros. */
interface Gabarito {
  rotulos: string[];
  valores: number[];
  /** Como o documento escreve cada valor (para achar no `.docx` e no `.pptx`). */
  escritos: string[];
  /** Páginas aceitas: toda página citada por toda célula tem de estar aqui. */
  paginas: number[];
}
const ANOS = ["2023", "2024", "2025"];
const LUCRO: Gabarito = { rotulos: ANOS, valores: [33166, 29172, 16782], escritos: ["33.166", "29.172", "16.782"], paginas: [93] };
const JUROS: Gabarito = { rotulos: ANOS, valores: [88749, 104514, 101011], escritos: ["88.749", "104.514", "101.011"], paginas: [93] };
// conjunto B (eval/f810b-medida-geracao.md): páginas das tabelas do PDF com a linha completa em células seguidas
const DEPOSITOS: Gabarito = { rotulos: ANOS, valores: [811944, 873711, 897937], escritos: ["811.944", "873.711", "897.937"], paginas: [83] };
const ATIVO: Gabarito = { rotulos: ANOS, valores: [2153878, 2398719, 2455143], escritos: ["2.153.878", "2.398.719", "2.455.143"], paginas: [80] };
const NAO_JUROS: Gabarito = { rotulos: ANOS, valores: [50740, 54152, 53788], escritos: ["50.740", "54.152", "53.788"], paginas: [93] };
const LPA: Gabarito = { rotulos: ANOS, valores: [5.23, 4.62, 2.4], escritos: ["5,23", "4,62", "2,40"], paginas: [80] };

interface Pedido {
  id: string;
  texto: string;
  gabarito: Gabarito | null;
  /** O formato do arquivo pedido (o gráfico em SVG também conta no A1). */
  arquivo: "svg" | "xlsx" | "docx" | "pptx" | null;
  rotuloDoLink: RegExp | null;
  grafico: boolean;
}

const PEDIDOS_B: Pedido[] = [
  { id: "B1", texto: "Faça um gráfico dos depósitos totais de 2023 a 2025.", gabarito: DEPOSITOS, arquivo: "svg", rotuloDoLink: /Baixar gráfico \(\.svg\)/, grafico: true },
  { id: "B2", texto: "Monte uma tabela e uma planilha com o ativo total de 2023 a 2025.", gabarito: ATIVO, arquivo: "xlsx", rotuloDoLink: /Baixar planilha \(\.xlsx\)/, grafico: false },
  { id: "B3", texto: "Gere um documento Word com as receitas não de juros de 2023 a 2025.", gabarito: NAO_JUROS, arquivo: "docx", rotuloDoLink: /Baixar documento \(\.docx\)/, grafico: false },
  { id: "B4", texto: "Faça uma apresentação com o lucro por ação de 2023 a 2025.", gabarito: LPA, arquivo: "pptx", rotuloDoLink: /Baixar apresentação \(\.pptx\)/, grafico: true },
  { id: "B5", texto: "Faça um gráfico do lucro líquido do Magazine Luiza de 2023 a 2025.", gabarito: null, arquivo: null, rotuloDoLink: null, grafico: false },
];

const PEDIDOS_A: Pedido[] = [
  { id: "A1", texto: "Faça um gráfico do lucro líquido do exercício de 2023 a 2025.", gabarito: LUCRO, arquivo: "svg", rotuloDoLink: /Baixar gráfico \(\.svg\)/, grafico: true },
  { id: "A2", texto: "Monte uma tabela e uma planilha com a receita líquida de juros de 2023 a 2025.", gabarito: JUROS, arquivo: "xlsx", rotuloDoLink: /Baixar planilha \(\.xlsx\)/, grafico: false },
  { id: "A3", texto: "Gere um documento Word com o lucro líquido do exercício de 2023 a 2025.", gabarito: LUCRO, arquivo: "docx", rotuloDoLink: /Baixar documento \(\.docx\)/, grafico: false },
  { id: "A4", texto: "Faça uma apresentação com o lucro líquido do exercício de 2023 a 2025.", gabarito: LUCRO, arquivo: "pptx", rotuloDoLink: /Baixar apresentação \(\.pptx\)/, grafico: true },
  { id: "A5", texto: "Faça um gráfico do lucro líquido do Santander Brasil de 2023 a 2025.", gabarito: null, arquivo: null, rotuloDoLink: null, grafico: false },
];
const PEDIDOS = CONJUNTO === "B" ? PEDIDOS_B : PEDIDOS_A;

interface Quadro {
  evento: string;
  dados: Record<string, unknown>;
}

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

/** "33.166" → 33166 (número do documento: ponto nos milhares, vírgula nos decimais). */
const numeroDoTexto = (t: string) => Number(t.replace(/\./g, "").replace(",", "."));
const perto = (a: number, b: number) => Math.abs(a - b) <= 0.005 * Math.max(Math.abs(a), Math.abs(b));
/** O valor está no texto como número, em pt-BR ou escrito como no documento (por exemplo "2,40"). */
const contem = (texto: string, valores: number[], escritos: string[]) =>
  valores.every((v, i) => texto.includes(String(v)) || texto.includes(new Intl.NumberFormat("pt-BR").format(v)) || (escritos[i] !== undefined && texto.includes(escritos[i]!)));

/** O XML tem de ser bem formado: quem decide é o DOMParser do navegador (o Node não traz um). */
async function xmlBemFormado(page: Page, xml: string): Promise<boolean> {
  return page.evaluate((x) => new DOMParser().parseFromString(x, "application/xml").getElementsByTagName("parsererror").length === 0, xml);
}

/** Relê o arquivo baixado: devolve se abriu, se tem os valores do gabarito e o que mais foi conferido. */
async function reler(page: Page, formato: "svg" | "xlsx" | "docx" | "pptx", caminho: string, valores: number[], escritos: string[]): Promise<{ abriu: boolean; valoresNoArquivo: boolean; partes: number | null; detalhe: string }> {
  const bytes = readFileSync(caminho);
  if (formato === "svg") {
    const texto = bytes.toString("utf8");
    const ok = texto.startsWith("<svg") && (await xmlBemFormado(page, texto));
    return { abriu: ok, valoresNoArquivo: contem(texto, valores, escritos), partes: null, detalhe: "svg lido como XML" };
  }
  if (formato === "xlsx") {
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(bytes as unknown as ArrayBuffer);
    const numeros: number[] = [];
    wb.eachSheet((ws) => ws.eachRow((r) => r.eachCell((c) => typeof c.value === "number" && numeros.push(c.value))));
    return { abriu: wb.worksheets.length > 0, valoresNoArquivo: valores.every((v) => numeros.some((n) => perto(n, v))), partes: wb.worksheets.length, detalhe: `${numeros.length} células numéricas` };
  }
  const zip = await JSZip.loadAsync(bytes);
  const nomes = Object.keys(zip.files).filter((n) => !zip.files[n]!.dir);
  const xmls = nomes.filter((n) => n.endsWith(".xml") || n.endsWith(".rels"));
  let bemFormados = 0;
  let todoTexto = "";
  for (const n of xmls) {
    const xml = await zip.files[n]!.async("string");
    if (await xmlBemFormado(page, xml)) bemFormados++;
    if (/^(word\/document|ppt\/slides\/slide\d+|ppt\/charts\/chart\d+)\.xml$/.test(n)) todoTexto += ` ${xml.replace(/<[^>]+>/g, " ")}`;
  }
  const temTipos = nomes.includes("[Content_Types].xml");
  const abriu = temTipos && xmls.length > 0 && bemFormados === xmls.length;
  return { abriu, valoresNoArquivo: contem(todoTexto, valores, escritos), partes: nomes.length, detalhe: `${bemFormados} de ${xmls.length} partes XML bem formadas` };
}

test(`${CONJUNTO}: 5 pedidos pela tela do assistente: material com valores do gabarito e página, arquivo relido e 'não consta' sem dado`, async ({ page }) => {
  test.setTimeout(1_800_000);
  const a = new PaginaAssistente(page);

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
  for (const p of PEDIDOS) {
    if (itens.length > 0) await a.novaConversa.click();
    const t0 = Date.now();
    await a.perguntar(p.texto);
    await expect(a.estado).toHaveText(/Resposta pronta\.|Não foi possível/, { timeout: 300_000 });
    const ms = Date.now() - t0;
    const terminou = /Resposta pronta\./.test(await a.estado.innerText()) ? "pronta" : "erro";
    const indice = itens.length;
    await page.waitForFunction((i) => (window as unknown as { __sse: { fim: boolean }[] }).__sse[i]?.fim === true, indice, { timeout: 60_000 });
    const quadros = lerQuadros(await page.evaluate((i) => (window as unknown as { __sse: { texto: string }[] }).__sse[i]?.texto ?? "", indice));
    const evento = quadros.find((q) => q.evento === "artefato")?.dados;
    const fim = quadros.find((q) => q.evento === "fim")?.dados as { metricas?: { latenciaMs?: number; estado?: string }; resposta?: string } | undefined;
    const base = { pedido: p.id, terminou, ms, latenciaDaApiMs: fim?.metricas?.latenciaMs ?? null, estadoDoFim: fim?.metricas?.estado ?? null, eventoArtefato: evento !== undefined };
    if (terminou !== "pronta") {
      itens.push({ ...base, ok: false, motivo: "a resposta terminou em erro" });
      continue;
    }

    // A5: o documento não tem o dado → sem gráfico, tabela nem arquivo, e a resposta diz que não consta
    if (p.gabarito === null) {
      const material = await a.artefato().count();
      const tabelas = await a.respostas.first().getByRole("table").count();
      const links = await a.respostas.first().getByRole("link", { name: /Baixar/ }).count();
      const texto = (await a.respostas.first().innerText()).replace(/\s+/g, " ");
      const dizNaoConsta = /não consta|não encontrei|não traz|não há/i.test(texto);
      const ok = evento === undefined && material === 0 && tabelas === 0 && links === 0 && dizNaoConsta;
      itens.push({ ...base, material, tabelas, links, dizNaoConsta, ok });
      continue;
    }

    // contrato: o evento `artefato` da API de verdade confere com o esquema
    const problemasDoContrato = evento ? problemas("EventoArtefato", evento) : ["a API não mandou o evento artefato"];

    const m = a.artefato();
    const material = await m.count();
    if (material === 0) {
      itens.push({ ...base, material, problemasDoContrato, ok: false, motivo: "nenhum material na tela" });
      continue;
    }
    // valores: a tabela da tela, na ordem, com a página
    const linhas = m.getByRole("table").getByRole("row");
    const n = (await linhas.count()) - 1;
    const celulas: string[][] = [];
    for (let i = 1; i <= n; i++) celulas.push(await linhas.nth(i).getByRole("cell").allInnerTexts());
    const rotulosOk = celulas.length === p.gabarito.rotulos.length && celulas.every((c, i) => c[0]?.trim() === p.gabarito!.rotulos[i]);
    const valoresOk = celulas.length === p.gabarito.valores.length && celulas.every((c, i) => perto(numeroDoTexto(c[1] ?? ""), p.gabarito!.valores[i]!));
    // toda célula cita pelo menos uma página e TODAS as páginas citadas estão entre as aceitas do pedido
    const paginasDaCelula = (c: string[]) => [...(c[2] ?? "").matchAll(/\d+/g)].map((m) => Number(m[0]));
    const paginasOk = celulas.length > 0 && celulas.every((c) => paginasDaCelula(c).length > 0 && paginasDaCelula(c).every((n) => p.gabarito!.paginas.includes(n)));
    const paginasCitadas = celulas.map((c) => c[2]?.trim() ?? "");
    const paginasNoPdf = celulas.map((c) => valorNaPaginaCitada(c[2] ?? "", (c[1] ?? "").trim()));

    // gráfico na tela
    let graficoOk: boolean | null = null;
    if (p.grafico) {
      const img = m.getByRole("img");
      graficoOk = (await img.count()) === 1 && (await img.evaluate((i: HTMLImageElement) => i.complete && i.naturalWidth > 0).catch(() => false));
      if (p.id === "A1" || p.id === "B1") {
        mkdirSync(new URL("../../../data/avaliacao/", import.meta.url), { recursive: true });
        await m.screenshot({ path: fileURLToPath(new URL(`../../../data/avaliacao/f810-material-${p.id.toLowerCase()}.png`, import.meta.url)) });
      }
    }

    // arquivo: baixa pelo link, confere o MIME e o tamanho pela API e relê
    let arquivo: Record<string, unknown> | null = null;
    if (p.rotuloDoLink && p.arquivo) {
      const link = a.baixar(p.rotuloDoLink);
      const href = (await link.getAttribute("href")) ?? "";
      const cabecalhos = await page.evaluate(async (h) => {
        const r = await fetch(h);
        return { status: r.status, tipo: r.headers.get("content-type"), bytes: (await r.arrayBuffer()).byteLength };
      }, href);
      const [baixado] = await Promise.all([page.waitForEvent("download"), link.click()]);
      const caminho = (await baixado.path()) as string;
      const lido = await reler(page, p.arquivo, caminho, p.gabarito.valores, p.gabarito.escritos);
      arquivo = { formato: p.arquivo, nome: baixado.suggestedFilename(), ...cabecalhos, ...lido };
    }
    const arquivoOk = arquivo === null ? true : arquivo["status"] === 200 && (arquivo["bytes"] as number) > 0 && (arquivo["bytes"] as number) <= 5 * 1024 * 1024 && arquivo["abriu"] === true && arquivo["valoresNoArquivo"] === true;
    // o A1 pede só o gráfico: o `.svg` conta como o arquivo dele. A2 a A4: o formato pedido tem de estar na lista de links.
    const removidos = typeof evento?.["removidos"] === "number" ? evento["removidos"] : null;
    const ok = problemasDoContrato.length === 0 && rotulosOk && valoresOk && paginasOk && (graficoOk === null || graficoOk) && arquivoOk;
    itens.push({ ...base, problemasDoContrato, celulas: celulas.length, rotulosOk, valoresOk, paginasOk, paginasCitadas, paginasNoPdf, graficoNaTela: graficoOk, removidos, arquivo, arquivoOk, ok });
  }

  const cumpridos = itens.filter((it) => it["ok"] === true).length;
  const resumo = { pedidos: PEDIDOS.map((p) => p.id), itens, resumo: { cumpridos: `${cumpridos} de ${PEDIDOS.length}`, aceiteCumprido: cumpridos === PEDIDOS.length } };
  mkdirSync(new URL("./", ALVO), { recursive: true });
  writeFileSync(ALVO, `${JSON.stringify(resumo, null, 2)}\n`);
  console.log(JSON.stringify(resumo.resumo));
  expect(cumpridos, "pedidos que passaram por todos os itens que se aplicam (de 5)").toBe(PEDIDOS.length);
});
