/**
 * Datas de calendário e escolha dos logs vencidos (F7.14). Funções puras: quem apaga é `diaria.ts`. A idade é contada em dias de
 * calendário a partir do NOME do arquivo (`AAAA-MM-DD.jsonl`, o dia local da F7.7), nunca em horas nem pelo `mtime`: copiar,
 * restaurar ou tocar um arquivo não pode rejuvenescer um log, e o horário de verão não pode empurrar um dia.
 */

const NOME_LOG = /^(\d{4})-(\d{2})-(\d{2})\.jsonl$/;
const DIA = /^(\d{4})-(\d{2})-(\d{2})$/;
const DIA_EM_MS = 86_400_000;

function utc(a: number, m: number, d: number): number {
  return Date.UTC(a, m - 1, d);
}

/** `AAAA-MM-DD` que existe no calendário (2026-02-29 e 2026-11-31 não existem). */
export function ehDia(texto: string): boolean {
  const x = DIA.exec(texto);
  if (!x) return false;
  const [a, m, d] = [Number(x[1]), Number(x[2]), Number(x[3])];
  const data = new Date(utc(a, m, d));
  return data.getUTCFullYear() === a && data.getUTCMonth() === m - 1 && data.getUTCDate() === d;
}

/** O dia de um arquivo `AAAA-MM-DD.jsonl`; `null` para qualquer outro nome (inclusive data que não existe). */
export function diaDoLog(nome: string): string | null {
  const x = NOME_LOG.exec(nome);
  if (!x) return null;
  const dia = `${x[1]}-${x[2]}-${x[3]}`;
  return ehDia(dia) ? dia : null;
}

/** Dias de calendário de `de` até `ate` (negativo se `ate` vem antes). */
export function diasEntre(de: string, ate: string): number {
  const a = DIA.exec(de);
  const b = DIA.exec(ate);
  if (!a || !b) throw new Error(`datas inválidas: ${de}, ${ate}`);
  return Math.round((utc(Number(b[1]), Number(b[2]), Number(b[3])) - utc(Number(a[1]), Number(a[2]), Number(a[3]))) / DIA_EM_MS);
}

export function diaAnterior(dia: string): string {
  const x = DIA.exec(dia);
  if (!x) throw new Error(`data inválida: ${dia}`);
  return new Date(utc(Number(x[1]), Number(x[2]), Number(x[3])) - DIA_EM_MS).toISOString().slice(0, 10);
}

export function validarDias(dias: number): void {
  if (!Number.isInteger(dias) || dias < 1) throw new Error(`dias deve ser um inteiro a partir de 1 (recebi ${String(dias)})`);
}

export function validarHoje(hoje: string): void {
  if (!ehDia(hoje)) throw new Error(`hoje deve ser AAAA-MM-DD, uma data que existe (recebi "${hoje}")`);
}

/**
 * Dos nomes dados, os logs com MAIS de `dias` dias (idade > `dias`). Não são logs: `feedback.jsonl`, relatórios, nomes com
 * data que não existe, sufixo a mais. Log com data de amanhã em diante (relógio errado) também não vence.
 */
export function logsExpirados(nomes: readonly string[], hoje: string, dias: number): string[] {
  validarDias(dias);
  validarHoje(hoje);
  return nomes.filter((n) => {
    const dia = diaDoLog(n);
    return dia !== null && diasEntre(dia, hoje) > dias;
  });
}
