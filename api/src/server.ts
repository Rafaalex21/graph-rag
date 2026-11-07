import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { criarApp } from "./app.ts";
import { executarCiclo } from "./agente/ciclo.ts";
import { redigir } from "./agente/redator.ts";
import { GrafoNeo4j, criarExecutor } from "./ferramentas/index.ts";
import { sondaLlamaSwap } from "./http/saude.ts";
import { ClienteLlm } from "./llm/index.ts";
import { criarRegistrador } from "./telemetria/registro.ts";

const RAIZ = fileURLToPath(new URL("../../", import.meta.url));
const porta = Number(process.env["API_PORT"] ?? 3000);
const baseUrl = process.env["LLAMA_SWAP_URL"] ?? "http://127.0.0.1:8080";

const grafo = GrafoNeo4j.conectar();
const llm = new ClienteLlm({ baseUrl });
const executor = criarExecutor({ grafo, llm });
const registrarErro = (contexto: string, erro: unknown) => console.error(`[${contexto}] ${erro instanceof Error ? `${erro.name}: ${erro.message}` : String(erro)}`);
// F7.7: um registro por requisição em data/logs/telemetria/AAAA-MM-DD.jsonl; sem o texto da pergunta, salvo TELEMETRIA_TEXTO=1
const telemetria = criarRegistrador({ pasta: process.env["TELEMETRIA_DIR"] ?? join(RAIZ, "data", "logs", "telemetria"), registrarErro });

const app = criarApp({
  ciclo: (pergunta, opcoes) => executarCiclo(llm, executor, pergunta, opcoes),
  redator: (entrada, opcoes) => redigir(llm, entrada, opcoes),
  grafo,
  llm: sondaLlamaSwap(baseUrl),
  pdf: process.env["DOCUMENTO_PDF"] ?? join(RAIZ, "data", "raw", "banco_do_brasil_formulario_referencia_2026.pdf"),
  arquivoDeFeedback: process.env["FEEDBACK_JSONL"] ?? join(RAIZ, "data", "logs", "feedback.jsonl"),
  telemetria,
  telemetriaComTexto: process.env["TELEMETRIA_TEXTO"] === "1",
  registrarErro,
});

// RNF-1: escuta só no endereço local.
await app.listen({ host: "127.0.0.1", port: porta });
console.log(`API no ar em http://127.0.0.1:${porta}`);

/**
 * Aquece o Neo4j e os três modelos em segundo plano: o primeiro uso de um modelo frio leva ~14 s (F7.1) e a primeira pergunta não deve
 * pagar isso. Falhar aqui não derruba nada: `/api/saude` mostra quais estão carregados. `API_AQUECER=0` desliga.
 */
async function aquecer(): Promise<void> {
  const passos: [string, () => Promise<unknown>][] = [
    // a 1ª conexão ao Neo4j (driver + autenticação) passou de 2 s e fez o 1º /api/saude dizer "indisponível"
    ["neo4j", () => grafo.consultar("RETURN 1 AS ok")],
    ["principal", () => llm.chat([{ role: "user", content: "ok" }], { maxTokens: 1 })],
    ["embedding", () => llm.embeddings(["ok"])],
    ["reranker", () => llm.rerank("ok", ["ok"])],
  ];
  for (const [nome, passo] of passos) {
    const t0 = performance.now();
    try {
      await passo();
      console.log(`modelo ${nome} aquecido em ${Math.round(performance.now() - t0)} ms`);
    } catch (e) {
      console.error(`não foi possível aquecer o modelo ${nome}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
}
if (process.env["API_AQUECER"] !== "0") void aquecer();

for (const sinal of ["SIGINT", "SIGTERM"] as const) {
  process.on(sinal, () => {
    void app.close().then(() => telemetria.aguardar()).then(() => grafo.fechar()).finally(() => process.exit(0));
  });
}
