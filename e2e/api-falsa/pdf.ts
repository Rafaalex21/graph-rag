/**
 * Um PDF de teste feito à mão (sem biblioteca): 12 páginas com texto conhecido, fonte padrão Helvetica, só ASCII. Serve ao
 * visualizador de fonte (F8.4) nos testes E2E da interface, sem precisar do documento real (que não vai para o git, ADR-009).
 */

export const PAGINAS = 12;

/** O texto de cada página, uma linha por item. As páginas 6, 9 e 10 têm o que os trechos de `fonte` citam. */
export function linhasDaPagina(n: number): string[] {
  const base = [`Documento de teste - pagina ${n} de ${PAGINAS}`, `Marcador unico da pagina ${n}: MARC${n}X`];
  if (n === 6) return [...base, "O lucro liquido ajustado foi de vinte bilhoes de reais em dois mil e vinte e cinco.", "Esta frase nao e citada por nenhuma fonte de teste."];
  if (n === 9) return [...base, "Ano Lucro", "2024 trinta e sete", "2025 vinte"];
  if (n === 10) return [...base, "continuacao da tabela de lucro por ano"];
  return [...base, `Texto de enchimento da pagina ${n} sem nenhuma relacao com as fontes.`];
}

const escapar = (t: string) => t.replace(/\\/g, "\\\\").replace(/\(/g, "\\(").replace(/\)/g, "\\)");

export function montarPdf(): Buffer {
  const objetos: string[] = [];
  const adicionar = (corpo: string): number => objetos.push(corpo);
  adicionar("<< /Type /Catalog /Pages 2 0 R >>"); // 1
  adicionar(`<< /Type /Pages /Kids [${Array.from({ length: PAGINAS }, (_, i) => `${4 + i * 2} 0 R`).join(" ")}] /Count ${PAGINAS} >>`); // 2
  adicionar("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>"); // 3
  for (let n = 1; n <= PAGINAS; n++) {
    const conteudo = `BT /F1 14 Tf 50 740 Td 22 TL ${linhasDaPagina(n)
      .map((l) => `(${escapar(l)}) Tj T*`)
      .join(" ")} ET`;
    adicionar(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents ${5 + (n - 1) * 2} 0 R >>`);
    adicionar(`<< /Length ${conteudo.length} >>\nstream\n${conteudo}\nendstream`);
  }
  let saida = "%PDF-1.4\n";
  const posicoes: number[] = [];
  objetos.forEach((o, i) => {
    posicoes.push(saida.length);
    saida += `${i + 1} 0 obj\n${o}\nendobj\n`;
  });
  const xref = saida.length;
  saida += `xref\n0 ${objetos.length + 1}\n0000000000 65535 f \n${posicoes.map((p) => `${String(p).padStart(10, "0")} 00000 n \n`).join("")}`;
  saida += `trailer\n<< /Size ${objetos.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(saida, "latin1");
}
