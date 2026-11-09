/** O cliente do `GET /api/grafo/vizinhanca` (F8.5, `contracts/api.openapi.yaml`): uma entidade, seus vizinhos e as ligações entre eles. */

export interface NoDoGrafo {
  id: string;
  rotulo: string;
  tipo: string;
}

export interface LigacaoDoGrafo {
  origem: string;
  destino: string;
  tipo: string;
}

export interface Vizinhanca {
  entidade: NoDoGrafo;
  nos: NoDoGrafo[];
  arestas: LigacaoDoGrafo[];
  truncado: boolean;
}

export type ResultadoVizinhanca = { estado: 'ok'; dados: Vizinhanca } | { estado: 'nao_encontrada' } | { estado: 'erro' };

const texto = (v: unknown): string | null => (typeof v === 'string' ? v : null);

function no(v: unknown): NoDoGrafo | null {
  if (typeof v !== 'object' || v === null) return null;
  const o = v as Record<string, unknown>;
  const id = texto(o['id']);
  return id === null || id === '' ? null : { id, rotulo: texto(o['rotulo']) ?? id, tipo: texto(o['tipo']) ?? '' };
}

/** Confere o corpo: o que não tem a forma do contrato vira `erro`, e um nó ou ligação malformado é descartado. */
function ler(corpo: unknown): Vizinhanca | null {
  if (typeof corpo !== 'object' || corpo === null) return null;
  const o = corpo as Record<string, unknown>;
  const entidade = no(o['entidade']);
  if (entidade === null || !Array.isArray(o['nos']) || !Array.isArray(o['arestas'])) return null;
  const nos = (o['nos'] as unknown[]).map(no).filter((n): n is NoDoGrafo => n !== null);
  const ids = new Set(nos.map((n) => n.id));
  const arestas: LigacaoDoGrafo[] = [];
  for (const a of o['arestas'] as unknown[]) {
    const r = typeof a === 'object' && a !== null ? (a as Record<string, unknown>) : {};
    const origem = texto(r['origem']);
    const destino = texto(r['destino']);
    if (origem !== null && destino !== null && ids.has(origem) && ids.has(destino)) arestas.push({ origem, destino, tipo: texto(r['tipo']) ?? '' });
  }
  return { entidade, nos, arestas, truncado: o['truncado'] === true };
}

export async function buscarVizinhanca(entidade: string, signal?: AbortSignal, buscar: typeof fetch = (...a) => fetch(...a)): Promise<ResultadoVizinhanca> {
  let resposta: Response;
  try {
    resposta = await buscar(`/api/grafo/vizinhanca?entidade=${encodeURIComponent(entidade)}&profundidade=1`, { signal, headers: { accept: 'application/json' } });
  } catch {
    return { estado: 'erro' };
  }
  if (resposta.status === 404) return { estado: 'nao_encontrada' };
  if (!resposta.ok) return { estado: 'erro' };
  try {
    const dados = ler(await resposta.json());
    return dados ? { estado: 'ok', dados } : { estado: 'erro' };
  } catch {
    return { estado: 'erro' };
  }
}
