/** `GET /api/fonte/:id`: o item do grafo que uma citação aponta (Pai, Filho, tabela, fato, entidade ou comunidade). */
import type { FastifyInstance } from "fastify";
import { rotuloDePaginas } from "../ferramentas/contrato.ts";
import { responderErro } from "./erros.ts";
import type { DependenciasApp } from "./tipos.ts";

export const MAX_ID = 200;
const TIPOS = new Set(["pai", "filho", "tabela", "fato", "entidade", "comunidade"]);
const MAX_PAGINAS = 60;

/** Uma consulta só, uma ramificação por rótulo; o id é parâmetro, nunca texto. */
const CYPHER = `
CALL () {
  MATCH (n:Parent {id: $id})
  OPTIONAL MATCH (s:Section)-[:HAS_PARENT]->(n)
  RETURN 'pai' AS tipo, n.text AS texto, n.pageStart AS ini, n.pageEnd AS fim, s.path AS secao
  UNION ALL
  MATCH (n:Child {id: $id})
  OPTIONAL MATCH (s:Section)-[:HAS_PARENT]->(:Parent)-[:HAS_CHILD]->(n)
  RETURN 'filho' AS tipo, n.text AS texto, n.pageStart AS ini, n.pageEnd AS fim, s.path AS secao
  UNION ALL
  MATCH (n:Table {id: $id})
  OPTIONAL MATCH (s:Section)-[:HAS_TABLE]->(n)
  RETURN 'tabela' AS tipo, n.markdown AS texto, coalesce(n.pageStart, n.page) AS ini, coalesce(n.pageEnd, n.page) AS fim, s.path AS secao
  UNION ALL
  MATCH (n:FinancialFact {id: $id})
  RETURN 'fato' AS tipo, n.evidence AS texto, n.page AS ini, coalesce(n.pageEnd, n.page) AS fim, null AS secao
  UNION ALL
  MATCH (n:__Entity__ {id: $id})
  RETURN 'entidade' AS tipo, coalesce(n.summary, n.description, n.name) AS texto, null AS ini, null AS fim, null AS secao
  UNION ALL
  MATCH (n:__Community__ {id: $id})
  RETURN 'comunidade' AS tipo, coalesce(n.summary, n.title) AS texto, null AS ini, null AS fim, null AS secao
}
RETURN tipo, texto, ini, fim, secao
LIMIT 1`;

const inteiro = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? Math.trunc(v) : null);

/** `path` pode ser texto ou lista de títulos. */
const secaoDe = (v: unknown): string | null => {
  if (Array.isArray(v)) {
    const t = v.map(String).filter((x) => x !== "").join(" > ");
    return t === "" ? null : t;
  }
  return typeof v === "string" && v !== "" ? v : null;
};

function paginasDe(ini: unknown, fim: unknown): string | null {
  const a = inteiro(ini);
  const b = inteiro(fim) ?? a;
  if (a === null || b === null) return null;
  const ultima = Math.min(Math.max(a, b), a + MAX_PAGINAS);
  const lista: number[] = [];
  for (let p = Math.min(a, b); p <= ultima; p++) lista.push(p);
  const r = rotuloDePaginas(lista);
  return r === "" ? null : r;
}

export function registrarFonte(app: FastifyInstance, deps: DependenciasApp): void {
  app.get<{ Params: { id: string } }>("/api/fonte/:id", async (req, reply) => {
    const { id } = req.params;
    if (id.length === 0 || id.length > MAX_ID) return responderErro(reply, 400, "requisicao_invalida", `O id deve ter de 1 a ${MAX_ID} caracteres.`);
    if (!deps.grafo) return responderErro(reply, 503, "neo4j_indisponivel", "O banco de grafos não está disponível.");
    let linhas: Record<string, unknown>[];
    try {
      linhas = await deps.grafo.consultar(CYPHER, { id });
    } catch (e) {
      deps.registrarErro?.("fonte", e);
      return responderErro(reply, 503, "neo4j_indisponivel", "O banco de grafos não está disponível.");
    }
    const l = linhas[0];
    const tipo = String(l?.["tipo"] ?? "");
    if (!l || !TIPOS.has(tipo)) return responderErro(reply, 404, "fonte_nao_encontrada", "Nenhum item do documento tem esse id.");
    return { tipo, pagina: paginasDe(l["ini"], l["fim"]), texto: typeof l["texto"] === "string" ? l["texto"] : "", secao: secaoDe(l["secao"]) };
  });
}
