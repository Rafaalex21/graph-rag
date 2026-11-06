/**
 * Paridade dos templates (F7.8): compara o resultado do Python (F6.3) com o do TypeScript para a mesma chamada.
 * A comparação é de JSON com JSON, ignorando só `latencia_ms`. Uma diferença só de **ordem** de lista (o banco não
 * garante a ordem de um `collect(DISTINCT ...)`) é separada das diferenças de conteúdo.
 */
export type Json = null | boolean | number | string | Json[] | { [k: string]: Json };

export interface Diferenca {
  caminho: string;
  tipo: "valor" | "tipo" | "chave_so_no_python" | "chave_so_no_ts" | "tamanho";
}

const CHAVES_IGNORADAS = new Set(["latencia_ms"]);

const tipoDe = (v: Json): string => (v === null ? "null" : Array.isArray(v) ? "lista" : typeof v);

/**
 * Todas as diferenças de conteúdo, na ordem em que aparecem; lista vazia = idênticos. `tolerancia` (padrão 0 = exato)
 * vale só para número contra número, para o ruído do reranker nas notas; texto, tipo, chave e tamanho são sempre exatos.
 */
export function diferencas(python: Json, ts: Json, caminho = "$", tolerancia = 0): Diferenca[] {
  if (tipoDe(python) !== tipoDe(ts)) return [{ caminho, tipo: "tipo" }];
  if (Array.isArray(python) && Array.isArray(ts)) {
    const saida: Diferenca[] = [];
    if (python.length !== ts.length) saida.push({ caminho, tipo: "tamanho" });
    for (let i = 0; i < Math.min(python.length, ts.length); i++) {
      saida.push(...diferencas(python[i] as Json, ts[i] as Json, `${caminho}[${i}]`, tolerancia));
    }
    return saida;
  }
  if (python !== null && typeof python === "object" && ts !== null && typeof ts === "object" && !Array.isArray(python) && !Array.isArray(ts)) {
    const saida: Diferenca[] = [];
    const chaves = new Set([...Object.keys(python), ...Object.keys(ts)].filter((k) => !CHAVES_IGNORADAS.has(k)));
    for (const k of [...chaves].sort()) {
      if (!(k in python)) saida.push({ caminho: `${caminho}.${k}`, tipo: "chave_so_no_ts" });
      else if (!(k in ts)) saida.push({ caminho: `${caminho}.${k}`, tipo: "chave_so_no_python" });
      else saida.push(...diferencas(python[k] as Json, ts[k] as Json, `${caminho}.${k}`, tolerancia));
    }
    return saida;
  }
  if (typeof python === "number" && typeof ts === "number" && Math.abs(python - ts) <= tolerancia) return [];
  return python === ts ? [] : [{ caminho, tipo: "valor" }];
}

/** Põe todas as listas em ordem canônica (por JSON), em qualquer profundidade, ignorando `latencia_ms`. */
export function canonico(v: Json): Json {
  if (Array.isArray(v)) {
    return v.map(canonico).sort((a, b) => (JSON.stringify(a) < JSON.stringify(b) ? -1 : JSON.stringify(a) > JSON.stringify(b) ? 1 : 0));
  }
  if (v !== null && typeof v === "object") {
    return Object.fromEntries(
      Object.keys(v)
        .filter((k) => !CHAVES_IGNORADAS.has(k))
        .sort()
        .map((k) => [k, canonico(v[k] as Json)]),
    );
  }
  return v;
}

export type Veredito = "igual" | "so_ordem" | "diferente";

export interface Comparacao {
  veredito: Veredito;
  diferencas: Diferenca[];
}

export function comparar(python: Json, ts: Json, tolerancia = 0): Comparacao {
  const d = diferencas(python, ts, "$", tolerancia);
  if (d.length === 0) return { veredito: "igual", diferencas: [] };
  const mesmoConjunto = diferencas(canonico(python), canonico(ts)).length === 0;
  return { veredito: mesmoConjunto ? "so_ordem" : "diferente", diferencas: d };
}

/**
 * Divergência de forma **documentada** (ADR-056): num erro de validação (`categoria_invalida`, `ano_invalido`) o Python
 * sai antes de criar a lista do resultado (`riscos`, `eventos`) e o TypeScript a devolve vazia, para o chamador não
 * precisar testar a chave. Tira do lado TypeScript as chaves que o Python não tem e cujo valor é `[]`; devolve
 * quantas tirou, para a divergência ficar contada e nunca escondida.
 */
export function semListasVaziasExtras(python: Json, ts: Json): { ts: Json; tiradas: string[] } {
  const tiradas: string[] = [];
  const andar = (p: Json, t: Json, caminho: string): Json => {
    if (Array.isArray(t)) {
      return t.map((x, i) => andar(Array.isArray(p) ? ((p[i] ?? null) as Json) : null, x, `${caminho}[${i}]`));
    }
    if (t !== null && typeof t === "object") {
      const pobj = p !== null && typeof p === "object" && !Array.isArray(p) ? p : null;
      const saida: { [k: string]: Json } = {};
      for (const [k, v] of Object.entries(t)) {
        if (pobj !== null && !(k in pobj) && Array.isArray(v) && v.length === 0) {
          tiradas.push(`${caminho}.${k}`);
          continue;
        }
        saida[k] = andar(pobj?.[k] ?? null, v, `${caminho}.${k}`);
      }
      return saida;
    }
    return t;
  };
  return { ts: andar(python, ts, "$"), tiradas };
}

export interface Item {
  id: string;
  /** Nota do reranker ou escore: é o que varia de uma execução para outra. */
  score?: number | null;
  [campo: string]: Json | undefined;
}

export interface ComparacaoDeItens {
  mesmo_conjunto: boolean;
  mesma_ordem: boolean;
  /** Maior diferença de nota entre os itens que os dois lados têm. */
  max_dif_score: number;
  /** Os itens comuns têm o mesmo conteúdo (todos os campos menos `score`). */
  conteudo_igual: boolean;
  so_em_a: string[];
  so_em_b: string[];
}

const semNota = (item: Item): Json => {
  const copia: Record<string, unknown> = { ...item };
  delete copia["score"];
  return comoJson(copia);
};

/**
 * Compara duas listas de itens com `id` e nota onde a nota tem ruído (o reranker do llama.cpp não repete a nota entre
 * execuções: dá diferenças de até alguns milésimos, que reordenam Pais quase empatados). Separa o que é
 * determinístico (conteúdo dos itens comuns) do que tem ruído (nota e ordem).
 */
export function compararItens(a: readonly Item[], b: readonly Item[]): ComparacaoDeItens {
  const pb = new Map(b.map((x) => [x.id, x]));
  const pa = new Map(a.map((x) => [x.id, x]));
  const soA = a.filter((x) => !pb.has(x.id)).map((x) => x.id);
  const soB = b.filter((x) => !pa.has(x.id)).map((x) => x.id);
  let maxDif = 0;
  let conteudoIgual = true;
  for (const x of a) {
    const y = pb.get(x.id);
    if (!y) continue;
    if (typeof x.score === "number" && typeof y.score === "number") maxDif = Math.max(maxDif, Math.abs(x.score - y.score));
    else if ((x.score ?? null) !== (y.score ?? null)) maxDif = Number.POSITIVE_INFINITY; // um lado sem nota
    if (diferencas(semNota(x), semNota(y)).length > 0) conteudoIgual = false;
  }
  return {
    mesmo_conjunto: soA.length === 0 && soB.length === 0,
    mesma_ordem: a.length === b.length && a.every((x, i) => x.id === b[i]?.id),
    max_dif_score: Math.round(maxDif * 1e6) / 1e6,
    conteudo_igual: conteudoIgual,
    so_em_a: soA,
    so_em_b: soB,
  };
}

/** O que o `JSON.stringify` do resultado do TypeScript manda para o outro lado: sem `undefined`. */
export const comoJson = (v: unknown): Json => JSON.parse(JSON.stringify(v)) as Json;
