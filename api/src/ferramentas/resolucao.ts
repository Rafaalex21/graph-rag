/**
 * Do texto do roteador ao que o grafo guarda (F7.8, porte de `indexer.templates_cypher`): métrica canônica, nome
 * exato de entidade, id de período, valor formatado em pt-BR e fatos consolidados. Cada função tem o mesmo
 * comportamento da do Python; o que o grafo real obriga está na ADR-048.
 */
import type { Metrica } from "./catalogo.ts";
import { arredondar, compararChaves, normalizar, SOBRAS_DE_BUSCA, tokens } from "./texto.ts";

// palavras que podem sobrar numa métrica pedida sem mudar o conceito ("o lucro líquido do exercício de 2025")
const SOBRAS_DE_METRICA: ReadonlySet<string> = new Set([
  "o", "a", "os", "as", "de", "do", "da", "dos", "das", "em", "no", "na", "e", "para", "qual", "foi", "quanto",
  "valor", "total", "ifrs", "fy", "exercicio", "ano", "periodo",
]);

const MESES: Record<string, number> = {
  janeiro: 1, fevereiro: 2, marco: 3, abril: 4, maio: 5, junho: 6, julho: 7, agosto: 8, setembro: 9, outubro: 10,
  novembro: 11, dezembro: 12,
};

const ESCALAS = new Map<number, [string, string]>([
  [1_000, ["mil", "mil"]],
  [1_000_000, ["milhão", "milhões"]],
  [1_000_000_000, ["bilhão", "bilhões"]],
  [1_000_000_000_000, ["trilhão", "trilhões"]],
]);

// ---------- métrica e entidade ----------

/**
 * Métrica canônica de um texto livre (§7.3): termo igual ao do catálogo, ou o termo mais longo contido no texto
 * quando o resto são só palavras de enchimento. Sem correspondência: `null` e nomes parecidos.
 */
export function resolverMetrica(texto: string | null | undefined, catalogo: readonly Metrica[]): [Metrica | null, string[]] {
  const nt = tokens(texto);
  if (nt.length === 0) return [null, []];
  const termos: [string, Metrica][] = [];
  for (const m of catalogo) for (const t of [m.name, m.name_pt, ...(m.aliases ?? [])]) termos.push([normalizar(t), m]);
  const pedido = nt.join(" ");
  for (const [t, m] of termos) if (t === pedido) return [m, []];

  const achados: [number, Metrica][] = [];
  for (const [t, m] of termos) {
    const tt = t === "" ? [] : t.split(" ");
    if (tt.length === 0) continue;
    for (let i = 0; i + tt.length <= nt.length; i++) {
      if (tt.every((x, j) => nt[i + j] === x)) {
        const resto = [...nt.slice(0, i), ...nt.slice(i + tt.length)];
        if (resto.every((x) => SOBRAS_DE_METRICA.has(x) || /^\d+$/.test(x))) achados.push([tt.length, m]);
        break;
      }
    }
  }
  if (achados.length > 0) {
    const melhor = Math.max(...achados.map(([n]) => n));
    const donos = new Map(achados.filter(([n]) => n === melhor).map(([, m]) => [m.id, m]));
    if (donos.size === 1) return [[...donos.values()][0] as Metrica, []];
  }
  const chave = new Set(nt.filter((t) => t.length >= 3 && !SOBRAS_DE_METRICA.has(t)));
  const sugestoes: string[] = [];
  for (const [t, m] of termos) {
    if (t.split(" ").some((x) => chave.has(x)) && !sugestoes.includes(m.name)) sugestoes.push(m.name);
  }
  return [null, sugestoes.slice(0, 5)];
}

/**
 * Nome exato (como está nos fatos) da entidade pedida. Sem texto: o emissor. Igual sem caixa nem acento; senão, o
 * único nome que contém todas as palavras pedidas. Ambígua ou desconhecida: `null` e sugestões.
 */
export function resolverEntidade(
  texto: string | null | undefined,
  conhecidas: readonly string[],
  emissor: string | null,
): [string | null, string[]] {
  if (!texto || texto.trim() === "") return [emissor, []];
  const nomes = [...new Set([...conhecidas, ...(emissor ? [emissor] : [])])];
  const alvo = normalizar(texto);
  for (const n of nomes) if (normalizar(n) === alvo) return [n, []];
  const pedidas = new Set(alvo === "" ? [] : alvo.split(" ").filter((t) => !SOBRAS_DE_BUSCA.has(t)));
  const doNome = (n: string) => new Set(tokens(n));
  const contem = nomes.filter((n) => pedidas.size > 0 && [...pedidas].every((p) => doNome(n).has(p)));
  const unico = contem.length === 1 ? contem[0] : undefined;
  if (unico !== undefined) return [unico, []];
  const pontuadas = nomes
    .map((n): [number, string] => [[...pedidas].filter((p) => doNome(n).has(p)).length, n])
    .filter(([pontos]) => pontos > 0)
    .sort((a, b) => compararChaves([-a[0], a[1]], [-b[0], b[1]]));
  return [null, (contem.length === 0 ? pontuadas.map(([, n]) => n) : contem).slice(0, 5)];
}

// ---------- período ----------

const diasNoMes = (a: number, m: number) => [31, a % 4 === 0 && (a % 100 !== 0 || a % 400 === 0) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][m - 1] as number;
const dois = (n: number) => String(n).padStart(2, "0");

/** Id de período do grafo: "2025" → `2025-FY`, "4T25" → `2025-Q4`, "31/12/2025" → `2025-12-31`. */
export function normalizarPeriodo(texto: string | null | undefined): string {
  const bruto = (texto ?? "").normalize("NFKD").replace(/\P{ASCII}/gu, "").toLowerCase().trim().replace(/\s+/g, " ");
  const data = (a: number, m: number, d: number): string => {
    if (!(a >= 1 && a <= 9999 && m >= 1 && m <= 12 && d >= 1 && d <= diasNoMes(a, m))) throw new Error(`data inválida: '${texto ?? ""}'`);
    return `${String(a).padStart(4, "0")}-${dois(m)}-${dois(d)}`;
  };
  const ano = (t: string) => {
    const a = Number(t);
    return a < 100 ? 2000 + a : a;
  };
  let m: RegExpExecArray | null;
  if ((m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(bruto))) return data(Number(m[1]), Number(m[2]), Number(m[3]));
  if ((m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(bruto))) return data(Number(m[3]), Number(m[2]), Number(m[1]));
  if ((m = /^(\d{1,2}) de ([a-z]+) de (\d{4})$/.exec(bruto)) && (m[2] as string) in MESES) {
    return data(Number(m[3]), MESES[m[2] as string] as number, Number(m[1]));
  }
  if ((m = /^(\d{4})-q([1-4])$/.exec(bruto))) return `${m[1]}-Q${m[2]}`;
  if ((m = /^([1-4]) ?t ?(\d{4}|\d{2})$/.exec(bruto))) return `${ano(m[2] as string)}-Q${m[1]}`;
  if ((m = /^([1-4]) ?o? ?trimestre(?: de)? (\d{4})$/.exec(bruto))) return `${m[2]}-Q${m[1]}`;
  if ((m = /^q([1-4]) ?(\d{4})$/.exec(bruto))) return `${m[2]}-Q${m[1]}`;
  if ((m = /^(?:fy ?|exercicio de |ano de )?(\d{4})(?:-fy)?$/.exec(bruto))) return `${m[1]}-FY`;
  throw new Error(`período não reconhecido: '${texto ?? ""}'`);
}

// ---------- valores em pt-BR ----------

function pt(valor: number, maxCasas = 2): string {
  const [inteiro = "0", decimal = ""] = Math.abs(valor).toFixed(maxCasas).split(".");
  const dec = decimal.replace(/0+$/, "");
  const texto = inteiro.replace(/\B(?=(\d{3})+(?!\d))/g, ".") + (dec ? `,${dec}` : "");
  return (valor < 0 && /[^0,.]/.test(texto) ? "-" : "") + texto;
}

/** "R$ 16.782 milhões", "R$ 16,8 bilhões", "23,9%", "130": o número, a escala e a moeda explícitos. */
export function formatarValor(valor: number, unidade: string, escala: number | null | undefined, moeda: string | null = null): string {
  if (unidade === "percent") return `${pt(valor)}%`;
  const palavra = escala ? ESCALAS.get(Math.trunc(escala)) : undefined;
  if (unidade === "count") return palavra ? `${pt(valor, 3)} ${palavra[1]}` : pt(valor);
  const prefixo = moeda === null || moeda === "" || moeda === "BRL" ? "R$ " : `${moeda} `;
  if (palavra) {
    const nome = Math.abs(valor) < 2 && palavra[0] !== "mil" ? palavra[0] : palavra[1];
    return `${prefixo}${pt(valor, 3)} ${nome}`;
  }
  return `${prefixo}${pt(valor)}`;
}

// ---------- consolidação dos fatos ----------

/** Uma linha de `FinancialFact` como a consulta `fatos` devolve. */
export interface LinhaFato {
  id: string;
  valor: number;
  unidade: string;
  moeda: string | null;
  escala: number | null;
  periodo: string;
  fim: string | null;
  tipo_periodo: string;
  entidade: string;
  qualificador: string | null;
  dimensao: string | null;
  rotulo: string | null;
  pagina: number | null;
  pagina_fim: number | null;
}

export interface FatoConsolidado extends Omit<LinhaFato, "escala"> {
  escala: number;
  valor_absoluto: number;
  paginas: number[];
  ids_equivalentes: string[];
  apoio: number;
  conflito: boolean;
  texto_valor: string;
}

/**
 * Une repetições do mesmo valor (mesma escala ou arredondado em escala maior) e marca divergências.
 *
 * O valor "16,8 bilhões" cobre 16,75 a 16,85 bilhões: se a diferença para "16.782 milhões" cabe em meia unidade da
 * escala maior, é o mesmo fato e fica a escala mais fina. Valores que não cabem ficam separados e, no mesmo período
 * e recorte, todos recebem `conflito`.
 */
export function consolidarFatos(linhas: readonly LinhaFato[]): FatoConsolidado[] {
  type Item = LinhaFato & { escala: number; valor_absoluto: number };
  const grupos = new Map<string, Item[]>();
  for (const r of linhas) {
    const escala = Number(r.escala || 1);
    const absoluto = arredondar(Number(r.valor) * escala, 2);
    const chave = JSON.stringify([r.periodo, r.qualificador ?? null, normalizar(r.dimensao), r.unidade ?? null]);
    const lista = grupos.get(chave) ?? [];
    lista.push({ ...r, escala, valor_absoluto: absoluto });
    grupos.set(chave, lista);
  }
  const saida: FatoConsolidado[] = [];
  for (const itens of grupos.values()) {
    itens.sort((a, b) => compararChaves([a.escala, a.pagina ?? 0], [b.escala, b.pagina ?? 0]));
    type Cluster = Item & { paginas: Set<number>; ids_equivalentes: string[]; apoio: number };
    const clusters: Cluster[] = [];
    const paginasDe = (it: Item) => [it.pagina, it.pagina_fim].filter((p): p is number => p !== null && p !== undefined);
    for (const it of itens) {
      const c = clusters.find((x) => Math.abs(it.valor_absoluto - x.valor_absoluto) <= 0.5 * Math.max(it.escala, x.escala));
      if (c) {
        for (const p of paginasDe(it)) c.paginas.add(p);
        c.ids_equivalentes.push(it.id);
        c.apoio += 1;
      } else {
        clusters.push({ ...it, paginas: new Set(paginasDe(it)), ids_equivalentes: [], apoio: 1 });
      }
    }
    for (const c of clusters) {
      const { paginas, ...resto } = c;
      const ordenadas = [...paginas].sort((a, b) => a - b);
      saida.push({
        ...resto,
        paginas: ordenadas,
        conflito: clusters.length > 1,
        texto_valor: formatarValor(c.valor, c.unidade, c.escala, c.moeda),
      });
    }
  }
  // mais recente, mais sustentado, maior (a ordenação é estável, como a do Python com reverse=True)
  saida.sort((a, b) => compararChaves([b.fim ?? "", b.apoio, b.valor_absoluto], [a.fim ?? "", a.apoio, a.valor_absoluto]));
  return saida;
}
