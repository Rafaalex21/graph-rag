/** O registrador: uma linha JSON por registro, no arquivo do dia, sem nunca atrasar nem derrubar a resposta. */
import { createHash } from "node:crypto";
import { appendFile, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { Registro } from "./tipos.ts";

export interface Registrador {
  /** Entra na fila e volta na hora; falha de gravação é avisada por `registrarErro`, nunca lançada. */
  registrar(registro: Registro): void;
  /** Espera o que está na fila (teste e desligamento da API). */
  aguardar(): Promise<void>;
}

export interface OpcoesRegistrador {
  pasta: string;
  /** Recebe a falha de gravação (`"telemetria"`, erro). */
  registrarErro?: (contexto: string, erro: unknown) => void;
  /** Troca a gravação (teste). Padrão: cria a pasta e acrescenta ao arquivo. */
  acrescentar?: (arquivo: string, texto: string) => Promise<void>;
}

const acrescentarPadrao = async (arquivo: string, texto: string): Promise<void> => {
  await mkdir(dirname(arquivo), { recursive: true });
  await appendFile(arquivo, texto, "utf-8");
};

/** A data LOCAL (`AAAA-MM-DD`) de um instante ISO: o "dia" do relatório é o do usuário, não o UTC. */
export function diaLocal(iso: string): string {
  const d = new Date(iso);
  const dois = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${dois(d.getMonth() + 1)}-${dois(d.getDate())}`;
}

export function criarRegistrador(opcoes: OpcoesRegistrador): Registrador {
  const acrescentar = opcoes.acrescentar ?? acrescentarPadrao;
  let fila: Promise<void> = Promise.resolve();
  return {
    registrar(registro) {
      let linha: string;
      let arquivo: string;
      try {
        linha = `${JSON.stringify(registro)}\n`;
        arquivo = join(opcoes.pasta, `${diaLocal(registro.ts)}.jsonl`);
      } catch (e) {
        opcoes.registrarErro?.("telemetria", e);
        return;
      }
      // em série: duas gravações ao mesmo tempo no mesmo arquivo poderiam se misturar
      fila = fila.then(() => acrescentar(arquivo, linha)).catch((e: unknown) => {
        opcoes.registrarErro?.("telemetria", e);
      });
    },
    aguardar: () => fila,
  };
}

/**
 * Tamanho e impressão digital da pergunta (sha256 do texto sem espaços sobrando e em minúsculas, 16 hex): serve para contar
 * perguntas repetidas sem guardar o que foi perguntado. O texto só vai com `comTexto`.
 */
export function impressaoDaPergunta(texto: string, comTexto: boolean): { caracteres: number; hash: string; texto?: string } {
  const normal = texto.replace(/\s+/g, " ").trim().toLowerCase();
  const hash = createHash("sha256").update(normal).digest("hex").slice(0, 16);
  return { caracteres: texto.length, hash, ...(comTexto ? { texto } : {}) };
}
