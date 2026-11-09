/**
 * Onde, na camada de texto de uma página do PDF, está o trecho de uma fonte (F8.4). Função pura: compara palavras sem acento,
 * sem caixa e sem pontuação, em sequências de 4 palavras (ou menos, se o trecho for curto). O PDF e o texto do grafo não têm
 * a mesma quebra de linha, a mesma pontuação nem os mesmos separadores de tabela, por isso a comparação é por palavras.
 */

const TAMANHO = 4;

/** As palavras de um texto, em minúsculas e sem acento (letras e números; o resto separa). */
export function palavras(texto: string): string[] {
  return texto.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
}

/** A primeira sequência de até 4 palavras do trecho: é o que o aceite da F8.4 exige que a página contenha. */
export function inicioDoTrecho(texto: string): string {
  return palavras(texto).slice(0, TAMANHO).join(' ');
}

/**
 * Quais itens de texto da página (na ordem do `textContent` do pdf.js) fazem parte do trecho. Devolve os índices, em ordem,
 * ou uma lista vazia se nenhuma sequência do trecho aparece na página.
 */
export function itensDoTrecho(trecho: string, itens: readonly string[]): number[] {
  const alvo = palavras(trecho);
  if (alvo.length === 0) return [];
  const n = Math.min(TAMANHO, alvo.length);

  const pagina: { palavra: string; item: number }[] = [];
  itens.forEach((s, item) => {
    for (const palavra of palavras(s)) pagina.push({ palavra, item });
  });
  const posicoes = new Map<string, number[]>();
  for (let j = 0; j + n <= pagina.length; j++) {
    const chave = pagina.slice(j, j + n).map((p) => p.palavra).join(' ');
    const lista = posicoes.get(chave);
    if (lista) lista.push(j);
    else posicoes.set(chave, [j]);
  }

  const cobertas = new Set<number>();
  for (let i = 0; i + n <= alvo.length; i++) {
    for (const j of posicoes.get(alvo.slice(i, i + n).join(' ')) ?? []) {
      for (let k = 0; k < n; k++) cobertas.add(j + k);
    }
  }
  const itensMarcados = new Set<number>();
  for (const j of cobertas) itensMarcados.add(pagina[j]!.item);
  return [...itensMarcados].sort((a, b) => a - b);
}
