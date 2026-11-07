/**
 * Números e frases da resposta (F7.5): a régua do aceite "100% das afirmações numéricas citadas" e o acerto numérico.
 * Porta as regras de `indexer/metricas.py` (F3.3): número pt-BR (`1.234,56`), escala escrita ("milhões", "bilhões"), os
 * números por extenso de dois a dez e a tolerância de 0,5%.
 *
 * Fica de fora do que conta como afirmação numérica: ano solto (1900–2100 sem separador, sem `%` e sem escala), parte de
 * data (`31/12/2025`), numeração de lista no começo da linha e o número do próprio marcador de citação. "um" e "uma" são
 * artigos e não contam; zero e os números por extenso acima de dez também não (limite da régua, dito no ADR-061).
 */

export const TOLERANCIA = 0.005;

export interface NumeroEncontrado {
  /** Como aparece, com a escala ("20,5 bilhões"). */
  texto: string;
  escrito: number;
  /** Com a escala aplicada. */
  escalado: number;
  comEscala: boolean;
  inicio: number;
}

const ESCALAS: Record<string, number> = { mil: 1e3, milhão: 1e6, milhões: 1e6, bilhão: 1e9, bilhões: 1e9, trilhão: 1e12, trilhões: 1e12 };
const PALAVRAS: Record<string, number> = { dois: 2, duas: 2, três: 3, tres: 3, quatro: 4, cinco: 5, seis: 6, sete: 7, oito: 8, nove: 9, dez: 10 };

const NUMERO = new RegExp(
  String.raw`(?<![\p{L}\p{N}.,])(?<n>\d{1,3}(?:\.\d{3})+(?:,\d+)?|\d+(?:,\d+)?)(?:\s*(?<e>milh(?:ão|ões)|bilh(?:ão|ões)|trilh(?:ão|ões)|mil)(?![\p{L}]))?|(?<![\p{L}\p{N}])(?<p>${Object.keys(PALAVRAS).join("|")})(?![\p{L}\p{N}])`,
  "giu",
);
const MARCADOR = /\[\s*E\d+(?:\s*[,;]\s*E\d+)*\s*\]|\[p\.[^\]]*\]/gi;

export interface OpcoesNumeros {
  /** O texto das evidências conta o ano como número (a resposta, não). */
  incluirAnos?: boolean;
}

/** Troca os marcadores por espaços do mesmo tamanho, para as posições não mudarem. */
const semMarcadores = (t: string) => t.replace(MARCADOR, (m) => " ".repeat(m.length));

export function numerosDoTexto(texto: string, opcoes: OpcoesNumeros = {}): NumeroEncontrado[] {
  const limpo = semMarcadores(texto);
  const saida: NumeroEncontrado[] = [];
  for (const m of limpo.matchAll(NUMERO)) {
    const g = m.groups as { n?: string; e?: string; p?: string };
    const inicio = m.index as number;
    const antes = limpo[inicio - 1] ?? "";
    const fim = inicio + m[0].length;
    const depois = limpo[fim] ?? "";
    if (antes === "/" || depois === "/") continue; // parte de data
    if (g.p) {
      const v = PALAVRAS[g.p.toLowerCase()] as number;
      saida.push({ texto: m[0], escrito: v, escalado: v, comEscala: false, inicio });
      continue;
    }
    const n = g.n as string;
    const escrito = Number(n.replaceAll(".", "").replace(",", "."));
    const comEscala = Boolean(g.e);
    const escalado = comEscala ? escrito * (ESCALAS[(g.e as string).toLowerCase()] as number) : escrito;
    if (!opcoes.incluirAnos && !comEscala) {
      const solto = /^\d{4}$/.test(n) && escrito >= 1900 && escrito <= 2100 && !/^\s*%/.test(limpo.slice(fim));
      if (solto) continue;
      // numeração de lista: "1." ou "2)" no começo da linha
      const linha = limpo.lastIndexOf("\n", inicio - 1) + 1;
      if (limpo.slice(linha, inicio).trim() === "" && /^[.)]\s/.test(limpo.slice(fim, fim + 2))) continue;
    }
    saida.push({ texto: m[0], escrito, escalado, comEscala, inicio });
  }
  return saida;
}

const ABREVIACOES = new Set(["p", "pp", "fl", "art", "arts", "inc", "nº", "no", "dr", "dra", "sr", "sra", "ex", "etc", "cf", "vs", "av", "cap", "val", "ltda", "cia", "cias", "corp", "dist"]);

const ABRE_COM_AUSENCIA =
  /^[\s\-*•_>]*(?:n[ãa]o\s+(?:encontrei|consta|constam|h[áa]\b|foi\s+(?:poss[ií]vel|encontrad|informad)|localizei|identifiquei)|(?:o\s+documento|as\s+evid[êe]ncias|os\s+trechos(?:\s+consultados)?|a\s+evid[êe]ncia)\s+n[ãa]o\s+(?:traz|trazem|informa|informam|apresenta|apresentam|cont[ée]m|cont[êe]m|menciona|mencionam|detalha|detalham|especifica|especificam)|(?:essa|esta)\s+informa[çc][ãa]o\s+n[ãa]o\s+consta)/i;

/**
 * A frase abre declarando que algo não foi encontrado ("Não encontrei…", "O documento não traz…", "Essa informação não
 * consta…"). Só abertura: "A União detém 50%; não há outros" e "Havia 3.900, não 4.100" são afirmações.
 */
export const declaracaoDeAusencia = (frase: string): boolean => ABRE_COM_AUSENCIA.test(frase.replaceAll("**", "").replaceAll("__", ""));

/**
 * Divide em afirmações: uma por linha e por frase. O ponto não encerra a frase em "1.234", em "S.A.", em "p. 12" nem antes
 * de minúscula; os marcadores `[E#]` logo depois do ponto ficam na frase do número.
 */
export function dividirAfirmacoes(texto: string): string[] {
  const saida: string[] = [];
  for (const linha of texto.split(/\r?\n/)) {
    let inicio = 0;
    let i = 0;
    const corta = (ate: number) => {
      const f = linha.slice(inicio, ate).trim();
      if (f !== "") saida.push(f);
      inicio = ate;
    };
    while (i < linha.length) {
      const c = linha[i] as string;
      if (c === "." || c === "!" || c === "?") {
        let j = i + 1;
        while (j < linha.length && ".!?".includes(linha[j] as string)) j++;
        const proximo = linha[j];
        const palavra = /([\p{L}]+)$/u.exec(linha.slice(0, i))?.[1] ?? "";
        const sigla = palavra.length === 1 && palavra === palavra.toUpperCase();
        const abrev = c === "." && (sigla || ABREVIACOES.has(palavra.toLowerCase()));
        const fimDeFrase = (proximo === undefined || /\s/.test(proximo)) && !abrev;
        if (fimDeFrase) {
          // leva junto os marcadores depois do ponto
          const m = /^(?:\s*\[\s*E\d+(?:\s*[,;]\s*E\d+)*\s*\])+/i.exec(linha.slice(j));
          const fim = j + (m ? m[0].length : 0);
          const resto = linha.slice(fim);
          if (resto.trim() === "" || !/^\s*[a-zà-ú]/.test(resto)) {
            corta(fim);
            i = fim;
            continue;
          }
        }
        i = j;
        continue;
      }
      i++;
    }
    corta(linha.length);
  }
  return saida;
}

/** Números em formato inglês ("1,234.56", "1,234,567", "12.5"): a resposta é em pt-BR. */
export function formatoNaoBrasileiro(texto: string): string[] {
  const limpo = semMarcadores(texto);
  const achados = [
    ...limpo.matchAll(/(?<![\d.,])\d{1,3}(?:,\d{3}){2,}(?![\d,])/g),
    ...limpo.matchAll(/(?<![\d.,])\d{1,3}(?:,\d{3})+\.\d+(?![\d.,])/g),
    ...limpo.matchAll(/(?<![\d.,])\d+\.\d{1,2}(?![\d.,])/g),
  ];
  return [...new Set(achados.map((m) => m[0]))];
}

const perto = (a: number, g: number) => Math.abs(Math.abs(a) - Math.abs(g)) <= TOLERANCIA * Math.abs(g);

/** `R$ milhões` e `R$ bilhões` mudam a escala do `valor`; `mil funcionários` também. */
function escalaDoGabarito(unidade: string): number {
  const u = unidade.toLowerCase().replace(/^r\$/, "").trim();
  for (const [palavra, escala] of Object.entries(ESCALAS)) if (u === palavra || u.startsWith(`${palavra} `)) return escala;
  return 1;
}

/**
 * A resposta tem o valor do gabarito dentro de 0,5%. Sem escala escrita, o número vale na unidade do gabarito ("16.782"
 * para "R$ milhões"); com escala ("16,8 bilhões"), compara-se o valor já convertido. Mesma regra do Python.
 */
export function acertoNumerico(caso: { valor: number; unidade: string }, resposta: string): boolean {
  const absoluto = caso.valor * escalaDoGabarito(caso.unidade);
  return numerosDoTexto(resposta, { incluirAnos: true }).some((n) => (n.comEscala ? perto(n.escalado, absoluto) : perto(n.escrito, caso.valor)));
}

/**
 * O número da resposta aparece em alguma das evidências: igual (0,5%) pelo valor escrito ou pelo escalado, ou, quando só um
 * dos lados traz a escala escrita, pelo valor de um lado contra o outro vezes 10^3, 10^6, 10^9 (tabela "em milhões").
 * Somar e converter são legítimos, então a falta de lastro é um registro, não um erro.
 */
export function numeroTemLastro(n: NumeroEncontrado, evidencias: readonly { texto: string }[]): boolean {
  for (const ev of evidencias) {
    for (const e of numerosDoTexto(ev.texto, { incluirAnos: true })) {
      if (n.comEscala === e.comEscala) {
        if (perto(n.escalado, e.escalado) || perto(n.escrito, e.escrito)) return true;
        continue;
      }
      if (perto(n.escrito, e.escrito)) return true;
      for (const k of [1e3, 1e6, 1e9, 1e12]) {
        if (perto(n.escalado, e.escrito * k) || perto(n.escrito * k, e.escalado) || perto(n.escrito, e.escalado * k) || perto(n.escalado * k, e.escrito)) return true;
      }
    }
  }
  return false;
}
