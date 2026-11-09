/**
 * Os registros de telemetria (F7.7), uma linha JSON cada, em `data/logs/telemetria/AAAA-MM-DD.jsonl`. O esquema Zod é também o
 * validador do relatório: linha que não confere é contada como inválida e ignorada, nunca vira NaN.
 *
 * Privacidade: o log fica na máquina (RNF-1) e NÃO guarda o texto da pergunta, da resposta nem das evidências, só tamanhos,
 * uma impressão digital da pergunta, ferramentas, tokens e tempos. O texto da pergunta só entra com `TELEMETRIA_TEXTO=1`.
 */
import { z } from "zod";

export const VERSAO_DO_REGISTRO = 1;

const ms = z.number().nonnegative();
const msOuNulo = ms.nullable();

export const FerramentaUsadaSchema = z.object({
  nome: z.string().min(1),
  chamadas: z.number().int().nonnegative(),
  erros: z.number().int().nonnegative(),
  evidencias: z.number().int().nonnegative(),
  /** Soma do tempo das chamadas na pergunta. */
  ms,
});

export const RegistroChatSchema = z.object({
  v: z.literal(VERSAO_DO_REGISTRO),
  tipo: z.literal("chat"),
  /** Início da requisição, ISO 8601 em UTC. */
  ts: z.string().min(10),
  id: z.string().min(1),
  conversationId: z.string().nullable(),
  resultado: z.enum(["fim", "erro", "cancelada", "recusada"]),
  /** Código do erro ou da recusa (`llm_indisponivel`, `ocupado`, `requisicao_invalida`…). */
  codigo: z.string().nullable(),
  pergunta: z.object({ caracteres: z.number().int().nonnegative(), hash: z.string(), texto: z.string().optional() }),
  estado: z.enum(["suficiente", "incompleta", "ausente", "sem_consulta"]).nullable(),
  rodadas: z.number().int().nonnegative(),
  ferramentas: z.array(FerramentaUsadaSchema),
  evidencias: z.number().int().nonnegative(),
  anotacoes: z.record(z.string(), z.number().int().nonnegative()),
  tokens: z.object({ entrada: z.number().int().nonnegative(), saida: z.number().int().nonnegative() }),
  redator: z.object({ modo: z.enum(["llm", "modelo_fixo"]), reparos: z.number().int().nonnegative(), cortada: z.boolean(), fallback: z.string().nullable() }).nullable(),
  latencia_ms: z.object({
    total: ms,
    primeiro_evento: msOuNulo,
    primeiro_token: msOuNulo,
    atualizar: msOuNulo,
    rotear: msOuNulo,
    executar: msOuNulo,
    criticar: msOuNulo,
    redator: msOuNulo,
  }),
});

export const RegistroHttpSchema = z.object({
  v: z.literal(VERSAO_DO_REGISTRO),
  tipo: z.literal("http"),
  ts: z.string().min(10),
  id: z.string().min(1),
  metodo: z.string().min(1),
  /** O padrão da rota (`/api/fonte/:id`), nunca a URL pedida. */
  rota: z.string().min(1),
  status: z.number().int(),
  ms,
});

export const RegistroSchema = z.discriminatedUnion("tipo", [RegistroChatSchema, RegistroHttpSchema]);

export type FerramentaUsada = z.infer<typeof FerramentaUsadaSchema>;
export type RegistroChat = z.infer<typeof RegistroChatSchema>;
export type RegistroHttp = z.infer<typeof RegistroHttpSchema>;
export type Registro = z.infer<typeof RegistroSchema>;
