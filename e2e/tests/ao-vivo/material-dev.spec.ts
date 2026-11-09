/**
 * F8.10d, desenvolvimento (escrito ANTES do conserto, `eval/f810d-medida-geracao.md`): os dois defeitos que a F8.10c mostrou, direto
 * na API real (POST /api/chat, sem navegador), e dois casos de guarda que não podem piorar.
 *
 *  1. O pedido de material sobre uma métrica que existe, sem o nome da companhia, não pode virar "fora do documento" (rota vazia).
 *  2. A série de três anos tem de chegar ao gerador mesmo quando a linha está no fim de uma tabela longa (o corte de 900 caracteres
 *     por evidência escondia a linha).
 *  3. Guarda: pedido sobre OUTRA empresa continua sem material ("não consta"). Não pode virar o lucro do Banco do Brasil com outro nome.
 *
 * Estes pedidos já foram vistos pela F8.10c: servem só ao desenvolvimento. A medida do aceite (F8.10d) usa pedidos novos. Precisa da
 * pilha real no ar (Neo4j, llama-swap e a API em 127.0.0.1:3000).
 */
import { expect, test } from "@playwright/test";

const API = "http://127.0.0.1:3000";

interface Quadro {
  evento: string;
  dados: Record<string, unknown>;
}

function lerQuadros(corpo: string): Quadro[] {
  return corpo
    .split(/\r?\n\r?\n/)
    .map((q) => {
      const evento = /^event: (.+)$/m.exec(q)?.[1];
      const dados = /^data: (.+)$/m.exec(q)?.[1];
      return evento && dados ? { evento, dados: JSON.parse(dados) as Record<string, unknown> } : null;
    })
    .filter((q): q is Quadro => q !== null);
}

async function pedir(request: import("@playwright/test").APIRequestContext, mensagem: string) {
  const r = await request.post(`${API}/api/chat`, { data: { conversationId: `dev-${Date.now()}`, message: mensagem }, timeout: 240_000 });
  expect(r.status()).toBe(200);
  const quadros = lerQuadros(await r.text());
  const artefato = quadros.find((q) => q.evento === "artefato")?.dados as { tabela: { linhas: string[][] } } | undefined;
  const fim = quadros.find((q) => q.evento === "fim")?.dados as { metricas: { estado: string; rota: string[] } } | undefined;
  return { artefato, fim };
}

test.use({ baseURL: API });

test("pedido de Word sobre o patrimônio líquido (sem nome da companhia) gera o material e não vira 'fora do documento'", async ({ request }) => {
  test.setTimeout(300_000);
  const { artefato, fim } = await pedir(request, "Gere um documento Word com o patrimônio líquido de 2023 a 2025.");
  expect(fim?.metricas.estado, "o roteador chamou ferramenta").not.toBe("sem_consulta");
  expect(artefato, "a API mandou o evento artefato").toBeDefined();
  expect(artefato!.tabela.linhas.map((l) => [l[0], l[1]])).toEqual([
    ["2023", "173.570"],
    ["2024", "184.236"],
    ["2025", "193.567"],
  ]);
});

test("a linha no fim de uma tabela longa chega ao gerador: lucro antes dos impostos com os três anos", async ({ request }) => {
  test.setTimeout(300_000);
  const { artefato } = await pedir(request, "Faça uma apresentação com o lucro antes dos impostos de 2023 a 2025.");
  expect(artefato, "a API mandou o evento artefato").toBeDefined();
  expect(artefato!.tabela.linhas.map((l) => [l[0], l[1]])).toEqual([
    ["2023", "41.147"],
    ["2024", "27.711"],
    ["2025", "5.614"],
  ]);
});

for (const [empresa, pedido] of [
  ["Nubank", "Faça uma apresentação com o lucro líquido do Nubank de 2023 a 2025."],
  ["Santander", "Faça um gráfico do lucro líquido do Santander Brasil de 2023 a 2025."],
  ["Itaú Unibanco", "Gere um documento Word com o patrimônio líquido do Itaú Unibanco de 2023 a 2025."],
] as const) {
  test(`guarda: pedido sobre ${empresa} continua sem material`, async ({ request }) => {
    test.setTimeout(300_000);
    const { artefato } = await pedir(request, pedido);
    expect(artefato, "não pode haver material com dados do Banco do Brasil sob outro nome").toBeUndefined();
  });
}
