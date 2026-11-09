/**
 * Os arquivos do pacote Office (F8.10): `.xlsx` (exceljs), `.docx` (docx) e `.pptx` (pptxgenjs), todos escritos por código a
 * partir do `Material` já verificado. O modelo nunca escreve arquivo nem código. O `.xlsx` e o `.docx` levam a tabela (as duas
 * bibliotecas não desenham gráfico nativo); o `.pptx` leva o gráfico nativo e a tabela. Sem fórmulas, macros nem links.
 */
import { AlignmentType, Document, HeadingLevel, Packer, Paragraph, Table, TableCell, TableRow, TextRun, WidthType } from "docx";
import ExcelJS from "exceljs";
import PptxGenJSImportado from "pptxgenjs";
import type { Material } from "./especificacao.ts";

// o pacote é CommonJS (`module.exports` é a própria classe) mas os tipos dizem `export default`: sob NodeNext o tipo do
// import de valor é o do namespace, então a classe é reafirmada com o tipo que o `.d.ts` declara
// eslint-disable-next-line @typescript-eslint/consistent-type-imports
type ClassePptx = (typeof import("pptxgenjs"))["default"];
const PptxGenJS = PptxGenJSImportado as unknown as ClassePptx;
type Slide = ReturnType<InstanceType<ClassePptx>["addSlide"]>;

const FONTE = "Fonte: Formulário de Referência (CVM)";
const colunas = (m: Material) => [m.colunaRotulo, m.unidade === "" ? "Valor" : `Valor (${m.unidade})`, "Fonte"];

export async function gerarXlsx(m: Material): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  wb.creator = "Assistente GraphRAG";
  const ws = wb.addWorksheet("Dados");
  ws.addRow([m.titulo]).font = { bold: true, size: 14 };
  ws.addRow([FONTE]).font = { italic: true, color: { argb: "FF4A5A57" } };
  ws.addRow([]);
  const cab = ws.addRow(colunas(m));
  cab.font = { bold: true, color: { argb: "FFFFFFFF" } };
  cab.eachCell((c) => {
    c.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF0B6B5C" } };
  });
  for (const p of m.pontos) ws.addRow([p.rotulo, p.valor, p.pagina]);
  ws.getColumn(1).width = 28;
  ws.getColumn(2).width = Math.max(18, colunas(m)[1]!.length + 2);
  ws.getColumn(3).width = 14;
  ws.getColumn(2).numFmt = "#,##0.##";
  ws.getColumn(2).alignment = { horizontal: "right" };
  ws.getCell("B4").alignment = { horizontal: "right" };
  const buf = await wb.xlsx.writeBuffer();
  return Buffer.from(buf);
}

const celula = (texto: string, opcoes: { negrito?: boolean; direita?: boolean } = {}) =>
  new TableCell({
    children: [new Paragraph({ alignment: opcoes.direita ? AlignmentType.RIGHT : AlignmentType.LEFT, children: [new TextRun({ text: texto, bold: opcoes.negrito ?? false })] })],
  });

export async function gerarDocx(m: Material): Promise<Buffer> {
  const c = colunas(m);
  const tabela = new Table({
    width: { size: 100, type: WidthType.PERCENTAGE },
    rows: [
      new TableRow({ tableHeader: true, children: c.map((t, i) => celula(t, { negrito: true, direita: i === 1 })) }),
      ...m.pontos.map((p) => new TableRow({ children: [celula(p.rotulo), celula(p.escrito, { direita: true }), celula(p.pagina)] })),
    ],
  });
  const doc = new Document({
    creator: "Assistente GraphRAG",
    title: m.titulo,
    sections: [
      {
        children: [
          new Paragraph({ heading: HeadingLevel.HEADING_1, children: [new TextRun(m.titulo)] }),
          ...(m.unidade === "" ? [] : [new Paragraph({ children: [new TextRun({ text: `Unidade: ${m.unidade}`, italics: true })] })]),
          new Paragraph({ children: [] }),
          tabela,
          new Paragraph({ children: [] }),
          new Paragraph({ children: [new TextRun({ text: FONTE, italics: true, size: 18 })] }),
        ],
      },
    ],
  });
  return Packer.toBuffer(doc);
}

export async function gerarPptx(m: Material): Promise<Buffer> {
  const p = new PptxGenJS();
  p.layout = "LAYOUT_WIDE";
  p.author = "Assistente GraphRAG";
  p.title = m.titulo;
  const nota = (s: Slide) => s.addText(`${FONTE}, ${[...new Set(m.pontos.map((x) => x.pagina))].join(", ")}`, { x: 0.5, y: 7, w: 12.3, h: 0.3, fontSize: 10, color: "4A5A57" });

  const s1 = p.addSlide();
  s1.addText(m.titulo, { x: 0.5, y: 0.3, w: 12.3, h: 0.8, fontSize: 28, bold: true, color: "1B2B28" });
  if (m.unidade !== "") s1.addText(m.unidade, { x: 0.5, y: 1.05, w: 12.3, h: 0.4, fontSize: 14, color: "4A5A57" });
  s1.addChart(m.grafico === "barras" ? p.ChartType.bar : p.ChartType.line, [{ name: m.titulo, labels: m.pontos.map((x) => x.rotulo), values: m.pontos.map((x) => x.valor) }], {
    x: 0.5,
    y: 1.6,
    w: 12.3,
    h: 5.2,
    chartColors: ["0B6B5C"],
    showValue: true,
    dataLabelFontSize: 12,
    catAxisLabelFontSize: 12,
    valAxisLabelFontSize: 11,
    showLegend: false,
  });
  nota(s1);

  const s2 = p.addSlide();
  s2.addText(m.titulo, { x: 0.5, y: 0.3, w: 12.3, h: 0.8, fontSize: 24, bold: true, color: "1B2B28" });
  const cab = colunas(m).map((t) => ({ text: t, options: { bold: true, color: "FFFFFF", fill: { color: "0B6B5C" } } }));
  s2.addTable([cab, ...m.pontos.map((x) => [{ text: x.rotulo }, { text: x.escrito, options: { align: "right" as const } }, { text: x.pagina }])], { x: 0.5, y: 1.4, w: 12.3, fontSize: 14, border: { type: "solid", color: "D7DFDD", pt: 1 } });
  nota(s2);

  const saida = await p.write({ outputType: "nodebuffer" });
  return Buffer.from(saida as Uint8Array);
}
