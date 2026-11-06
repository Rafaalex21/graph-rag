/**
 * Mede o atualizador de pergunta (F7.2) em `eval/golden_decomposicao.json` com o llama-swap de verdade.
 *
 *   npm run avaliar:decomposicao -- --nome f72-teste --grupo teste
 *
 * Grava `eval/resultados/<nome>.json` (só ids e números) e o que o modelo respondeu em
 * `data/avaliacao/<nome>-detalhes.json` (fora do repositório).
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { atualizarPergunta } from "../agente/atualizador.ts";
import { ClienteLlm, type Perfil } from "../llm/index.ts";
import { avaliarDecomposicao, resumirAvaliacao, type CasoDecomposicao } from "./decomposicao.ts";

const RAIZ = new URL("../../../", import.meta.url);

const { values } = parseArgs({
  options: {
    nome: { type: "string", default: "f72" },
    grupo: { type: "string" },
    perfil: { type: "string", default: "principal" },
    swap: { type: "string", default: process.env["LLAMA_SWAP_URL"] ?? "http://127.0.0.1:8080" },
  },
});

const casos = (JSON.parse(readFileSync(new URL("eval/golden_decomposicao.json", RAIZ), "utf-8")) as CasoDecomposicao[]).filter(
  (c) => !values.grupo || c.grupo === values.grupo,
);
const llm = new ClienteLlm({ baseUrl: values.swap });
const perfil = values.perfil as Perfil;

const itens = [];
const detalhes = [];
for (const c of casos) {
  const r = await atualizarPergunta(llm, c.pergunta, c.historico, { perfil });
  const a = avaliarDecomposicao(c, { autonoma: r.autonoma, subperguntas: r.subperguntas });
  itens.push({
    id: c.id, grupo: c.grupo, tipo: c.tipo, ok: a.ok, motivos: a.motivos,
    obtidas: r.subperguntas.length, esperadas: c.esperado.subperguntas.length,
    fallback: r.fallback, ms: r.ms,
  });
  detalhes.push({ id: c.id, ok: a.ok, motivos: a.motivos, autonoma: r.autonoma, subperguntas: r.subperguntas, erro: r.erro });
  console.log(`${a.ok ? "OK  " : "ERRO"} ${c.id} ${c.grupo} ${c.tipo} ${a.motivos.join("; ")}${r.fallback ? ` [fallback ${r.fallback}]` : ""}`);
}
const tempos = itens.map((i) => i.ms).sort((a, b) => a - b);
const resumo = {
  modelo: perfil,
  ...resumirAvaliacao(itens),
  latencia_ms: { mediana: tempos[Math.floor(tempos.length / 2)] ?? 0, maximo: tempos.at(-1) ?? 0 },
  fallbacks: itens.filter((i) => i.fallback).length,
  casos: itens,
};
mkdirSync(new URL("data/avaliacao/", RAIZ), { recursive: true });
writeFileSync(new URL(`data/avaliacao/${values.nome}-detalhes.json`, RAIZ), JSON.stringify(detalhes, null, 2));
writeFileSync(new URL(`eval/resultados/${values.nome}.json`, RAIZ), JSON.stringify(resumo, null, 2));
console.log(JSON.stringify({ ...resumo, casos: undefined }));
