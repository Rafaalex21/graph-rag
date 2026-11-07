/**
 * Testes do registrador de telemetria (F7.7), escritos antes do código. Modos de falha:
 *
 *  1. um registro por linha, no arquivo do DIA (data local), com a pasta criada na hora; linhas lidas de volta como JSON;
 *  2. gravações simultâneas não se misturam nem se perdem (50 de uma vez → 50 linhas inteiras);
 *  3. a virada do dia manda o registro para o arquivo do dia certo, não para o do primeiro registro;
 *  4. falha de gravação (disco, permissão, pasta que é arquivo) NUNCA derruba nem atrasa a resposta: o registrador não lança,
 *     avisa por `registrarErro` e segue gravando os próximos;
 *  5. o texto da pergunta não vai para o log por padrão (só tamanho e uma impressão digital); com a opção ligada, vai;
 *  6. `aguardar` espera o que ainda está na fila (para o desligamento da API não perder o último registro).
 */
import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { criarRegistrador, diaLocal, impressaoDaPergunta } from "../../src/telemetria/registro.ts";
import type { RegistroHttp } from "../../src/telemetria/tipos.ts";

const pasta = () => mkdtempSync(join(tmpdir(), "graphrag-telemetria-"));
const http = (ts: string, id = "r"): RegistroHttp => ({ v: 1, tipo: "http", ts, id, metodo: "GET", rota: "/api/saude", status: 200, ms: 3 });
const linhas = (arquivo: string) => readFileSync(arquivo, "utf-8").split("\n").filter(Boolean);

describe("criarRegistrador", () => {
  it("grava uma linha JSON por registro no arquivo do dia, criando a pasta", async () => {
    const dir = join(pasta(), "telemetria", "sub");
    const r = criarRegistrador({ pasta: dir });
    r.registrar(http("2026-11-07T15:00:00.000Z", "a"));
    r.registrar(http("2026-11-07T15:00:01.000Z", "b"));
    await r.aguardar();
    const arquivos = readdirSync(dir);
    expect(arquivos).toHaveLength(1);
    expect(arquivos[0]).toMatch(/^\d{4}-\d{2}-\d{2}\.jsonl$/);
    const l = linhas(join(dir, arquivos[0] as string));
    expect(l.map((x) => JSON.parse(x).id)).toEqual(["a", "b"]);
  });

  it("50 gravações ao mesmo tempo viram 50 linhas inteiras, na ordem em que foram pedidas", async () => {
    const dir = pasta();
    const r = criarRegistrador({ pasta: dir });
    for (let i = 0; i < 50; i++) r.registrar({ ...http("2026-11-07T15:00:00.000Z", `r${i}`), ms: i });
    await r.aguardar();
    const l = linhas(join(dir, readdirSync(dir)[0] as string));
    expect(l).toHaveLength(50);
    expect(l.map((x) => JSON.parse(x).id)).toEqual(Array.from({ length: 50 }, (_, i) => `r${i}`));
  });

  it("a virada do dia vai para o arquivo do dia do registro", async () => {
    const dir = pasta();
    const r = criarRegistrador({ pasta: dir });
    const antes = new Date(2026, 10, 7, 23, 59, 59); // data local
    const depois = new Date(2026, 10, 8, 0, 0, 1);
    r.registrar(http(antes.toISOString(), "ontem"));
    r.registrar(http(depois.toISOString(), "hoje"));
    await r.aguardar();
    expect(readdirSync(dir).sort()).toEqual(["2026-11-07.jsonl", "2026-11-08.jsonl"]);
    expect(JSON.parse(linhas(join(dir, "2026-11-08.jsonl"))[0] as string).id).toBe("hoje");
  });

  it("diaLocal usa a data local, não a UTC (23h no Brasil ainda é o mesmo dia)", () => {
    expect(diaLocal(new Date(2026, 10, 7, 23, 30).toISOString())).toBe("2026-11-07");
    expect(diaLocal(new Date(2026, 0, 2, 0, 5).toISOString())).toBe("2026-01-02");
  });

  it("falha de gravação não lança, avisa, e os registros seguintes ainda são gravados", async () => {
    const base = pasta();
    const arquivoNoLugarDaPasta = join(base, "ocupado");
    writeFileSync(arquivoNoLugarDaPasta, "x");
    const erros: string[] = [];
    const r = criarRegistrador({ pasta: join(arquivoNoLugarDaPasta, "dentro"), registrarErro: (c, e) => erros.push(`${c}:${e instanceof Error ? e.name : e}`) });
    expect(() => r.registrar(http("2026-11-07T15:00:00.000Z"))).not.toThrow();
    await expect(r.aguardar()).resolves.toBeUndefined();
    expect(erros).toHaveLength(1);
    expect(erros[0]).toContain("telemetria");
  });

  it("depois de uma falha, a próxima gravação funciona (a fila não fica presa no erro)", async () => {
    const dir = pasta();
    let falhar = true;
    const r = criarRegistrador({
      pasta: dir,
      acrescentar: async (arquivo, texto) => {
        if (falhar) throw new Error("disco cheio");
        const { appendFile } = await import("node:fs/promises");
        await appendFile(arquivo, texto);
      },
      registrarErro: () => {},
    });
    r.registrar(http("2026-11-07T15:00:00.000Z", "perdido"));
    await r.aguardar();
    falhar = false;
    r.registrar(http("2026-11-07T15:00:01.000Z", "ok"));
    await r.aguardar();
    expect(linhas(join(dir, readdirSync(dir)[0] as string)).map((x) => JSON.parse(x).id)).toEqual(["ok"]);
  });

  it("registrar volta na hora, mesmo com a gravação lenta (não atrasa a resposta)", async () => {
    const r = criarRegistrador({ pasta: pasta(), acrescentar: () => new Promise((ok) => setTimeout(ok, 300)) });
    const t0 = performance.now();
    r.registrar(http("2026-11-07T15:00:00.000Z"));
    expect(performance.now() - t0).toBeLessThan(50);
    await r.aguardar();
  });
});

describe("impressaoDaPergunta", () => {
  it("guarda o tamanho e uma impressão digital estável; o texto só se a opção estiver ligada", () => {
    const p = impressaoDaPergunta("Qual foi o lucro líquido de 2025?", false);
    expect(p.caracteres).toBe(33);
    expect(p.hash).toMatch(/^[0-9a-f]{16}$/);
    expect(p).not.toHaveProperty("texto");
    expect(impressaoDaPergunta("Qual foi o lucro líquido de 2025?", false).hash).toBe(p.hash);
    expect(impressaoDaPergunta("outra", false).hash).not.toBe(p.hash);
    expect(impressaoDaPergunta("Qual foi o lucro líquido de 2025?", true).texto).toBe("Qual foi o lucro líquido de 2025?");
  });

  it("a mesma pergunta com espaços e maiúsculas diferentes tem a mesma impressão (para contar repetidas)", () => {
    expect(impressaoDaPergunta("  Qual o LUCRO?  ", false).hash).toBe(impressaoDaPergunta("qual o lucro?", false).hash);
  });
});
