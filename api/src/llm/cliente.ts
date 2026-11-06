/**
 * Cliente LLM do agente (F7.1, ARQUITETURA §7 e §9): o SDK da OpenAI apontado para o llama-swap.
 *
 * Cobre as cinco coisas que o agente pede ao llama-swap: chat (com ou sem fluxo), JSON, chamada de
 * ferramentas, embeddings e rerank. O que o SDK não dá, o cliente acrescenta: perfis (modelo e
 * `chat_template_kwargs`), tempo-limite por chamada, cancelamento, uma nova tentativa para o que é
 * transitório, erros por causa e conferência do que volta (dimensão e norma dos vetores, índices do rerank).
 */
import OpenAI, {
  APIConnectionError,
  APIConnectionTimeoutError,
  APIError,
  APIUserAbortError,
} from "openai";
import type {
  ChatCompletion,
  ChatCompletionChunk,
  ChatCompletionCreateParamsNonStreaming,
  ChatCompletionCreateParamsStreaming,
  ChatCompletionMessageParam,
} from "openai/resources/chat/completions";
import {
  LlmAbortadoError,
  LlmErro,
  LlmHttpError,
  LlmIndisponivelError,
  LlmRespostaInvalidaError,
  LlmTimeoutError,
} from "./erros.ts";
import { DIMENSOES, MODELOS, PERFIS, TAREFA_PADRAO, type Perfil } from "./perfis.ts";

export type Mensagem = ChatCompletionMessageParam;

export interface OpcoesCliente {
  /** Ex.: `http://127.0.0.1:8080`. Barra final e `/v1` são aceitos e normalizados. */
  baseUrl: string;
  /** Tentativas por chamada (a primeira conta). Padrão 2: uma nova tentativa para rede e 5xx. */
  tentativas?: number;
  /** Espera antes da nova tentativa, multiplicada pelo número da tentativa. */
  esperaRetentativaMs?: number;
}

export interface OpcoesChat {
  perfil?: Perfil;
  temperatura?: number;
  maxTokens?: number;
  parar?: string[];
  /** Substitui o tempo-limite do perfil. */
  timeoutMs?: number;
  signal?: AbortSignal;
}

export type FimMotivo = "stop" | "length" | "tool_calls" | "content_filter" | "desconhecido";
export interface Uso {
  entrada: number;
  saida: number;
}

export interface RespostaChat {
  texto: string;
  /** `reasoning_content` do servidor, quando o modelo raciocina; nunca vai ao usuário. */
  raciocinio: string;
  fim: FimMotivo;
  uso: Uso;
  modelo: string;
  ms: number;
}

export interface OpcoesJson<T> extends OpcoesChat {
  /** JSON Schema: o llama.cpp o converte em gramática e o modelo não consegue sair da forma. */
  esquema?: Record<string, unknown>;
  /** Valida e converte o objeto lido; lançar vira `LlmRespostaInvalidaError`. */
  validar?: (valor: unknown) => T;
}

export interface Ferramenta {
  nome: string;
  descricao: string;
  /** JSON Schema do objeto de argumentos. */
  parametros: Record<string, unknown>;
}

export interface ChamadaDeFerramenta {
  id: string;
  nome: string;
  argumentos: Record<string, unknown>;
}

export interface RespostaFerramentas extends RespostaChat {
  /** Vazia quando o modelo respondeu em texto em vez de chamar uma ferramenta. */
  chamadas: ChamadaDeFerramenta[];
}

export interface OpcoesFerramentas extends OpcoesChat {
  /** `required` obriga a chamar alguma; `none` proíbe. */
  escolha?: "auto" | "required" | "none";
}

export interface OpcoesFluxo extends OpcoesChat {
  /** Silêncio máximo entre dois pedaços; substitui o do perfil. */
  ociosoMs?: number;
  /** Duração máxima da resposta inteira. Padrão 10 minutos. */
  totalMs?: number;
}

export type EventoFluxo =
  | { tipo: "token"; texto: string }
  | { tipo: "raciocinio"; texto: string }
  | { tipo: "fim"; fim: FimMotivo; uso: Uso };

export interface OpcoesEmbeddings {
  modelo?: string;
  dimensoes?: number;
  /** Textos por requisição; o indexador usa 16. */
  lote?: number;
  timeoutMs?: number;
  signal?: AbortSignal;
}

export interface OpcoesRerank {
  modelo?: string;
  timeoutMs?: number;
  signal?: AbortSignal;
}

const TENTATIVAS_PADRAO = 2;
const TIMEOUT_AUXILIAR_MS = 30_000;
const TOTAL_FLUXO_MS = 600_000;
const LOTE_PADRAO = 16;
const TOLERANCIA_NORMA = 1e-3;

export function formatarConsulta(pergunta: string, tarefa: string = TAREFA_PADRAO): string {
  return `Instruct: ${tarefa}\nQuery: ${pergunta}`;
}

function normalizarBase(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, "").replace(/\/v1$/, "");
}

function mapaFim(motivo: string | null | undefined): FimMotivo {
  return motivo === "stop" || motivo === "length" || motivo === "tool_calls" || motivo === "content_filter"
    ? motivo
    : "desconhecido";
}

function dormir(ms: number): Promise<void> {
  return ms > 0 ? new Promise((ok) => setTimeout(ok, ms)) : Promise.resolve();
}

function lerJson(texto: string, operacao: string): unknown {
  const limpo = texto
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/, "");
  try {
    return JSON.parse(limpo);
  } catch (e) {
    throw new LlmRespostaInvalidaError(`não é JSON (${(e as Error).message})`, operacao, texto);
  }
}

export class ClienteLlm {
  readonly baseUrl: string;
  private readonly sdk: OpenAI;
  private readonly tentativas: number;
  private readonly espera: number;

  constructor(opcoes: OpcoesCliente) {
    this.baseUrl = normalizarBase(opcoes.baseUrl);
    this.tentativas = Math.max(1, opcoes.tentativas ?? TENTATIVAS_PADRAO);
    this.espera = opcoes.esperaRetentativaMs ?? 500;
    // O llama-swap não pede chave; o SDK exige uma. As tentativas são do cliente, não do SDK, para que o
    // tempo-limite e o cancelamento valham para a chamada inteira e os erros saiam com os nossos tipos.
    this.sdk = new OpenAI({ apiKey: "local", baseURL: `${this.baseUrl}/v1`, maxRetries: 0 });
  }

  // ---------- chat ----------

  async chat(mensagens: Mensagem[], opcoes: OpcoesChat = {}): Promise<RespostaChat> {
    const r = await this.completar("chat", mensagens, opcoes);
    return r;
  }

  async chatJson<T = unknown>(
    mensagens: Mensagem[],
    opcoes: OpcoesJson<T> = {},
  ): Promise<RespostaChat & { valor: T }> {
    const formato = opcoes.esquema
      ? { type: "json_schema", json_schema: { name: "resposta", strict: true, schema: opcoes.esquema } }
      : { type: "json_object" };
    const r = await this.completar("chatJson", mensagens, opcoes, { response_format: formato });
    if (!r.texto) {
      throw new LlmRespostaInvalidaError(
        r.fim === "length"
          ? "resposta truncada e vazia (finish_reason=length): o orçamento de tokens acabou antes do JSON; " +
              "aumente maxTokens ou desligue o raciocínio"
          : `texto vazio (finish_reason=${r.fim})`,
        "chatJson",
        r.texto,
      );
    }
    const bruto = lerJson(r.texto, "chatJson");
    try {
      return { ...r, valor: opcoes.validar ? opcoes.validar(bruto) : (bruto as T) };
    } catch (e) {
      throw new LlmRespostaInvalidaError((e as Error).message, "chatJson", r.texto);
    }
  }

  async chamarFerramentas(
    mensagens: Mensagem[],
    ferramentas: Ferramenta[],
    opcoes: OpcoesFerramentas = {},
  ): Promise<RespostaFerramentas> {
    const extra = {
      tools: ferramentas.map((f) => ({
        type: "function",
        function: { name: f.nome, description: f.descricao, parameters: f.parametros },
      })),
      tool_choice: opcoes.escolha ?? "auto",
    };
    const bruta = await this.completarBruto("chamarFerramentas", mensagens, opcoes, extra);
    const base = this.resumir(bruta.completo, bruta.ms);
    const declaradas = new Set(ferramentas.map((f) => f.nome));
    const chamadas: ChamadaDeFerramenta[] = [];
    for (const c of bruta.completo.choices[0]?.message.tool_calls ?? []) {
      if (c.type !== "function") continue;
      const nome = c.function.name;
      if (!declaradas.has(nome)) {
        throw new LlmRespostaInvalidaError(
          `o modelo chamou a ferramenta "${nome}", que não foi declarada (${[...declaradas].join(", ")})`,
          "chamarFerramentas",
          c.function.arguments,
        );
      }
      const texto = c.function.arguments ?? "";
      const argumentos = texto.trim() === "" ? {} : lerJson(texto, "chamarFerramentas");
      if (typeof argumentos !== "object" || argumentos === null || Array.isArray(argumentos)) {
        throw new LlmRespostaInvalidaError(`argumentos de "${nome}" não são um objeto`, "chamarFerramentas", texto);
      }
      chamadas.push({ id: c.id, nome, argumentos: argumentos as Record<string, unknown> });
    }
    return { ...base, chamadas };
  }

  /**
   * Fluxo de tokens (o redator, F7.5). A nova tentativa só vale até o primeiro pedaço: depois dele o
   * usuário já viu texto e repetir duplicaria a resposta.
   */
  async *chatStream(mensagens: Mensagem[], opcoes: OpcoesFluxo = {}): AsyncGenerator<EventoFluxo> {
    const perfil = PERFIS[opcoes.perfil ?? "principal"];
    const ociosoMs = opcoes.ociosoMs ?? perfil.ociosoMs;
    const totalMs = opcoes.totalMs ?? TOTAL_FLUXO_MS;
    const usuario = opcoes.signal;
    const ocioso = new AbortController();
    const total = AbortSignal.timeout(totalMs);
    const signal = AbortSignal.any([...(usuario ? [usuario] : []), total, ocioso.signal]);
    let relogio: ReturnType<typeof setTimeout> | undefined;
    const armar = () => {
      clearTimeout(relogio);
      relogio = setTimeout(() => ocioso.abort(), ociosoMs);
    };
    const corpo = {
      ...this.corpoChat(mensagens, opcoes),
      stream: true,
      stream_options: { include_usage: true },
    } as unknown as ChatCompletionCreateParamsStreaming;
    const traduzir = (e: unknown) =>
      this.traduzir(e, "chatStream", usuario, [
        { sinal: total, limiteMs: totalMs, detalhe: "duração total" },
        { sinal: ocioso.signal, limiteMs: ociosoMs, detalhe: "silêncio entre pedaços" },
      ]);

    try {
      armar();
      let fluxo: AsyncIterable<ChatCompletionChunk> | undefined;
      for (let tentativa = 1; fluxo === undefined; tentativa++) {
        if (usuario?.aborted) throw new LlmAbortadoError("chatStream");
        try {
          fluxo = await this.sdk.chat.completions.create(corpo, { signal });
        } catch (e) {
          const erro = traduzir(e);
          if (!erro.repetivel || tentativa >= this.tentativas) throw erro;
          await dormir(this.espera * tentativa);
        }
      }
      let fim: FimMotivo = "desconhecido";
      let uso: Uso = { entrada: 0, saida: 0 };
      try {
        for await (const pedaco of fluxo) {
          armar();
          const escolha = pedaco.choices[0];
          const delta = escolha?.delta as { content?: string | null; reasoning_content?: string | null } | undefined;
          if (delta?.reasoning_content) yield { tipo: "raciocinio", texto: delta.reasoning_content };
          if (delta?.content) yield { tipo: "token", texto: delta.content };
          if (escolha?.finish_reason) fim = mapaFim(escolha.finish_reason);
          if (pedaco.usage) {
            uso = { entrada: pedaco.usage.prompt_tokens, saida: pedaco.usage.completion_tokens };
          }
        }
      } catch (e) {
        throw traduzir(e);
      }
      // O iterador do SDK trata o cancelamento como fim normal do fluxo e não levanta nada: sem esta
      // checagem, um fluxo cortado pelo usuário, pelo silêncio do servidor ou pelo tempo total pareceria completo.
      if (signal.aborted) throw traduzir(new APIUserAbortError());
      yield { tipo: "fim", fim, uso };
    } finally {
      clearTimeout(relogio);
    }
  }

  // ---------- embeddings e rerank ----------

  async embeddings(textos: string[], opcoes: OpcoesEmbeddings = {}): Promise<number[][]> {
    if (textos.length === 0) return [];
    const modelo = opcoes.modelo ?? MODELOS.embedding;
    const dimensoes = opcoes.dimensoes ?? DIMENSOES;
    const lote = Math.max(1, opcoes.lote ?? LOTE_PADRAO);
    const saida: number[][] = [];
    for (let i = 0; i < textos.length; i += lote) {
      const parte = textos.slice(i, i + lote);
      const r = await this.executar("embeddings", opcoes.timeoutMs ?? TIMEOUT_AUXILIAR_MS, opcoes.signal, (signal) =>
        this.sdk.embeddings.create({ model: modelo, input: parte, encoding_format: "float" }, { signal }),
      );
      const ordenado = [...r.data].sort((a, b) => a.index - b.index);
      if (ordenado.length !== parte.length) {
        throw new LlmRespostaInvalidaError(`${parte.length} textos, ${ordenado.length} vetores`, "embeddings");
      }
      for (const d of ordenado) {
        const v = d.embedding as number[];
        if (v.length !== dimensoes) {
          throw new LlmRespostaInvalidaError(`vetor com ${v.length} dimensões, esperado ${dimensoes}`, "embeddings");
        }
        const norma = Math.sqrt(v.reduce((s, x) => s + x * x, 0));
        if (Math.abs(norma - 1) > TOLERANCIA_NORMA) {
          throw new LlmRespostaInvalidaError(`vetor não normalizado (norma ${norma.toFixed(6)})`, "embeddings");
        }
        saida.push(v);
      }
    }
    return saida;
  }

  /** O vetor de uma pergunta, com o prefixo `Instruct:` com que o Qwen3-Embedding foi treinado. */
  async embeddingDeConsulta(
    pergunta: string,
    opcoes: OpcoesEmbeddings & { tarefa?: string } = {},
  ): Promise<number[]> {
    const [vetor] = await this.embeddings([formatarConsulta(pergunta, opcoes.tarefa)], opcoes);
    if (!vetor) throw new LlmRespostaInvalidaError("sem vetor", "embeddings");
    return vetor;
  }

  /** Nota de relevância de cada texto para a pergunta, na ordem de entrada (maior é mais relevante). */
  async rerank(pergunta: string, textos: string[], opcoes: OpcoesRerank = {}): Promise<number[]> {
    if (textos.length === 0) return [];
    const corpo = { model: opcoes.modelo ?? MODELOS.reranker, query: pergunta, documents: textos };
    const r = await this.executar("rerank", opcoes.timeoutMs ?? TIMEOUT_AUXILIAR_MS, opcoes.signal, (signal) =>
      this.sdk.post<{ results?: { index: number; relevance_score: number }[] }>("/rerank", { body: corpo, signal }),
    );
    const notas = new Array<number | undefined>(textos.length).fill(undefined);
    for (const x of r.results ?? []) {
      if (!Number.isInteger(x.index) || x.index < 0 || x.index >= textos.length) {
        throw new LlmRespostaInvalidaError(`índice ${x.index} fora de 0..${textos.length - 1}`, "rerank");
      }
      if (notas[x.index] !== undefined) {
        throw new LlmRespostaInvalidaError(`índice ${x.index} repetido`, "rerank");
      }
      notas[x.index] = Number(x.relevance_score);
    }
    const faltam = notas.flatMap((n, i) => (n === undefined ? [i] : []));
    if (faltam.length > 0) {
      throw new LlmRespostaInvalidaError(`${textos.length} textos, sem nota para o(s) índice(s) ${faltam.join(", ")}`, "rerank");
    }
    return notas as number[];
  }

  async modelos(opcoes: { timeoutMs?: number; signal?: AbortSignal } = {}): Promise<string[]> {
    const r = await this.executar("modelos", opcoes.timeoutMs ?? 5_000, opcoes.signal, (signal) =>
      this.sdk.get<{ data?: { id: string }[] }>("/models", { signal }),
    );
    return (r.data ?? []).map((m) => m.id);
  }

  // ---------- internos ----------

  private corpoChat(mensagens: Mensagem[], opcoes: OpcoesChat, extra: Record<string, unknown> = {}) {
    const perfil = PERFIS[opcoes.perfil ?? "principal"];
    return {
      model: perfil.modelo,
      messages: mensagens,
      temperature: opcoes.temperatura ?? perfil.temperatura,
      max_tokens: opcoes.maxTokens ?? perfil.maxTokens,
      ...(opcoes.parar ? { stop: opcoes.parar } : {}),
      chat_template_kwargs: perfil.chatTemplateKwargs,
      ...extra,
    };
  }

  private async completarBruto(
    operacao: string,
    mensagens: Mensagem[],
    opcoes: OpcoesChat,
    extra: Record<string, unknown> = {},
  ): Promise<{ completo: ChatCompletion; ms: number }> {
    const perfil = PERFIS[opcoes.perfil ?? "principal"];
    const corpo = this.corpoChat(mensagens, opcoes, extra) as unknown as ChatCompletionCreateParamsNonStreaming;
    const t0 = performance.now();
    const completo = await this.executar(operacao, opcoes.timeoutMs ?? perfil.timeoutMs, opcoes.signal, (signal) =>
      this.sdk.chat.completions.create(corpo, { signal }),
    );
    if (!completo.choices[0]) {
      throw new LlmRespostaInvalidaError("a resposta não trouxe nenhuma escolha", operacao);
    }
    return { completo, ms: Math.round(performance.now() - t0) };
  }

  private async completar(
    operacao: string,
    mensagens: Mensagem[],
    opcoes: OpcoesChat,
    extra: Record<string, unknown> = {},
  ): Promise<RespostaChat> {
    const { completo, ms } = await this.completarBruto(operacao, mensagens, opcoes, extra);
    return this.resumir(completo, ms);
  }

  private resumir(completo: ChatCompletion, ms: number): RespostaChat {
    const escolha = completo.choices[0];
    const mensagem = escolha?.message as { content?: string | null; reasoning_content?: string | null } | undefined;
    return {
      texto: (mensagem?.content ?? "").trim(),
      raciocinio: (mensagem?.reasoning_content ?? "").trim(),
      fim: mapaFim(escolha?.finish_reason),
      uso: { entrada: completo.usage?.prompt_tokens ?? 0, saida: completo.usage?.completion_tokens ?? 0 },
      modelo: completo.model,
      ms,
    };
  }

  /** Uma chamada com tempo-limite, cancelamento e as novas tentativas dos erros transitórios. */
  private async executar<T>(
    operacao: string,
    timeoutMs: number,
    usuario: AbortSignal | undefined,
    chamada: (signal: AbortSignal) => Promise<T>,
  ): Promise<T> {
    for (let tentativa = 1; ; tentativa++) {
      if (usuario?.aborted) throw new LlmAbortadoError(operacao);
      const limite = AbortSignal.timeout(timeoutMs);
      const signal = usuario ? AbortSignal.any([usuario, limite]) : limite;
      try {
        return await chamada(signal);
      } catch (e) {
        const erro = this.traduzir(e, operacao, usuario, [{ sinal: limite, limiteMs: timeoutMs }]);
        if (!erro.repetivel || tentativa >= this.tentativas) throw erro;
        await dormir(this.espera * tentativa);
      }
    }
  }

  private traduzir(
    e: unknown,
    operacao: string,
    usuario: AbortSignal | undefined,
    tempos: { sinal: AbortSignal; limiteMs: number; detalhe?: string }[],
  ): LlmErro {
    if (e instanceof LlmErro) return e;
    if (usuario?.aborted) return new LlmAbortadoError(operacao);
    const estourou = tempos.find((t) => t.sinal.aborted);
    if (estourou) return new LlmTimeoutError(operacao, estourou.limiteMs, estourou.detalhe);
    if (e instanceof APIConnectionTimeoutError) return new LlmTimeoutError(operacao, tempos[0]?.limiteMs ?? 0);
    if (e instanceof APIUserAbortError) return new LlmAbortadoError(operacao);
    if (e instanceof APIConnectionError) return new LlmIndisponivelError(this.baseUrl, operacao, e);
    if (e instanceof APIError && typeof e.status === "number") {
      const corpo = e.error as { message?: unknown } | undefined;
      const mensagem = typeof corpo?.message === "string" ? corpo.message : e.message;
      return new LlmHttpError(e.status, mensagem, operacao, e);
    }
    return new LlmErro(e instanceof Error ? e.message : String(e), operacao, { causa: e });
  }
}
