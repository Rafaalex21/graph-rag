/**
 * `npm run relatorio:telemetria [-- --dia AAAA-MM-DD] [--pasta <dir>] [--feedback <arquivo>] [--saida <dir>]`
 *
 * Lê `data/logs/telemetria/<dia>.jsonl` (e o `feedback.jsonl`, se existir) e grava `relatorio-<dia>.md` e `.json` ao lado.
 * Sem `--dia`, usa hoje (data local). As notas do dia são ligadas às perguntas, inclusive às do dia anterior. Termina com
 * código 1 se o log do dia não existe, para um agendador perceber (a rotina diária, `cli-diaria.ts`, trata isso como normal).
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { gerarArquivosDoDia } from "./diaria.ts";
import { diaLocal } from "./registro.ts";
import { ehDia } from "./rotacao.ts";

const RAIZ = fileURLToPath(new URL("../../../", import.meta.url));

function opcao(nome: string): string | undefined {
  const i = process.argv.indexOf(`--${nome}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const dia = opcao("dia") ?? diaLocal(new Date().toISOString());
if (!ehDia(dia)) {
  console.error(`--dia deve ser AAAA-MM-DD, uma data que existe (recebi "${dia}")`);
  process.exit(2);
}
const pasta = opcao("pasta") ?? join(RAIZ, "data", "logs", "telemetria");
const feedback = opcao("feedback") ?? join(RAIZ, "data", "logs", "feedback.jsonl");
const saida = opcao("saida") ?? pasta;

const resultado = await gerarArquivosDoDia({ pasta, dia, feedback, saida });
if (resultado === "sem_log") {
  console.error(`Não há log de telemetria de ${dia} em ${pasta}.`);
  process.exit(1);
}
console.log(await readFile(join(saida, `relatorio-${dia}.md`), "utf-8"));
console.log(`Gravado em ${join(saida, `relatorio-${dia}.md`)} e .json`);
