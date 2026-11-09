/**
 * O cliente do `POST /api/feedback` (F8.7, `contracts/api.openapi.yaml`): a nota de uma resposta (1 ou -1) e, se quiser, um
 * comentário. Toda falha sai como `Error` com uma mensagem nossa em português: a da API quando ela mandou `{codigo, mensagem}`,
 * senão uma genérica (nunca o HTML de um proxy nem uma pilha).
 */
export interface PedidoFeedback {
  mensagemId: string;
  nota: 1 | -1;
  comentario?: string;
}

export const MENSAGEM_FEEDBACK = 'Não foi possível registrar a nota agora.';

export async function enviarFeedback(pedido: PedidoFeedback, opcoes: { fetch?: typeof fetch } = {}): Promise<void> {
  const chamar = opcoes.fetch ?? ((...a: Parameters<typeof fetch>) => globalThis.fetch(...a));
  let r: Response;
  try {
    r = await chamar('/api/feedback', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(pedido) });
  } catch {
    throw new Error(MENSAGEM_FEEDBACK);
  }
  if (r.ok) return;
  let mensagem = MENSAGEM_FEEDBACK;
  try {
    const c: unknown = await r.json();
    if (typeof c === 'object' && c !== null) {
      const o = c as Record<string, unknown>;
      if (typeof o['codigo'] === 'string' && typeof o['mensagem'] === 'string' && o['mensagem'] !== '') mensagem = o['mensagem'];
    }
  } catch {
    /* corpo que não é JSON (HTML de proxy): fica a mensagem genérica */
  }
  throw new Error(mensagem);
}
