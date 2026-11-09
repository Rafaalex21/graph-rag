/**
 * Foco nas linhas da tabela (F8.10d, ADR-076): a evidência de tabela traz a descrição e o Markdown inteiro, e o corte de 900
 * caracteres por evidência (`selecionar`) escondia as linhas do fim de uma tabela longa: o "Lucro Antes dos Impostos" da p. 93 fica
 * depois de uns doze outros. Para o pedido de material, a evidência que vai ao modelo da especificação traz o cabeçalho e as linhas
 * cujo rótulo se parece com o que o pedido cita, não o começo da tabela. Só muda o que o modelo lê; a conferência dos números
 * (`verificacao.ts`) continua contra a evidência original inteira.
 */

const SEM_VALOR = new Set([
  "de", "da", "do", "das", "dos", "a", "o", "as", "os", "e", "em", "um", "uma", "com", "para", "por", "no", "na", "nos", "nas", "ao", "aos", "ate",
  "gere", "gerar", "faca", "fazer", "monte", "montar", "crie", "criar", "grafico", "tabela", "planilha", "documento", "word", "excel", "apresentacao", "powerpoint", "slides", "arquivo",
]);

const semAcento = (t: string) => t.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();
const palavras = (t: string) => semAcento(t).split(/[^a-z]+/).filter((p) => p.length >= 3 && !SEM_VALOR.has(p));
/** "depositos" e "deposito" são a mesma palavra: compara pelos 5 primeiros caracteres. */
const raiz = (p: string) => p.slice(0, 5);

const ehLinhaDeTabela = (l: string) => l.trimStart().startsWith("|");
const ehSeparador = (l: string) => /^\s*\|?[\s:|-]+\|?\s*$/.test(l) && l.includes("-");
const temAnos = (l: string) => (l.match(/\b20\d\d\b/g) ?? []).length >= 2;
const MAX_DESCRICAO = 200;

/**
 * Devolve a evidência de tabela com a descrição (cortada), o cabeçalho e as linhas que mais se parecem com o pedido, dentro de
 * `orcamento` caracteres. Sem linhas de tabela ou sem nenhuma linha parecida, devolve o texto como veio.
 */
export function focarTabela(texto: string, pedido: string, orcamento = 880): string {
  const linhas = texto.split("\n");
  const tabela = linhas.filter(ehLinhaDeTabela);
  if (tabela.length < 3) return texto;

  const raizesDoPedido = new Set(palavras(pedido).map(raiz));
  if (raizesDoPedido.size === 0) return texto;

  // cabeçalho: a última linha com anos antes de cada linha (as tabelas repetem o cabeçalho por seção)
  let cabecalho = tabela.find(temAnos) ?? tabela[0]!;
  const candidatas: { linha: string; cabecalho: string; pontos: number; ordem: number }[] = [];
  tabela.forEach((linha, ordem) => {
    if (ehSeparador(linha)) return;
    if (temAnos(linha)) {
      cabecalho = linha;
      return;
    }
    const rotulo = linha.trim().replace(/^\|/, "").split("|")[0] ?? "";
    const raizesDoRotulo = new Set(palavras(rotulo).map(raiz));
    let pontos = 0;
    for (const r of raizesDoPedido) if (raizesDoRotulo.has(r)) pontos += 1;
    if (pontos > 0) candidatas.push({ linha, cabecalho, pontos, ordem });
  });
  if (candidatas.length === 0) return texto;

  const descricao = linhas.filter((l) => !ehLinhaDeTabela(l) && l.trim() !== "").join(" ").replace(/\s+/g, " ").trim();
  const inicio = descricao.length > MAX_DESCRICAO ? `${descricao.slice(0, MAX_DESCRICAO).trimEnd()}…` : descricao;

  const melhores = [...candidatas].sort((a, b) => b.pontos - a.pontos || a.ordem - b.ordem);
  const escolhidas: typeof candidatas = [];
  let gasto = inicio.length;
  for (const c of melhores) {
    const custo = c.linha.length + c.cabecalho.length + 2;
    if (gasto + custo > orcamento && escolhidas.length > 0) continue;
    escolhidas.push(c);
    gasto += custo;
  }
  escolhidas.sort((a, b) => a.ordem - b.ordem);

  const saida: string[] = inicio === "" ? [] : [inicio];
  let ultimoCabecalho = "";
  for (const c of escolhidas) {
    if (c.cabecalho !== ultimoCabecalho) {
      saida.push(c.cabecalho);
      ultimoCabecalho = c.cabecalho;
    }
    saida.push(c.linha);
  }
  return saida.join("\n");
}
