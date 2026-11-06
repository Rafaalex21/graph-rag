/**
 * Executor de ferramentas (F7.8): recebe `{nome, argumentos}` do roteador (F7.3) e devolve o resultado da ferramenta
 * no contrato `evidencias[]`. Nunca lança: ferramenta desconhecida, ainda não portada (as das F7.9 e F7.10) e exceção
 * viram `erro` no resultado, para o agente seguir. Os argumentos vêm de um LLM; aqui são convertidos ao que cada
 * template espera (categoria de risco em português, ano em texto, segmento único em lista).
 */
import { lerCatalogo, type Metrica } from "./catalogo.ts";
import { envelope, type ChamadaFerramenta, type Envelope } from "./contrato.ts";
import type { GrafoLeitura } from "./grafo.ts";
import { buscarTabelas, buscarTrechos, respostaJaDada, type LlmDeBusca } from "./busca.ts";
import { buscarEntidade } from "./entidade.ts";
import { compararSegmentos, eventos, fatoFinanceiro, pessoasCargos, riscos, serieMetrica } from "./templates.ts";
import { normalizar } from "./texto.ts";

export type FerramentaExecutavel = (argumentos: Record<string, unknown>) => Promise<Envelope>;

/** As ferramentas do roteador que ainda não têm execução em TypeScript (F7.10). */
export const NAO_PORTADAS: readonly string[] = ["panorama", "consultar_grafo"];

const CATEGORIAS: Record<string, string> = {
  market: "market", mercado: "market",
  credit: "credit", credito: "credit",
  operational: "operational", operacional: "operational",
  regulatory: "regulatory", regulatorio: "regulatory", regulatoria: "regulatory",
  liquidity: "liquidity", liquidez: "liquidity",
  currency: "currency", cambio: "currency", cambial: "currency",
  "sem categoria": "sem_categoria",
};

/** Código de categoria do grafo para o que o roteador escreveu ("mercado", "Risco de Crédito"); `null` se não reconhece. */
export function normalizarCategoria(textoLivre: string): string | null {
  const n = normalizar(textoLivre);
  if (n === "") return null;
  return CATEGORIAS[n] ?? CATEGORIAS[n.replace(/^risco (de |do |da )?/, "")] ?? null;
}

const texto = (v: unknown): string | undefined => {
  if (typeof v === "string") return v.trim() === "" ? undefined : v.trim();
  if (typeof v === "number" && Number.isFinite(v)) return String(v);
  return undefined;
};
const numero = (v: unknown): number | undefined => {
  if (typeof v === "number") return v;
  if (typeof v === "string" && v.trim() !== "") return Number(v);
  return undefined;
};
const lista = (v: unknown): string[] | undefined => {
  const itens = (Array.isArray(v) ? v : [v]).map(texto).filter((x): x is string => x !== undefined);
  return itens.length > 0 ? itens : undefined;
};

/** Só as chaves com valor, para não passar `undefined` onde o template distingue ausente de nulo. */
const sem = <T extends Record<string, unknown>>(o: T) => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as T;

function erroDe(nome: string, codigo: string, aviso: string | null = null): Envelope {
  return { ...envelope(nome), erro: codigo, aviso };
}

export interface OpcoesExecutor {
  grafo: GrafoLeitura;
  catalogo?: readonly Metrica[];
  /** Embedding de consulta e reranker, para `buscar_trechos`, `buscar_tabelas` e `entidade`. Sem ele elas respondem `llm_nao_configurado`. */
  llm?: LlmDeBusca;
  /** Ferramentas além das portadas (F7.10); uma entrada tira o nome de `NAO_PORTADAS`. */
  extras?: Record<string, FerramentaExecutavel>;
}

export interface Executor {
  executar(chamada: ChamadaFerramenta): Promise<Envelope>;
  /** Roda as chamadas ao mesmo tempo e devolve os resultados na ordem pedida. */
  executarTodas(chamadas: readonly ChamadaFerramenta[]): Promise<Envelope[]>;
  readonly ferramentas: string[];
}

export function criarExecutor(opcoes: OpcoesExecutor): Executor {
  const { grafo } = opcoes;
  let catalogo = opcoes.catalogo;
  const metricas = () => (catalogo ??= lerCatalogo());
  const comLlm = async (nome: string, f: (llm: LlmDeBusca) => Promise<Envelope>): Promise<Envelope> =>
    opcoes.llm ? f(opcoes.llm) : erroDe(nome, "llm_nao_configurado", "O executor foi criado sem o cliente LLM que esta busca exige.");

  const portadas: Record<string, FerramentaExecutavel> = {
    fato_financeiro: (a) =>
      fatoFinanceiro(grafo, { ...sem({ metrica: texto(a["metrica"]) ?? "", entidade: texto(a["entidade"]), periodo: texto(a["periodo"]) }), catalogo: metricas() }),
    serie_metrica: (a) =>
      serieMetrica(grafo, { ...sem({ metrica: texto(a["metrica"]) ?? "", entidade: texto(a["entidade"]) }), catalogo: metricas() }),
    comparar_segmentos: (a) =>
      compararSegmentos(grafo, {
        ...sem({ metrica: texto(a["metrica"]) ?? "", segmentos: lista(a["segmentos"]), periodo: texto(a["periodo"]) }),
        catalogo: metricas(),
      }),
    riscos: (a) => {
      const pedida = texto(a["categoria"]);
      const categoria = pedida ? normalizarCategoria(pedida) : null;
      // categoria que o grafo não conhece vira tema, se não houver outro: não some e não vira erro
      const tema = texto(a["tema"]) ?? (pedida && !categoria ? pedida : undefined);
      return riscos(grafo, sem({ tema, categoria: categoria ?? undefined }));
    },
    eventos: (a) => eventos(grafo, sem({ tema: texto(a["tema"]), ano: numero(a["ano"]) })),
    pessoas_cargos: (a) => pessoasCargos(grafo, sem({ cargo: texto(a["cargo"]), nome: texto(a["nome"]), orgao: texto(a["orgao"]) })),
    buscar_trechos: (a) => comLlm("buscar_trechos", (llm) => buscarTrechos(grafo, llm, texto(a["pergunta"]) ?? "")),
    buscar_tabelas: (a) => comLlm("buscar_tabelas", (llm) => buscarTabelas(grafo, llm, texto(a["pergunta"]) ?? "")),
    entidade: (a) => comLlm("entidade", (llm) => buscarEntidade(grafo, llm, texto(a["nome"]) ?? "")),
    resposta_ja_dada: async (a) => respostaJaDada({ resposta: texto(a["resposta"]) ?? "" }),
  };
  const tabela: Record<string, FerramentaExecutavel> = { ...portadas, ...(opcoes.extras ?? {}) };

  const executar = async (chamada: ChamadaFerramenta): Promise<Envelope> => {
    const f = tabela[chamada.nome];
    if (!f) {
      return NAO_PORTADAS.includes(chamada.nome)
        ? erroDe(chamada.nome, "ferramenta_nao_portada", "Esta ferramenta ainda não tem execução em TypeScript.")
        : erroDe(chamada.nome, "ferramenta_desconhecida");
    }
    try {
      return await f(chamada.argumentos);
    } catch (e) {
      return erroDe(chamada.nome, `falha na ferramenta: ${e instanceof Error ? e.message : String(e)}`);
    }
  };

  return {
    executar,
    executarTodas: (chamadas) => Promise.all(chamadas.map(executar)),
    ferramentas: [...Object.keys(tabela), ...NAO_PORTADAS.filter((n) => !(n in tabela))],
  };
}

/** As ferramentas de template Cypher (F7.8) e as de busca (F7.9), para quem só quer a lista de nomes. */
export const FERRAMENTAS_DE_TEMPLATE = ["fato_financeiro", "serie_metrica", "comparar_segmentos", "riscos", "eventos", "pessoas_cargos"] as const;
export const FERRAMENTAS_DE_BUSCA = ["buscar_trechos", "buscar_tabelas", "entidade", "resposta_ja_dada"] as const;
