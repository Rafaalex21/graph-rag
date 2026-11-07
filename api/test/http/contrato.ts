/**
 * Valida valores contra os esquemas de `contracts/api.openapi.yaml` (F7.6). O YAML é a fonte: mudar uma rota sem mudar o
 * contrato quebra os testes que usam este arquivo.
 */
import { readFileSync } from "node:fs";
import { Ajv2020 } from "ajv/dist/2020.js";
import { parse } from "yaml";

export const CAMINHO_DO_CONTRATO = new URL("../../../contracts/api.openapi.yaml", import.meta.url);

interface Documento {
  openapi: string;
  paths: Record<string, Record<string, { responses: Record<string, { content?: Record<string, { schema?: unknown }> }>; "x-eventos"?: Record<string, unknown> }>>;
  components: { schemas: Record<string, unknown> };
}

export const contrato = parse(readFileSync(CAMINHO_DO_CONTRATO, "utf-8")) as Documento;

const ajv = new Ajv2020({ strict: false, allErrors: true });
ajv.addSchema({ $id: "contrato", components: contrato.components });

/** Valida `valor` contra `#/components/schemas/<nome>`; devolve a lista de problemas (vazia se confere). */
export function problemas(nome: string, valor: unknown): string[] {
  const validar = ajv.getSchema(`contrato#/components/schemas/${nome}`);
  if (!validar) throw new Error(`esquema ${nome} não existe no contrato`);
  return validar(valor) ? [] : (validar.errors ?? []).map((e) => `${e.instancePath || "/"} ${e.message ?? ""}`.trim());
}

/** Os nomes dos esquemas dos eventos SSE do `POST /api/chat`: evento → esquema. */
export function esquemasDosEventos(): Record<string, string> {
  const x = contrato.paths["/api/chat"]?.["post"]?.["x-eventos"] ?? {};
  return Object.fromEntries(Object.entries(x).map(([evento, ref]) => [evento, String((ref as { $ref: string }).$ref).split("/").pop() ?? ""]));
}

/** Os códigos de status que o contrato declara para `método` e `rota`. */
export function statusDeclarados(rota: string, metodo: string): string[] {
  return Object.keys(contrato.paths[rota]?.[metodo]?.responses ?? {});
}
