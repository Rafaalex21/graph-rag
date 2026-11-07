/**
 * `npm run relatorio:telemetria [-- --dia AAAA-MM-DD] [--pasta <dir>] [--feedback <arquivo>] [--saida <dir>]`
 *
 * Lê `data/logs/telemetria/<dia>.jsonl` (e o `feedback.jsonl`, se existir) e grava `relatorio-<dia>.md` e `.json` ao lado.
 * Sem `--dia`, usa hoje (data local). Termina com código 1 se o log do dia não existe, para um agendador perceber.
 */
import { readFile, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { gerarRelatorio, lerRegistros, paraMarkdown } from "./relatorio.ts";
import { diaLocal } from "./registro.ts";

const RAIZ = fileURLToPath(new URL("../../../", import.meta.url));

function opcao(nome: string): string | undefined {
  const i = process.argv.indexOf(`--${nome}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function lerSeExiste(arquivo: string): Promise<string | null> {
  try {
    return await readFile(arquivo, "utf-8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw e;
  }
}

const dia = opcao("dia") ?? diaLocal(new Date().toISOString());
if (!/^\d{4}-\d{2}-\d{2}$/.test(dia)) {
  console.error(`--dia deve ser AAAA-MM-DD (recebi "${dia}")`);
  process.exit(2);
}
const pasta = opcao("pasta") ?? join(RAIZ, "data", "logs", "telemetria");
const arquivoFeedback = opcao("feedback") ?? join(RAIZ, "data", "logs", "feedback.jsonl");
const saida = opcao("saida") ?? pasta;

const texto = await lerSeExiste(join(pasta, `${dia}.jsonl`));
if (texto === null) {
  console.error(`Não há log de telemetria de ${dia} em ${pasta}.`);
  process.exit(1);
}
const { registros, invalidas } = lerRegistros(texto);
const feedback = await lerSeExiste(arquivoFeedback);
const relatorio = gerarRelatorio(registros, { dia, linhasInvalidas: invalidas, ...(feedback === null ? {} : { feedback }) });

await mkdir(saida, { recursive: true });
await writeFile(join(saida, `relatorio-${dia}.md`), paraMarkdown(relatorio), "utf-8");
await writeFile(join(saida, `relatorio-${dia}.json`), `${JSON.stringify(relatorio, null, 2)}\n`, "utf-8");
console.log(paraMarkdown(relatorio));
console.log(`Gravado em ${join(saida, `relatorio-${dia}.md`)} e .json`);
