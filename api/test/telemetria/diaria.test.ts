/**
 * Testes da rotina diária da telemetria (F7.14), escritos antes do código: o relatório do dia anterior e a remoção dos logs
 * com mais de N dias. Apagar arquivo é irreversível, então os modos de falha são sobretudo de apagar demais ou de apagar
 * antes da hora. Modos de falha:
 *
 *  1. idade: "mais de N dias" é maior que N (com N = 30, o log de 30 dias fica e o de 31 sai), contada em dias de calendário
 *     (virada de mês e de ano, ano bissexto), nunca em horas nem pelo `mtime` do arquivo;
 *  2. só apaga o que é log de telemetria: `AAAA-MM-DD.jsonl` com data válida. Fica o que parece mas não é (`feedback.jsonl`,
 *     `2026-13-45.jsonl`, `2026-10-01.jsonl.bak`, `relatorio-*.md`/`.json`, pasta com nome de log, arquivo sem extensão);
 *  3. N inválido (0, negativo, fracionário, NaN, texto) e data de hoje inválida param antes de apagar qualquer coisa;
 *  4. log com data no futuro (relógio errado) não é apagado;
 *  5. nunca apaga o log sem antes ter o relatório daquele dia: se falta, gera; se não consegue gerar, o log fica e o erro
 *     é dito (nenhum dado perdido sem resumo);
 *  6. sem log de ontem (API não usada, PC desligado) não é erro: segue e ainda faz a limpeza; pasta que não existe, idem;
 *  7. rodar duas vezes seguidas dá o mesmo resultado (idempotente) e o relatório de ontem é regravado sem acumular;
 *  8. `simular` só diz o que faria, sem gravar nem apagar nada;
 *  9. um arquivo que não dá para apagar não impede de apagar os outros; o erro volta no resultado;
 * 10. o relatório de ontem leva as notas ligadas, inclusive de uma pergunta feita anteontem.
 */
import { mkdtemp, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { diaAnterior, diaDoLog, diasEntre, logsExpirados } from "../../src/telemetria/rotacao.ts";
import { gerarArquivosDoDia, rodarDiaria } from "../../src/telemetria/diaria.ts";

const registro = (id: string, ts: string, extra: Record<string, unknown> = {}) =>
  JSON.stringify({
    v: 1, tipo: "chat", ts, id, conversationId: "c", resultado: "fim", codigo: null,
    pergunta: { caracteres: 10, hash: "0123456789abcdef" }, estado: "suficiente", rodadas: 1,
    ferramentas: [{ nome: "buscar_trechos", chamadas: 1, erros: 0, evidencias: 3, ms: 500 }], evidencias: 3, anotacoes: {},
    tokens: { entrada: 100, saida: 10 }, redator: { modo: "llm", reparos: 0, cortada: false, fallback: null },
    latencia_ms: { total: 9000, primeiro_evento: 2, primeiro_token: 5000, atualizar: 1, rotear: 1, executar: 1, criticar: 1, redator: 1 },
    ...extra,
  } as unknown) + "\n"; // prettier-ignore

let pasta: string;
beforeEach(async () => {
  pasta = await mkdtemp(join(tmpdir(), "telemetria-"));
});
afterEach(async () => {
  await rm(pasta, { recursive: true, force: true });
});
const log = (dia: string, id = `id-${dia}`) => writeFile(join(pasta, `${dia}.jsonl`), registro(id, `${dia}T15:00:00.000Z`));
const nomes = async () => (await readdir(pasta)).sort();

describe("datas de calendário", () => {
  it("diaDoLog só aceita AAAA-MM-DD.jsonl com data que existe", () => {
    expect(diaDoLog("2026-11-07.jsonl")).toBe("2026-11-07");
    expect(diaDoLog("2028-02-29.jsonl")).toBe("2028-02-29");
    for (const ruim of ["2026-02-29.jsonl", "2026-13-01.jsonl", "2026-00-10.jsonl", "2026-11-31.jsonl", "2026-11-07.jsonl.bak", "feedback.jsonl", "relatorio-2026-11-07.json", "2026-11-07", "x2026-11-07.jsonl", "2026-1-7.jsonl", ""]) {
      expect(diaDoLog(ruim), ruim).toBeNull();
    }
  });

  it.each([
    ["2026-11-07", "2026-11-07", 0],
    ["2026-11-06", "2026-11-07", 1],
    ["2026-10-08", "2026-11-07", 30],
    ["2025-12-31", "2026-01-01", 1], // virada de ano
    ["2028-02-28", "2028-03-01", 2], // ano bissexto
    ["2026-02-28", "2026-03-01", 1],
    ["2026-11-08", "2026-11-07", -1], // futuro
  ])("diasEntre(%s, %s) = %i", (de, ate, esperado) => expect(diasEntre(de, ate)).toBe(esperado));

  it("diaAnterior atravessa mês, ano e fevereiro bissexto", () => {
    expect(diaAnterior("2026-11-07")).toBe("2026-11-06");
    expect(diaAnterior("2026-03-01")).toBe("2026-02-28");
    expect(diaAnterior("2028-03-01")).toBe("2028-02-29");
    expect(diaAnterior("2026-01-01")).toBe("2025-12-31");
  });
});

describe("logsExpirados", () => {
  const hoje = "2026-11-07";
  it("mais de N dias: 30 fica, 31 sai", () => {
    expect(logsExpirados(["2026-10-08.jsonl", "2026-10-07.jsonl", "2026-11-07.jsonl", "2026-11-06.jsonl"], hoje, 30)).toEqual(["2026-10-07.jsonl"]);
  });

  it("ignora o que não é log de telemetria", () => {
    const quase = ["feedback.jsonl", "2026-01-01.jsonl.bak", "2026-13-45.jsonl", "relatorio-2026-01-01.md", "relatorio-2026-01-01.json", "notas.txt", "2026-01-01"];
    expect(logsExpirados([...quase, "2026-01-01.jsonl"], hoje, 30)).toEqual(["2026-01-01.jsonl"]);
  });

  it("log do futuro não sai", () => expect(logsExpirados(["2027-01-01.jsonl", "2026-11-08.jsonl"], hoje, 30)).toEqual([]));

  it("N = 1: só fica hoje e ontem", () => {
    expect(logsExpirados(["2026-11-07.jsonl", "2026-11-06.jsonl", "2026-11-05.jsonl"], hoje, 1)).toEqual(["2026-11-05.jsonl"]);
  });

  it.each([0, -3, 1.5, Number.NaN, Number.POSITIVE_INFINITY])("N = %s é recusado", (n) => {
    expect(() => logsExpirados(["2020-01-01.jsonl"], hoje, n)).toThrow(/dias/);
  });

  it.each(["", "07/11/2026", "2026-13-01", "2026-11-7"])("hoje inválido %j é recusado", (h) => {
    expect(() => logsExpirados(["2020-01-01.jsonl"], h, 30)).toThrow(/hoje/);
  });
});

describe("gerarArquivosDoDia", () => {
  it("grava o .md e o .json do dia e diz que gerou", async () => {
    await log("2026-11-06");
    expect(await gerarArquivosDoDia({ pasta, dia: "2026-11-06" })).toBe("gerado");
    expect(await nomes()).toEqual(["2026-11-06.jsonl", "relatorio-2026-11-06.json", "relatorio-2026-11-06.md"]);
    expect(await readFile(join(pasta, "relatorio-2026-11-06.md"), "utf-8")).toContain("# Telemetria de 2026-11-06");
  });

  it("sem log do dia: devolve sem_log e não cria arquivo nenhum", async () => {
    expect(await gerarArquivosDoDia({ pasta, dia: "2026-11-06" })).toBe("sem_log");
    expect(await nomes()).toEqual([]);
  });

  it("pasta que não existe: sem_log, sem criar a pasta", async () => {
    expect(await gerarArquivosDoDia({ pasta: join(pasta, "nao-existe"), dia: "2026-11-06" })).toBe("sem_log");
    expect(await nomes()).toEqual([]);
  });

  it("liga a nota de hoje à pergunta de anteontem lendo o log do dia anterior ao relatório", async () => {
    await log("2026-11-05", "antiga");
    await log("2026-11-06", "recente");
    const feedback = join(pasta, "feedback.jsonl");
    await writeFile(feedback, JSON.stringify({ ts: "2026-11-06T18:00:00.000Z", mensagemId: "antiga", nota: -1, comentario: "errou" }) + "\n");
    await gerarArquivosDoDia({ pasta, dia: "2026-11-06", feedback });
    const rel = JSON.parse(await readFile(join(pasta, "relatorio-2026-11-06.json"), "utf-8")) as { feedback: { notas: { registro: unknown }[] } };
    expect(rel.feedback.notas[0]?.registro).not.toBeNull();
  });
});

describe("rodarDiaria", () => {
  const hoje = "2026-11-07";

  it("gera o relatório de ontem e remove só os logs com mais de 30 dias", async () => {
    for (const d of ["2026-09-01", "2026-10-07", "2026-10-08", "2026-11-06", "2026-11-07"]) await log(d);
    await writeFile(join(pasta, "feedback.jsonl"), "");
    await writeFile(join(pasta, "relatorio-2026-09-01.md"), "velho");
    const r = await rodarDiaria({ pasta, hoje, dias: 30 });
    expect(r).toMatchObject({ dia: "2026-11-06", relatorio: "gerado", erros: [] });
    expect(r.removidos.sort()).toEqual(["2026-09-01.jsonl", "2026-10-07.jsonl"]);
    expect(await nomes()).toEqual([
      "2026-10-08.jsonl", "2026-11-06.jsonl", "2026-11-07.jsonl", "feedback.jsonl",
      "relatorio-2026-09-01.json", "relatorio-2026-09-01.md", "relatorio-2026-10-07.json", "relatorio-2026-10-07.md", "relatorio-2026-11-06.json", "relatorio-2026-11-06.md",
    ]); // prettier-ignore
  });

  it("gera o relatório que faltava antes de apagar o log vencido (o resumo fica)", async () => {
    await log("2026-09-01");
    const r = await rodarDiaria({ pasta, hoje, dias: 30 });
    expect(r.removidos).toEqual(["2026-09-01.jsonl"]);
    expect(await nomes()).toContain("relatorio-2026-09-01.json");
  });

  it("não apaga o log vencido se não consegue gerar o relatório dele", async () => {
    await mkdir(join(pasta, "relatorio-2026-09-01.json")); // um diretório no lugar do arquivo: a gravação falha
    await log("2026-09-01");
    const r = await rodarDiaria({ pasta, hoje, dias: 30 });
    expect(r.removidos).toEqual([]);
    expect(r.mantidos_sem_relatorio).toEqual(["2026-09-01.jsonl"]);
    expect(r.erros.join(" ")).toContain("2026-09-01");
    expect(await nomes()).toContain("2026-09-01.jsonl");
  });

  it("sem log de ontem não é erro e a limpeza acontece", async () => {
    await log("2026-09-01");
    await log("2026-11-07");
    const r = await rodarDiaria({ pasta, hoje, dias: 30 });
    expect(r).toMatchObject({ dia: "2026-11-06", relatorio: "sem_log", erros: [] });
    expect(r.removidos).toEqual(["2026-09-01.jsonl"]);
  });

  it("pasta que não existe: nada a fazer, sem erro e sem criar a pasta", async () => {
    const fantasma = join(pasta, "nada");
    const r = await rodarDiaria({ pasta: fantasma, hoje, dias: 30 });
    expect(r).toMatchObject({ relatorio: "sem_log", removidos: [], erros: [] });
    expect(await nomes()).toEqual([]);
  });

  it("é idempotente: a segunda rodada não remove nem muda nada além de regravar o relatório de ontem", async () => {
    for (const d of ["2026-09-01", "2026-11-06"]) await log(d);
    await rodarDiaria({ pasta, hoje, dias: 30 });
    const antes = await nomes();
    const md = await readFile(join(pasta, "relatorio-2026-11-06.md"), "utf-8");
    const r2 = await rodarDiaria({ pasta, hoje, dias: 30 });
    expect(r2.removidos).toEqual([]);
    expect(await nomes()).toEqual(antes);
    expect(await readFile(join(pasta, "relatorio-2026-11-06.md"), "utf-8")).toBe(md);
  });

  it("simular não grava nem apaga e diz o que faria", async () => {
    for (const d of ["2026-09-01", "2026-11-06"]) await log(d);
    const r = await rodarDiaria({ pasta, hoje, dias: 30, simular: true });
    expect(r.removidos).toEqual(["2026-09-01.jsonl"]);
    expect(r.simulado).toBe(true);
    expect(await nomes()).toEqual(["2026-09-01.jsonl", "2026-11-06.jsonl"]);
  });

  it("N inválido ou hoje inválido: lança antes de tocar em qualquer arquivo", async () => {
    await log("2020-01-01");
    await expect(rodarDiaria({ pasta, hoje, dias: 0 })).rejects.toThrow(/dias/);
    await expect(rodarDiaria({ pasta, hoje: "ontem", dias: 30 })).rejects.toThrow(/hoje/);
    expect(await nomes()).toEqual(["2020-01-01.jsonl"]);
  });

  it("um log que não dá para apagar não impede de apagar os outros; o erro volta no resultado", async () => {
    await mkdir(join(pasta, "2026-08-01.jsonl")); // diretório com nome de log: ignorado, não é arquivo
    await log("2026-09-01");
    await log("2026-09-02");
    const r = await rodarDiaria({ pasta, hoje, dias: 30, apagar: async (arquivo) => {
      if (arquivo.endsWith("2026-09-01.jsonl")) throw new Error("em uso");
      await rm(arquivo);
    } }); // prettier-ignore
    expect(r.removidos).toEqual(["2026-09-02.jsonl"]);
    expect(r.erros.join(" ")).toMatch(/2026-09-01.*em uso/);
    expect(await nomes()).toContain("2026-09-01.jsonl");
    expect(await nomes()).toContain("2026-08-01.jsonl"); // o diretório ficou
  });
});
