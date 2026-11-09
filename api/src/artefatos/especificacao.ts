/**
 * Material gerado pelo assistente (F8.10, ADR-075): gráfico, tabela e arquivos do pacote Office. O modelo só escreve uma
 * ESPECIFICAÇÃO (JSON validado por esquema); quem desenha e grava é código nosso, e todo número da especificação é conferido
 * contra a evidência que ele cita (`verificacao.ts`). Nada aqui chama o modelo.
 */
import { z } from "zod";

export type FormatoOffice = "xlsx" | "docx" | "pptx";
export type FormatoDeArquivo = FormatoOffice | "svg";

export const MAX_PONTOS = 24;

/** O que a mensagem pede, achado por palavras (sem chamar o modelo: pergunta comum não paga nada a mais). */
export interface PedidoDeArtefato {
  /** Pediu gráfico (ou apresentação, que leva o gráfico). */
  grafico: boolean;
  /** Pediu tabela. */
  tabela: boolean;
  formatos: FormatoOffice[];
}

const semAcento = (t: string) => t.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
const VERBO_DE_CRIAR = String.raw`(?:gere|gerar|crie|criar|monte|montar|faca|fazer|exporte|exportar|prepare|preparar)`;

/**
 * Procura na mensagem gráfico, tabela, planilha, documento Word e apresentação. "documento" sozinho não conta (o Formulário
 * também é "o documento"): só "gere/monte/faça um documento" ou "Word/docx". `null` se nada foi pedido.
 */
export function detectarPedido(mensagem: string): PedidoDeArtefato | null {
  const t = semAcento(mensagem);
  const formatos: FormatoOffice[] = [];
  if (/\b(?:planilha|planilhas|excel|xlsx)\b/.test(t)) formatos.push("xlsx");
  if (new RegExp(String.raw`\b(?:word|docx)\b|\b${VERBO_DE_CRIAR}\s+(?:um|o)\s+documento\b`).test(t)) formatos.push("docx");
  const apresentacao = /\b(?:apresentacao|apresentacoes|powerpoint|pptx|slide|slides)\b/.test(t);
  if (apresentacao) formatos.push("pptx");
  const grafico = /\b(?:grafico|graficos)\b/.test(t) || apresentacao;
  const tabela = /\b(?:tabela|tabelas)\b/.test(t);
  if (!grafico && !tabela && formatos.length === 0) return null;
  return { grafico, tabela, formatos };
}

/** Um valor da série: o rótulo, o número, como ele está ESCRITO no documento e de qual evidência (`E1`…) veio. */
export const PontoSchema = z
  .object({
    rotulo: z.string().min(1).max(60),
    valor: z.number().finite(),
    escrito: z.string().min(1).max(40),
    evidencia: z.string().regex(/^E\d{1,2}$/),
  })
  .strict();

export const EspecificacaoSchema = z
  .object({
    titulo: z.string().min(1).max(120),
    unidade: z.string().max(40),
    /** O que os rótulos são: "Ano", "Segmento"…; vira o cabeçalho da primeira coluna. */
    coluna_rotulo: z.string().min(1).max(30),
    grafico: z.enum(["barras", "linhas"]),
    pontos: z.array(PontoSchema).max(MAX_PONTOS),
  })
  .strict();

export type Especificacao = z.infer<typeof EspecificacaoSchema>;
export type PontoDaEspecificacao = z.infer<typeof PontoSchema>;

/** O mesmo formato em JSON Schema, que o llama.cpp converte em gramática (o modelo não consegue sair da forma). */
export const ESQUEMA_DA_ESPECIFICACAO: Record<string, unknown> = {
  type: "object",
  additionalProperties: false,
  required: ["titulo", "unidade", "coluna_rotulo", "grafico", "pontos"],
  properties: {
    titulo: { type: "string", maxLength: 120 },
    unidade: { type: "string", maxLength: 40 },
    coluna_rotulo: { type: "string", maxLength: 30 },
    grafico: { type: "string", enum: ["barras", "linhas"] },
    pontos: {
      type: "array",
      maxItems: MAX_PONTOS,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["rotulo", "valor", "escrito", "evidencia"],
        properties: {
          rotulo: { type: "string", maxLength: 60 },
          valor: { type: "number" },
          escrito: { type: "string", maxLength: 40 },
          evidencia: { type: "string", pattern: "^E[0-9]{1,2}$" },
        },
      },
    },
  },
};

/** Um ponto que passou na verificação: o que aparece na tela e vai para os arquivos. */
export interface PontoVerificado {
  rotulo: string;
  valor: number;
  /** Como o documento escreve o número (`33.166`). */
  escrito: string;
  /** O rótulo de página da evidência (`p. 93`) ou `sem página`. */
  pagina: string;
  evidencia: string;
}

/** O que está pronto para desenhar e gravar. */
export interface Material {
  titulo: string;
  unidade: string;
  colunaRotulo: string;
  grafico: "barras" | "linhas";
  pontos: PontoVerificado[];
}

/** Nome de arquivo só com letras minúsculas, números e hífen (nunca o texto do modelo cru). */
export function nomeDeArquivo(titulo: string, formato: FormatoDeArquivo): string {
  const base = semAcento(titulo)
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60)
    .replace(/-+$/g, "");
  return `${base === "" ? "material" : base}.${formato}`;
}
