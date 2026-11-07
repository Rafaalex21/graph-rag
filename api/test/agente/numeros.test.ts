/**
 * Testes dos números e das frases da resposta (F7.5), escritos antes do código. É a régua do aceite ("100% das afirmações
 * numéricas citadas"), então os erros dela decidem a medida. Modos de falha:
 *
 *  1. número sem citação por falso positivo: ano ("em 2025"), data (31/12/2025), numeração de lista ("1." no começo da
 *     linha) e o número da própria citação não são afirmação numérica;
 *  2. número escrito de outro jeito não contado: "1.234,56", "50,0%", "R$ 20,5 bilhões", "cinco" (dois a dez; "um/uma" é
 *     artigo e não conta);
 *  3. a frase quebrada no lugar errado: "S.A.", "p. 12", "R$ 1.234,5" e a citação depois do ponto final ("... 50%. [E1]")
 *     não podem separar o número da citação;
 *  4. o acerto numérico do Python (`indexer/metricas.py`) porta igual: tolerância de 0,5%, escala escrita ("16,8 bilhões")
 *     contra a unidade do gabarito ("R$ milhões"), sem escala vale na unidade do gabarito;
 *  5. número em formato inglês ("1,234.56") é achado, o brasileiro não.
 */
import { describe, expect, it } from "vitest";
import { acertoNumerico, declaracaoDeAusencia, dividirAfirmacoes, formatoNaoBrasileiro, numerosDoTexto, numeroTemLastro } from "../../src/agente/numeros.ts";

const valores = (t: string) => numerosDoTexto(t).map((n) => n.escalado);

describe("numerosDoTexto", () => {
  it.each([
    ["O lucro foi de R$ 20,5 bilhões.", [20.5e9]],
    ["Havia 1.234 agências e 56,7% da rede.", [1234, 56.7]],
    ["Total de R$ 16.782 milhões.", [16782e6]],
    ["São cinco segmentos e dois conselhos.", [5, 2]],
    ["Pagou 3 mil reais.", [3000]],
    ["Cresceu 12,34%.", [12.34]],
  ])("%s", (texto, esperado) => expect(valores(texto as string)).toEqual(esperado));

  it.each([
    ["Em 2025 o Banco cresceu.", []],
    ["Entre 1998 e 2024.", []],
    ["Em 31/12/2025 e 01/2026.", []],
    ["1. Primeiro item\n2) Segundo item", []],
    ["Há um acionista e uma regra.", []],
    ["Conforme [E12] e [E3][E4].", []],
  ])("não conta: %s", (texto, esperado) => expect(valores(texto as string)).toEqual(esperado));

  it("ano com % ou escala é número; ano com ponto de milhar também", () => {
    expect(valores("Foram 2025% do previsto.")).toEqual([2025]);
    expect(valores("Eram 2.025 agências.")).toEqual([2025]);
    expect(valores("Somou 1990 milhões.")).toEqual([1990e6]);
  });

  it("com incluirAnos (para o texto das evidências) o ano também é número", () => {
    expect(numerosDoTexto("Em 2025 houve 3 eventos.", { incluirAnos: true }).map((x) => x.escalado)).toEqual([2025, 3]);
  });

  it("guarda o texto, a escala e se havia escala", () => {
    const [n] = numerosDoTexto("Lucro de 20,5 bilhões.");
    expect(n).toMatchObject({ texto: "20,5 bilhões", escrito: 20.5, escalado: 20.5e9, comEscala: true });
  });
});

describe("dividirAfirmacoes", () => {
  it("separa por frase e por linha, e mantém a citação depois do ponto na frase do número", () => {
    const f = dividirAfirmacoes("O lucro foi de R$ 20 bilhões. [E1] A sede fica em Brasília. [E2]\n- Havia 3.900 agências [E3].");
    expect(f).toEqual(["O lucro foi de R$ 20 bilhões. [E1]", "A sede fica em Brasília. [E2]", "- Havia 3.900 agências [E3]."]);
  });

  it.each([
    ["A BB Seguridade Participações S.A. tem 50% [E1].", 1],
    ["Veja a p. 12 sobre 50% do capital [E1].", 1],
    ["O total foi de R$ 1.234,5 milhões [E1]. Outra frase sem número.", 2],
    ["Fim? Sim! Mais 3 itens [E2].", 3],
    // achado na medida do golden (F7.5): "Val." de "Títulos e Val. Mobiliários" separava a frase de sua citação
    ["Tem 100% da BB Gestão - Distribuidora de Títulos e Val. Mobiliários S.A. [E8].", 1],
    ["A Cia. Energética tem 50% [E1].", 1],
    ["A Alfa Ltda. Beta detém 10% [E1].", 1],
  ])("não quebra no lugar errado: %s", (texto, n) => expect(dividirAfirmacoes(texto as string)).toHaveLength(n as number));

  it("texto vazio e só espaços não geram frases", () => {
    expect(dividirAfirmacoes("")).toEqual([]);
    expect(dividirAfirmacoes("  \n \n")).toEqual([]);
  });
});

describe("declaracaoDeAusencia", () => {
  it.each([
    "Não encontrei nos trechos consultados a lista com 100% de participação.",
    "Essa informação não consta no documento.",
    "O documento não traz o total de 85,2 mil funcionários.",
    "- Não consta o valor de 50%.",
    "**Não encontrei** os 3 itens.",
  ])("é ausência: %s", (f) => expect(declaracaoDeAusencia(f)).toBe(true));

  it.each([
    "O Banco tem 50% do capital [E1].",
    "A União detém 50%; não há outros acionistas com mais de 10%.",
    "Havia 3.900 agências, não 4.100.",
    "O lucro foi de R$ 20 bilhões e não encontrei queda.",
  ])("não é: %s", (f) => expect(declaracaoDeAusencia(f)).toBe(false));
});

describe("formatoNaoBrasileiro", () => {
  it.each(["R$ 1,234.56 milhões", "1,234,567", "12.5%"])("acha %s", (t) => expect(formatoNaoBrasileiro(`Valor ${t}.`)).not.toEqual([]));
  it.each(["R$ 1.234,56 milhões", "12,5%", "1.234.567", "3,14", "2025"])("deixa %s", (t) => expect(formatoNaoBrasileiro(`Valor ${t}.`)).toEqual([]));
});

describe("acertoNumerico (porta de indexer/metricas.py)", () => {
  const caso = (valor: number, unidade: string) => ({ valor, unidade });
  it.each([
    ["O lucro foi de 16.782 milhões de reais.", caso(16782, "R$ milhões"), true],
    ["O lucro foi de R$ 16,8 bilhões.", caso(16782, "R$ milhões"), true], // 16,8 bi = 16.800 mi, 0,1% acima
    ["Somou 16.700 milhões.", caso(16782, "R$ milhões"), true],
    ["Somou 16.000.", caso(16782, "R$ milhões"), false],
    ["A participação é de 66,2%.", caso(66.2, "%"), true],
    ["Eram 5 segmentos.", caso(5, "segmentos"), true],
    ["São cinco segmentos.", caso(5, "segmentos"), true],
    ["Não há número.", caso(5, "segmentos"), false],
    ["Tinha 84,5 mil funcionários.", caso(84500, "funcionários"), true],
    ["Tinha 84,5 mil funcionários.", caso(84.5, "mil funcionários"), true],
  ])("%s", (texto, c, esperado) => expect(acertoNumerico(c as { valor: number; unidade: string }, texto as string)).toBe(esperado));
});

describe("numeroTemLastro", () => {
  const ev = (texto: string) => ({ texto });
  const n = (t: string) => numerosDoTexto(t)[0]!;

  it("acha o mesmo número escrito em outro formato", () => {
    expect(numeroTemLastro(n("Foram 50% do capital."), [ev("a União detém 50,0% do capital")])).toBe(true);
    expect(numeroTemLastro(n("Havia 3.900 agências."), [ev("contava com 3900 agências")])).toBe(true);
  });

  it("converte a escala escrita: 20,5 bilhões contra 20.500 milhões", () => {
    expect(numeroTemLastro(n("Lucro de R$ 20,5 bilhões."), [ev("lucro líquido de 20.500 milhões")])).toBe(true);
  });

  it("não aceita número que não está na evidência", () => {
    expect(numeroTemLastro(n("Havia 4.100 agências."), [ev("havia 3.900 agências")])).toBe(false);
    expect(numeroTemLastro(n("Havia 4.100 agências."), [])).toBe(false);
  });

  it("palavra de número casa com o algarismo e vice-versa", () => {
    expect(numeroTemLastro(n("São cinco segmentos."), [ev("os 5 segmentos divulgáveis")])).toBe(true);
    expect(numeroTemLastro(n("São 5 segmentos."), [ev("os cinco segmentos divulgáveis")])).toBe(true);
  });

  it("tolera 0,5% e não mais", () => {
    expect(numeroTemLastro(n("Foram 1.000 itens."), [ev("1.004 itens")])).toBe(true);
    expect(numeroTemLastro(n("Foram 1.000 itens."), [ev("1.010 itens")])).toBe(false);
  });
});
