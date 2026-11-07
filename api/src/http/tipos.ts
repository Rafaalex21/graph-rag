import type { OpcoesCiclo, ResultadoCiclo } from "../agente/ciclo.ts";
import type { EntradaRedator, OpcoesRedator, RespostaRedator } from "../agente/redator.ts";
import type { GrafoLeitura } from "../ferramentas/index.ts";

/** O que a API precisa saber do llama-swap para o `/api/saude`. */
export interface SondaLlm {
  /** Os modelos que o llama-swap serve. */
  modelos(): Promise<string[]>;
  /** Os que estão carregados na memória agora. */
  carregados(): Promise<string[]>;
}

/**
 * Tudo que as rotas usam de fora. Cada parte é opcional: sem ela a rota responde com o erro certo (503, 404) em vez de a API
 * nem subir, e os testes põem dublês no lugar.
 */
export interface DependenciasApp {
  /** O ciclo do agente (atualizador → roteador → executor → crítico). */
  ciclo?: (pergunta: string, opcoes: OpcoesCiclo) => Promise<ResultadoCiclo>;
  redator?: (entrada: EntradaRedator, opcoes: OpcoesRedator) => Promise<RespostaRedator>;
  grafo?: GrafoLeitura;
  llm?: SondaLlm;
  /** Caminho do PDF do Formulário de Referência. */
  pdf?: string;
  /** Arquivo `.jsonl` do `POST /api/feedback`. */
  arquivoDeFeedback?: string;
  /** Perguntas ao mesmo tempo no `/api/chat` (padrão 2, os slots do llama-server). */
  maxPerguntas?: number;
  /** Tempo máximo de cada sonda do `/api/saude` (padrão 2 s). */
  tempoDaSondaMs?: number;
  /** Recebe o erro real de uma falha interna (a resposta ao cliente é genérica). */
  registrarErro?: (contexto: string, erro: unknown) => void;
}
