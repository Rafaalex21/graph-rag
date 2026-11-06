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

/** Todas as diferenças de conteúdo, na ordem em que aparecem; lista vazia = idênticos. */
export function diferencas(python: Json, ts: Json, caminho = "$"): Diferenca[] {
  if (tipoDe(python) !== tipoDe(ts)) return [{ caminho, tipo: "tipo" }];
  if (Array.isArray(python) && Array.isArray(ts)) {
    const saida: Diferenca[] = [];
    if (python.length !== ts.length) saida.push({ caminho, tipo: "tamanho" });
    for (let i = 0; i < Math.min(python.length, ts.length); i++) {
      saida.push(...diferencas(python[i] as Json, ts[i] as Json, `${caminho}[${i}]`));
    }
    return saida;
  }
  if (python !== null && typeof python === "object" && ts !== null && typeof ts === "object" && !Array.isArray(python) && !Array.isArray(ts)) {
    const saida: Diferenca[] = [];
    const chaves = new Set([...Object.keys(python), ...Object.keys(ts)].filter((k) => !CHAVES_IGNORADAS.has(k)));
    for (const k of [...chaves].sort()) {
      if (!(k in python)) saida.push({ caminho: `${caminho}.${k}`, tipo: "chave_so_no_ts" });
      else if (!(k in ts)) saida.push({ caminho: `${caminho}.${k}`, tipo: "chave_so_no_python" });
      else saida.push(...diferencas(python[k] as Json, ts[k] as Json, `${caminho}.${k}`));
    }
    return saida;
  }
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

export function comparar(python: Json, ts: Json): Comparacao {
  const d = diferencas(python, ts);
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

/** O que o `JSON.stringify` do resultado do TypeScript manda para o outro lado: sem `undefined`. */
export const comoJson = (v: unknown): Json => JSON.parse(JSON.stringify(v)) as Json;
