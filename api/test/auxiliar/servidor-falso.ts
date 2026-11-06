/**
 * llama-swap de mentira para os testes do cliente LLM (F7.1): um servidor HTTP de verdade em 127.0.0.1,
 * porque o que se quer provar é o que o cliente manda e como ele reage ao que chega pela rede (corpo,
 * cabeçalhos, atraso, status, SSE), e isso um `fetch` simulado não prova.
 */
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

export interface Chamada {
  metodo: string;
  caminho: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- o corpo é o JSON que o cliente mandou
  corpo: any;
  cabecalhos: IncomingMessage["headers"];
}

export type Tratador = (chamada: Chamada, res: ServerResponse, numero: number) => void | Promise<void>;

export interface ServidorFalso {
  url: string;
  chamadas: Chamada[];
  fechar: () => Promise<void>;
}

export async function servidor(tratador: Tratador): Promise<ServidorFalso> {
  const chamadas: Chamada[] = [];
  const http = createServer((req, res) => {
    const partes: Buffer[] = [];
    req.on("data", (p: Buffer) => partes.push(p));
    req.on("end", () => {
      const texto = Buffer.concat(partes).toString("utf-8");
      const chamada: Chamada = {
        metodo: req.method ?? "",
        caminho: req.url ?? "",
        corpo: texto ? JSON.parse(texto) : undefined,
        cabecalhos: req.headers,
      };
      chamadas.push(chamada);
      void Promise.resolve(tratador(chamada, res, chamadas.length)).catch(() => res.destroy());
    });
  });
  await new Promise<void>((ok) => http.listen(0, "127.0.0.1", ok));
  const porta = (http.address() as AddressInfo).port;
  return {
    url: `http://127.0.0.1:${porta}`,
    chamadas,
    fechar: () =>
      new Promise<void>((ok) => {
        http.closeAllConnections();
        http.close(() => ok());
      }),
  };
}

/** Uma porta onde nada escuta, para o caso "llama-swap desligado". */
export async function portaFechada(): Promise<string> {
  const s = await servidor(() => undefined);
  const url = s.url;
  await s.fechar();
  return url;
}

export function json(res: ServerResponse, corpo: unknown, status = 200): void {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(corpo));
}

export function respostaChat(
  texto: string,
  extra: {
    raciocinio?: string;
    fim?: string;
    uso?: { prompt_tokens: number; completion_tokens: number };
    ferramentas?: { id: string; nome: string; argumentos: string }[];
    modelo?: string;
  } = {},
) {
  return {
    id: "chatcmpl-1",
    object: "chat.completion",
    created: 0,
    model: extra.modelo ?? "qwen36-35b-a3b",
    choices: [
      {
        index: 0,
        finish_reason: extra.fim ?? (extra.ferramentas ? "tool_calls" : "stop"),
        message: {
          role: "assistant",
          content: texto,
          ...(extra.raciocinio ? { reasoning_content: extra.raciocinio } : {}),
          ...(extra.ferramentas
            ? {
                tool_calls: extra.ferramentas.map((f) => ({
                  id: f.id,
                  type: "function",
                  function: { name: f.nome, arguments: f.argumentos },
                })),
              }
            : {}),
        },
      },
    ],
    usage: extra.uso ?? { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
  };
}

/** Escreve um fluxo SSE: cada item vira `data: ...`, e o fim vira `data: [DONE]`. */
export async function sse(
  res: ServerResponse,
  eventos: unknown[],
  opcoes: { intervaloMs?: number; semFim?: boolean } = {},
): Promise<void> {
  res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" });
  for (const e of eventos) {
    res.write(`data: ${JSON.stringify(e)}\n\n`);
    if (opcoes.intervaloMs) await new Promise((ok) => setTimeout(ok, opcoes.intervaloMs));
  }
  if (!opcoes.semFim) {
    res.write("data: [DONE]\n\n");
    res.end();
  }
}

export function pedaco(
  delta: Record<string, unknown>,
  fim: string | null = null,
  uso?: { prompt_tokens: number; completion_tokens: number },
) {
  return {
    id: "chatcmpl-1",
    object: "chat.completion.chunk",
    created: 0,
    model: "qwen36-35b-a3b",
    choices: uso ? [] : [{ index: 0, delta, finish_reason: fim }],
    ...(uso ? { usage: { ...uso, total_tokens: uso.prompt_tokens + uso.completion_tokens } } : {}),
  };
}

export function vetorUnitario(dim: number, posicao = 0): number[] {
  const v = new Array<number>(dim).fill(0);
  v[posicao % dim] = 1;
  return v;
}
