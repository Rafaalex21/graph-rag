/** Normalização de texto igual à do indexador (`indexer.importar.normalizar`): é o que casa nomes, métricas e cargos. */

/** Minúsculas, sem acento, só letras e dígitos separados por um espaço. */
export function normalizar(texto: string | null | undefined): string {
  const semAcento = (texto ?? "").normalize("NFKD").replace(/\P{ASCII}/gu, "");
  return (semAcento.toLowerCase().match(/[a-z0-9]+/g) ?? []).join(" ");
}

export function tokens(texto: string | null | undefined): string[] {
  const n = normalizar(texto);
  return n === "" ? [] : n.split(" ");
}

// palavras que podem sobrar numa busca por nome, cargo ou tema sem mudar o que se pede
export const SOBRAS_DE_BUSCA: ReadonlySet<string> = new Set([
  "de", "da", "do", "das", "dos", "e", "o", "a", "os", "as", "em", "no", "na", "nos", "nas", "para", "por", "com",
  "que", "um", "uma", "sobre", "qual", "quais", "s", "sa", "ltda",
]);

/** Dobra plural e flexão de gênero dos cargos: "diretoras" e "diretor" → "diretor". */
export function raiz(token: string): string {
  let t = token;
  if (t.length > 3 && t.endsWith("s")) t = t.slice(0, -1);
  if (t.endsWith("ora")) return t.slice(0, -1);
  if (t.endsWith("eira")) return `${t.slice(0, -1)}o`;
  return t;
}

export function raizes(texto: string | null | undefined): Set<string> {
  return new Set(tokens(texto).filter((t) => !SOBRAS_DE_BUSCA.has(t)).map(raiz));
}

/** O pedido casa o candidato quando todas as suas palavras (sem caixa nem acento) estão nele. */
export function casaTexto(pedido: string, candidato: string | null | undefined): boolean {
  const p = tokens(pedido).filter((t) => !SOBRAS_DE_BUSCA.has(t));
  if (p.length === 0) return false;
  const c = new Set(tokens(candidato));
  return p.every((t) => c.has(t));
}

/** `a ⊆ b`. */
export function contidoEm<T>(a: ReadonlySet<T>, b: ReadonlySet<T>): boolean {
  for (const x of a) if (!b.has(x)) return false;
  return true;
}

type Elemento = string | number;

/** Comparação de tuplas como a do Python: elemento a elemento, e a mais curta vem antes quando é prefixo. */
export function compararChaves(a: readonly Elemento[], b: readonly Elemento[]): number {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    const x = a[i] as Elemento;
    const y = b[i] as Elemento;
    if (x < y) return -1;
    if (x > y) return 1;
  }
  return a.length - b.length;
}

/** `Number(x.toFixed(casas))`: o arredondamento do `round` do Python, salvo empate exato (Python vai ao par). */
export function arredondar(x: number, casas: number): number {
  return Number(x.toFixed(casas));
}
