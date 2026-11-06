/**
 * Acesso de leitura ao Neo4j. As ferramentas só conhecem `GrafoLeitura` (uma consulta fixa com parâmetros); o
 * driver real fica aqui, em sessão `READ`, e os testes põem um dublê no lugar.
 */
import { readFileSync } from "node:fs";
import neo4j, { type Driver } from "neo4j-driver";

export interface GrafoLeitura {
  consultar(cypher: string, parametros?: Record<string, unknown>): Promise<Record<string, unknown>[]>;
}

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

/** O contrário, para os parâmetros: um número inteiro de JS iria como FLOAT e `LIMIT $n` o recusaria. */
export function paraNeo4j(valor: unknown): unknown {
  if (typeof valor === "number" && Number.isInteger(valor)) return neo4j.int(valor);
  if (Array.isArray(valor)) return valor.map(paraNeo4j);
  return valor;
}

export class GrafoNeo4j implements GrafoLeitura {
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

  async fechar(): Promise<void> {
    await this.#driver.close();
  }
}
