/**
 * Erros do cliente LLM. Cada causa tem a sua classe porque quem chama decide diferente: o tempo-limite e o
 * servidor fora do ar pedem uma resposta ao usuário, o cancelamento pede silêncio, e a resposta inválida
 * é o caso em que o agente (F7.3) pode tentar de novo com outra instrução.
 */

export class LlmErro extends Error {
  readonly operacao: string;
  /** Vale uma nova tentativa idêntica (rede ou 5xx); nunca para cancelamento, tempo-limite e 4xx. */
  readonly repetivel: boolean;

  constructor(mensagem: string, operacao: string, opcoes: { repetivel?: boolean; causa?: unknown } = {}) {
    super(mensagem, opcoes.causa === undefined ? undefined : { cause: opcoes.causa });
    this.name = new.target.name;
    this.operacao = operacao;
    this.repetivel = opcoes.repetivel ?? false;
  }
}

/** O llama-swap não respondeu: desligado, porta errada ou caiu no meio. */
export class LlmIndisponivelError extends LlmErro {
  readonly baseUrl: string;

  constructor(baseUrl: string, operacao: string, causa?: unknown) {
    super(
      `llama-swap indisponível em ${baseUrl} (${operacao}). Suba com infra\\swap.ps1 ou confira LLAMA_SWAP_URL.`,
      operacao,
      { repetivel: true, causa },
    );
    this.baseUrl = baseUrl;
  }
}

export class LlmTimeoutError extends LlmErro {
  readonly limiteMs: number;

  constructor(operacao: string, limiteMs: number, detalhe = "") {
    super(`${operacao} excedeu ${limiteMs} ms${detalhe ? ` (${detalhe})` : ""}`, operacao);
    this.limiteMs = limiteMs;
  }
}

export class LlmAbortadoError extends LlmErro {
  constructor(operacao: string) {
    super(`${operacao} cancelada pelo chamador`, operacao);
  }
}

/** O servidor respondeu com erro HTTP; a mensagem é a do servidor (contexto estourado, modelo ausente...). */
export class LlmHttpError extends LlmErro {
  readonly status: number;

  constructor(status: number, mensagem: string, operacao: string, causa?: unknown) {
    super(`${operacao}: HTTP ${status}: ${mensagem}`, operacao, { repetivel: status >= 500 || status === 429, causa });
    this.status = status;
  }
}

/** O servidor respondeu 200, mas o conteúdo não serve: JSON quebrado, vetor com dimensão errada, índice faltando. */
export class LlmRespostaInvalidaError extends LlmErro {
  /** O texto bruto que não pôde ser lido, para o log e para a nova instrução do agente. */
  readonly bruto: string | undefined;

  constructor(mensagem: string, operacao: string, bruto?: string) {
    super(`${operacao}: resposta inválida: ${mensagem}`, operacao);
    this.bruto = bruto;
  }
}
