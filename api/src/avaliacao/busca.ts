/**
 * Peças da medida das buscas (F7.9): leitura do golden CSV, páginas de um rótulo (`p. 6-7, 9`) e page recall@k
 * (a mesma conta de `indexer.metricas.page_recall`, F3.3).
 */

/** CSV (RFC 4180): campos com vírgula, aspas duplicadas e quebras de linha; ignora BOM e linhas em branco. */
export function lerCsv(texto: string): Record<string, string>[] {
  const linhas: string[][] = [];
  let campo = "";
  let linha: string[] = [];
  let aspas = false;
  const t = texto.charCodeAt(0) === 0xfeff ? texto.slice(1) : texto; // BOM do Excel e do Bloco de Notas
  for (let i = 0; i < t.length; i++) {
    const c = t[i] as string;
    if (aspas) {
      if (c === '"' && t[i + 1] === '"') {
        campo += '"';
        i++;
      } else if (c === '"') aspas = false;
      else campo += c;
    } else if (c === '"') aspas = true;
    else if (c === ",") {
      linha.push(campo);
      campo = "";
    } else if (c === "\n" || c === "\r") {
      if (c === "\r" && t[i + 1] === "\n") i++;
      linha.push(campo);
      linhas.push(linha);
      campo = "";
      linha = [];
    } else campo += c;
  }
  if (campo !== "" || linha.length > 0) {
    linha.push(campo);
    linhas.push(linha);
  }
  const [cabecalho, ...resto] = linhas;
  if (!cabecalho) return [];
  return resto.filter((l) => l.length > 1 || (l[0] ?? "") !== "").map((l) => Object.fromEntries(cabecalho.map((k, j) => [k, l[j] ?? ""])));
}

const FAIXA_MAXIMA = 20; // como `ask.paginas_de`: faixa maior que isso conta só as pontas

/** As páginas de um rótulo do contrato (`p. 80`, `p. 156-157`, `p. 6-7, 9`); rótulo vazio dá conjunto vazio. */
export function paginasDoRotulo(rotulo: string): Set<number> {
  const saida = new Set<number>();
  for (const parte of rotulo.replace(/^\s*p\.?\s*/i, "").split(/[,;]| a /)) {
    const m = /^\s*(\d+)\s*(?:[-–]\s*(\d+))?\s*$/.exec(parte);
    if (!m) continue;
    const a = Number(m[1]);
    const b = Number(m[2] ?? m[1]);
    if (b - a < FAIXA_MAXIMA) for (let p = a; p <= Math.max(a, b); p++) saida.add(p);
    else {
      saida.add(a);
      saida.add(b);
    }
  }
  return saida;
}

/** A coluna `paginas` do golden: `80|81`. */
export function paginasDoGabarito(coluna: string): number[] {
  return coluna
    .split("|")
    .map((p) => p.trim())
    .filter((p) => p !== "")
    .map(Number);
}

/** Por k: recall (páginas do gabarito cobertas pelos k primeiros trechos / total) e acerto (alguma coberta). */
export function pageRecall(gabarito: readonly number[], trechos: readonly ReadonlySet<number>[], ks: readonly number[]): Record<number, { recall: number; acerto: number }> {
  const gold = new Set(gabarito);
  const saida: Record<number, { recall: number; acerto: number }> = {};
  for (const k of ks) {
    const vistas = new Set<number>();
    for (const t of trechos.slice(0, k)) for (const p of t) vistas.add(p);
    const achadas = [...gold].filter((p) => vistas.has(p)).length;
    saida[k] = { recall: gold.size === 0 ? 0 : achadas / gold.size, acerto: achadas > 0 ? 1 : 0 };
  }
  return saida;
}
