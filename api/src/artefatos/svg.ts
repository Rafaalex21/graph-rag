/**
 * O gráfico em SVG (F8.10), desenhado por nós, sem biblioteca de gráficos e sem script: só `<rect>`, `<line>`, `<polyline>` e
 * `<text>`. Todo texto que veio do modelo ou do documento passa por `escapar`. Barras ou linhas, uma série, com o eixo no zero
 * (valores negativos descem), números do documento sobre cada ponto e texto alternativo (`<title>` e `<desc>`).
 */
import type { Material } from "./especificacao.ts";

const LARGURA = 640;
const ALTURA = 380;
const M = { esq: 64, dir: 24, topo: 56, base: 64 };
const COR = "#0b6b5c";
const TEXTO = "#1b2b28";
const GRADE = "#d7dfdd";

export const escapar = (t: string): string => t.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] as string);

/** Passo "redondo" (1, 2, 5 × 10^n) para ~5 divisões entre `min` e `max`. */
export function passoRedondo(amplitude: number): number {
  if (!(amplitude > 0)) return 1;
  const bruto = amplitude / 5;
  const potencia = 10 ** Math.floor(Math.log10(bruto));
  const f = bruto / potencia;
  return (f <= 1 ? 1 : f <= 2 ? 2 : f <= 5 ? 5 : 10) * potencia;
}

const fmt = (n: number): string => new Intl.NumberFormat("pt-BR", { maximumFractionDigits: 2 }).format(n);

/** O texto que descreve o gráfico para quem não o vê (`alt` da imagem e `<desc>`). */
export function descricaoDoGrafico(m: Material): string {
  const itens = m.pontos.map((p) => `${p.rotulo}, ${p.escrito}`).join("; ");
  const unidade = m.unidade === "" ? "" : ` (${m.unidade})`;
  return `Gráfico de ${m.grafico === "barras" ? "barras" : "linhas"} de ${m.titulo.charAt(0).toLowerCase()}${m.titulo.slice(1)}: ${itens}${unidade}.`;
}

export function desenharGrafico(m: Material): string {
  const n = Math.max(m.pontos.length, 1);
  const valores = m.pontos.map((p) => p.valor);
  const minimo = Math.min(0, ...valores);
  const maximo = Math.max(0, ...valores);
  const passo = passoRedondo(maximo - minimo);
  const topo = Math.ceil(maximo / passo) * passo;
  const piso = Math.floor(minimo / passo) * passo;
  const faixa = topo - piso || 1;
  const areaL = LARGURA - M.esq - M.dir;
  const areaA = ALTURA - M.topo - M.base;
  const y = (v: number) => M.topo + ((topo - v) / faixa) * areaA;
  const largura = areaL / n;
  const cx = (i: number) => M.esq + largura * (i + 0.5);

  const partes: string[] = [];
  partes.push(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${LARGURA} ${ALTURA}" width="${LARGURA}" height="${ALTURA}" role="img" font-family="Inter, 'Segoe UI', Arial, sans-serif">`);
  partes.push(`<title>${escapar(m.titulo)}</title><desc>${escapar(descricaoDoGrafico(m))}</desc>`);
  partes.push(`<rect width="${LARGURA}" height="${ALTURA}" fill="#ffffff"/>`);
  partes.push(`<text x="${M.esq}" y="28" font-size="18" font-weight="700" fill="${TEXTO}">${escapar(m.titulo)}</text>`);
  if (m.unidade !== "") partes.push(`<text x="${M.esq}" y="46" font-size="12" fill="#4a5a57">${escapar(m.unidade)}</text>`);

  for (let v = piso; v <= topo + passo / 1000; v += passo) {
    partes.push(`<line x1="${M.esq}" x2="${LARGURA - M.dir}" y1="${y(v).toFixed(1)}" y2="${y(v).toFixed(1)}" stroke="${v === 0 ? TEXTO : GRADE}" stroke-width="${v === 0 ? 1.2 : 1}"/>`);
    partes.push(`<text x="${M.esq - 8}" y="${(y(v) + 4).toFixed(1)}" font-size="11" text-anchor="end" fill="#4a5a57">${escapar(fmt(v))}</text>`);
  }

  if (m.grafico === "barras") {
    const bw = Math.min(72, largura * 0.6);
    m.pontos.forEach((p, i) => {
      const y0 = y(0);
      const y1 = y(p.valor);
      partes.push(`<rect x="${(cx(i) - bw / 2).toFixed(1)}" y="${Math.min(y0, y1).toFixed(1)}" width="${bw.toFixed(1)}" height="${Math.max(Math.abs(y0 - y1), 1).toFixed(1)}" fill="${COR}"/>`);
    });
  } else {
    const pts = m.pontos.map((p, i) => `${cx(i).toFixed(1)},${y(p.valor).toFixed(1)}`).join(" ");
    if (m.pontos.length > 1) partes.push(`<polyline points="${pts}" fill="none" stroke="${COR}" stroke-width="2.5" stroke-linejoin="round"/>`);
    m.pontos.forEach((p, i) => partes.push(`<circle cx="${cx(i).toFixed(1)}" cy="${y(p.valor).toFixed(1)}" r="4.5" fill="${COR}"/>`));
  }

  m.pontos.forEach((p, i) => {
    const acima = p.valor >= 0;
    partes.push(`<text x="${cx(i).toFixed(1)}" y="${(y(p.valor) + (acima ? -10 : 18)).toFixed(1)}" font-size="12" font-weight="600" text-anchor="middle" fill="${TEXTO}">${escapar(p.escrito)}</text>`);
    const rotulo = p.rotulo.length > 18 ? `${p.rotulo.slice(0, 17)}…` : p.rotulo;
    partes.push(`<text x="${cx(i).toFixed(1)}" y="${ALTURA - M.base + 22}" font-size="12" text-anchor="middle" fill="${TEXTO}">${escapar(rotulo)}</text>`);
  });

  const paginas = [...new Set(m.pontos.map((p) => p.pagina))].join(", ");
  partes.push(`<text x="${M.esq}" y="${ALTURA - 12}" font-size="11" fill="#4a5a57">Fonte: Formulário de Referência, ${escapar(paginas)}</text>`);
  partes.push("</svg>");
  return partes.join("");
}
