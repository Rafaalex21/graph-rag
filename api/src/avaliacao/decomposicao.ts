/**
 * Avaliação da decomposição de perguntas (F7.2). Não há "decomposição única certa": o que se confere é o que
 * importa para o roteador (F7.3): a quantidade de subperguntas, que cada uma cubra o assunto esperado (termos
 * normalizados, sem depender de acento nem de caixa), as dependências entre elas (o que impede ou permite
 * executar em paralelo) e os termos que não podem aparecer (pronome que sobrou, assunto do histórico que
 * vazou). O conjunto está em `eval/golden_decomposicao.json`.
 */

export interface TurnoHistorico {
  papel: "usuario" | "assistente";
  texto: string;
}

export interface Esperado {
  /** Uma lista de termos por subpergunta esperada; `a|b` aceita qualquer alternativa. */
  subperguntas: string[][];
  /** Índice da subpergunta (como texto) → índices das que ela precisa antes. */
  dependencias: Record<string, number[]>;
  proibido?: string[];
}

export type Grupo = "ajuste" | "teste" | "teste2";
export const GRUPOS: Grupo[] = ["ajuste", "teste", "teste2"];

export interface CasoDecomposicao {
  id: string;
  /** `ajuste` serve para iterar o prompt; `teste` e `teste2` não, e `teste2` foi escrito depois da correção que o `teste` pediu. */
  grupo: Grupo;
  tipo: "composta" | "simples" | "seguimento";
  historico: TurnoHistorico[];
  pergunta: string;
  esperado: Esperado;
  origem?: string;
  observacao?: string;
}

export interface DecomposicaoObtida {
  autonoma: string;
  subperguntas: { pergunta: string; dependeDe: number[] }[];
}

export interface Avaliacao {
  ok: boolean;
  motivos: string[];
}

export function normalizar(texto: string): string {
  return texto
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function escapar(texto: string): string {
  return texto.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Todos os termos casam como prefixo de palavra ou de frase, em qualquer posição do texto. */
export function casaTermos(texto: string, termos: string[]): boolean {
  const t = normalizar(texto);
  return termos.every((termo) =>
    termo.split("|").some((alt) => {
      const a = normalizar(alt);
      return a !== "" && new RegExp(`(^| )${escapar(a)}`).test(t);
    }),
  );
}

function contemInteiro(texto: string, termo: string): boolean {
  const a = normalizar(termo);
  return a !== "" && new RegExp(`(^| )${escapar(a)}( |$)`).test(normalizar(texto));
}

function permutacoes(n: number): number[][] {
  if (n === 0) return [[]];
  const saida: number[][] = [];
  const usar = (atual: number[], livres: number[]) => {
    if (livres.length === 0) saida.push(atual);
    for (const [i, x] of livres.entries()) usar([...atual, x], livres.filter((_, j) => j !== i));
  };
  usar([], Array.from({ length: n }, (_, i) => i));
  return saida;
}

const mesmoConjunto = (a: number[], b: number[]) =>
  a.length === b.length && [...a].sort().join() === [...b].sort().join();

export function avaliarDecomposicao(caso: CasoDecomposicao, obtida: DecomposicaoObtida): Avaliacao {
  const motivos: string[] = [];
  const esperadas = caso.esperado.subperguntas;
  const n = esperadas.length;

  for (const termo of caso.esperado.proibido ?? []) {
    const textos = [obtida.autonoma, ...obtida.subperguntas.map((s) => s.pergunta)];
    if (textos.some((t) => contemInteiro(t, termo))) motivos.push(`proibido:${termo}`);
  }

  if (obtida.subperguntas.length !== n) {
    motivos.unshift(`quantidade: esperadas ${n}, obtidas ${obtida.subperguntas.length}`);
    return { ok: false, motivos };
  }

  // Atribuição esperada → obtida: qualquer permutação em que cada uma casa; depois, a que respeita as dependências.
  const validas = permutacoes(n).filter((p) => esperadas.every((termos, i) => casaTermos(obtida.subperguntas[p[i] as number]?.pergunta ?? "", termos)));
  if (validas.length === 0) {
    const sem = esperadas.flatMap((termos, i) =>
      obtida.subperguntas.some((s) => casaTermos(s.pergunta, termos)) ? [] : [i],
    );
    motivos.push(`sem_correspondencia: esperada(s) ${sem.length ? sem.join(", ") : "todas (duas esperadas na mesma obtida)"}`);
    return { ok: false, motivos };
  }
  const dependenciasCertas = validas.some((p) =>
    esperadas.every((_, i) => {
      const esperadoDeps = (caso.esperado.dependencias[String(i)] ?? []).map((d) => p[d] as number);
      return mesmoConjunto(obtida.subperguntas[p[i] as number]?.dependeDe ?? [], esperadoDeps);
    }),
  );
  if (!dependenciasCertas) motivos.push("dependencias: não batem com as esperadas");
  return { ok: motivos.length === 0, motivos };
}

export interface Taxa {
  n: number;
  acertos: number;
  taxa: number;
}

const taxa = (itens: { ok: boolean }[]): Taxa => ({
  n: itens.length,
  acertos: itens.filter((i) => i.ok).length,
  taxa: itens.length === 0 ? 0 : Math.round((itens.filter((i) => i.ok).length / itens.length) * 1000) / 1000,
});

export function resumirAvaliacao(
  itens: { id: string; grupo: Grupo; tipo: CasoDecomposicao["tipo"]; ok: boolean }[],
): Record<string, Taxa> & { geral: Taxa } {
  const saida: Record<string, Taxa> & { geral: Taxa } = { geral: taxa(itens) };
  for (const grupo of GRUPOS) {
    const g = itens.filter((i) => i.grupo === grupo);
    saida[grupo] = taxa(g);
    for (const tipo of ["composta", "simples", "seguimento"] as const) {
      const t = g.filter((i) => i.tipo === tipo);
      if (t.length > 0) saida[`${grupo}_${tipo}`] = taxa(t);
    }
  }
  return saida;
}
