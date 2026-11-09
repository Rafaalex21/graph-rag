/**
 * Onde os arquivos gerados ficam até serem baixados (F8.10): uma pasta em `data/` (fora do git), um arquivo por material e um
 * `.json` ao lado com nome e tipo. O id é um UUID gerado aqui (nunca vem do cliente, e só entra no caminho depois de validado), o
 * tamanho de cada arquivo e a quantidade têm teto, e o que passou da validade é apagado (a cada gravação e a cada leitura).
 * Só arquivos que ESTE código gravou saem por `GET /api/arquivos/:id`.
 */
import { randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";

export const VALIDADE_PADRAO_MS = 60 * 60 * 1000;
export const MAX_BYTES = 5 * 1024 * 1024;
export const MAX_ARQUIVOS = 200;
export const ID_VALIDO = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export interface ArquivoGuardado {
  id: string;
  nome: string;
  tipo: string;
  bytes: number;
}

export interface Armazem {
  guardar(nome: string, tipo: string, corpo: Buffer): Promise<ArquivoGuardado>;
  ler(id: string): Promise<{ nome: string; tipo: string; corpo: Buffer } | null>;
}

export interface OpcoesArmazem {
  pasta: string;
  validadeMs?: number;
  /** Troca o relógio (teste ao vivo). */
  agora?: () => number;
}

interface Meta {
  nome: string;
  tipo: string;
  expira: number;
}

export function criarArmazem(opcoes: OpcoesArmazem): Armazem {
  const validade = opcoes.validadeMs ?? VALIDADE_PADRAO_MS;
  const agora = opcoes.agora ?? Date.now;

  const limpar = async (): Promise<string[]> => {
    let nomes: string[];
    try {
      nomes = await readdir(opcoes.pasta);
    } catch {
      return [];
    }
    const vivos: string[] = [];
    for (const n of nomes.filter((x) => x.endsWith(".json"))) {
      const id = n.slice(0, -5);
      try {
        const meta = JSON.parse(await readFile(join(opcoes.pasta, n), "utf8")) as Meta;
        if (meta.expira > agora()) {
          vivos.push(id);
          continue;
        }
      } catch {
        // metadado ilegível: sai junto
      }
      await rm(join(opcoes.pasta, `${id}.bin`), { force: true });
      await rm(join(opcoes.pasta, n), { force: true });
    }
    return vivos;
  };

  return {
    async guardar(nome, tipo, corpo) {
      if (corpo.length > MAX_BYTES) throw new Error(`arquivo de ${corpo.length} bytes passa do limite de ${MAX_BYTES}`);
      await mkdir(opcoes.pasta, { recursive: true });
      const vivos = await limpar();
      if (vivos.length >= MAX_ARQUIVOS) throw new Error("armazém de arquivos cheio");
      const id = randomUUID();
      await writeFile(join(opcoes.pasta, `${id}.bin`), corpo);
      await writeFile(join(opcoes.pasta, `${id}.json`), JSON.stringify({ nome, tipo, expira: agora() + validade } satisfies Meta));
      return { id, nome, tipo, bytes: corpo.length };
    },
    async ler(id) {
      if (!ID_VALIDO.test(id)) return null;
      try {
        const meta = JSON.parse(await readFile(join(opcoes.pasta, `${id}.json`), "utf8")) as Meta;
        if (meta.expira <= agora()) {
          await limpar();
          return null;
        }
        const arquivo = join(opcoes.pasta, `${id}.bin`);
        if ((await stat(arquivo)).size > MAX_BYTES) return null;
        return { nome: meta.nome, tipo: meta.tipo, corpo: await readFile(arquivo) };
      } catch {
        return null;
      }
    },
  };
}
