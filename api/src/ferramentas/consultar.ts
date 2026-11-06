/**
 * `consultar_grafo`: Text2Cypher em TypeScript (F7.10, porte de `indexer/text2cypher.py`, F6.4, com a guarda da F6.5;
 * ARQUITETURA §7.3): pergunta → prompt → LLM → Cypher → guarda → execução somente leitura → evidências.
 *
 * O prompt tem quatro seções: o **esquema** do grafo (descoberto pela APOC e amostrado), o **mapeamento
 * terminológico** PT↔EN das métricas (`contracts/metricas.json`), **exemplos** *few-shot*
 * (`api/prompts/cypher-examples.json`) e as **instruções de formato**. O que fez o prompt funcionar foi dar ao modelo o
 * vocabulário do grafo (os rótulos de `f.metric` e os 12 mais parecidos com a pergunta), não só o esquema.
 *
 * O que a ferramenta garante (ADR-050 e ADR-058): o Cypher passa pela guarda (`guarda.ts`) antes de tocar o banco;
 * o `EXPLAIN` mostra se o plano escreve; a execução é numa sessão de leitura, com tempo-limite e teto de linhas; falha
 * do LLM, Cypher vazio, bloqueio ou erro do banco voltam como `erro`, nunca como exceção; o que não tem página não é
 * citado. **O resultado é hipótese**: a consulta pode rodar e devolver um número errado (F6.4: 8 perguntas sem dado
 * no grafo voltaram números plausíveis); a guarda protege o banco, não a resposta.
 *
 * Não portado: as variantes de prompt do especialista Gemma (`nativo` e `compacto`, F6.6), rejeitadas na decisão.
 */
import { readFileSync } from "node:fs";
import { lerCatalogo, type Metrica } from "./catalogo.ts";
import { envelope, rotuloDePaginas, type Envelope, type Evidencia } from "./contrato.ts";
import { temCypherLivre, type GrafoLeitura, type GrafoCypher } from "./grafo.ts";
import { avisosDoPlano, planoComEscrita, preparar } from "./guarda.ts";

const RAIZ = new URL("../../../", import.meta.url);
const EXEMPLOS = new URL("api/prompts/cypher-examples.json", RAIZ);

export const CANDIDATOS_POR_PERGUNTA = 12;
export const RECORTES_POR_METRICA = 5;
export const MAX_CHARS_ROTULOS = 16000; // ~5 mil tokens; o prefixo do prompt é igual em toda pergunta e fica no cache
export const LIMITE_LINHAS = 50;
export const TIMEOUT_MS = 5000; // §7.3
export const MAX_DESPEJO = 5; // mais linhas que isso no resultado não prova que a resposta certa estava lá
const TIMEOUT_LLM_MS = 120_000;
const MAX_TOKENS_CYPHER = 600; // uma agregação com CASE cabe em ~250

/** Propriedades que nunca vão ao prompt: vetores e textos longos estourariam o contexto sem ajudar a consulta. */
const OCULTAS = new Set(["embedding", "evidence", "text", "texto", "summary", "definition", "markdown", "description", "content"]);
/** Propriedades categóricas cujos valores de exemplo entram no esquema: [tipo, nome, propriedade, quantos]. */
const AMOSTRAS: [string, string, string, number][] = [
  ["rel", "OF_METRIC", "qualifier", 20],
  ["no", "Period", "id", 60],
  ["no", "FinancialFact", "unit", 10],
  ["no", "FinancialFact", "periodType", 10],
  ["no", "FinancialFact", "scale", 10],
  ["no", "Metric", "kind", 10],
  ["no", "RiskFactor", "category", 20],
];
/** Rótulos de infraestrutura de recuperação: nenhuma pergunta de agregação passa por eles. */
const ROTULOS_IGNORADOS = new Set(["__Entity__", "Child", "HypotheticalQuestion"]);
const TIPOS: Record<string, string> = { String: "STRING", Long: "INTEGER", Double: "FLOAT", Boolean: "BOOLEAN", Date: "DATE" };

export interface MensagemCypher {
  role: "system" | "user" | "assistant";
  content: string;
}
export type GeraCypher = (mensagens: MensagemCypher[]) => Promise<string>;

/** O que a ferramenta pede ao LLM: só o chat (o `ClienteLlm` da F7.1 satisfaz). */
export interface LlmDeCypher {
  chat(mensagens: MensagemCypher[], opcoes?: { perfil?: "principal" | "rapido"; temperatura?: number; maxTokens?: number; timeoutMs?: number }): Promise<{ texto: string }>;
}

// As linhas terminadas em "\" do Python (continuação) viram uma linha só; o espaço antes da barra fica.
const INSTRUCOES = `Você traduz perguntas em português sobre o Formulário de Referência de uma companhia brasileira em consultas Cypher para o grafo descrito abaixo.

# Esquema do grafo
{esquema}

# Terminologia (termo da pergunta → nome no grafo)
{terminologia}

# Regras do grafo
- Cada valor numérico do documento é um nó FinancialFact: \`f.value\` está na unidade \`f.unit\` e na escala \`f.scale\` (1, 1000, 1000000...); some só valores com a mesma unidade e a mesma escala.
- O período vem do nó Period ligado por FOR_PERIOD. O mesmo ano pode estar como \`2025-FY\` ou \`2025-12-31\`: para "em 2025" use \`p.id STARTS WITH '2025'\`.
- \`f.metric\` guarda o rótulo completo da linha da tabela (em português) e \`Metric\` é a métrica canônica. \`OF_METRIC.dimension\` é um recorte ambíguo (região, idade, órgão, gênero) e seus valores não estão listados: quando a pergunta citar um recorte (cor/raça, região, gênero, área, órgão), filtre \`f.metric\` com os rótulos da lista "Rótulos existentes em FinancialFact.metric" (\`IN [...]\` com o texto exato; \`STARTS WITH\` só para o prefixo de uma família). Se o recorte já está no rótulo de \`f.metric\`, não ligue \`Metric\` nem use \`dimension\`. Nunca invente um valor de \`dimension\` nem de \`f.metric\`.
- Rótulos de total (com "Total" ou "TOTAL" em qualquer posição, como "... - TOTAL DE X", e o rótulo curto da família) já somam as demais linhas: em máximo, mínimo ou ranking, exclua-os explicitamente (com \`<>\` ou \`NOT ... CONTAINS\`); ao somar partes, não os inclua.
- Rótulos quase iguais podem repetir o mesmo valor vindo de tabelas diferentes (por exemplo "Empregados X" e "TOTAL DE EMPREGADOS - X"): ao somar, use um só rótulo por item, o mais curto, para não contar duas vezes.
- Escolha o rótulo com todas as palavras da pergunta ("não-liderança" não é "liderança"; "pardo" sem recorte é o total do documento).
- Calcule somas, diferenças e contagens na própria consulta, com um único sum(CASE WHEN ... THEN f.value ELSE -f.value END); não use collect nem indexação de listas. "Quanto caiu/diminuiu" é anterior menos atual; "quanto cresceu/superou" é atual menos anterior; o resultado é positivo.

# Exemplos
{exemplos}

# Formato da resposta
- Responda SOMENTE CYPHER, SEM BLOCOS DE CÓDIGO, sem explicação, sem comentários e sem ponto e vírgula.
- A consulta é somente de leitura: use MATCH, WITH, WHERE, RETURN, ORDER BY e LIMIT.
- Dê alias a toda coluna do RETURN. Quando a consulta devolver fatos, inclua \`f.page AS pagina\` e \`f.id AS id\`; em agregações, agregue direto no RETURN (sem WITH antes) e devolva \`min(f.page) AS pagina\` ali mesmo.
- Termine sempre com LIMIT (no máximo 50).`;

// ---------- esquema ----------

export type Relacao = [origem: string, tipo: string, destino: string, props: Record<string, string>];

export interface Esquema {
  nos: Record<string, Record<string, string>>;
  relacoes: Relacao[];
  valores: Record<string, unknown[]>;
  entidades?: string[];
  rotulos?: string[];
  rotulos_todos?: string[];
  recortes?: Record<string, string[]>;
}

const tipoDe = (tipos: unknown): string => {
  const t = (Array.isArray(tipos) && tipos.length > 0 ? String(tipos[0]) : "String");
  return t.endsWith("Array") ? "LIST" : (TIPOS[t] ?? t.toUpperCase());
};

/** Vetores, textos longos e metadados de indexação (embeddingHash...) não ajudam a consulta. */
const oculta = (prop: string): boolean => OCULTAS.has(prop) || prop.startsWith("embedding") || prop.startsWith("summary") || prop.endsWith("Text") || prop.endsWith("Hash");

/** Até `quantos` valores, espalhados pela lista ordenada (não só os primeiros). */
function amostrar<T>(valores: T[], quantos: number): T[] {
  const v = valores.filter((x) => x !== null && x !== undefined);
  if (v.length <= quantos) return v;
  const passo = v.length / quantos;
  return Array.from({ length: quantos }, (_, i) => v[Math.trunc(i * passo)] as T);
}

const porTexto = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/**
 * Esquema do grafo pela APOC, mais valores de exemplo. Devolve o esquema e os avisos; sem APOC, cai para
 * `db.schema.*` (sem as propriedades das relações) e avisa, em vez de montar um prompt mudo.
 */
export async function descobrirEsquema(grafo: GrafoLeitura): Promise<{ esquema: Esquema; avisos: string[] }> {
  const avisos: string[] = [];
  let nos: Record<string, Record<string, string>> = {};
  const propsRel: Record<string, Record<string, string>> = {};
  const lerNos = (linhas: Record<string, unknown>[]) => {
    for (const r of linhas) {
      for (const rotulo of r["nodeLabels"] as string[]) {
        nos[rotulo] ??= {};
        if (r["propertyName"]) (nos[rotulo] as Record<string, string>)[r["propertyName"] as string] = tipoDe(r["propertyTypes"]);
      }
    }
  };
  try {
    lerNos(await grafo.consultar("CALL apoc.meta.nodeTypeProperties() YIELD nodeLabels, propertyName, propertyTypes RETURN nodeLabels, propertyName, propertyTypes"));
    for (const r of await grafo.consultar("CALL apoc.meta.relTypeProperties() YIELD relType, propertyName, propertyTypes RETURN relType, propertyName, propertyTypes")) {
      const tipo = String(r["relType"]).replace(/^[:`]+|[:`]+$/g, "");
      propsRel[tipo] ??= {};
      if (r["propertyName"]) (propsRel[tipo] as Record<string, string>)[r["propertyName"] as string] = tipoDe(r["propertyTypes"]);
    }
  } catch (e) {
    avisos.push(`apoc_indisponivel: ${String(e instanceof Error ? e.message : e).slice(0, 120)}`);
    nos = {};
    lerNos(await grafo.consultar("CALL db.schema.nodeTypeProperties() YIELD nodeLabels, propertyName, propertyTypes RETURN nodeLabels, propertyName, propertyTypes"));
  }
  // `__Entity__` é o rótulo genérico das entidades; o específico (Person, Organization) é o que informa
  const especifico = (v: string) => `[l IN labels(${v}) WHERE l <> '__Entity__'][0]`;
  const padroes = await grafo.consultar(`MATCH (a)-[r]->(b) RETURN DISTINCT ${especifico("a")} AS origem, type(r) AS tipo, ${especifico("b")} AS destino`);
  const relacoesBrutas: Relacao[] = padroes
    .filter((p) => !ROTULOS_IGNORADOS.has(String(p["origem"])) && !ROTULOS_IGNORADOS.has(String(p["destino"])))
    .map((p) => [String(p["origem"]), String(p["tipo"]), String(p["destino"]), propsRel[String(p["tipo"])] ?? {}]);
  const entidades = (await grafo.consultar(`MATCH (e:__Entity__) RETURN DISTINCT ${especifico("e")} AS rotulo`))
    .map((r) => r["rotulo"])
    .filter((r): r is string => typeof r === "string" && r !== "")
    .sort(porTexto);
  const relacoes = agruparRelacoes(relacoesBrutas, new Set(entidades));
  nos = Object.fromEntries(Object.entries(nos).filter(([k]) => !ROTULOS_IGNORADOS.has(k)));
  const valores: Record<string, unknown[]> = {};
  for (const [tipo, nome, prop, quantos] of AMOSTRAS) {
    const padrao = tipo === "rel" ? `()-[x:\`${nome}\`]->()` : `(x:\`${nome}\`)`;
    try {
      const lista = (await grafo.consultar(`MATCH ${padrao} RETURN DISTINCT x.\`${prop}\` AS v ORDER BY v`)).map((r) => r["v"]);
      if (lista.length > 0) valores[`${nome}.${prop}`] = amostrar(lista, quantos);
    } catch (e) {
      avisos.push(`amostra_falhou ${nome}.${prop}: ${String(e instanceof Error ? e.message : e).slice(0, 80)}`);
    }
  }
  let rotulos: string[] = [];
  try {
    rotulos = (await grafo.consultar("MATCH (f:FinancialFact) RETURN DISTINCT f.metric AS v ORDER BY v")).map((r) => r["v"]).filter((v): v is string => typeof v === "string" && v !== "");
  } catch (e) {
    avisos.push(`rotulos_falhou: ${String(e instanceof Error ? e.message : e).slice(0, 80)}`);
  }
  let recortes: Record<string, string[]> = {};
  try {
    const linhas = await grafo.consultar("MATCH ()-[r:OF_METRIC]->(m:Metric) WHERE r.dimension IS NOT NULL RETURN m.name AS m, collect(DISTINCT r.dimension) AS dims ORDER BY size(dims) DESC");
    recortes = Object.fromEntries(linhas.map((r) => [String(r["m"]), amostrar([...(r["dims"] as string[])].sort(porTexto), RECORTES_POR_METRICA)]));
  } catch (e) {
    avisos.push(`recortes_falhou: ${String(e instanceof Error ? e.message : e).slice(0, 80)}`);
  }
  return { esquema: { nos, relacoes, valores, entidades, rotulos: agruparRotulos(rotulos), rotulos_todos: rotulos, recortes }, avisos };
}

/** Sem acento, sem maiúscula, só `[a-z0-9]` separado por espaço (mesma regra do `_norm` do Python). */
export function normalizarAscii(texto: unknown): string {
  const semAcento = String(texto ?? "").normalize("NFKD").replace(/\P{ASCII}/gu, "");
  return (semAcento.toLowerCase().match(/[a-z0-9]+/g) ?? []).join(" ");
}

const SEM_VALOR = new Set([
  "a", "o", "as", "os", "de", "do", "da", "dos", "das", "e", "em", "no", "na", "nos", "nas", "um", "uma",
  "que", "qual", "quais", "quanto", "quantos", "quantas", "ha", "mais", "menos", "entre",
  "para", "por", "com", "se", "ou", "somando", "soma", "somados", "diferenca", "total", "tem", "sao",
  "foi", "ser", "ao", "aos", "pelo", "pela", "maior", "menor", "ano", "anos",
]); // prettier-ignore

/** Palavras úteis, sem acento e sem plural simples: "pardos" e "Pardo" casam. */
function radicais(texto: string): Set<string> {
  const saida = new Set<string>();
  for (const t of normalizarAscii(texto).split(" ")) {
    if (t === "" || SEM_VALOR.has(t) || t.length < 3) continue;
    saida.add((t.endsWith("es") || t.endsWith("ns")) && t.length > 5 ? t.slice(0, -2) : t.replace(/s+$/, ""));
  }
  return saida;
}

/**
 * Os `k` rótulos de `f.metric` mais parecidos com a pergunta (palavras em comum, as raras pesam mais). É a ligação
 * entre a pergunta e o vocabulário do grafo; o LLM ainda escolhe, mas escolhe entre poucos. A pontuação é somada em
 * ordem alfabética das palavras e arredondada, para a ordem não depender da ordem de iteração de um conjunto.
 */
export function rotulosCandidatos(pergunta: string, rotulos: readonly string[], k: number = CANDIDATOS_POR_PERGUNTA): string[] {
  if (rotulos.length === 0) return [];
  const alvo = radicais(pergunta);
  const docs = rotulos.map((r): [string, Set<string>] => [r, radicais(r)]);
  const freq = new Map<string, number>();
  for (const [, rad] of docs) for (const t of rad) freq.set(t, (freq.get(t) ?? 0) + 1);
  const pontos: [number, string][] = [];
  for (const [r, rad] of docs) {
    const comuns = [...alvo].filter((t) => rad.has(t)).sort(porTexto);
    if (comuns.length === 0) continue;
    const peso = comuns.reduce((s, t) => s + 1 + 1 / (freq.get(t) as number), 0);
    const sobra = [...rad].filter((t) => !alvo.has(t)).length;
    pontos.push([Math.round((peso - 0.01 * sobra) * 1e9) / 1e9, r]); // rótulo sem palavras sobrando empata melhor
  }
  pontos.sort((a, b) => b[0] - a[0] || porTexto(a[1], b[1]));
  return pontos.slice(0, k).map(([, r]) => r);
}

/**
 * Rótulos distintos de `f.metric` (o vocabulário que o filtro precisa copiar). Famílias de rótulos quase iguais (as 40
 * faixas de provisão, os 20 programas de remuneração) entram com alguns exemplos e a contagem do resto; o total é
 * cortado em `maxChars`.
 */
export function agruparRotulos(rotulos: readonly string[], porFamilia = 6, maxChars: number = MAX_CHARS_ROTULOS): string[] {
  const familias = new Map<string, string[]>();
  for (const r of rotulos) {
    const chave = r.split(/\s+/).filter(Boolean).slice(0, 3).join(" ");
    familias.set(chave, [...(familias.get(chave) ?? []), r]);
  }
  const saida: string[] = [];
  let usados = 0;
  for (const membros of familias.values()) {
    const mostrados = membros.slice(0, porFamilia);
    if (membros.length > porFamilia) mostrados.push(`(+${membros.length - porFamilia} rótulos semelhantes a '${(membros[0] as string).slice(0, 40)}')`);
    for (const r of mostrados) {
      if (usados + r.length + 3 > maxChars) return saida;
      saida.push(r);
      usados += r.length + 3;
    }
  }
  return saida;
}

/**
 * Relações que ligam muitos pares de tipos de entidade (RELATED_TO, MENTIONED_IN...) viram uma linha só, com `Entidade`
 * no lugar do rótulo; sem isso o esquema lista o produto cartesiano (20 mil caracteres).
 */
export function agruparRelacoes(relacoes: readonly Relacao[], entidades: ReadonlySet<string>, maximo = 4): Relacao[] {
  const porTipo = new Map<string, number>();
  for (const [, tipo] of relacoes) porTipo.set(tipo, (porTipo.get(tipo) ?? 0) + 1);
  const saida = new Map<string, Relacao>();
  for (const [origemBruta, tipo, destinoBruto, props] of relacoes) {
    let origem = origemBruta;
    let destino = destinoBruto;
    if ((porTipo.get(tipo) as number) > maximo) {
      origem = entidades.has(origem) ? "Entidade" : origem;
      destino = entidades.has(destino) ? "Entidade" : destino;
    }
    saida.set(JSON.stringify([origem, tipo, destino]), [origem, tipo, destino, props]);
  }
  return [...saida.values()].sort((a, b) => porTexto(a[0], b[0]) || porTexto(a[1], b[1]) || porTexto(a[2], b[2]));
}

/** Esquema em texto para o prompt. Vetores e textos longos ficam de fora. */
export function formatarEsquema(esquema: Esquema): string {
  const linhas = ["Nós (rótulo e propriedades):"];
  for (const rotulo of Object.keys(esquema.nos).sort(porTexto)) {
    const props = esquema.nos[rotulo] as Record<string, string>;
    const corpo = Object.entries(props).filter(([p, t]) => !oculta(p) && t !== "LIST").map(([p, t]) => `${p}: ${t}`).join(", ");
    linhas.push(`(:${rotulo}) {${corpo}}`);
  }
  linhas.push("Relações:");
  for (const [origem, tipo, destino, props] of esquema.relacoes) {
    const corpo = Object.entries(props).filter(([p, t]) => !oculta(p) && t !== "LIST").map(([p, t]) => `${p}: ${t}`).join(", ");
    linhas.push(`(:${origem})-${corpo ? `[:${tipo} {${corpo}}]` : `[:${tipo}]`}->(:${destino})`);
  }
  if (esquema.entidades?.length) linhas.push(`Entidade = qualquer um destes rótulos: ${esquema.entidades.join(", ")}`);
  if (esquema.rotulos?.length) {
    linhas.push("Rótulos existentes em FinancialFact.metric (copie o texto exato ao filtrar por f.metric):");
    linhas.push(esquema.rotulos.join(" | "));
  }
  if (esquema.recortes && Object.keys(esquema.recortes).length > 0) {
    linhas.push("Exemplos de recorte (OF_METRIC.dimension) por métrica; os rótulos de f.metric têm prioridade:");
    for (const [metrica, dims] of Object.entries(esquema.recortes)) linhas.push(`${metrica}: ${dims.map((d) => String(d).slice(0, 40)).join(" | ")}`);
  }
  if (Object.keys(esquema.valores).length > 0) {
    linhas.push("Valores de exemplo:");
    for (const [chave, lista] of Object.entries(esquema.valores)) linhas.push(`${chave}: ${lista.map(String).join(" | ")}`);
  }
  return linhas.join("\n");
}

/** Uma linha por métrica: nome do grafo (EN), nome em português e sinônimos. */
export function terminologia(catalogo: readonly Pick<Metrica, "name" | "name_pt" | "aliases">[], maxApelidos = 6): string {
  return catalogo
    .map((m) => {
      const apelidos = (m.aliases ?? []).slice(0, maxApelidos).join(", ");
      return `- Metric.name = '${m.name}' ← ${m.name_pt ?? ""}${apelidos ? ` (também: ${apelidos})` : ""}`;
    })
    .join("\n");
}

// ---------- exemplos e prompt ----------

export interface Exemplo {
  pergunta: string;
  cypher: string;
}

export function carregarExemplos(caminho: URL | string = EXEMPLOS): Exemplo[] {
  const dados = JSON.parse(readFileSync(caminho, "utf-8").trim()) as Exemplo[];
  return dados.map((e) => ({ pergunta: e.pergunta, cypher: e.cypher }));
}

/**
 * Mensagens do LLM. O sistema (esquema, termos, exemplos, formato) é igual em toda pergunta e fica no início, onde o
 * cache de prefixo do llama.cpp o reaproveita; o que muda por pergunta vai na mensagem do usuário: os rótulos de
 * `f.metric` mais parecidos e, por último, a pergunta.
 */
export function montarPrompt(pergunta: string, esquemaTxt: string, terminologiaTxt: string, exemplos: readonly Exemplo[], candidatos: readonly string[] = []): MensagemCypher[] {
  const blocos = exemplos.length > 0 ? exemplos.map((e) => `Pergunta: ${e.pergunta}\nCypher:\n${e.cypher}`).join("\n\n") : "(sem exemplos)";
  const valores: Record<string, string> = { esquema: esquemaTxt, terminologia: terminologiaTxt, exemplos: blocos };
  // uma passada só: o texto de uma seção que contenha "{exemplos}" não é substituído de novo
  const sistema = INSTRUCOES.replace(/\{(esquema|terminologia|exemplos)\}/g, (_, k: string) => valores[k] as string);
  let usuario = `Pergunta: ${pergunta.trim()}`;
  if (candidatos.length > 0) {
    const lista = candidatos.map((r) => `- ${r}`).join("\n");
    usuario = `Rótulos de f.metric mais parecidos com a pergunta (confira todos antes de escolher):\n${lista}\n\n${usuario}`;
  }
  return [
    { role: "system", content: sistema },
    { role: "user", content: usuario },
  ];
}

// ---------- do texto do LLM ao Cypher ----------

const ci = (palavra: string) => [...palavra].map((c) => `[${c.toLowerCase()}${c.toUpperCase()}]`).join("");
const RE_INICIO = new RegExp(
  "^[ \\t]*(" +
    "(?:MATCH|OPTIONAL\\s+MATCH|UNWIND|CALL|WITH|RETURN)\\b" +
    // escrita e administração também iniciam consulta: chegam à guarda e são bloqueadas lá, em vez de sumirem como "sem_cypher"
    "|(?:CREATE|MERGE|DELETE|DETACH|SET|REMOVE|DROP|LOAD|FOREACH|USE|SHOW|EXPLAIN|PROFILE)\\b" +
    `|(?:${ci("match")}|${ci("optional")}\\s+${ci("match")}|${ci("unwind")}|${ci("call")}|${ci("create")}|${ci("merge")}|${ci("delete")}|${ci("detach")}|${ci("drop")}|${ci("load")}|${ci("show")})\\b` +
    ")",
  "m",
);
const RE_CLAUSULA = /^\s*(?:MATCH|OPTIONAL|WITH|WHERE|RETURN|ORDER|SKIP|LIMIT|UNWIND|UNION|CALL)\b/i;

/**
 * `\n`, `\r` e `\t` escritos com barra, fora de string, viram espaço. Cypher não tem essa sequência fora de aspas; o
 * especialista (treinado com Cypher dentro de JSON) a devolve entre as cláusulas.
 */
function quebrasLiterais(texto: string): string {
  const saida: string[] = [];
  let aspas = "";
  for (let i = 0; i < texto.length; i++) {
    const c = texto[i] as string;
    if (aspas) {
      saida.push(c);
      if (c === "\\" && i + 1 < texto.length) {
        saida.push(texto[i + 1] as string);
        i++;
      } else if (c === aspas) aspas = "";
    } else if (c === "'" || c === '"' || c === "`") {
      aspas = c;
      saida.push(c);
    } else if (c === "\\" && ["n", "r", "t"].includes(texto.slice(i + 1, i + 2))) {
      saida.push(" ");
      i++;
    } else saida.push(c);
  }
  return saida.join("");
}

/**
 * A primeira consulta do texto: sem cerca ```, sem prosa antes, sem `Cypher:`, sem o que vem depois do primeiro `;` fora
 * de aspas. Lança `Error("sem_cypher")` quando não há Cypher.
 */
export function extrairCypher(texto: string): string {
  let t = (texto ?? "").trim();
  const cerca = /```[^\n`]*\n?([\s\S]*?)```/.exec(t);
  if (cerca) t = (cerca[1] as string).trim();
  else if (t.startsWith("```")) t = t.replace(/^`+|`+$/g, "").trim();
  t = t.replace(/^\s*cypher(?:\s+output)?\s*:\s*/i, "");
  t = quebrasLiterais(t);
  const achado = RE_INICIO.exec(t);
  if (!achado) throw new Error("sem_cypher");
  t = t.slice(achado.index + achado[0].length - (achado[1] as string).length);
  // prosa depois de uma linha em branco ("Explanation: ...") não é Cypher; uma consulta com linha em branco no meio
  // continua se o que vem depois abre com uma cláusula
  const quebras = /\n[ \t]*\n/g;
  for (let q = quebras.exec(t); q !== null; q = quebras.exec(t)) {
    if (!RE_CLAUSULA.test(t.slice(q.index + q[0].length))) {
      t = t.slice(0, q.index);
      break;
    }
  }
  let aspas = "";
  for (let i = 0; i < t.length; i++) {
    const c = t[i] as string;
    if (aspas) {
      if (c === aspas) aspas = "";
    } else if (c === "'" || c === '"' || c === "`") aspas = c;
    else if (c === ";") {
      t = t.slice(0, i);
      break;
    }
  }
  t = t.trim().replace(/;+$/, "").trim();
  if (t === "") throw new Error("sem_cypher");
  return t;
}

// ---------- execução e evidências ----------

const textoDaLinha = (linha: Record<string, unknown>): string =>
  Object.entries(linha)
    .filter(([, v]) => v !== null && v !== undefined)
    .map(([k, v]) => `${k}=${typeof v === "object" ? JSON.stringify(v) : String(v)}`)
    .join("; ");

const paginasDe = (valor: unknown): number[] => {
  if (valor === null || valor === undefined) return [];
  return (Array.isArray(valor) ? valor : [valor]).filter((x): x is number => typeof x === "number" && Number.isFinite(x)).map(Math.trunc);
};

/** Uma evidência por linha, no contrato das outras ferramentas; a página só vem da coluna `pagina`. */
export function evidenciasDe(linhas: readonly Record<string, unknown>[]): Evidencia[] {
  return linhas.map((linha, i) => ({
    id: String((linha["id"] as unknown) || `consulta:${i}`),
    tipo: "consulta",
    paginas: rotuloDePaginas(paginasDe(linha["pagina"])),
    caminho: "consulta ao grafo",
    texto: textoDaLinha(linha),
    score: 1,
  }));
}

export interface OpcoesPerguntar {
  esquemaTexto?: string;
  terminologiaTexto?: string;
  exemplos?: readonly Exemplo[];
  /** Todos os `f.metric` do grafo; deles saem os candidatos mais parecidos com a pergunta. */
  rotulos?: readonly string[];
  limiteLinhas?: number;
  timeoutMs?: number;
  /** Uma autocorreção (padrão) para erro do banco e nome inexistente; violação da guarda nunca é autocorrigida. */
  autocorrigir?: boolean;
}

export interface ResultadoCypher {
  pergunta: string;
  cypher: string | null;
  linhas: Record<string, unknown>[];
  evidencias: Evidencia[];
  truncado: boolean;
  erro: string | null;
  aviso: string | null;
  guarda: { corrigida: boolean; avisos: string[]; bloqueada: string | null };
  latencia_ms: { llm?: number; banco?: number; total?: number };
  resposta_bruta?: string;
  avisos_esquema?: string[];
}

const mensagemDe = (e: unknown): string => (e instanceof Error ? e.message : String(e));
const nomeDoErro = (e: unknown): string => (e instanceof Error ? e.constructor.name : typeof e);

/**
 * Pergunta → Cypher → guarda → linhas. Nunca lança: as falhas voltam em `erro`. A guarda (F6.5) valida o texto, olha o
 * plano do `EXPLAIN` e só então executa; erro do banco ou nome inexistente tem uma autocorreção; violação da guarda não
 * tem (`erro = "bloqueada_pela_guarda: ..."`).
 */
export async function perguntar(grafo: GrafoCypher, pergunta: string, gera: GeraCypher, opcoes: OpcoesPerguntar = {}): Promise<ResultadoCypher> {
  const t0 = performance.now();
  const limiteLinhas = opcoes.limiteLinhas ?? LIMITE_LINHAS;
  const timeoutMs = opcoes.timeoutMs ?? TIMEOUT_MS;
  const autocorrigir = opcoes.autocorrigir ?? true;
  const saida: ResultadoCypher = {
    pergunta, cypher: null, linhas: [], evidencias: [], truncado: false, erro: null, aviso: null,
    guarda: { corrigida: false, avisos: [], bloqueada: null }, latencia_ms: {},
  }; // prettier-ignore
  if ((pergunta ?? "").trim() === "") {
    saida.erro = "pergunta_vazia";
    return saida;
  }
  let esquemaTexto = opcoes.esquemaTexto;
  let rotulos = opcoes.rotulos;
  if (esquemaTexto === undefined) {
    try {
      const d = await descobrirEsquema(grafo);
      esquemaTexto = formatarEsquema(d.esquema);
      saida.avisos_esquema = d.avisos;
      rotulos ??= d.esquema.rotulos_todos ?? [];
    } catch (e) {
      saida.erro = `falha_no_esquema: ${mensagemDe(e).slice(0, 150)}`;
      return saida;
    }
  }
  const terminologiaTexto = opcoes.terminologiaTexto ?? terminologia(lerCatalogo());
  const exemplos = opcoes.exemplos ?? carregarExemplos();
  const mensagens = montarPrompt(pergunta, esquemaTexto, terminologiaTexto, exemplos, rotulosCandidatos(pergunta, rotulos ?? []));
  const t1 = performance.now();
  let bruto: string;
  try {
    bruto = await gera(mensagens);
  } catch (e) {
    saida.erro = `falha_no_llm: ${nomeDoErro(e)}: ${mensagemDe(e).slice(0, 150)}`;
    return saida;
  }
  const t2 = performance.now();
  saida.resposta_bruta = bruto;
  let atual: string;
  try {
    atual = extrairCypher(bruto);
    saida.cypher = atual;
  } catch {
    saida.erro = "sem_cypher";
    saida.latencia_ms = { llm: Math.round(t2 - t1) };
    return saida;
  }
  const guarda = saida.guarda;
  const tentativas = autocorrigir ? 2 : 1;
  for (let tentativa = 0; tentativa < tentativas; tentativa++) {
    const ultima = tentativa === tentativas - 1;
    let pedido: string | null = null;
    saida.erro = null;
    const p = preparar(atual); // barreira 1: o texto; nada vai ao banco se falhar
    if (p.cypher === null) {
      guarda.bloqueada = p.motivo;
      saida.erro = `bloqueada_pela_guarda: ${p.motivo}`;
      break;
    }
    const final = p.cypher;
    saida.cypher = final;
    try {
      const plano = await grafo.explicar(final, timeoutMs); // barreira 2: o plano, sem executar
      const bloqueio = planoComEscrita(plano.plano);
      if (bloqueio) {
        guarda.bloqueada = bloqueio;
        saida.erro = `bloqueada_pela_guarda: ${bloqueio} (plano)`;
        break;
      }
      const { desconhecidos, outros } = avisosDoPlano(plano.notificacoes);
      guarda.avisos = outros;
      if (desconhecidos.length > 0) {
        guarda.avisos = [...desconhecidos, ...outros];
        if (!ultima) pedido = `O Neo4j avisou que estes nomes não existem no grafo: ${desconhecidos.join("; ")}`;
      }
      if (pedido === null) {
        const r = await grafo.executarLivre(final, { timeoutMs, maxLinhas: limiteLinhas });
        saida.linhas = r.linhas;
        saida.truncado = r.truncado;
      }
    } catch (e) {
      saida.erro = `falha_na_execucao: ${mensagemDe(e).slice(0, 200)}`;
      pedido = `A consulta falhou no Neo4j com este erro: ${mensagemDe(e).slice(0, 300)}`;
    }
    if (pedido === null || ultima) break;
    try {
      // a única autocorreção: devolve ao LLM a consulta e o erro, e revalida o que ele responder
      const nova = await gera([
        ...mensagens,
        { role: "assistant", content: final },
        { role: "user", content: `${pedido}\nConsulta: ${final}\nCorrija e responda SOMENTE CYPHER, SEM BLOCOS DE CÓDIGO.` },
      ]);
      atual = extrairCypher(nova);
    } catch (e) {
      saida.erro = e instanceof Error && e.message === "sem_cypher" ? "sem_cypher" : `falha_no_llm: ${nomeDoErro(e)}: ${mensagemDe(e).slice(0, 150)}`;
      break;
    }
    guarda.corrigida = true;
    saida.linhas = [];
    saida.truncado = false;
  }
  if (saida.erro) saida.linhas = [];
  const t3 = performance.now();
  saida.latencia_ms = { llm: Math.round(t2 - t1), banco: Math.round(t3 - t2), total: Math.round(t3 - t0) };
  if (saida.erro) return saida;
  if (saida.linhas.length === 0) saida.aviso = "A consulta rodou e não devolveu linhas.";
  else {
    saida.evidencias = evidenciasDe(saida.linhas);
    // soma de conjunto vazio dá 0 sem página: sem página não há como conferir no documento
    if (!saida.evidencias.some((e) => e.paginas !== "")) saida.aviso = "O resultado não cita página; não use como resposta sem conferir.";
  }
  return saida;
}

// ---------- a ferramenta ----------

export interface EnvelopeCypher extends Envelope {
  /** O Cypher que rodou (já com `LIMIT` e sem comentários); `null` se o LLM não produziu consulta. */
  cypher: string | null;
  linhas: Record<string, unknown>[];
  guarda: ResultadoCypher["guarda"];
  etapas_ms: ResultadoCypher["latencia_ms"];
}

interface ContextoCypher {
  esquemaTexto: string;
  terminologiaTexto: string;
  exemplos: Exemplo[];
  rotulos: string[];
  avisosEsquema: string[];
}

// O esquema tem milhares de rótulos e custa várias consultas ao banco: uma leitura por grafo e processo. Falha não fica em
// cache. Depois de reindexar, o processo da API é reiniciado (o esquema antigo seria usado até lá).
const CONTEXTOS = new WeakMap<object, Promise<ContextoCypher>>();

function contextoDe(grafo: GrafoLeitura): Promise<ContextoCypher> {
  let p = CONTEXTOS.get(grafo);
  if (!p) {
    p = (async () => {
      const { esquema, avisos } = await descobrirEsquema(grafo);
      return {
        esquemaTexto: formatarEsquema(esquema),
        terminologiaTexto: terminologia(lerCatalogo()),
        exemplos: carregarExemplos(),
        rotulos: esquema.rotulos_todos ?? [],
        avisosEsquema: avisos,
      };
    })();
    p.catch(() => CONTEXTOS.delete(grafo));
    CONTEXTOS.set(grafo, p);
  }
  return p;
}

/** A ferramenta `consultar_grafo` (§7.2): o resultado é hipótese, e só a página o torna conferível. */
export async function consultarGrafo(grafo: GrafoCypher, llm: LlmDeCypher, pergunta: string): Promise<EnvelopeCypher> {
  const t0 = performance.now();
  const saida: EnvelopeCypher = { ...envelope("consultar_grafo", { pergunta }), cypher: null, linhas: [], guarda: { corrigida: false, avisos: [], bloqueada: null }, etapas_ms: {} };
  const fechar = (): EnvelopeCypher => {
    saida.latencia_ms = Math.round((performance.now() - t0) * 10) / 10;
    return saida;
  };
  if ((pergunta ?? "").trim() === "") {
    saida.erro = "pergunta_vazia";
    return fechar();
  }
  let contexto: ContextoCypher;
  try {
    contexto = await contextoDe(grafo);
  } catch (e) {
    saida.erro = `falha_no_esquema: ${mensagemDe(e).slice(0, 150)}`;
    return fechar();
  }
  const gera: GeraCypher = async (mensagens) =>
    (await llm.chat(mensagens, { perfil: "principal", temperatura: 0, maxTokens: MAX_TOKENS_CYPHER, timeoutMs: TIMEOUT_LLM_MS })).texto.trim();
  const r = await perguntar(grafo, pergunta, gera, {
    esquemaTexto: contexto.esquemaTexto,
    terminologiaTexto: contexto.terminologiaTexto,
    exemplos: contexto.exemplos,
    rotulos: contexto.rotulos,
  });
  Object.assign(saida, { cypher: r.cypher, linhas: r.linhas, evidencias: r.evidencias, guarda: r.guarda, etapas_ms: r.latencia_ms, erro: r.erro, aviso: r.aviso });
  if (r.truncado) saida.omitido["linhas_truncadas"] = 1;
  return fechar();
}

/** O executor só pode oferecer `consultar_grafo` se o grafo sabe `EXPLAIN` e execução livre (o `GrafoNeo4j` sabe). */
export const grafoServeParaCypher = temCypherLivre;

// ---------- medida de acerto (F6.4) ----------

/**
 * Execução certa: o valor esperado aparece no resultado. Número com tolerância de centavo, texto sem acento/caixa/espaços.
 * Mais de `MAX_DESPEJO` linhas contam como erro (despejo que acerta por acaso).
 */
export function acerto(esperado: number | string, tipo: "numero" | "texto", linhas: readonly Record<string, unknown>[]): boolean {
  if (linhas.length === 0 || linhas.length > MAX_DESPEJO) return false;
  const valores = linhas.flatMap((l) => Object.values(l)).filter((v) => v !== null && v !== undefined);
  if (tipo === "numero") {
    const alvo = Number(esperado);
    return valores.some((v) => typeof v === "number" && Math.abs(v - alvo) <= 0.01);
  }
  const alvo = normalizarAscii(esperado);
  return valores.some((v) => alvo !== "" && normalizarAscii(v).includes(alvo));
}
