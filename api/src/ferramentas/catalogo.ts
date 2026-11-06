/** Catálogo de métricas (`contracts/metricas.json`), o mesmo arquivo que o indexador e o Text2Cypher leem. */
import { readFileSync } from "node:fs";

export interface Metrica {
  id: string;
  name: string;
  name_pt: string;
  kind: string;
  aliases: string[];
}

const CAMINHO = new URL("../../../contracts/metricas.json", import.meta.url);

export function lerCatalogo(caminho: URL | string = CAMINHO): Metrica[] {
  const bruto = readFileSync(caminho, "utf-8").replace(/^\uFEFF/, "");
  return (JSON.parse(bruto) as { metricas: Metrica[] }).metricas;
}
