/**
 * Verificação do que o modelo escreveu na especificação (F8.10, regra do ADR-061): cada valor tem de aparecer, com a tolerância
 * de 0,5% de `numeros.ts`, na evidência que ele cita. O ponto que não passa é REMOVIDO e contado; nunca é corrigido nem
 * completado. A verificação prova que o número existe na evidência citada; o par rótulo/número (o ano certo de cada valor) é
 * conferido na medida da etapa contra o gabarito, não aqui.
 */
import { TOLERANCIA, numeroTemLastro, numerosDoTexto } from "../agente/numeros.ts";
import type { Especificacao, Material, PontoVerificado } from "./especificacao.ts";

export interface EvidenciaCitavel {
  paginas: string;
  texto: string;
}

export interface Verificado {
  material: Material;
  /** Quantos pontos o código tirou (referência que não existe, número que não bate ou sem lastro, rótulo repetido). */
  removidos: number;
}

const perto = (a: number, b: number) => Math.abs(a - b) <= TOLERANCIA * Math.max(Math.abs(a), Math.abs(b), Number.EPSILON);

export function verificarEspecificacao(spec: Especificacao, evidencias: ReadonlyMap<string, EvidenciaCitavel>): Verificado {
  const pontos: PontoVerificado[] = [];
  const vistos = new Set<string>();
  let removidos = 0;
  for (const p of spec.pontos) {
    const ev = evidencias.get(p.evidencia);
    const escrito = numerosDoTexto(p.escrito, { incluirAnos: true })[0];
    const ok =
      ev !== undefined &&
      escrito !== undefined &&
      !vistos.has(p.rotulo) &&
      (perto(Math.abs(p.valor), escrito.escrito) || perto(Math.abs(p.valor), escrito.escalado)) &&
      numeroTemLastro(escrito, [ev]);
    if (!ok) {
      removidos++;
      continue;
    }
    vistos.add(p.rotulo);
    pontos.push({ rotulo: p.rotulo, valor: p.valor, escrito: p.escrito.trim(), pagina: ev.paginas === "" ? "sem página" : ev.paginas, evidencia: p.evidencia });
  }
  return { material: { titulo: spec.titulo.trim(), unidade: spec.unidade.trim(), colunaRotulo: spec.coluna_rotulo.trim(), grafico: spec.grafico, pontos }, removidos };
}
