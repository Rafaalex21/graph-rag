/** O relatório diário (F7.7): lê o JSONL do dia e resume resultados, ferramentas, tokens, tempos e notas. Funções puras. */
import { diaLocal } from "./registro.ts";
import { RegistroSchema, type Registro, type RegistroChat, type RegistroHttp } from "./tipos.ts";

export interface Resumo {
  n: number;
  p50: number | null;
  p95: number | null;
  max: number | null;
}

export interface RelatorioDoDia {
  dia: string;
  /** Linhas do log que não eram um registro válido (JSON quebrado, versão ou tipo desconhecido). */
  linhas_invalidas: number;
  chat: {
    total: number;
    resultados: Record<string, number>;
    estados: Record<string, number>;
    /** Códigos de erro e de recusa. */
    codigos: Record<string, number>;
    /** Só das perguntas que terminaram em `fim`. */
    tokens: { entrada: number; saida: number };
    /** Só das que terminaram em `fim`. */
    latencia_ms: { total: Resumo; primeiro_evento: Resumo; primeiro_token: Resumo; atualizar: Resumo; rotear: Resumo; executar: Resumo; criticar: Resumo; redator: Resumo };
    ferramentas: { nome: string; requisicoes: number; chamadas: number; erros: number; taxa_de_erro: number; ms_por_chamada: Resumo }[];
    redator: { com_reparo: number; cortadas: number; modelo_fixo: number; fallbacks: Record<string, number> };
  };
  http: { rota: string; total: number; status: Record<string, number>; ms: Resumo }[];
  feedback: { positivas: number; negativas: number; invalidas: number } | null;
}

/** Nearest-rank: o menor valor tal que `p` dos valores são menores ou iguais a ele. Lista vazia: `null`. */
export function percentil(valores: readonly number[], p: number): number | null {
  if (valores.length === 0) return null;
  const o = [...valores].sort((a, b) => a - b);
  return o[Math.min(o.length, Math.max(1, Math.ceil(p * o.length))) - 1] as number;
}

const resumo = (v: readonly number[]): Resumo => ({ n: v.length, p50: percentil(v, 0.5), p95: percentil(v, 0.95), max: v.length === 0 ? null : Math.max(...v) });
const contar = (itens: readonly string[]): Record<string, number> => {
  const c: Record<string, number> = {};
  for (const i of itens) c[i] = (c[i] ?? 0) + 1;
  return c;
};
const numeros = (v: readonly (number | null)[]): number[] => v.filter((x): x is number => x !== null);

/** Lê o texto de um `.jsonl`. Linha vazia é ignorada sem contar; linha que não confere com o esquema conta como inválida. */
export function lerRegistros(texto: string): { registros: Registro[]; invalidas: number } {
  const registros: Registro[] = [];
  let invalidas = 0;
  for (const linha of texto.split(/\r?\n/)) {
    if (linha.trim() === "") continue;
    try {
      const lido = RegistroSchema.safeParse(JSON.parse(linha));
      if (lido.success) registros.push(lido.data);
      else invalidas++;
    } catch {
      invalidas++;
    }
  }
  return { registros, invalidas };
}

function resumoDoFeedback(texto: string, dia: string): { positivas: number; negativas: number; invalidas: number } {
  let positivas = 0;
  let negativas = 0;
  let invalidas = 0;
  for (const linha of texto.split(/\r?\n/)) {
    if (linha.trim() === "") continue;
    try {
      const f = JSON.parse(linha) as { ts?: unknown; mensagemId?: unknown; nota?: unknown };
      if (typeof f.ts !== "string" || typeof f.mensagemId !== "string" || (f.nota !== 1 && f.nota !== -1) || Number.isNaN(new Date(f.ts).getTime())) {
        invalidas++;
        continue;
      }
      if (diaLocal(f.ts) !== dia) continue;
      if (f.nota === 1) positivas++;
      else negativas++;
    } catch {
      invalidas++;
    }
  }
  return { positivas, negativas, invalidas };
}

export interface OpcoesRelatorio {
  dia: string;
  linhasInvalidas?: number;
  /** O texto de `feedback.jsonl`, se houver. */
  feedback?: string;
}

export function gerarRelatorio(registros: readonly Registro[], opcoes: OpcoesRelatorio): RelatorioDoDia {
  const chat = registros.filter((r): r is RegistroChat => r.tipo === "chat");
  const http = registros.filter((r): r is RegistroHttp => r.tipo === "http");
  const fins = chat.filter((r) => r.resultado === "fim");

  const porFerramenta = new Map<string, { requisicoes: number; chamadas: number; erros: number; mediasMs: number[] }>();
  for (const r of chat) {
    for (const f of r.ferramentas) {
      const x = porFerramenta.get(f.nome) ?? { requisicoes: 0, chamadas: 0, erros: 0, mediasMs: [] };
      x.requisicoes++;
      x.chamadas += f.chamadas;
      x.erros += f.erros;
      if (f.chamadas > 0) x.mediasMs.push(f.ms / f.chamadas);
      porFerramenta.set(f.nome, x);
    }
  }

  const porRota = new Map<string, RegistroHttp[]>();
  for (const r of http) porRota.set(r.rota, [...(porRota.get(r.rota) ?? []), r]);

  const redatores = chat.flatMap((r) => (r.redator ? [r.redator] : []));
  const lat = (campo: keyof RegistroChat["latencia_ms"]) => resumo(numeros(fins.map((r) => r.latencia_ms[campo])));

  return {
    dia: opcoes.dia,
    linhas_invalidas: opcoes.linhasInvalidas ?? 0,
    chat: {
      total: chat.length,
      resultados: contar(chat.map((r) => r.resultado)),
      estados: contar(chat.flatMap((r) => (r.estado ? [r.estado] : []))),
      codigos: contar(chat.flatMap((r) => (r.codigo ? [r.codigo] : []))),
      tokens: { entrada: fins.reduce((s, r) => s + r.tokens.entrada, 0), saida: fins.reduce((s, r) => s + r.tokens.saida, 0) },
      latencia_ms: { total: lat("total"), primeiro_evento: lat("primeiro_evento"), primeiro_token: lat("primeiro_token"), atualizar: lat("atualizar"), rotear: lat("rotear"), executar: lat("executar"), criticar: lat("criticar"), redator: lat("redator") },
      ferramentas: [...porFerramenta.entries()]
        .map(([nome, x]) => ({ nome, requisicoes: x.requisicoes, chamadas: x.chamadas, erros: x.erros, taxa_de_erro: x.chamadas === 0 ? 0 : x.erros / x.chamadas, ms_por_chamada: resumo(x.mediasMs) }))
        .sort((a, b) => b.chamadas - a.chamadas || a.nome.localeCompare(b.nome)),
      redator: {
        com_reparo: redatores.filter((r) => r.reparos > 0).length,
        cortadas: redatores.filter((r) => r.cortada).length,
        modelo_fixo: redatores.filter((r) => r.modo === "modelo_fixo").length,
        fallbacks: contar(redatores.flatMap((r) => (r.fallback ? [r.fallback] : []))),
      },
    },
    http: [...porRota.entries()]
      .map(([rota, itens]) => ({ rota, total: itens.length, status: contar(itens.map((i) => String(i.status))), ms: resumo(itens.map((i) => i.ms)) }))
      .sort((a, b) => b.total - a.total || a.rota.localeCompare(b.rota)),
    feedback: opcoes.feedback === undefined ? null : resumoDoFeedback(opcoes.feedback, opcoes.dia),
  };
}

// ---------- Markdown ----------

const num = (n: number) => n.toLocaleString("pt-BR", { maximumFractionDigits: 1 });
const val = (n: number | null) => (n === null ? "—" : num(n));
const pct = (x: number) => `${(x * 100).toLocaleString("pt-BR", { maximumFractionDigits: 1 })}%`;
const linhaResumo = (nome: string, r: Resumo) => `| ${nome} | ${num(r.n)} | ${val(r.p50)} | ${val(r.p95)} | ${val(r.max)} |`;
const lista = (c: Record<string, number>) => Object.entries(c).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([k, v]) => `${k} ${num(v)}`).join(", ") || "—";

export function paraMarkdown(r: RelatorioDoDia): string {
  const s: string[] = [`# Telemetria de ${r.dia}`, ""];
  if (r.chat.total === 0 && r.http.length === 0) s.push("Nenhuma requisição registrada neste dia.", "");
  else {
    const c = r.chat;
    s.push(
      "## Perguntas (`/api/chat`)",
      "",
      `- Total: ${num(c.total)} (${lista(c.resultados)})`,
      `- Estado da resposta: ${lista(c.estados)}`,
      `- Erros e recusas: ${lista(c.codigos)}`,
      `- Tokens das respondidas: ${num(c.tokens.entrada)} de entrada, ${num(c.tokens.saida)} de saída`,
      `- Redator: ${num(c.redator.com_reparo)} com reparo, ${num(c.redator.cortadas)} cortadas, ${num(c.redator.modelo_fixo)} com texto fixo (fallbacks: ${lista(c.redator.fallbacks)})`,
      "",
      "### Tempo das respondidas (ms)",
      "",
      "| Etapa | n | p50 | p95 | máx |",
      "|---|---|---|---|---|",
      linhaResumo("pergunta inteira", c.latencia_ms.total),
      linhaResumo("primeiro evento", c.latencia_ms.primeiro_evento),
      linhaResumo("primeiro token", c.latencia_ms.primeiro_token),
      linhaResumo("atualizador", c.latencia_ms.atualizar),
      linhaResumo("roteador", c.latencia_ms.rotear),
      linhaResumo("ferramentas", c.latencia_ms.executar),
      linhaResumo("crítico", c.latencia_ms.criticar),
      linhaResumo("redator", c.latencia_ms.redator),
      "",
      "As etapas do roteador e das ferramentas somam as subperguntas, que rodam em paralelo: a soma das etapas pode passar de \"pergunta inteira\", que é o tempo de relógio.",
      "",
    );
    if (c.ferramentas.length > 0) {
      s.push("### Ferramentas", "", "| Ferramenta | Perguntas | Chamadas | Erros | Taxa de erro | ms/chamada p50 | p95 |", "|---|---|---|---|---|---|---|");
      for (const f of c.ferramentas) s.push(`| ${f.nome} | ${num(f.requisicoes)} | ${num(f.chamadas)} | ${num(f.erros)} | ${pct(f.taxa_de_erro)} | ${val(f.ms_por_chamada.p50)} | ${val(f.ms_por_chamada.p95)} |`);
      s.push("");
    }
    if (r.http.length > 0) {
      s.push("## Outras rotas", "", "| Rota | Requisições | Status | ms p50 | p95 |", "|---|---|---|---|---|");
      for (const h of r.http) s.push(`| ${h.rota} | ${num(h.total)} | ${lista(h.status)} | ${val(h.ms.p50)} | ${val(h.ms.p95)} |`);
      s.push("");
    }
  }
  if (r.feedback) s.push("## Notas", "", `- Positivas: ${num(r.feedback.positivas)}; negativas: ${num(r.feedback.negativas)}${r.feedback.invalidas > 0 ? `; linhas de feedback inválidas: ${num(r.feedback.invalidas)}` : ""}`, "");
  if (r.linhas_invalidas > 0) s.push(`> ${num(r.linhas_invalidas)} linha(s) do log ignorada(s) por não conferirem com o esquema.`, "");
  return `${s.join("\n").trimEnd()}\n`;
}
