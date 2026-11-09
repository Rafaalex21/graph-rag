/**
 * A API falsa dos testes E2E da interface: fala o contrato de `contracts/api.openapi.yaml` (POST /api/chat em SSE, corpo `Erro`
 * nas falhas) com respostas roteirizadas pelo TEXTO da pergunta. Existe para que o E2E da interface seja determinístico e rode em
 * qualquer máquina e no CI, sem Neo4j nem modelos. O que é da API de verdade (agente, grafo, guarda) é testado no projeto
 * `ao-vivo`, contra a pilha real.
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
 *   (outra)   resposta curta de uma frase com [E1] nos tokens e [p. 6] no fim
 */
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";

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

  if (mensagem.includes("rastro")) {
    await roteiroRastro(res);
  } else if (mensagem.includes("ausente")) {
    roteiroAusente(res);
  } else if (/lent[oa]/.test(mensagem)) {
    await tokens(["O ", "lucro ", "líquido ", "foi ", "de ", "R$ 20 ", "bilhões ", "[E1]", "."], 150);
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
  if (url.pathname === "/api/saude") return json(res, 200, { estado: "ok" });
  json(res, 404, { codigo: "nao_encontrado", mensagem: "Rota inexistente." });
});

servidor.listen(porta, "127.0.0.1", () => console.log(`API falsa em http://127.0.0.1:${porta}`));
