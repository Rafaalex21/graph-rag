/**
 * Do que o ciclo conta (`EventoCiclo`) para os eventos SSE do contrato: `etapa` e `cypher`. Os eventos `evidencia`, `token` e
 * `fim` saem do `chat.ts`, que é quem conhece o resultado.
 */
import type { EventoCiclo } from "../agente/ciclo.ts";
import type { Quadro } from "./sse.ts";

const etapa = (tipo: string, detalhe: Record<string, unknown>): Quadro => ({ evento: "etapa", dados: { tipo, detalhe } });

export function traduzirEvento(e: EventoCiclo): Quadro[] {
  switch (e.fase) {
    case "atualizacao":
      return [etapa("reescrita", { rodada: e.rodada, subperguntas: e.subperguntas, fallback: e.fallback, ms: e.ms })];
    case "roteamento":
      return [
        etapa("rota", { rodada: e.rodada, indice: e.indice, onda: e.onda, rota: e.rota, ferramentas: e.ferramentas, fallback: e.fallback, ms: e.ms }),
        ...e.ferramentas.map((ferramenta) => etapa("ferramenta_inicio", { rodada: e.rodada, indice: e.indice, ferramenta })),
      ];
    case "execucao":
      return e.ferramentas.flatMap((f) => [
        etapa("ferramenta_fim", { rodada: e.rodada, indice: e.indice, ferramenta: f.ferramenta, erro: f.erro, evidencias: f.evidencias, ms: f.ms }),
        ...(f.cypher ? [{ evento: "cypher", dados: { query: f.cypher.query, linhas: f.cypher.linhas, ms: f.ms } } satisfies Quadro] : []),
      ]);
    case "critica":
      return [etapa("critica", { rodada: e.rodada, decisao: e.decisao, perguntas: e.perguntas, faltando: e.faltando, ms: e.ms })];
    case "fim":
      return []; // o fim da pergunta é o do redator
  }
}
