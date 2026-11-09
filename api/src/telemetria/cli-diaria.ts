/**
 * `npm run telemetria:diaria [-- --hoje AAAA-MM-DD] [--dias 30] [--pasta <dir>] [--feedback <arquivo>] [--saida <dir>] [--simular]`
 *
 * A rotina que o agendador roda uma vez por dia (via `infra/relatorio-diario.ps1`): gera o relatório do dia anterior e remove
 * os logs com mais de N dias (padrão 30), sempre com o relatório do dia em mãos. Sem log de ontem não é erro. Código de saída:
 * 0 tudo certo, 1 algum erro (relatório que não saiu, log que não pôde ser apagado), 2 argumento inválido.
 */
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { rodarDiaria } from "./diaria.ts";
import { diaLocal } from "./registro.ts";

const RAIZ = fileURLToPath(new URL("../../../", import.meta.url));

function opcao(nome: string): string | undefined {
  const i = process.argv.indexOf(`--${nome}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const hoje = opcao("hoje") ?? diaLocal(new Date().toISOString());
const dias = opcao("dias") === undefined ? 30 : Number(opcao("dias"));
const pasta = opcao("pasta") ?? join(RAIZ, "data", "logs", "telemetria");
const feedback = opcao("feedback") ?? join(RAIZ, "data", "logs", "feedback.jsonl");
const saida = opcao("saida");
const simular = process.argv.includes("--simular");

try {
  const r = await rodarDiaria({ pasta, hoje, dias, feedback, simular, ...(saida ? { saida } : {}) });
  const quando = simular ? "[simulação] " : "";
  console.log(`${quando}Relatório de ${r.dia}: ${r.relatorio === "gerado" ? "gerado" : r.relatorio === "sem_log" ? "sem log nesse dia (nada a fazer)" : "FALHOU"}`);
  console.log(`${quando}Logs com mais de ${dias} dias ${simular ? "que seriam removidos" : "removidos"}: ${r.removidos.length === 0 ? "nenhum" : r.removidos.join(", ")}`);
  if (r.mantidos_sem_relatorio.length > 0) console.log(`Mantidos por falta de relatório: ${r.mantidos_sem_relatorio.join(", ")}`);
  for (const e of r.erros) console.error(`ERRO: ${e}`);
  process.exitCode = r.erros.length > 0 ? 1 : 0;
} catch (e) {
  console.error(`Argumento inválido: ${e instanceof Error ? e.message : String(e)}`);
  process.exitCode = 2;
}
