/**
 * Guarda-corpos do Text2Cypher (F7.10, porte de `indexer/guarda_cypher.py`, F6.5; ARQUITETURA §7.3).
 *
 * O Cypher vem de um LLM que lê a pergunta do usuário; logo é entrada não confiável. Quatro barreiras, da mais
 * barata à mais forte (a última vale mesmo se as outras falharem):
 *
 *  1. **Texto** (`preparar`): sem comentários, uma única consulta, só leitura (`MATCH`, `WITH`, `UNWIND`, `RETURN`),
 *     sem cláusula de escrita nem de administração, sem procedimento (`CALL nome(...)`) e sem `LOAD CSV`; tamanho
 *     máximo; sem caracteres de controle; `LIMIT` literal e no máximo `LIMITE_PADRAO` (injetado quando falta).
 *     Strings e nomes entre crases são mascarados antes de procurar as palavras, então `'Set up'` e `` n.`delete` ``
 *     passam.
 *  2. **Plano** (`planoComEscrita`): o `EXPLAIN` não executa, mas mostra os operadores; qualquer `Create`, `Merge`,
 *     `Delete`, `Set*`, `Remove*`, `Foreach`, `ProcedureCall`, `LoadCSV` ou `EmptyResult` bloqueia.
 *  3. **Sessão `READ` e tempo-limite** (em `GrafoNeo4j`): o servidor recusa escrita, o que vale mesmo que as duas
 *     primeiras barreiras tenham um furo.
 *  4. **Teto de linhas**.
 *
 * Os avisos do `EXPLAIN` sobre rótulo, propriedade ou relação que não existem (`avisosDoPlano`) não bloqueiam: são a
 * pista do erro mais comum do LLM e alimentam a única autocorreção.
 *
 * Diferença deliberada em relação ao Python: o `\w` e o `\b` do Python entendem letra acentuada e os do JavaScript
 * não; as expressões que decidem segurança usam classes Unicode (`\p{L}`) para dar o mesmo veredito.
 */

export const LIMITE_PADRAO = 100;
export const MAX_CARACTERES = 4000;
const INICIOS = new Set(["MATCH", "OPTIONAL", "WITH", "UNWIND", "RETURN", "CALL"]);
export const PROIBIDAS = [
  "CREATE", "MERGE", "DELETE", "DETACH", "SET", "REMOVE", "DROP", "FOREACH", "LOAD", "USE", "SHOW",
  "GRANT", "DENY", "REVOKE", "ALTER", "RENAME", "TERMINATE", "EXPLAIN", "PROFILE", "TRANSACTIONS",
] as const; // prettier-ignore

const PALAVRA = String.raw`\p{L}\p{N}_`;
// Sem a bandeira `g`: uma regex global guarda `lastIndex` entre chamadas e deixaria passar a segunda consulta igual.
const ANTES_DA_PALAVRA = "[" + PALAVRA + ".\\$`]"; // letra, dígito, `_`, `.` (n.set), `$` (parâmetro) ou crase
const RE_PROIBIDAS = new RegExp("(?<!" + ANTES_DA_PALAVRA + ")(" + PROIBIDAS.join("|") + ")(?![" + PALAVRA + "])", "iu");
const RE_CALL_PROCEDIMENTO = new RegExp("(?<![" + PALAVRA + "])CALL\\s+(?!\\{)", "iu");
// eslint-disable-next-line no-control-regex -- é exatamente o que se quer achar
const RE_CONTROLE = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;
export const OPERADORES_DE_ESCRITA = ["Create", "Merge", "Delete", "DetachDelete", "Set", "Remove", "Foreach", "ProcedureCall", "LoadCSV", "EmptyResult"] as const;
const DESCONHECIDOS = ["UnknownPropertyKeyWarning", "UnknownLabelWarning", "UnknownRelationshipTypeWarning"];

export interface ConsultaPreparada {
  /** A consulta pronta para o `EXPLAIN`, ou `null` se foi bloqueada. */
  cypher: string | null;
  /** O motivo do bloqueio, ou `null`. */
  motivo: string | null;
}

interface Limpo {
  limpo: string;
  mascarado: string;
  erro: string | null;
}

/** Texto sem comentários e o mesmo com strings e crases mascaradas (mesmo tamanho, então posições valem nos dois). */
function limpar(cypher: string): Limpo {
  const limpo: string[] = [];
  const mascarado: string[] = [];
  let i = 0;
  const n = cypher.length;
  while (i < n) {
    const c = cypher[i] as string;
    if (c === "'" || c === '"' || c === "`") {
      let j = i + 1;
      while (j < n && cypher[j] !== c) j += cypher[j] === "\\" && c !== "`" ? 2 : 1;
      if (j >= n) return { limpo: "", mascarado: "", erro: "string_aberta" };
      limpo.push(cypher.slice(i, j + 1));
      mascarado.push(c + "_".repeat(j - i - 1) + c);
      i = j + 1;
    } else if (cypher.startsWith("//", i)) {
      const j = cypher.indexOf("\n", i);
      i = j < 0 ? n : j;
      limpo.push(" ");
      mascarado.push(" ");
    } else if (cypher.startsWith("/*", i)) {
      const j = cypher.indexOf("*/", i + 2);
      if (j < 0) return { limpo: "", mascarado: "", erro: "comentario_aberto" };
      i = j + 2;
      limpo.push(" ");
      mascarado.push(" ");
    } else {
      limpo.push(c);
      mascarado.push(c);
      i += 1;
    }
  }
  return { limpo: limpo.join(""), mascarado: mascarado.join(""), erro: null };
}

/** O último `LIMIT` fora de parênteses e chaves (o de dentro de subconsulta não limita a saída). */
function limitExterno(mascarado: string): RegExpExecArray | null {
  let nivel = 0;
  const profundidade: number[] = [];
  for (const c of mascarado) {
    if (c === "(" || c === "{" || c === "[") nivel += 1;
    else if (c === ")" || c === "}" || c === "]") nivel -= 1;
    for (let k = 0; k < c.length; k++) profundidade.push(nivel);
  }
  let achado: RegExpExecArray | null = null;
  const re = /\bLIMIT\b/gi; // local: o `lastIndex` não escapa da função
  for (let m = re.exec(mascarado); m !== null; m = re.exec(mascarado)) {
    if (profundidade[m.index] === 0) achado = m;
  }
  return achado;
}

const bloqueada = (motivo: string): ConsultaPreparada => ({ cypher: null, motivo });

/**
 * Valida o texto e devolve a consulta pronta para o `EXPLAIN` (comentários fora, `LIMIT` garantido) ou o motivo.
 * Motivos: vazia, muito_longa, caractere_de_controle, string_aberta, comentario_aberto, varios_comandos,
 * sem_leitura, incompleta, clausula_proibida:X, procedimento_proibido, limit_invalido.
 */
export function preparar(cypher: string, limite: number = LIMITE_PADRAO, maxCaracteres: number = MAX_CARACTERES): ConsultaPreparada {
  if ((cypher ?? "").trim() === "") return bloqueada("vazia");
  if ([...cypher].length > maxCaracteres) return bloqueada("muito_longa");
  if (RE_CONTROLE.test(cypher)) return bloqueada("caractere_de_controle");
  const l = limpar(cypher);
  if (l.erro) return bloqueada(l.erro);
  let limpo = l.limpo.trim();
  let mascarado = l.mascarado.trim();
  while (mascarado.endsWith(";")) {
    limpo = limpo.slice(0, -1).trimEnd();
    mascarado = mascarado.slice(0, -1).trimEnd();
  }
  if (mascarado.includes(";")) return bloqueada("varios_comandos");
  const achado = RE_PROIBIDAS.exec(mascarado); // primeiro o perigo: é o motivo que o log deve mostrar
  if (achado) return bloqueada(`clausula_proibida:${(achado[1] as string).toUpperCase()}`);
  if (RE_CALL_PROCEDIMENTO.test(mascarado)) return bloqueada("procedimento_proibido");
  const tokens = mascarado.match(/[A-Za-z_]+/g) ?? [];
  if (tokens.length === 0 || !INICIOS.has((tokens[0] as string).toUpperCase())) return bloqueada("sem_leitura");
  if (tokens.length < 2 || !/\bRETURN\b|\bWITH\b|\bCALL\b/i.test(mascarado)) return bloqueada("incompleta");
  const m = limitExterno(mascarado);
  if (m === null) return { cypher: `${limpo} LIMIT ${limite}`, motivo: null };
  const valor = /^\s*(\d+)\s*$/.exec(mascarado.slice(m.index + m[0].length));
  if (!valor) return bloqueada("limit_invalido");
  if (Number(valor[1]) > limite) limpo = `${limpo.slice(0, m.index + m[0].length)} ${limite}`;
  return { cypher: limpo, motivo: null };
}

export interface PlanoNo {
  operatorType?: string;
  children?: readonly PlanoNo[];
}

/** Motivo se algum operador do plano do `EXPLAIN` escreve ou chama procedimento; senão `null`. */
export function planoComEscrita(plano: PlanoNo | null | undefined): string | null {
  if (!plano) return null;
  const nome = String(plano.operatorType ?? "").split("@")[0] as string;
  if (OPERADORES_DE_ESCRITA.some((op) => nome.startsWith(op))) return `plano_com_escrita:${nome}`;
  for (const filho of plano.children ?? []) {
    const achado = planoComEscrita(filho);
    if (achado) return achado;
  }
  return null;
}

export interface Notificacao {
  code?: string;
  title?: string;
  description?: string;
}

/** Rótulo, propriedade ou relação que não existem (a pista do erro do LLM) e os outros avisos, como produto cartesiano. */
export function avisosDoPlano(notificacoes: readonly Notificacao[] | null | undefined): { desconhecidos: string[]; outros: string[] } {
  const desconhecidos: string[] = [];
  const outros: string[] = [];
  for (const n of notificacoes ?? []) {
    const codigo = String(n.code ?? "");
    const texto = String(n.description || n.title || codigo).slice(0, 240);
    (DESCONHECIDOS.some((d) => codigo.includes(d)) ? desconhecidos : outros).push(texto);
  }
  return { desconhecidos, outros };
}
