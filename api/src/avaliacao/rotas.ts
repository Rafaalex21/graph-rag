/**
 * Avaliação do roteador (F7.3) em `eval/golden_rotas.json`.
 *
 * Dois critérios, lado a lado, porque a `rota_esperada` do golden set foi atribuída na F3.1, antes de existirem
 * as ferramentas das fases 5 e 6 (`serie_metrica`, `pessoas_cargos`, `comparar_segmentos`...):
 *  - **estrito**: a rota literal do golden. Todas as chamadas têm de ser a esperada; uma a mais é erro.
 *  - **aceito**: todas as chamadas estão no conjunto `aceitas` do caso, fixado antes da primeira medição
 *    (a esperada mais as ferramentas cujo mecanismo cobre a pergunta de verdade).
 * Os dois números vão para o relatório; o aceite da tarefa é o aceito, e o estrito diz o quanto dele vem do
 * conjunto ampliado.
 */

export type GrupoRota = "ajuste" | "teste" | "teste2" | "teste3";

export interface CasoRota {
  id: string;
  grupo: GrupoRota | string;
  pergunta: string;
  rota_esperada: string;
  /** Ferramentas (ou `nenhuma`) que cobrem a pergunta. Vazio em `varias`. */
  aceitas: string[];
}

/** Uma lista de nomes de ferramenta por subpergunta; pergunta simples = uma lista só. */
export interface SaidaRota {
  rotas: string[][];
}

export interface AvaliacaoRota {
  estrito: boolean;
  aceito: boolean;
  motivo: string;
}

export function avaliarRota(caso: CasoRota, saida: SaidaRota): AvaliacaoRota {
  const falha = (motivo: string): AvaliacaoRota => ({ estrito: false, aceito: false, motivo });

  if (caso.rota_esperada === "varias") {
    if (saida.rotas.length < 2) return falha(`esperava 2 subperguntas ou mais, vieram ${saida.rotas.length}`);
    const vazia = saida.rotas.findIndex((r) => r.length === 0);
    if (vazia >= 0) return falha(`a subpergunta ${vazia} ficou sem ferramenta`);
    return { estrito: true, aceito: true, motivo: "" };
  }

  const chamadas = [...new Set(saida.rotas.flat())];
  if (chamadas.length === 0) {
    if (caso.rota_esperada === "nenhuma") {
      const aceito = caso.aceitas.includes("nenhuma");
      return { estrito: true, aceito, motivo: aceito ? "" : "nenhuma não está entre as aceitas" };
    }
    return falha("nenhuma ferramenta chamada");
  }

  const estrito = caso.rota_esperada !== "nenhuma" && chamadas.length === 1 && chamadas[0] === caso.rota_esperada;
  const fora = chamadas.filter((c) => !caso.aceitas.includes(c));
  const aceito = fora.length === 0;
  const motivo = estrito ? "" : aceito ? `chamou ${chamadas.join("+")}, esperava ${caso.rota_esperada}` : `fora das aceitas: ${fora.join(", ")}`;
  return { estrito, aceito, motivo };
}

export interface Taxa {
  ok: number;
  taxa: number;
}
export interface Contagem {
  n: number;
  estrito: Taxa;
  aceito: Taxa;
}
export interface ItemRota {
  id: string;
  grupo: string;
  rota_esperada: string;
  estrito: boolean;
  aceito: boolean;
}

function contar(itens: ItemRota[]): Contagem {
  const n = itens.length;
  const e = itens.filter((i) => i.estrito).length;
  const a = itens.filter((i) => i.aceito).length;
  const taxa = (ok: number) => (n === 0 ? 0 : Math.round((ok / n) * 10000) / 10000);
  return { n, estrito: { ok: e, taxa: taxa(e) }, aceito: { ok: a, taxa: taxa(a) } };
}

export function resumirRotas(itens: ItemRota[]): {
  geral: Contagem;
  por_grupo: Record<string, Contagem>;
  por_rota: Record<string, Contagem>;
} {
  const agrupar = (chave: (i: ItemRota) => string) => {
    const mapa = new Map<string, ItemRota[]>();
    for (const i of itens) mapa.set(chave(i), [...(mapa.get(chave(i)) ?? []), i]);
    return Object.fromEntries([...mapa].map(([k, v]) => [k, contar(v)]));
  };
  return { geral: contar(itens), por_grupo: agrupar((i) => i.grupo), por_rota: agrupar((i) => i.rota_esperada) };
}
