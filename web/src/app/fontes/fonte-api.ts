/** O cliente do `GET /api/fonte/:id` (F8.4, `contracts/api.openapi.yaml`): o texto e a página de um item do grafo citado. */

export interface FonteDoGrafo {
  tipo: string;
  pagina: string | null;
  texto: string;
  secao: string | null;
}

export type ResultadoFonte = { estado: 'ok'; fonte: FonteDoGrafo } | { estado: 'nao_encontrada' } | { estado: 'erro' };

const texto = (v: unknown): string | null => (typeof v === 'string' ? v : null);

export async function buscarFonte(id: string, signal?: AbortSignal, buscar: typeof fetch = (...a) => fetch(...a)): Promise<ResultadoFonte> {
  let resposta: Response;
  try {
    resposta = await buscar(`/api/fonte/${encodeURIComponent(id)}`, { signal, headers: { accept: 'application/json' } });
  } catch {
    return { estado: 'erro' };
  }
  if (resposta.status === 404) return { estado: 'nao_encontrada' };
  if (!resposta.ok) return { estado: 'erro' };
  try {
    const corpo = (await resposta.json()) as Record<string, unknown>;
    const t = texto(corpo['texto']);
    const tipo = texto(corpo['tipo']);
    if (t === null || tipo === null) return { estado: 'erro' };
    return { estado: 'ok', fonte: { tipo, texto: t, pagina: texto(corpo['pagina']), secao: texto(corpo['secao']) } };
  } catch {
    return { estado: 'erro' };
  }
}
