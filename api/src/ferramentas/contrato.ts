/** Contrato comum das ferramentas de recuperação (ARQUITETURA §7.2): toda ferramenta devolve `evidencias[]`. */

export interface Evidencia {
  id: string;
  tipo: string;
  /** `p. 6`, `p. 6-7` ou `p. 6, 9, 12`; vazio quando não há página (nada é inventado). */
  paginas: string;
  caminho: string;
  texto: string;
  score: number;
}

export interface Envelope {
  ferramenta: string;
  parametros: Record<string, unknown>;
  evidencias: Evidencia[];
  aviso: string | null;
  erro: string | null;
  sugestoes: string[];
  omitido: Record<string, number>;
  latencia_ms: number;
}

export function envelope(ferramenta: string, parametros: Record<string, unknown> = {}): Envelope {
  return { ferramenta, parametros, evidencias: [], aviso: null, erro: null, sugestoes: [], omitido: {}, latencia_ms: 0 };
}

/** `p. 6`, `p. 6-7` (páginas seguidas) ou `p. 6, 9, 12`; vazio quando não há página. */
export function rotuloDePaginas(paginas: readonly (number | null | undefined)[]): string {
  const ordenadas = [...new Set(paginas.filter((p): p is number => p !== null && p !== undefined).map((p) => Math.trunc(p)))].sort((a, b) => a - b);
  const primeira = ordenadas[0];
  if (primeira === undefined) return "";
  const faixas: [number, number][] = [[primeira, primeira]];
  for (const p of ordenadas.slice(1)) {
    const ultima = faixas[faixas.length - 1] as [number, number];
    if (p === ultima[1] + 1) ultima[1] = p;
    else faixas.push([p, p]);
  }
  return `p. ${faixas.map(([a, b]) => (a === b ? String(a) : `${a}-${b}`)).join(", ")}`;
}

export function evidencia(
  id: string,
  tipo: string,
  paginas: readonly (number | null | undefined)[],
  caminho: string,
  texto: string,
  score = 1.0,
): Evidencia {
  return { id, tipo, paginas: rotuloDePaginas(paginas), caminho, texto, score };
}

export interface ChamadaFerramenta {
  nome: string;
  argumentos: Record<string, unknown>;
}
