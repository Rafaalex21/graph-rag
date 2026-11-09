/**
 * A API falsa dos testes E2E da interface: fala o contrato de `contracts/api.openapi.yaml` (POST /api/chat em SSE, corpo `Erro`
 * nas falhas) com respostas roteirizadas pelo TEXTO da pergunta. Existe para que o E2E da interface seja determinístico e rode em
 * qualquer máquina e no CI, sem Neo4j nem modelos. O que é da API de verdade (agente, grafo, guarda) é testado no projeto
 * `ao-vivo`, contra a pilha real.
 *
 * Também serve o PDF de teste em GET /api/documento/pdf (com `Range`, como a API real) e as fontes em GET /api/fonte/:id:
 *   p1 pai p. 6 · t1 tabela p. 9-10 · f1 fato sem página (texto com HTML) · e1 entidade (resumo que não está no PDF) · tudo mais, 404.
 *
 * Também o grafo de teste do explorador em GET /api/grafo/vizinhanca (ver `ENTIDADES`) e o roteiro "quem é" (evidências com id de entidade).
 *
 * Roteiros (a pergunta contém a palavra):
 *   lento/a   tokens com 150 ms entre eles, para provar que a tela mostra a resposta AOS POUCOS pelo proxy do ng serve
 *   xss       a resposta traz HTML hostil
 *   tabela    markdown com tabela, lista, cabeçalho e citações
 *   limite    HTTP 429 (corpo Erro do contrato)
 *   html502   HTTP 502 com uma página HTML (o que um proxy mostraria)
 *   cai       manda alguns tokens e encerra o fluxo sem `fim` (um corte seco com RST o proxy do ng serve não repassa: a tela fica em "Gerando" até o Parar)
 *   erro      manda alguns tokens e um evento `erro`
 *   trava     manda um token e fica parado até o cliente desistir (para o botão Parar)
 *   rastro    o fluxo completo do contrato (2 rodadas, uma ferramenta que falha, Cypher, evidências com e sem página, crítica
 *             "buscar_mais" e depois "suficiente", reparo e `fim` com métricas), com 120 ms entre os eventos para a tela mostrar o
 *             Rastro ao vivo
 *   ausente   o documento não tem o dado: crítica "ausente", nenhuma evidência, resposta "Não consta"
 *   marcar    evidências com e sem página, mas `citacoes` vazio (o assistente mostra as 3 primeiras com página)
 *   (outra)   resposta curta de uma frase com [E1] nos tokens e [p. 6] no fim
 */
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { montarPdf } from "./pdf.ts";

const porta = Number(process.env["API_FALSA_PORTA"] ?? 3100);
let contador = 0;

const FIM = (resposta: string, extra: Record<string, unknown> = {}) => ({
  mensagemId: `m-${contador}`,
  resposta,
  citacoes: [{ id: "p1", pagina: "p. 6" }],
  metricas: { latenciaMs: 1234, tokensEntrada: 100, tokensSaida: 20, rota: ["buscar_trechos"], estado: "suficiente" },
  ...extra,
});

const quadro = (evento: string, dados: unknown) => `event: ${evento}\ndata: ${JSON.stringify(dados)}\n\n`;
const dormir = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** O `GET /api/saude` com tudo no ar (o mesmo formato do contrato); os testes trocam por `page.route` para simular falhas. */
const SAUDE_OK = {
  status: "ok",
  servico: "graphrag-api",
  versao: "0.1.0",
  llm: { estado: "ok", ms: 16 },
  modelos: [
    { nome: "qwen36-35b-a3b", carregado: true },
    { nome: "qwen3-embed-0.6b", carregado: false },
    { nome: "qwen3-rerank-0.6b", carregado: false },
  ],
  neo4j: { estado: "ok", ms: 120 },
  indices: [
    { nome: "child_ft", estado: "ONLINE" },
    { nome: "entity_vec", estado: "ONLINE" },
    { nome: "fact_id", estado: "ONLINE" },
  ],
};

function json(res: ServerResponse, status: number, corpo: unknown): void {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(corpo));
}

async function lerCorpo(req: IncomingMessage): Promise<string> {
  const partes: Buffer[] = [];
  for await (const p of req) partes.push(p as Buffer);
  return Buffer.concat(partes).toString("utf-8");
}


const PAUSA_RASTRO = 120;
const etapa = (tipo: string, detalhe: Record<string, unknown>) => quadro("etapa", { tipo, detalhe });

async function roteiroRastro(res: ServerResponse): Promise<void> {
  const aberta = () => !res.destroyed && !res.writableEnded;
  const eventos = [
    etapa("reescrita", { rodada: 1, subperguntas: 2, fallback: null, ms: 420 }),
    etapa("rota", { rodada: 1, indice: 0, onda: 0, rota: "ferramentas", ferramentas: ["buscar_trechos"], fallback: null, ms: 900 }),
    etapa("ferramenta_inicio", { rodada: 1, indice: 0, ferramenta: "buscar_trechos" }),
    etapa("rota", { rodada: 1, indice: 1, onda: 0, rota: "ferramentas", ferramentas: ["consultar_grafo"], fallback: "chamada_invalida", ms: 700 }),
    etapa("ferramenta_inicio", { rodada: 1, indice: 1, ferramenta: "consultar_grafo" }),
    etapa("ferramenta_fim", { rodada: 1, indice: 0, ferramenta: "buscar_trechos", erro: null, evidencias: 5, ms: 340 }),
    etapa("ferramenta_fim", { rodada: 1, indice: 1, ferramenta: "consultar_grafo", erro: "tempo esgotado na consulta", evidencias: 0, ms: 2100 }),
    quadro("cypher", { query: "MATCH (f:FinancialFact) WHERE f.metric = 'Lucro'\nRETURN f.value AS v LIMIT 5 // <script>window.__xss=1</script>", linhas: 3, ms: 45 }),
    etapa("critica", { rodada: 1, decisao: "buscar_mais", perguntas: 1, faltando: "o lucro de 2024", ms: 2500 }),
    etapa("reescrita", { rodada: 2, subperguntas: 1, fallback: null, ms: 300 }),
    etapa("rota", { rodada: 2, indice: 0, onda: 0, rota: "ferramentas", ferramentas: ["buscar_trechos"], fallback: null, ms: 800 }),
    etapa("ferramenta_inicio", { rodada: 2, indice: 0, ferramenta: "buscar_trechos" }),
    etapa("ferramenta_fim", { rodada: 2, indice: 0, ferramenta: "buscar_trechos", erro: null, evidencias: 4, ms: 310 }),
    etapa("critica", { rodada: 2, decisao: "suficiente", perguntas: 0, faltando: "", ms: 2200 }),
    quadro("evidencia", { id: "p1", tipo: "pai", pagina: "p. 6", trecho: "Lucro líquido ajustado de R$ 20,7 bilhões em 2025.", score: 0.91 }),
    quadro("evidencia", { id: "t1", tipo: "tabela", pagina: "p. 9-10", trecho: "| Ano | Lucro |", score: 0.8 }),
    quadro("evidencia", { id: "f1", tipo: "fato", pagina: null, trecho: '<img src=x onerror="window.__xss=1"> valor sem página', score: 0.5 }),
  ];
  for (const e of eventos) {
    if (!aberta()) return;
    res.write(e);
    await dormir(PAUSA_RASTRO);
  }
  for (const t of ["O lucro foi ", "R$ 20 bi [E1]", "."]) {
    if (!aberta()) return;
    res.write(quadro("token", { t }));
    await dormir(PAUSA_RASTRO);
  }
  res.write(etapa("reparo", { frases: ["O lucro foi R$ 20 bi"] }));
  await dormir(PAUSA_RASTRO);
  res.write(
    quadro("fim", FIM("O lucro foi R$ 20 bi [p. 6].", { metricas: { latenciaMs: 12345, tokensEntrada: 1234, tokensSaida: 56, rota: ["buscar_trechos", "consultar_grafo"], estado: "suficiente" } })),
  );
}

function roteiroAusente(res: ServerResponse): void {
  for (const e of [
    etapa("reescrita", { rodada: 1, subperguntas: 1, fallback: null, ms: 300 }),
    etapa("rota", { rodada: 1, indice: 0, onda: 0, rota: "ferramentas", ferramentas: ["buscar_trechos"], fallback: null, ms: 700 }),
    etapa("ferramenta_inicio", { rodada: 1, indice: 0, ferramenta: "buscar_trechos" }),
    etapa("ferramenta_fim", { rodada: 1, indice: 0, ferramenta: "buscar_trechos", erro: null, evidencias: 0, ms: 280 }),
    etapa("critica", { rodada: 1, decisao: "ausente", perguntas: 0, faltando: "o documento não traz esse dado", ms: 1900 }),
  ])
    res.write(e);
  res.write(
    quadro("fim", FIM("Não consta no documento.", { citacoes: [], metricas: { latenciaMs: 3000, tokensEntrada: 300, tokensSaida: 8, rota: ["buscar_trechos"], estado: "ausente" } })),
  );
}

/** A ferramenta de cada modo forçado (a mesma tabela de `api/src/agente/modos.ts`). */
const FERRAMENTA_DO_MODO: Record<string, string> = { trechos: "buscar_trechos", tabelas: "buscar_tabelas", local: "entidade", global: "panorama", cypher: "consultar_grafo" };

const PDF = montarPdf();

const FONTES: Record<string, { tipo: string; pagina: string | null; texto: string; secao: string | null }> = {
  p1: { tipo: "pai", pagina: "p. 6", texto: "O lucro liquido ajustado foi de vinte bilhoes de reais em dois mil e vinte e cinco.", secao: "Resultados > Lucro" },
  t1: { tipo: "tabela", pagina: "p. 9-10", texto: "| Ano | Lucro |\n|---|---|\n| 2024 | trinta e sete |\n| 2025 | vinte |", secao: "Resultados > Tabela de lucro" },
  f1: { tipo: "fato", pagina: null, texto: '<img src=x onerror="window.__xss=1"> valor sem pagina', secao: null },
  e1: { tipo: "entidade", pagina: null, texto: "Uma entidade resumida que nao esta escrita em nenhuma pagina do PDF.", secao: null },
};

function servirPdf(req: IncomingMessage, res: ServerResponse): void {
  const total = PDF.length;
  const m = /^bytes=(\d*)-(\d*)$/.exec(String(req.headers["range"] ?? ""));
  if (!m) {
    res.writeHead(200, { "content-type": "application/pdf", "content-length": total, "accept-ranges": "bytes" });
    return void res.end(PDF);
  }
  const ini = m[1] === "" ? Math.max(0, total - Number(m[2])) : Number(m[1]);
  const fim = m[1] === "" || m[2] === "" ? total - 1 : Math.min(Number(m[2]), total - 1);
  if (ini > fim || ini >= total) {
    res.writeHead(416, { "content-type": "application/json", "content-range": `bytes */${total}` });
    return void res.end(JSON.stringify({ codigo: "faixa_invalida", mensagem: "Faixa fora do arquivo." }));
  }
  res.writeHead(206, { "content-type": "application/pdf", "content-length": fim - ini + 1, "content-range": `bytes ${ini}-${fim}/${total}`, "accept-ranges": "bytes" });
  res.end(PDF.subarray(ini, fim + 1));
}

/**
 * O grafo de teste do explorador (F8.5). Entidades: bb (Banco do Brasil), uniao, marco, bbseg, tesouro, bndes e `hostil` (rótulo e
 * tipo com HTML). Ligações: uniao→bb, marco→bb, bb→bbseg, uniao→tesouro, uniao→bndes, hostil→tesouro. `ent:erro` responde 503 e
 * `ent:grande` devolve 100 nós com `truncado`. Tudo o mais é 404, como a API real.
 */
const ENTIDADES: Record<string, { rotulo: string; tipo: string }> = {
  "ent:org:bb": { rotulo: "Banco do Brasil", tipo: "organizacao" },
  "ent:org:uniao": { rotulo: "União Federal", tipo: "organizacao" },
  "ent:pessoa:marco": { rotulo: "Marco Geovanne Tobias da Silva", tipo: "pessoa" },
  "ent:org:bbseg": { rotulo: "BB Seguridade", tipo: "organizacao" },
  "ent:org:tesouro": { rotulo: "Tesouro Nacional", tipo: "organizacao" },
  "ent:org:bndes": { rotulo: "BNDES", tipo: "organizacao" },
  "ent:org:hostil": { rotulo: '<img src=x onerror="window.__xss=1">', tipo: "<script>window.__xss=1</script>" },
};
const LIGACOES: [string, string, string][] = [
  ["ent:org:uniao", "ent:org:bb", "CONTROLA"],
  ["ent:pessoa:marco", "ent:org:bb", "DIRIGE"],
  ["ent:org:bb", "ent:org:bbseg", "CONTROLA"],
  ["ent:org:uniao", "ent:org:tesouro", "VINCULADA"],
  ["ent:org:uniao", "ent:org:bndes", "CONTROLA"],
  ["ent:org:hostil", "ent:org:tesouro", "CITA"],
];

function vizinhanca(url: URL, res: ServerResponse): void {
  const q = url.searchParams.get("entidade") ?? "";
  if (q === "") return json(res, 400, { codigo: "requisicao_invalida", mensagem: "Informe entidade." });
  if (q === "ent:erro") return json(res, 503, { codigo: "neo4j_indisponivel", mensagem: "O banco de grafos não está disponível." });
  if (q === "ent:grande") {
    const nos = [{ id: "ent:grande", rotulo: "Entidade grande", tipo: "organizacao" }, ...Array.from({ length: 99 }, (_, i) => ({ id: `ent:g:${i}`, rotulo: `Vizinha ${i + 1}`, tipo: "organizacao" }))];
    const arestas = nos.slice(1).map((n) => ({ origem: "ent:grande", destino: n.id, tipo: "LIGADA" }));
    return json(res, 200, { entidade: nos[0], nos, arestas, truncado: true });
  }
  const id = Object.keys(ENTIDADES).find((k) => k === q || ENTIDADES[k]?.rotulo.toLowerCase() === q.toLowerCase());
  if (!id) return json(res, 404, { codigo: "entidade_nao_encontrada", mensagem: "Nenhuma entidade com esse nome ou id." });
  const no = (k: string) => ({ id: k, rotulo: ENTIDADES[k]?.rotulo ?? k, tipo: ENTIDADES[k]?.tipo ?? "" });
  const ids = new Set([id]);
  for (const [a, b] of LIGACOES) {
    if (a === id) ids.add(b);
    if (b === id) ids.add(a);
  }
  const arestas = LIGACOES.filter(([a, b]) => ids.has(a) && ids.has(b)).map(([origem, destino, tipo]) => ({ origem, destino, tipo }));
  json(res, 200, { entidade: no(id), nos: [...ids].map(no), arestas, truncado: false });
}

async function responderChat(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const bruto = await lerCorpo(req);
  let corpo: Record<string, unknown>;
  try {
    corpo = JSON.parse(bruto) as Record<string, unknown>;
  } catch {
    return json(res, 400, { codigo: "requisicao_invalida", mensagem: "Corpo inválido: mande conversationId e message." });
  }
  contador++;
  const mensagem = typeof corpo["message"] === "string" ? corpo["message"] : "";
  if (mensagem === "" || typeof corpo["conversationId"] !== "string") return json(res, 400, { codigo: "requisicao_invalida", mensagem: "Corpo inválido: mande conversationId e message." });

  if (mensagem.includes("limite")) return json(res, 429, { codigo: "ocupado", mensagem: "Há perguntas demais em andamento. Tente de novo em instantes." });
  if (mensagem.includes("html502")) {
    res.writeHead(502, { "content-type": "text/html" });
    return void res.end("<html><body><h1>Bad Gateway</h1><script>alert(1)</script></body></html>");
  }

  res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
  res.write(quadro("etapa", { tipo: "reescrita", detalhe: { estado: "inicio" } }));
  const aberta = () => !res.destroyed && !res.writableEnded;
  const tokens = async (partes: string[], pausa = 5) => {
    for (const t of partes) {
      if (!aberta()) return;
      res.write(quadro("token", { t }));
      await dormir(pausa);
    }
  };

  const minuscula = mensagem.toLowerCase();
  if (minuscula.includes("modo teste")) {
    // roteiro "modo teste": a rota depende do `mode` do pedido (forçado: a ferramenta do modo, com `forcado`) e o perfil rápido
    // faz só a rodada 1, como a API real
    const modo = typeof corpo["mode"] === "string" ? corpo["mode"] : "auto";
    const rapido = corpo["profile"] === "consultar-rapido";
    const ferramenta = FERRAMENTA_DO_MODO[modo] ?? "buscar_trechos";
    const forcado = modo === "auto" ? {} : { forcado: modo };
    for (const rodada of rapido ? [1] : [1, 2]) {
      res.write(etapa("rota", { rodada, indice: 0, onda: 0, rota: "ferramentas", ferramentas: [ferramenta], fallback: null, ms: modo === "auto" ? 900 : 0, ...forcado }));
      res.write(etapa("ferramenta_inicio", { rodada, indice: 0, ferramenta }));
      res.write(etapa("ferramenta_fim", { rodada, indice: 0, ferramenta, erro: null, evidencias: 1, ms: 120 }));
      res.write(etapa("critica", { rodada, decisao: rodada === 1 && !rapido ? "buscar_mais" : "suficiente", perguntas: rodada === 1 && !rapido ? 1 : 0, faltando: "", ms: 300 }));
    }
    await tokens(["Resposta ", "no modo ", modo, "."]);
    res.write(quadro("evidencia", { id: "p1", tipo: "pai", pagina: "p. 6", trecho: "trecho", score: 0.9 }));
    res.write(quadro("fim", FIM(`Resposta no modo ${modo}.`, { metricas: { latenciaMs: 800, tokensEntrada: 50, tokensSaida: 5, rota: [ferramenta], estado: "suficiente" } })));
  } else if (minuscula.includes("quem é") || minuscula.includes("quem e ")) {
    // roteiro "quem é": a ferramenta `entidade` acha entidades (evidências com id de entidade) e um trecho de texto
    const todas = minuscula.includes("todas as entidades");
    res.write(etapa("rota", { rodada: 1, indice: 0, onda: 0, rota: "entidade", ferramentas: ["entidade"], fallback: null, ms: 40 }));
    await tokens(["O Banco do Brasil ", "é uma sociedade ", "de economia mista [E1]", "."]);
    res.write(quadro("evidencia", { id: "ent:org:bb", tipo: "entidade", pagina: "p. 6", trecho: "Banco do Brasil S.A.", score: 0.95 }));
    res.write(quadro("evidencia", { id: "ent:pessoa:marco", tipo: "entidade", pagina: null, trecho: "Diretor de Relações com Investidores", score: 0.7 }));
    if (todas) for (let i = 1; i <= 6; i++) res.write(quadro("evidencia", { id: `ent:x:${i}`, tipo: "entidade", pagina: null, trecho: `Entidade ${i}`, score: 0.5 }));
    res.write(quadro("evidencia", { id: "p1", tipo: "pai", pagina: "p. 6", trecho: "trecho", score: 0.9 }));
    res.write(quadro("fim", FIM("O Banco do Brasil é uma sociedade de economia mista [p. 6].", { metricas: { latenciaMs: 900, tokensEntrada: 80, tokensSaida: 12, rota: ["entidade"], estado: "suficiente" } })));
  } else if (minuscula.includes("olá")) {
    // uma saudação: o ciclo termina `suficiente`, mas sem nenhuma evidência nem citação (a tela não põe selo de estado)
    // a API real emite a reescrita mesmo numa saudação (estado `sem_consulta`: nenhuma ferramenta, nenhuma evidência)
    res.write(etapa("reescrita", { rodada: 1, subperguntas: 0, fallback: null, ms: 300 }));
    await tokens(["Olá! ", "Sou o assistente do Formulário de Referência. ", "O que você quer saber?"]);
    res.write(quadro("fim", FIM("Olá! Sou o assistente do Formulário de Referência. O que você quer saber?", { citacoes: [], metricas: { latenciaMs: 800, tokensEntrada: 40, tokensSaida: 14, rota: [], estado: "sem_consulta" } })));
  } else if (minuscula.includes("parcial")) {
    // o ciclo acabou `incompleta`: achou uma parte e a crítica ainda pedia mais
    await tokens(["Achei só ", "uma parte [E1]", "."]);
    res.write(quadro("evidencia", { id: "p1", tipo: "pai", pagina: "p. 6", trecho: "Lucro líquido ajustado de R$ 20,7 bilhões em 2025.", score: 0.7 }));
    res.write(quadro("fim", FIM("Achei só uma parte [p. 6].", { metricas: { latenciaMs: 15000, tokensEntrada: 900, tokensSaida: 30, rota: ["buscar_trechos"], estado: "incompleta" } })));
  } else if (minuscula.includes("marcar")) {
    // a resposta se apoiou em evidências mas não citou nenhuma (citacoes vazio): a tela mostra as primeiras com página
    await tokens(["Resposta ", "sem marcas."]);
    for (const [id, tipo, pagina] of [["p1", "pai", "p. 6"], ["t1", "tabela", "p. 9-10"], ["e1", "entidade", null], ["p2", "pai", "p. 3"], ["p3", "pai", "p. 4"]] as const)
      res.write(quadro("evidencia", { id, tipo, pagina, trecho: `trecho de ${id}`, score: 0.5 }));
    res.write(quadro("fim", FIM("Resposta sem marcas.", { citacoes: [] })));
  } else if (minuscula.includes("fontes")) {
    // várias fontes de tipos diferentes (uma repetida, uma sem página, uma entidade) para os cartões de fonte do assistente
    await tokens(["O lucro foi ", "R$ 20 bi [E1]", "."]);
    res.write(quadro("evidencia", { id: "p1", tipo: "pai", pagina: "p. 6", trecho: "Lucro líquido ajustado de R$ 20,7 bilhões em 2025.", score: 0.91 }));
    res.write(quadro("evidencia", { id: "t1", tipo: "tabela", pagina: "p. 9-10", trecho: "| Ano | Lucro |", score: 0.8 }));
    res.write(quadro("evidencia", { id: "p1", tipo: "pai", pagina: "p. 6", trecho: "Lucro líquido ajustado de R$ 20,7 bilhões em 2025.", score: 0.6 }));
    res.write(quadro("evidencia", { id: "e1", tipo: "entidade", pagina: null, trecho: "Uma entidade resumida.", score: 0.5 }));
    res.write(quadro("evidencia", { id: "f1", tipo: "fato", pagina: null, trecho: '<img src=x onerror="window.__xss=1"> valor sem página', score: 0.4 }));
    res.write(quadro("fim", FIM("O lucro foi R$ 20 bi [p. 6]. Veja também [p. 9-10].", { citacoes: [{ id: "p1", pagina: "p. 6" }, { id: "t1", pagina: "p. 9-10" }] })));
  } else if (mensagem.includes("rastro")) {
    await roteiroRastro(res);
  } else if (mensagem.includes("ausente")) {
    roteiroAusente(res);
  } else if (/lent[oa]/.test(mensagem)) {
    await tokens(["O ", "lucro ", "líquido ", "foi ", "de ", "R$ 20 ", "bilhões "], 150);
    await tokens(["[E1]"], 1500); // a marca "fonte" fica na tela tempo de sobra para o teste vê-la mesmo com a máquina carregada
    await tokens(["."], 150);
    res.write(quadro("fim", FIM("O lucro líquido foi de R$ 20 bilhões [p. 6].")));
  } else if (mensagem.includes("xss")) {
    await tokens(['<img src=x onerror="window.__xss=1">', "<script>window.__xss=1</script>", " texto **seguro** ", "[link](javascript:window.__xss=1)"]);
    res.write(quadro("fim", FIM('<img src=x onerror="window.__xss=1"><script>window.__xss=1</script> texto **seguro** [link](javascript:window.__xss=1)')));
  } else if (mensagem.includes("tabela")) {
    const md = "# Resultado\n\nO lucro por ano:\n\n| Ano | Lucro |\n|---|---|\n| 2024 | 37,9 [p. 6] |\n| 2025 | 20,0 [p. 9] |\n\n- primeiro item [p. 10-12, 40]\n- segundo item [sem página]\n\nFim `[p. 7]`.";
    await tokens([md.slice(0, 40), md.slice(40, 90), md.slice(90)]);
    res.write(quadro("fim", FIM(md, { citacoes: [{ id: "p1", pagina: "p. 6" }] })));
  } else if (mensagem.includes("cai")) {
    await tokens(["Metade ", "da resposta"]); // o fluxo acaba limpo, sem `fim`: é o que qualquer proxy repassa
    return void res.end();
  } else if (mensagem.includes("erro")) {
    await tokens(["Começo da resposta"]);
    res.write(quadro("erro", { codigo: "llm_timeout", mensagem: "O modelo de linguagem demorou demais. Tente novamente." }));
  } else if (mensagem.includes("trava")) {
    await tokens(["Resposta ", "parcial"]);
    await new Promise<void>((ok) => res.on("close", () => ok()));
    return;
  } else {
    await tokens(["O lucro foi ", "R$ 20 bi [E1]", "."]);
    res.write(quadro("evidencia", { id: "p1", tipo: "pai", pagina: "p. 6", trecho: "trecho", score: 0.9 }));
    res.write(quadro("fim", FIM("O lucro foi R$ 20 bi [p. 6].")));
  }
  res.end();
}

const servidor = createServer((req, res) => {
  const url = new URL(req.url ?? "/", "http://x");
  if (url.pathname === "/api/chat" && req.method === "POST") {
    responderChat(req, res).catch(() => res.destroy());
    return;
  }
  if (url.pathname === "/api/documento/pdf" && req.method === "GET") return servirPdf(req, res);
  if (url.pathname === "/api/grafo/vizinhanca" && req.method === "GET") return vizinhanca(url, res);
  const fonte = /^\/api\/fonte\/([^/]+)$/.exec(url.pathname);
  if (fonte && req.method === "GET") {
    const f = FONTES[decodeURIComponent(fonte[1] as string)];
    return f ? json(res, 200, f) : json(res, 404, { codigo: "nao_encontrado", mensagem: "Nenhum item do grafo com esse id." });
  }
  if (url.pathname === "/api/saude") return json(res, 200, SAUDE_OK);
  if (url.pathname === "/api/feedback" && req.method === "POST") {
    lerCorpo(req)
      .then((bruto) => {
        let c: Record<string, unknown> = {};
        try {
          c = JSON.parse(bruto) as Record<string, unknown>;
        } catch {
          /* corpo inválido: cai no 400 */
        }
        const valido = typeof c["mensagemId"] === "string" && c["mensagemId"] !== "" && (c["nota"] === 1 || c["nota"] === -1) && (c["comentario"] === undefined || (typeof c["comentario"] === "string" && c["comentario"].length <= 1000));
        if (!valido) return json(res, 400, { codigo: "requisicao_invalida", mensagem: "Mande mensagemId, nota (1 ou -1) e, se quiser, comentario (até 1.000 caracteres)." });
        json(res, 201, { registrado: true });
      })
      .catch(() => res.destroy());
    return;
  }
  json(res, 404, { codigo: "nao_encontrado", mensagem: "Rota inexistente." });
});

servidor.listen(porta, "127.0.0.1", () => console.log(`API falsa em http://127.0.0.1:${porta}`));
