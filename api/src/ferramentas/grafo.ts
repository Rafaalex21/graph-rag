/**
 * Acesso de leitura ao Neo4j. As ferramentas só conhecem `GrafoLeitura` (uma consulta fixa com parâmetros); o
 * driver real fica aqui, em sessão `READ`, e os testes põem um dublê no lugar.
 */
import { readFileSync } from "node:fs";
import neo4j, { type Driver } from "neo4j-driver";
import type { Notificacao, PlanoNo } from "./guarda.ts";

export interface GrafoLeitura {
  consultar(cypher: string, parametros?: Record<string, unknown>): Promise<Record<string, unknown>[]>;
}

export interface ResultadoExplain {
  /** Raiz do plano do `EXPLAIN` (`operatorType` e `children`); `null` se o servidor não mandou. */
  plano: PlanoNo | null;
  notificacoes: Notificacao[];
}

/**
 * O que o Text2Cypher (F7.10) pede além de `consultar`: o `EXPLAIN` de uma consulta que veio de um LLM (nada executa)
 * e a execução dela numa sessão de leitura, com tempo-limite no servidor e teto de linhas.
 */
export interface GrafoCypher extends GrafoLeitura {
  explicar(cypher: string, timeoutMs: number): Promise<ResultadoExplain>;
  executarLivre(cypher: string, opcoes: { timeoutMs: number; maxLinhas: number }): Promise<{ linhas: Record<string, unknown>[]; truncado: boolean }>;
}

export const temCypherLivre = (g: GrafoLeitura): g is GrafoCypher => typeof (g as Partial<GrafoCypher>).explicar === "function" && typeof (g as Partial<GrafoCypher>).executarLivre === "function";

export interface ConfigGrafo {
  uri: string;
  usuario: string;
  senha: string;
  banco: string;
}

/** Pares CHAVE=valor de um `.env`: ignora BOM, comentário e linha em branco; tira aspas que cercam o valor. */
export function lerEnv(texto: string): Record<string, string> {
  const saida: Record<string, string> = {};
  for (const bruta of texto.replace(/^\uFEFF/, "").split(/\r?\n/)) {
    const linha = bruta.trim();
    const i = linha.indexOf("=");
    if (linha === "" || linha.startsWith("#") || i < 0) continue;
    let valor = linha.slice(i + 1).trim();
    const aspa = valor[0];
    if (valor.length >= 2 && (aspa === '"' || aspa === "'") && valor.endsWith(aspa)) valor = valor.slice(1, -1);
    saida[linha.slice(0, i).trim()] = valor;
  }
  return saida;
}

/** O ambiente vence o arquivo, e só variáveis `NEO4J_*` do ambiente entram. */
export function configuracaoDoGrafo(arquivo: Record<string, string>, ambiente: Record<string, string | undefined>): ConfigGrafo {
  const env: Record<string, string> = { ...arquivo };
  for (const [k, v] of Object.entries(ambiente)) if (k.startsWith("NEO4J_") && v !== undefined) env[k] = v;
  const senha = env["NEO4J_PASSWORD"];
  if (!senha) throw new Error("NEO4J_PASSWORD não está no .env nem no ambiente");
  return {
    uri: env["NEO4J_URI"] ?? "bolt://127.0.0.1:7687",
    usuario: env["NEO4J_USER"] ?? "neo4j",
    senha,
    banco: env["NEO4J_DATABASE"] ?? "neo4j",
  };
}

/** Inteiros do Neo4j chegam como `Integer`; viram número (e é erro se não couberem com segurança). */
export function paraJs(valor: unknown): unknown {
  if (neo4j.isInt(valor)) {
    if (!valor.inSafeRange()) throw new Error(`inteiro fora do intervalo seguro: ${valor.toString()}`);
    return valor.toNumber();
  }
  if (Array.isArray(valor)) return valor.map(paraJs);
  if (valor !== null && typeof valor === "object") {
    return Object.fromEntries(Object.entries(valor).map(([k, v]) => [k, paraJs(v)]));
  }
  return valor;
}

/**
 * O contrário, para os parâmetros: um número inteiro de JS iria como FLOAT e `LIMIT $n` o recusaria. Uma lista com
 * ao menos um número fracionário é um vetor de embedding e fica como está (um `0` solto entre floats viraria
 * INTEGER e o índice vetorial receberia uma lista de tipos misturados).
 */
export function paraNeo4j(valor: unknown): unknown {
  if (typeof valor === "number" && Number.isInteger(valor)) return neo4j.int(valor);
  if (Array.isArray(valor)) {
    if (valor.some((x) => typeof x === "number" && Number.isFinite(x) && !Number.isInteger(x))) return valor;
    return valor.map(paraNeo4j);
  }
  return valor;
}

/** Plano do driver → só o que a guarda lê, recursivamente (o objeto do driver traz também argumentos e identificadores). */
function copiarPlano(p: unknown): PlanoNo | null {
  if (!p || typeof p !== "object") return null;
  const o = p as { operatorType?: unknown; children?: unknown };
  const filhos = Array.isArray(o.children) ? o.children.map(copiarPlano).filter((x): x is PlanoNo => x !== null) : [];
  return { operatorType: String(o.operatorType ?? ""), children: filhos };
}

export class GrafoNeo4j implements GrafoCypher {
  readonly #driver: Driver;
  readonly #banco: string;

  constructor(config: ConfigGrafo) {
    this.#driver = neo4j.driver(config.uri, neo4j.auth.basic(config.usuario, config.senha));
    this.#banco = config.banco;
  }

  /** Lê `<raiz>/.env` (se existir) e as variáveis `NEO4J_*` do ambiente. */
  static conectar(raiz: URL | string = new URL("../../../", import.meta.url)): GrafoNeo4j {
    let arquivo: Record<string, string> = {};
    try {
      arquivo = lerEnv(readFileSync(new URL(".env", raiz), "utf-8"));
    } catch {
      // sem .env: valem as variáveis do ambiente
    }
    return new GrafoNeo4j(configuracaoDoGrafo(arquivo, process.env));
  }

  async consultar(cypher: string, parametros: Record<string, unknown> = {}): Promise<Record<string, unknown>[]> {
    const params = Object.fromEntries(Object.entries(parametros).map(([k, v]) => [k, paraNeo4j(v)]));
    const r = await this.#driver.executeQuery(cypher, params, { database: this.#banco, routing: neo4j.routing.READ });
    return r.records.map((rec) => paraJs(rec.toObject()) as Record<string, unknown>);
  }

  /** `EXPLAIN` numa sessão de leitura: o plano não executa nada. Erro de sintaxe lança. */
  async explicar(cypher: string, timeoutMs: number): Promise<ResultadoExplain> {
    const sessao = this.#driver.session({ database: this.#banco, defaultAccessMode: neo4j.session.READ });
    try {
      const { summary } = await sessao.run(`EXPLAIN ${cypher}`, {}, { timeout: timeoutMs });
      const notificacoes = (summary.notifications ?? []).map((n) => ({ code: n.code, title: n.title, description: n.description }));
      return { plano: copiarPlano(summary.plan), notificacoes };
    } finally {
      await sessao.close();
    }
  }

  /** Executa numa sessão de leitura, com tempo-limite no servidor; lê no máximo `maxLinhas` e avisa se havia mais. */
  async executarLivre(cypher: string, opcoes: { timeoutMs: number; maxLinhas: number }): Promise<{ linhas: Record<string, unknown>[]; truncado: boolean }> {
    const sessao = this.#driver.session({ database: this.#banco, defaultAccessMode: neo4j.session.READ });
    try {
      const linhas: Record<string, unknown>[] = [];
      let truncado = false;
      for await (const registro of sessao.run(cypher, {}, { timeout: opcoes.timeoutMs })) {
        if (linhas.length >= opcoes.maxLinhas) {
          truncado = true;
          break;
        }
        linhas.push(paraJs(registro.toObject()) as Record<string, unknown>);
      }
      return { linhas, truncado };
    } finally {
      await sessao.close();
    }
  }

  async fechar(): Promise<void> {
    await this.#driver.close();
  }
}
