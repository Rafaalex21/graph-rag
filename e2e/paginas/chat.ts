import { expect, type Locator, type Page } from "@playwright/test";

/** A página do chat vista como o usuário a vê: pelos papéis e rótulos, não pela estrutura interna. */
export class PaginaChat {
  readonly caixa: Locator;
  readonly enviar: Locator;
  readonly parar: Locator;
  readonly tentarDeNovo: Locator;
  readonly novaConversa: Locator;
  readonly perguntas: Locator;
  readonly respostas: Locator;
  readonly alerta: Locator;
  readonly estado: Locator;

  constructor(readonly page: Page) {
    this.caixa = page.getByRole("textbox", { name: "Sua pergunta" });
    this.enviar = page.getByRole("button", { name: "Enviar" });
    this.parar = page.getByRole("button", { name: "Parar" });
    this.tentarDeNovo = page.getByRole("button", { name: "Tentar de novo" });
    this.novaConversa = page.getByRole("button", { name: "Nova conversa" });
    this.perguntas = page.locator('[data-papel="usuario"]');
    this.respostas = page.locator('[data-papel="assistente"]');
    this.alerta = page.getByRole("alert");
    // só o status da conversa: as abas Fontes e Grafo têm o seu próprio `role="status"`
    this.estado = page.getByRole("region", { name: "Conversa" }).getByRole("status");
  }

  async abrir(): Promise<void> {
    await this.page.goto("/chat");
    await expect(this.page.getByRole("heading", { level: 1, name: "Conversa" })).toBeVisible();
  }

  async perguntar(texto: string): Promise<void> {
    await this.caixa.fill(texto);
    await this.caixa.press("Enter");
  }

  async esperarResposta(): Promise<void> {
    await expect(this.estado).toHaveText(/Resposta pronta\./, { timeout: 20_000 });
  }

  /** O grupo de botões "Resposta útil" / "Resposta não útil" da resposta de posição `indice` (0 = a primeira). */
  avaliacao(indice = 0): Locator {
    return this.respostas.nth(indice).getByRole("group", { name: "Avaliar a resposta" });
  }

  /** Anota o corpo de cada pedido ao /api/feedback que o navegador fizer daqui em diante. */
  gravarFeedbacks(): Record<string, unknown>[] {
    const corpos: Record<string, unknown>[] = [];
    this.page.on("request", (r) => {
      if (r.url().endsWith("/api/feedback") && r.method() === "POST") corpos.push(r.postDataJSON() as Record<string, unknown>);
    });
    return corpos;
  }

  /** Anota o corpo de cada pedido ao /api/chat que o navegador fizer daqui em diante. */
  gravarPedidos(): Record<string, unknown>[] {
    const corpos: Record<string, unknown>[] = [];
    this.page.on("request", (r) => {
      if (r.url().endsWith("/api/chat") && r.method() === "POST") corpos.push(r.postDataJSON() as Record<string, unknown>);
    });
    return corpos;
  }
}
