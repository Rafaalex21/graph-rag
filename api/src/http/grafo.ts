/** `GET /api/grafo/vizinhanca`: a entidade, seus vizinhos (profundidade 1 ou 2) e as arestas entre eles, para o explorador. */
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { responderErro } from "./erros.ts";
import type { DependenciasApp } from "./tipos.ts";

/** O teto de nós devolvidos, contando a entidade. */
export const MAX_NOS = 100;
const MAX_ARESTAS = 500;

const ConsultaSchema = z.object({
  entidade: z.string().min(1).max(200),
  profundidade: z.coerce.number().int().min(1).max(2).default(1),
});

/** Pelo id, pelo nome ou por um apelido ("BB", "Banco do Brasil"); entre vários, o que tem mais ligações (a entidade, não um órgão com o nome parecido). */
const RESOLVER = `MATCH (e:__Entity__)
WHERE e.id = $q OR toLower(e.name) = toLower($q) OR any(a IN coalesce(e.aliases, []) WHERE toLower(a) = toLower($q))
RETURN e.id AS id, e.name AS rotulo, e.type AS tipo
ORDER BY (e.id = $q) DESC, (toLower(e.name) = toLower($q)) DESC, size([(e)--() | 1]) DESC
LIMIT 1`;

/** A profundidade vem de um inteiro validado (1 ou 2): é o único pedaço montado no texto, porque o Cypher não parametriza o alcance. */
const vizinhos = (profundidade: number) => `MATCH p = (e:__Entity__ {id: $id})-[*1..${profundidade}]-(v:__Entity__)
WHERE v.id <> $id
WITH v, min(length(p)) AS distancia
RETURN v.id AS id, v.name AS rotulo, v.type AS tipo
ORDER BY distancia, v.name
LIMIT ${MAX_NOS}`;

const ARESTAS = `MATCH (a:__Entity__)-[r]->(b:__Entity__)
WHERE a.id IN $ids AND b.id IN $ids
RETURN a.id AS origem, b.id AS destino, type(r) AS tipo
LIMIT ${MAX_ARESTAS}`;

const no = (l: Record<string, unknown>) => ({ id: String(l["id"]), rotulo: String(l["rotulo"] ?? l["id"]), tipo: String(l["tipo"] ?? "") });

export function registrarGrafo(app: FastifyInstance, deps: DependenciasApp): void {
  app.get("/api/grafo/vizinhanca", async (req, reply) => {
    const lido = ConsultaSchema.safeParse(req.query);
    if (!lido.success) return responderErro(reply, 400, "requisicao_invalida", "Informe entidade (até 200 caracteres) e, se quiser, profundidade 1 ou 2.");
    const { entidade, profundidade } = lido.data;
    if (!deps.grafo) return responderErro(reply, 503, "neo4j_indisponivel", "O banco de grafos não está disponível.");
    const grafo = deps.grafo;
    try {
      const achada = (await grafo.consultar(RESOLVER, { q: entidade }))[0];
      if (!achada) return responderErro(reply, 404, "entidade_nao_encontrada", "Nenhuma entidade com esse nome ou id.");
      const centro = no(achada);
      const linhas = await grafo.consultar(vizinhos(profundidade), { id: centro.id });
      const vistos = new Set([centro.id]);
      const nos = [centro];
      let truncado = false;
      for (const l of linhas) {
        const n = no(l);
        if (vistos.has(n.id)) continue;
        if (nos.length >= MAX_NOS) {
          truncado = true;
          break;
        }
        vistos.add(n.id);
        nos.push(n);
      }
      const arestas: { origem: string; destino: string; tipo: string }[] = [];
      const chaves = new Set<string>();
      for (const l of await grafo.consultar(ARESTAS, { ids: nos.map((n) => n.id) })) {
        const a = { origem: String(l["origem"]), destino: String(l["destino"]), tipo: String(l["tipo"]) };
        const chave = `${a.origem}\u0000${a.destino}\u0000${a.tipo}`;
        if (!vistos.has(a.origem) || !vistos.has(a.destino) || chaves.has(chave)) continue;
        chaves.add(chave);
        arestas.push(a);
      }
      return { entidade: centro, nos, arestas, truncado };
    } catch (e) {
      deps.registrarErro?.("grafo", e);
      return responderErro(reply, 503, "neo4j_indisponivel", "O banco de grafos não está disponível.");
    }
  });
}
