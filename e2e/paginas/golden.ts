import { readFileSync } from "node:fs";

/** Lê o `eval/golden.csv` (campos entre aspas, com vírgulas e quebras de linha dentro). */
function lerCsv(texto: string): Record<string, string>[] {
  const linhas: string[][] = [];
  let campo = "";
  let linha: string[] = [];
  let aspas = false;
  const t = texto.replace(/^﻿/, "");
  for (let i = 0; i < t.length; i++) {
    const c = t[i] as string;
    if (aspas) {
      if (c === '"' && t[i + 1] === '"') {
        campo += '"';
        i++;
      } else if (c === '"') aspas = false;
      else campo += c;
    } else if (c === '"') aspas = true;
    else if (c === ",") {
      linha.push(campo);
      campo = "";
    } else if (c === "\n" || c === "\r") {
      if (c === "\r" && t[i + 1] === "\n") i++;
      linha.push(campo);
      campo = "";
      if (linha.some((x) => x !== "")) linhas.push(linha);
      linha = [];
    } else campo += c;
  }
  if (campo !== "" || linha.length > 0) {
    linha.push(campo);
    linhas.push(linha);
  }
  const [cabecalho = [], ...resto] = linhas;
  return resto.map((l) => Object.fromEntries(cabecalho.map((h, i) => [h, l[i] ?? ""])));
}

const CAMINHO = new URL("../../eval/golden.csv", import.meta.url);

/** A pergunta do golden pelo id (T01, N06...). */
export function perguntaDoGolden(id: string): string {
  const linha = lerCsv(readFileSync(CAMINHO, "utf-8")).find((l) => l["id"] === id);
  if (!linha?.["pergunta"]) throw new Error(`Não achei a pergunta ${id} no golden.`);
  return linha["pergunta"];
}
