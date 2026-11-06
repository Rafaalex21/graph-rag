/**
 * Perfis do cliente LLM (ARQUITETURA §9). O llama-swap escolhe o perfil de carga pelo modelo pedido
 * (`matrix.sets` de `infra/llama-swap.yaml`), então "perfil" aqui é: qual modelo, com quais parâmetros de
 * template e tempos-limite. Os nomes dos modelos são os do llama-swap, não os dos arquivos GGUF.
 */

export interface PerfilChat {
  /** Nome do modelo no llama-swap. */
  modelo: string;
  /** Tempo-limite de uma chamada sem fluxo, já contando a carga do modelo (14 s o Qwen). */
  timeoutMs: number;
  /** Silêncio máximo entre dois pedaços de um fluxo. */
  ociosoMs: number;
  maxTokens: number;
  temperatura: number;
  /** Vai em `chat_template_kwargs`: é como o template do modelo liga e desliga o raciocínio. */
  chatTemplateKwargs: Record<string, unknown>;
}

export type Perfil = "principal" | "rapido";

export const PERFIS: Record<Perfil, PerfilChat> = {
  // Qwen3.6-35B-A3B (perfil `consultar`). Sem raciocínio: com ele o modelo gasta o teto de tokens pensando e a
  // resposta de um roteador ou de um JSON chega vazia (`finish_reason: length`).
  principal: {
    modelo: "qwen36-35b-a3b",
    timeoutMs: 120_000,
    ociosoMs: 60_000,
    maxTokens: 1024,
    temperatura: 0,
    chatTemplateKwargs: { enable_thinking: false },
  },
  // gpt-oss-20b (perfil `consultar-rapido`): o template dele não tem `enable_thinking`; o raciocínio vai de
  // "low" a "high" e o texto final vem separado em `reasoning_content`.
  rapido: {
    modelo: "gpt-oss-20b",
    timeoutMs: 60_000,
    ociosoMs: 30_000,
    maxTokens: 1024,
    temperatura: 0,
    chatTemplateKwargs: { reasoning_effort: "low" },
  },
};

export const MODELOS = {
  /** Embeddings de consulta: CPU, uma pergunta por vez (perfis consultar e consultar-rapido). */
  embedding: "qwen3-embed-0.6b",
  /** Embeddings em lote: GPU, só no perfil `vetorizar` (indexação). */
  embeddingLote: "qwen3-embed-0.6b-lote",
  reranker: "qwen3-rerank-0.6b",
  juiz: "gemma4-26b-a4b-juiz",
} as const;

/** Dimensão do índice `child_vec` (Qwen3-Embedding-0.6B). */
export const DIMENSOES = 1024;
export const TAREFA_PADRAO =
  "Given a question about a company's annual report, retrieve relevant passages that answer it";
