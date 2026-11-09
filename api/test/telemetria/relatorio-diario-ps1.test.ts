/**
 * O script `infra/relatorio-diario.ps1` de ponta a ponta (F7.14): chama o PowerShell de verdade, com uma pasta de logs de
 * datas diferentes, e confere o que sobrou. Só roda no Windows e com o Node portátil de `infra/bin` (o CI do GitHub é Linux
 * e pula). Modos de falha: o script não achar o Node, não repassar os argumentos, devolver código 0 com erro, apagar o que
 * não é log, ou apagar no modo `-Simular`.
 */
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const RAIZ = fileURLToPath(new URL("../../../", import.meta.url));
const SCRIPT = join(RAIZ, "infra", "relatorio-diario.ps1");
const NODE_PORTATIL = join(RAIZ, "infra", "bin", "node-v24.22.1-win-x64");
const pode = process.platform === "win32" && existsSync(NODE_PORTATIL);

const linha = (id: string, dia: string) =>
  JSON.stringify({
    v: 1, tipo: "http", ts: `${dia}T15:00:00.000Z`, id, metodo: "GET", rota: "/api/saude", status: 200, ms: 5,
  }) + "\n"; // prettier-ignore

let pasta: string;
let log: string;
beforeEach(async () => {
  pasta = await mkdtemp(join(tmpdir(), "relatorio-diario-"));
  log = join(pasta, "saida", "diaria.log");
});
afterEach(async () => {
  await rm(pasta, { recursive: true, force: true });
});

function rodar(...extra: string[]) {
  return spawnSync("powershell", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", SCRIPT, "-Hoje", "2026-11-07", "-Pasta", pasta, "-Feedback", join(pasta, "nao-existe.jsonl"), "-Log", log, ...extra], { encoding: "utf-8", timeout: 60_000 });
}
const nomes = async () => (await readdir(pasta)).filter((n) => n !== "saida").sort();

describe.skipIf(!pode)("infra/relatorio-diario.ps1", () => {
  beforeEach(async () => {
    for (const d of ["2026-08-15", "2026-10-07", "2026-10-08", "2026-11-06", "2026-11-07"]) await writeFile(join(pasta, `${d}.jsonl`), linha(`h-${d}`, d));
    await writeFile(join(pasta, "feedback.jsonl"), "");
    await writeFile(join(pasta, "2026-10-01.jsonl.bak"), "nao e log");
  });

  it("gera o relatório de ontem, remove só os logs com mais de 30 dias e sai com 0", async () => {
    const r = rodar();
    expect(r.status, r.stdout + r.stderr).toBe(0);
    expect(r.stdout).toContain("Relatório de 2026-11-06: gerado");
    expect(await nomes()).toEqual([
      "2026-10-01.jsonl.bak", "2026-10-08.jsonl", "2026-11-06.jsonl", "2026-11-07.jsonl", "feedback.jsonl",
      "relatorio-2026-08-15.json", "relatorio-2026-08-15.md", "relatorio-2026-10-07.json", "relatorio-2026-10-07.md", "relatorio-2026-11-06.json", "relatorio-2026-11-06.md",
    ]); // prettier-ignore
    expect(await readFile(log, "utf-8")).toContain("código 0");
  });

  it("-Dias 90 mantém o log de agosto", async () => {
    const r = rodar("-Dias", "90");
    expect(r.status, r.stdout + r.stderr).toBe(0);
    expect(await nomes()).toContain("2026-08-15.jsonl");
    expect(await nomes()).not.toContain("relatorio-2026-08-15.md");
  });

  it("-Simular não grava nem apaga", async () => {
    const antes = await nomes();
    const r = rodar("-Simular");
    expect(r.status, r.stdout + r.stderr).toBe(0);
    expect(r.stdout).toContain("[simulação]");
    expect(await nomes()).toEqual(antes);
  });

  it("-Dias 0 é recusado pelo PowerShell antes de qualquer coisa", async () => {
    const antes = await nomes();
    const r = rodar("-Dias", "0");
    expect(r.status).not.toBe(0);
    expect(await nomes()).toEqual(antes);
  });

  it("data de hoje inválida: código 2 e nada apagado", async () => {
    const antes = await nomes();
    const r = spawnSync("powershell", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", SCRIPT, "-Hoje", "2026-02-31", "-Pasta", pasta, "-Log", log], { encoding: "utf-8", timeout: 60_000 });
    expect(r.status).toBe(2);
    expect(await nomes()).toEqual(antes);
  });
});
