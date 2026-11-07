/** Monta o registro de uma pergunta do `/api/chat` a partir do que o ciclo e o redator contaram. */
import type { ResultadoCiclo } from "../agente/ciclo.ts";
import type { RespostaRedator } from "../agente/redator.ts";
import { impressaoDaPergunta } from "./registro.ts";
import { VERSAO_DO_REGISTRO, type FerramentaUsada, type RegistroChat } from "./tipos.ts";

export interface EntradaRegistroChat {
  id: string;
  inicio: Date;
  conversationId: string | null;
  mensagem: string;
  /** Guarda o texto da pergunta (`TELEMETRIA_TEXTO=1`). */
  comTexto: boolean;
  resultado: RegistroChat["resultado"];
  codigo: string | null;
  ciclo: ResultadoCiclo | null;
  resposta: RespostaRedator | null;
  ms: { total: number; primeiroEvento: number | null; primeiroToken: number | null };
}

const arredonda = (n: number) => Math.round(n * 10) / 10;

function ferramentasDe(ciclo: ResultadoCiclo | null): FerramentaUsada[] {
  const por = new Map<string, FerramentaUsada>();
  for (const rodada of ciclo?.rodadas ?? []) {
    for (const sub of rodada.agente.subperguntas) {
      for (const e of sub.execucoes) {
        const f = por.get(e.ferramenta) ?? { nome: e.ferramenta, chamadas: 0, erros: 0, evidencias: 0, ms: 0 };
        f.chamadas++;
        if (e.erro) f.erros++;
        f.evidencias += e.evidencias;
        f.ms = arredonda(f.ms + e.ms);
        por.set(e.ferramenta, f);
      }
    }
  }
  return [...por.values()].sort((a, b) => b.chamadas - a.chamadas || a.nome.localeCompare(b.nome));
}

export function montarRegistroChat(e: EntradaRegistroChat): RegistroChat {
  const anotacoes: Record<string, number> = {};
  for (const a of e.ciclo?.anotacoes ?? []) anotacoes[a.tipo] = (anotacoes[a.tipo] ?? 0) + 1;
  return {
    v: VERSAO_DO_REGISTRO,
    tipo: "chat",
    ts: e.inicio.toISOString(),
    id: e.id,
    conversationId: e.conversationId,
    resultado: e.resultado,
    codigo: e.codigo,
    pergunta: impressaoDaPergunta(e.mensagem, e.comTexto),
    estado: e.ciclo?.estado ?? null,
    rodadas: e.ciclo?.rodadas.length ?? 0,
    ferramentas: ferramentasDe(e.ciclo),
    evidencias: e.ciclo?.evidencias.length ?? 0,
    anotacoes,
    tokens: { entrada: (e.ciclo?.uso.entrada ?? 0) + (e.resposta?.uso.entrada ?? 0), saida: (e.ciclo?.uso.saida ?? 0) + (e.resposta?.uso.saida ?? 0) },
    redator: e.resposta ? { modo: e.resposta.modo, reparos: e.resposta.reparos, cortada: e.resposta.cortada, fallback: e.resposta.fallback } : null,
    latencia_ms: {
      total: e.ms.total,
      primeiro_evento: e.ms.primeiroEvento,
      primeiro_token: e.ms.primeiroToken,
      atualizar: e.ciclo?.etapas_ms.atualizar ?? null,
      rotear: e.ciclo?.etapas_ms.rotear ?? null,
      executar: e.ciclo?.etapas_ms.executar ?? null,
      criticar: e.ciclo?.etapas_ms.criticar ?? null,
      redator: e.resposta?.ms.total ?? null,
    },
  };
}
