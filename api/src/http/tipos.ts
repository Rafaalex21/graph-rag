import type { OpcoesCiclo, ResultadoCiclo } from "../agente/ciclo.ts";
import type { EntradaRedator, OpcoesRedator, RespostaRedator } from "../agente/redator.ts";
import type { Armazem } from "../artefatos/armazem.ts";
import type { EntradaArtefato, ResultadoArtefato } from "../artefatos/gerador.ts";
import type { GrafoLeitura } from "../ferramentas/index.ts";
import type { Registrador } from "../telemetria/registro.ts";

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
  /** O material pedido (gráfico, tabela, planilha, documento, apresentação), depois do redator (F8.10). Sem ele o pedido é ignorado. */
  artefatos?: (entrada: EntradaArtefato, opcoes: { signal?: AbortSignal }) => Promise<ResultadoArtefato>;
  /** Onde os arquivos gerados ficam até serem baixados (`GET /api/arquivos/:id`). */
  arquivos?: Armazem;
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
  /** Grava um registro por requisição (F7.7). Sem ele a API funciona sem telemetria. */
  telemetria?: Registrador;
  /** Guarda também o texto da pergunta no registro (`TELEMETRIA_TEXTO=1`); desligado por padrão. */
  telemetriaComTexto?: boolean;
  /** Recebe o erro real de uma falha interna (a resposta ao cliente é genérica). */
  registrarErro?: (contexto: string, erro: unknown) => void;
}
