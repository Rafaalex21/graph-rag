/**
 * Guarda-corpos contra o grafo real (F7.10; porte de `indexer/tests/test_guarda_cypher_grafo.py`, F6.5). Roda só com o
 * Neo4j no ar e o grafo da F5.8 carregado; sem ele (CI, máquina sem o banco) é pulado.
 *
 * O aceite é "26 entradas maliciosas ou malformadas bloqueadas **sem escrita no banco**": a contagem de nós, de relações
 * e a soma de `f.value` do grafo real são as mesmas antes e depois de cada entrada. Além do texto (`preparar`), confere as
 * barreiras que só o servidor dá: o plano do `EXPLAIN` mostra o operador de escrita, a sessão `READ` recusa a escrita, o
 * tempo-limite derruba a consulta lenta e os nomes que não existem viram aviso.
 *
 * Formas de falhar, além das de `guarda.test.ts` (que não tem banco):
 *  1. o driver não devolve o plano em `summary.plan` ou as notificações em `summary.notifications`, e a segunda barreira
 *     fica muda sem ninguém notar;
 *  2. a sessão não é de leitura (o `defaultAccessMode` não vale) e a escrita passa se o texto e o plano falharem;
 *  3. o tempo-limite não chega ao servidor e o produto cartesiano trava a API;
 *  4. o `for await` com `break` deixa a sessão aberta ou a consulta correndo;
 *  5. a autocorreção refaz a consulta mais de uma vez, ou corrige uma violação da guarda.
 */
import { connect } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { avisosDoPlano, carregarExemplos, GrafoNeo4j, perguntar, planoComEscrita, preparar } from "../../src/ferramentas/index.ts";
import { LEGITIMAS, MALICIOSAS } from "./guarda.casos.ts";

const no_ar = await new Promise<boolean>((resolver) => {
  const s = connect({ host: "127.0.0.1", port: 7687, timeout: 1000 });
  s.on("connect", () => {
    s.destroy();
    resolver(true);
  });
  s.on("error", () => resolver(false));
  s.on("timeout", () => {
    s.destroy();
    resolver(false);
  });
});

const ESCRITAS = [
  "CREATE (:Intruso {x: 1})",
  "MERGE (:Intruso {x: 1})",
  "MATCH (n:Intruso) DETACH DELETE n",
  "MATCH (n:Intruso) SET n.x = 2",
  "MATCH (n:Intruso) REMOVE n.x",
  "FOREACH (i IN [1] | CREATE (:Intruso))",
  "CALL apoc.cypher.runWrite('CREATE (n:Intruso)', {}) YIELD value RETURN value",
];

describe.skipIf(!no_ar)("guarda contra o grafo real", () => {
  let grafo: GrafoNeo4j;
  beforeAll(async () => {
    grafo = GrafoNeo4j.conectar();
    const n = await grafo.consultar("MATCH (f:FinancialFact) RETURN count(f) AS n");
    if (!n[0]?.["n"]) throw new Error("grafo sem fatos financeiros: rode a importação (F5.8)");
  }, 30_000);
  afterAll(async () => {
    await grafo?.fechar();
  });

  /** Nós, relações e uma soma de propriedades: qualquer escrita muda pelo menos um dos três. */
  const estado = async () => {
    const n = await grafo.consultar("MATCH (n) RETURN count(n) AS n");
    const r = await grafo.consultar("MATCH ()-[r]->() RETURN count(r) AS n");
    const v = await grafo.consultar("MATCH (f:FinancialFact) RETURN sum(f.value) AS s");
    return [n[0]?.["n"], r[0]?.["n"], v[0]?.["s"]];
  };
  const llmFixo = (texto: string) => async () => texto;
  const semContexto = { esquemaTexto: "E", terminologiaTexto: "T", exemplos: [] };

  it.each(MALICIOSAS)("%s não escreve no grafo real", async (nome, cypher) => {
    const antes = await estado();
    const r = await perguntar(grafo, "pergunta qualquer", llmFixo(cypher), semContexto);
    // bloqueada, ou (só o caso do `;`, que a extração do Cypher corta na primeira consulta) reduzida a uma consulta de
    // leitura: nunca a escrita
    expect(r.erro || !/DELETE/i.test(r.cypher ?? ""), `${nome} rodou: ${r.cypher}`).toBeTruthy();
    if (nome === "depois_de_ponto_e_virgula") expect(r.cypher).toBe("MATCH (n) RETURN n LIMIT 1");
    else {
      expect(r.erro, `${nome} rodou: ${r.cypher}`).toMatch(/^bloqueada_pela_guarda: /);
      expect(r.linhas).toEqual([]);
    }
    expect(r.guarda.corrigida).toBe(false); // violação da guarda nunca é autocorrigida
    expect(await estado()).toEqual(antes);
  }, 20_000);

  it.each(ESCRITAS)("o plano do servidor denuncia a escrita mesmo sem o filtro de texto: %s", async (cypher) => {
    const antes = await estado();
    const { plano } = await grafo.explicar(cypher, 5000);
    expect(plano, "o driver não devolveu o plano").not.toBeNull();
    expect(planoComEscrita(plano), cypher).toBeTruthy();
    expect(await estado()).toEqual(antes); // EXPLAIN não executa
  });

  it.each(ESCRITAS.slice(0, 6))("a sessão de leitura recusa a escrita se tudo o mais falhar: %s", async (cypher) => {
    const antes = await estado();
    await expect(grafo.executarLivre(cypher, { timeoutMs: 5000, maxLinhas: 50 })).rejects.toThrow(/write|read/i);
    expect(await estado()).toEqual(antes);
  });

  it("consulta de leitura passa no plano, e nome inexistente vira aviso", async () => {
    const ok = await grafo.explicar("MATCH (f:FinancialFact) RETURN f.value AS v LIMIT 1", 5000);
    expect(planoComEscrita(ok.plano)).toBeNull();
    expect(avisosDoPlano(ok.notificacoes).desconhecidos).toEqual([]);
    const ruim = await grafo.explicar("MATCH (f:FinancialFact) WHERE f.valorInexistente > 1 RETURN f.value AS v LIMIT 1", 5000);
    expect(planoComEscrita(ruim.plano)).toBeNull();
    expect(avisosDoPlano(ruim.notificacoes).desconhecidos.some((d) => d.includes("valorInexistente"))).toBe(true);
    const rotulo = await grafo.explicar("MATCH (n:RotuloQueNaoExiste) RETURN n LIMIT 1", 5000);
    expect(avisosDoPlano(rotulo.notificacoes).desconhecidos.length).toBeGreaterThan(0);
  });

  it("erro de sintaxe levanta no EXPLAIN", async () => {
    await expect(grafo.explicar("MATCH (n RETURN n LIMIT 1", 5000)).rejects.toThrow(/syntax|invalid/i);
  });

  it("o tempo-limite de 5 s derruba o produto cartesiano", async () => {
    const cartesiano = "MATCH (a:FinancialFact), (b:FinancialFact), (c:FinancialFact) RETURN count(*) AS n";
    const r = await perguntar(grafo, "q?", llmFixo(cartesiano), { ...semContexto, autocorrigir: false });
    expect(r.erro).toMatch(/^falha_na_execucao/);
    expect(r.latencia_ms.total ?? Infinity).toBeLessThan(20_000);
    expect(r.guarda.avisos.length).toBeGreaterThan(0); // o EXPLAIN já avisava do produto cartesiano
  }, 40_000);

  it("as consultas legítimas e os exemplos passam pela guarda e pelo plano", async () => {
    for (const cypher of [LEGITIMAS[0] as string, ...carregarExemplos().map((e) => e.cypher)]) {
      const p = preparar(cypher);
      expect(p.motivo, cypher).toBeNull();
      const { plano } = await grafo.explicar(p.cypher as string, 5000);
      expect(planoComEscrita(plano), cypher).toBeNull();
    }
  });

  it("os exemplos continuam devolvendo linhas através do perguntar", async () => {
    for (const e of carregarExemplos()) {
      const r = await perguntar(grafo, e.pergunta, llmFixo(e.cypher), { ...semContexto, autocorrigir: false });
      expect(r.erro, e.pergunta).toBeNull();
      expect(r.linhas.length, e.pergunta).toBeGreaterThan(0);
    }
  }, 60_000);

  it("a autocorreção no grafo real conserta a sintaxe e para no nome inexistente: uma só", async () => {
    const respostas = [
      "MATCH (f:FinancialFact RETURN f.value AS v", // sintaxe: o EXPLAIN levanta
      "MATCH (f:FinancialFact) WHERE f.valorInexistente > 1 RETURN f.value AS v", // nome inexistente
      "MATCH (f:FinancialFact) RETURN f.value AS v, f.page AS pagina",
    ];
    const chamadas: { role: string; content: string }[][] = [];
    const r = await perguntar(
      grafo,
      "q?",
      async (mensagens) => {
        chamadas.push(mensagens);
        return respostas[chamadas.length - 1] as string;
      },
      semContexto,
    );
    // a 1ª resposta falha na sintaxe e é corrigida pela 2ª; a 2ª tem nome inexistente, mas a correção é uma só: o
    // resultado segue com o aviso do Neo4j e sem uma terceira chamada ao LLM
    expect(chamadas).toHaveLength(2);
    expect(r.guarda.corrigida).toBe(true);
    expect(r.guarda.avisos.length).toBeGreaterThan(0);
    expect(chamadas[1]?.at(-1)?.content).toMatch(/Invalid input|syntax/i);
  }, 30_000);
});
