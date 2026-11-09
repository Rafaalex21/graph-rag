/**
 * Modos de recuperação (F8.6, ARQUITETURA §11.1): `auto` deixa o roteador escolher a ferramenta; os outros cinco forçam a
 * ferramenta da subpergunta, sem chamar o LLM do roteador. O resto do ciclo (atualizador, crítico, redator) não muda.
 *
 *   trechos → buscar_trechos · tabelas → buscar_tabelas · local → entidade · global → panorama · cypher → consultar_grafo
 *
 * `local` (busca local por entidade) passa a pergunta como "nome" da entidade, cortada em 200 caracteres: a ferramenta foi feita
 * para um nome, então num pergunta longa ela pode devolver pouco.
 */
import { MAX_PERGUNTA } from "./atualizador.ts";
import type { Roteamento } from "./roteador.ts";

export const MODOS = ["auto", "trechos", "tabelas", "local", "global", "cypher"] as const;
export type Modo = (typeof MODOS)[number];
export type ModoForcado = Exclude<Modo, "auto">;

export const FERRAMENTA_DO_MODO: Readonly<Record<ModoForcado, string>> = {
  trechos: "buscar_trechos",
  tabelas: "buscar_tabelas",
  local: "entidade",
  global: "panorama",
  cypher: "consultar_grafo",
};

const MAX_NOME = 200;

/** O roteamento de um modo forçado: uma chamada, sem LLM, sem tempo e sem plano de reserva. */
export function roteamentoForcado(modo: ModoForcado, pergunta: string): Roteamento {
  const ferramenta = FERRAMENTA_DO_MODO[modo];
  const texto = pergunta.trim().slice(0, MAX_PERGUNTA);
  const argumentos = modo === "local" ? { nome: texto.slice(0, MAX_NOME) } : { pergunta: texto };
  return { pergunta, rota: "ferramentas", chamadas: [{ nome: ferramenta, argumentos }], texto: "", descartadas: [], fallback: null, uso: { entrada: 0, saida: 0 }, ms: 0 };
}
