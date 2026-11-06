/**
 * Mede o roteador (F7.3) em `eval/golden_rotas.json` com o llama-swap de verdade.
 *
 *   npm run avaliar:rotas -- --nome f73-ajuste --grupo ajuste
 *
 * Por padrão roda o caminho do agente: atualizador de pergunta (F7.2) e, em cada subpergunta, o roteador.
 * Com `--direto` a pergunta vai só ao roteador (separa o erro de rota do erro de decomposição).
 *
 * Grava `eval/resultados/<nome>.json` (só ids e números) e o que o modelo chamou em
 * `data/avaliacao/<nome>-detalhes.json` (fora do repositório).
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { atualizarPergunta } from "../agente/atualizador.ts";
import { rotear, rotearSubperguntas, type Roteamento } from "../agente/roteador.ts";
import { ClienteLlm, type Perfil } from "../llm/index.ts";
import { avaliarRota, resumirRotas, type CasoRota } from "./rotas.ts";

const RAIZ = new URL("../../../", import.meta.url);

const { values } = parseArgs({
  options: {
    nome: { type: "string", default: "f73" },
    grupo: { type: "string" },
    perfil: { type: "string", default: "principal" },
    direto: { type: "boolean", default: false },
    swap: { type: "string", default: process.env["LLAMA_SWAP_URL"] ?? "http://127.0.0.1:8080" },
  },
});

const casos = (JSON.parse(readFileSync(new URL("eval/golden_rotas.json", RAIZ), "utf-8")) as CasoRota[]).filter(
  (c) => !values.grupo || c.grupo === values.grupo,
);
const llm = new ClienteLlm({ baseUrl: values.swap });
const perfil = values.perfil as Perfil;

const itens = [];
const detalhes = [];
for (const c of casos) {
  const t0 = performance.now();
  let subperguntas: string[];
  let roteamentos: Roteamento[];
  let fallbackAtualizador: string | null = null;
  if (values.direto) {
    subperguntas = [c.pergunta];
    roteamentos = [await rotear(llm, c.pergunta, { perfil })];
  } else {
    const a = await atualizarPergunta(llm, c.pergunta, [], { perfil });
    fallbackAtualizador = a.fallback;
    const subs = a.subperguntas.length > 0 ? a.subperguntas : [{ pergunta: a.autonoma, dependeDe: [] }];
    const r = await rotearSubperguntas(llm, subs, { perfil });
    subperguntas = r.map((x) => x.pergunta);
    roteamentos = r.map((x) => x.roteamento);
  }
  const ms = Math.round(performance.now() - t0);
  const rotas = roteamentos.map((r) => r.chamadas.map((x) => x.nome));
  const a = avaliarRota(c, { rotas });
  const fallbacks = roteamentos.map((r) => r.fallback).filter((f) => f !== null);
  itens.push({
    id: c.id, grupo: c.grupo, rota_esperada: c.rota_esperada, estrito: a.estrito, aceito: a.aceito, motivo: a.motivo,
    rotas, subperguntas: subperguntas.length, fallbacks, fallback_atualizador: fallbackAtualizador, ms,
  });
  detalhes.push({
    id: c.id, ...a, subperguntas,
    roteamentos: roteamentos.map((r) => ({ chamadas: r.chamadas, texto: r.texto, descartadas: r.descartadas, fallback: r.fallback, erro: r.erro })),
  });
  console.log(
    `${a.aceito ? "OK  " : "ERRO"} ${a.estrito ? "E" : "-"} ${c.id} ${c.grupo} ${c.rota_esperada} -> ${rotas.map((r) => r.join("+") || "nenhuma").join(" | ")}` +
      `${fallbacks.length ? ` [fallback ${fallbacks.join(",")}]` : ""} ${a.motivo}`,
  );
}
const tempos = itens.map((i) => i.ms).sort((a, b) => a - b);
const resumo = {
  modelo: perfil,
  caminho: values.direto ? "direto" : "atualizador+roteador",
  ...resumirRotas(itens),
  latencia_ms: { mediana: tempos[Math.floor(tempos.length / 2)] ?? 0, maximo: tempos.at(-1) ?? 0 },
  fallbacks: itens.filter((i) => i.fallbacks.length > 0 || i.fallback_atualizador).length,
  casos: itens,
};
mkdirSync(new URL("data/avaliacao/", RAIZ), { recursive: true });
writeFileSync(new URL(`data/avaliacao/${values.nome}-detalhes.json`, RAIZ), JSON.stringify(detalhes, null, 2));
writeFileSync(new URL(`eval/resultados/${values.nome}.json`, RAIZ), JSON.stringify(resumo, null, 2));
console.log(JSON.stringify({ ...resumo, casos: undefined }));
