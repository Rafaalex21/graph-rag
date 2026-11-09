import { expect, type Locator, type Page } from "@playwright/test";

/** A tela do assistente (F8.9) vista como o usuário a vê: pelos papéis e rótulos, não pela estrutura interna. */
export class PaginaAssistente {
  readonly caixa: Locator;
  readonly enviar: Locator;
  readonly parar: Locator;
  readonly novaConversa: Locator;
  readonly respostas: Locator;
  readonly perguntas: Locator;
  readonly estado: Locator;
  readonly menu: Locator;
  readonly painel: Locator;
  readonly recentes: Locator;

  constructor(readonly page: Page) {
    this.caixa = page.getByRole("textbox", { name: "Sua pergunta" });
    this.enviar = page.getByRole("button", { name: "Enviar pergunta" });
    this.parar = page.getByRole("button", { name: "Parar" });
    this.novaConversa = page.getByRole("button", { name: "Nova conversa" });
    this.respostas = page.locator('[data-papel="assistente"]');
    this.perguntas = page.locator('[data-papel="usuario"]');
    this.estado = page.getByRole("region", { name: "Conversa" }).getByRole("status");
    this.menu = page.getByRole("complementary", { name: "Menu" });
    this.painel = page.getByRole("complementary", { name: "Fonte aberta" });
    this.recentes = page.getByRole("navigation", { name: "Conversas recentes" });
  }

  async abrir(): Promise<void> {
    await this.page.goto("/");
    await expect(this.page).toHaveURL(/\/assistente$/);
    await expect(this.page.getByRole("heading", { level: 1 })).toBeVisible();
  }

  async perguntar(texto: string): Promise<void> {
    await this.caixa.fill(texto);
    await this.caixa.press("Enter");
  }

  async esperarResposta(): Promise<void> {
    await expect(this.estado).toHaveText(/Resposta pronta\./, { timeout: 20_000 });
  }

  /** Os botões do "Tipo de resposta" (Completa, Rápida). */
  perfil(rotulo: "Completa" | "Rápida"): Locator {
    return this.page.getByRole("group", { name: "Tipo de resposta" }).getByRole("button", { name: rotulo, exact: true });
  }

  /** Os botões do "Como buscar". */
  modo(rotulo: string): Locator {
    return this.page.getByRole("group", { name: "Como buscar" }).getByRole("button", { name: rotulo, exact: true });
  }

  /** O cartão da resposta de posição `i`: o selo de estado, as fontes, a nota e o passo a passo ficam dentro dele. */
  fontes(i = 0): Locator {
    return this.respostas.nth(i).getByRole("region", { name: "Fontes da resposta" });
  }

  avaliacao(i = 0): Locator {
    return this.respostas.nth(i).getByRole("group", { name: "Avaliar a resposta" });
  }

  passos(i = 0): Locator {
    return this.respostas.nth(i).getByRole("list", { name: "Passos da resposta" });
  }

  botaoPassos(i = 0): Locator {
    return this.respostas.nth(i).getByRole("button", { name: "Como cheguei a esta resposta" });
  }

  /** A conversa da lista de recentes com esse título. */
  recente(titulo: string): Locator {
    return this.recentes.getByRole("button", { name: titulo, exact: true });
  }

  /** O botão que apaga a conversa desse título da lista. */
  apagar(titulo: string): Locator {
    return this.recentes.getByRole("button", { name: `Apagar conversa: ${titulo}`, exact: true });
  }

  /** O cartão de fonte cujo nome combina com o texto (ex.: `/p\. 6/`). */
  cartao(nome: string | RegExp, i = 0): Locator {
    return this.fontes(i).getByRole("button", { name: nome });
  }

  /** Anota o corpo de cada pedido ao /api/chat que o navegador fizer daqui em diante. */
  gravarPedidos(): Record<string, unknown>[] {
    const corpos: Record<string, unknown>[] = [];
    this.page.on("request", (r) => {
      if (r.url().endsWith("/api/chat") && r.method() === "POST") corpos.push(r.postDataJSON() as Record<string, unknown>);
    });
    return corpos;
  }

  /** Anota o corpo de cada pedido ao /api/feedback. */
  gravarFeedbacks(): Record<string, unknown>[] {
    const corpos: Record<string, unknown>[] = [];
    this.page.on("request", (r) => {
      if (r.url().endsWith("/api/feedback") && r.method() === "POST") corpos.push(r.postDataJSON() as Record<string, unknown>);
    });
    return corpos;
  }
}
