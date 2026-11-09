/**
 * A rotina diária da telemetria (F7.14): gera o relatório de ontem e remove os logs com mais de N dias. Apagar é irreversível,
 * então: só `AAAA-MM-DD.jsonl` de data válida (`rotacao.ts`), nunca antes de existir o relatório daquele dia (se falta, é
 * gerado agora; se não dá para gerar, o log fica e o erro é dito), e os relatórios (`relatorio-*.md`/`.json`, pequenos) e o
 * `feedback.jsonl` nunca são tocados. Sem log de ontem (API não usada) ou sem pasta não é erro.
 */
import { mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { gerarRelatorio, lerRegistros, paraMarkdown } from "./relatorio.ts";
import { diaAnterior, diaDoLog, logsExpirados, validarDias, validarHoje } from "./rotacao.ts";

async function lerSeExiste(arquivo: string): Promise<string | null> {
  try {
    return await readFile(arquivo, "utf-8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw e;
  }
}

export interface OpcoesDoDia {
  pasta: string;
  dia: string;
  /** Arquivo `feedback.jsonl`, se houver. */
  feedback?: string;
  /** Onde gravar `relatorio-<dia>.md` e `.json`; padrão: a própria pasta dos logs. */
  saida?: string;
}

/** Grava o relatório do dia. `sem_log` quando não há `<dia>.jsonl` (nada é criado). Erro de leitura ou gravação sobe. */
export async function gerarArquivosDoDia(opcoes: OpcoesDoDia): Promise<"gerado" | "sem_log"> {
  const texto = await lerSeExiste(join(opcoes.pasta, `${opcoes.dia}.jsonl`));
  if (texto === null) return "sem_log";
  const { registros, invalidas } = lerRegistros(texto);
  // a nota de hoje pode ser de uma pergunta de ontem: o log do dia anterior só serve para ligar
  const anterior = await lerSeExiste(join(opcoes.pasta, `${diaAnterior(opcoes.dia)}.jsonl`));
  const feedback = opcoes.feedback ? await lerSeExiste(opcoes.feedback) : null;
  const relatorio = gerarRelatorio(registros, {
    dia: opcoes.dia,
    linhasInvalidas: invalidas,
    ...(anterior === null ? {} : { registrosAnteriores: lerRegistros(anterior).registros }),
    ...(feedback === null ? {} : { feedback }),
  });
  const saida = opcoes.saida ?? opcoes.pasta;
  await mkdir(saida, { recursive: true });
  await writeFile(join(saida, `relatorio-${opcoes.dia}.md`), paraMarkdown(relatorio), "utf-8");
  await writeFile(join(saida, `relatorio-${opcoes.dia}.json`), `${JSON.stringify(relatorio, null, 2)}\n`, "utf-8");
  return "gerado";
}

export interface OpcoesDiaria {
  pasta: string;
  /** O dia de hoje, `AAAA-MM-DD` (local). O relatório é o de ontem. */
  hoje: string;
  /** Vence o log com mais de `dias` dias; padrão 30. */
  dias?: number;
  feedback?: string;
  saida?: string;
  /** Só diz o que faria. */
  simular?: boolean;
  /** Troca a remoção (teste). */
  apagar?: (arquivo: string) => Promise<void>;
}

export interface ResultadoDiaria {
  dia: string;
  relatorio: "gerado" | "sem_log" | "falhou";
  removidos: string[];
  /** Logs vencidos que ficaram porque o relatório deles não pôde ser gerado. */
  mantidos_sem_relatorio: string[];
  erros: string[];
  simulado: boolean;
}

const mensagem = (e: unknown) => (e instanceof Error ? e.message : String(e));

async function ehArquivo(caminho: string): Promise<boolean> {
  try {
    return (await stat(caminho)).isFile();
  } catch {
    return false;
  }
}

export async function rodarDiaria(opcoes: OpcoesDiaria): Promise<ResultadoDiaria> {
  const dias = opcoes.dias ?? 30;
  validarDias(dias);
  validarHoje(opcoes.hoje);
  const saida = opcoes.saida ?? opcoes.pasta;
  const apagar = opcoes.apagar ?? ((arquivo: string) => rm(arquivo));
  const simular = opcoes.simular ?? false;
  const dia = diaAnterior(opcoes.hoje);
  const r: ResultadoDiaria = { dia, relatorio: "sem_log", removidos: [], mantidos_sem_relatorio: [], erros: [], simulado: simular };
  const doDia = (d: string): OpcoesDoDia => ({ pasta: opcoes.pasta, dia: d, saida, ...(opcoes.feedback ? { feedback: opcoes.feedback } : {}) });

  // 1. o relatório de ontem (regravado a cada rodada: o resultado é o mesmo)
  if (simular) r.relatorio = (await ehArquivo(join(opcoes.pasta, `${dia}.jsonl`))) ? "gerado" : "sem_log";
  else {
    try {
      r.relatorio = await gerarArquivosDoDia(doDia(dia));
    } catch (e) {
      r.relatorio = "falhou";
      r.erros.push(`relatório de ${dia}: ${mensagem(e)}`);
    }
  }

  // 2. os logs vencidos: só os arquivos, e só com o relatório do dia em mãos
  let entradas: { name: string; isFile(): boolean }[] = [];
  try {
    entradas = await readdir(opcoes.pasta, { withFileTypes: true });
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") r.erros.push(`ler a pasta: ${mensagem(e)}`);
  }
  const vencidos = logsExpirados(entradas.filter((x) => x.isFile()).map((x) => x.name), opcoes.hoje, dias);
  for (const nome of vencidos.sort()) {
    const diaDoArquivo = diaDoLog(nome) as string;
    if (!simular && !(await ehArquivo(join(saida, `relatorio-${diaDoArquivo}.json`)))) {
      try {
        await gerarArquivosDoDia(doDia(diaDoArquivo));
      } catch (e) {
        r.mantidos_sem_relatorio.push(nome);
        r.erros.push(`${nome}: não foi possível gerar o relatório antes de apagar (${mensagem(e)}); o log ficou`);
        continue;
      }
    }
    if (simular) {
      r.removidos.push(nome);
      continue;
    }
    try {
      await apagar(join(opcoes.pasta, nome));
      r.removidos.push(nome);
    } catch (e) {
      r.erros.push(`${nome}: ${mensagem(e)}`);
    }
  }
  return r;
}
