/**
 * Custo do registrador de telemetria no tempo de resposta (F7.14): `npm run avaliar:telemetria`. Não precisa de Neo4j nem de
 * llama-swap: o ciclo e o redator são dublês que respondem na hora, para que sobre só o que a API e o registrador gastam.
 *
 * Definições fixadas ANTES de rodar (o aceite do ETAPAS é "a diferença de latência do /api/chat e de uma rota simples com e
 * sem telemetria é medida e registrada em ADR"):
 *
 *  - **Rotas**: `POST /api/chat` (o fluxo SSE inteiro lido até o fim, com o ciclo e o redator falsos que respondem na hora e
 *    emitem os mesmos eventos de sempre) e `GET /api/saude` (rota simples, sem nenhuma dependência configurada).
 *  - **Condições**: três instâncias da mesma API em portas diferentes, uma por condição: `sem` (sem registrador), `sem2`
 *    (outra instância igualzinha, o CONTROLE DE RUÍDO: a diferença entre as duas sem telemetria é o que a medida erra) e `com`
 *    (registrador real gravando em uma pasta temporária). Mede-se por HTTP em 127.0.0.1, com a pilha de rede inteira.
 *  - **Amostra**: 200 requisições de aquecimento por instância e rota (descartadas) e depois 1.000 medidas por condição e
 *    rota. Uma requisição por vez; a ordem entre as três condições gira a cada rodada (as 6 permutações), para que deriva da
 *    máquina e cache não favoreçam sempre a mesma.
 *  - **Número**: mediana, p95 (nearest-rank) e média de cada condição, e a diferença `com` menos `sem` em cada uma; o ruído
 *    é `sem2` menos `sem`. Uma diferença só conta se passar do ruído; sem limiar de aprovação.
 *  - **Também**: o tempo que a fila de gravação leva para esvaziar depois da última requisição, e se o arquivo ficou com uma
 *    linha por requisição (nenhuma perdida).
 *  - **O que NÃO mede**: o custo com o ciclo real (LLM de ~10 a 30 s por pergunta), onde o registrador é desprezível; com o
 *    dublê a pergunta toma alguns milissegundos e qualquer custo do registrador aparece inteiro.
 *
 * Grava `eval/resultados/f714-custo-telemetria.json` (só números).
 */
import { mkdtemp, readFile, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { criarApp } from "../../src/app.ts";
import type { DependenciasApp } from "../../src/http/tipos.ts";
import { criarRegistrador } from "../../src/telemetria/registro.ts";

const RAIZ = fileURLToPath(new URL("../../../", import.meta.url));
const { values } = parseArgs({
  options: {
    medidas: { type: "string", default: "1000" },
    aquecimento: { type: "string", default: "200" },
    nome: { type: "string", default: "f714-custo-telemetria" },
  },
});
const MEDIDAS = Number(values.medidas);
const AQUECIMENTO = Number(values.aquecimento);

const ciclo = {
  pergunta: "Qual o lucro?",
  autonoma: "Qual foi o lucro líquido de 2025?",
  estado: "suficiente",
  faltando: "",
  rodadas: [{ rodada: 1, agente: { subperguntas: [{ execucoes: [{ ferramenta: "buscar_trechos" }, { ferramenta: "fato_financeiro" }] }] }, critica: null }],
  evidencias: [{ id: "p1", tipo: "pai", paginas: "p. 6", caminho: "c", texto: "texto", score: 0.9, subpergunta: 0, ferramenta: "buscar_trechos", rodada: 1 }],
  anotacoes: [],
  etapas_ms: { atualizar: 1, rotear: 1, executar: 1, criticar: 1, total: 4 },
  uso: { entrada: 100, saida: 10 },
  erro: null,
} as never;
const resposta = {
  estado: "suficiente", modo: "llm", texto: "O lucro foi de R$ 20 bilhões [E1].", textoComPaginas: "O lucro foi de R$ 20 bilhões [p. 6].",
  citacoes: [{ ref: "E1", id: "p1", tipo: "pai", paginas: "p. 6" }],
  verificacao: { afirmacoes_numericas: 1, sem_citacao: [], citacoes_invalidas: [], formato_nao_ptbr: [], numeros_sem_lastro: [], declaracoes_de_ausencia: 0 },
  reparos: 0, antes_do_reparo: null, cortada: false, fallback: null, uso: { entrada: 400, saida: 40 }, ms: { total: 5, primeiroToken: 2 },
} as never; // prettier-ignore

const base: DependenciasApp = {
  ciclo: async () => ciclo,
  redator: async (_e, o) => {
    o.progresso?.({ fase: "token", texto: "O lucro foi de R$ 20 bilhões " });
    o.progresso?.({ fase: "token", texto: "[E1]." });
    return resposta;
  },
};

const pastaLogs = await mkdtemp(join(tmpdir(), "custo-telemetria-"));
const registrador = criarRegistrador({ pasta: pastaLogs, registrarErro: (c, e) => console.error(`[${c}]`, e) });
const instancias = {
  sem: criarApp({ ...base }),
  sem2: criarApp({ ...base }),
  com: criarApp({ ...base, telemetria: registrador }),
};
type Condicao = keyof typeof instancias;
const CONDICOES: Condicao[] = ["sem", "sem2", "com"];
const urls = {} as Record<Condicao, string>;
for (const c of CONDICOES) {
  await instancias[c].listen({ host: "127.0.0.1", port: 0 });
  urls[c] = `http://127.0.0.1:${(instancias[c].server.address() as { port: number }).port}`;
}

const corpoChat = JSON.stringify({ conversationId: "medida", message: "Qual o lucro líquido de 2025?" });
const rotas = {
  chat: async (c: Condicao) => {
    const r = await fetch(`${urls[c]}/api/chat`, { method: "POST", headers: { "content-type": "application/json" }, body: corpoChat });
    await r.text();
    if (r.status !== 200) throw new Error(`chat ${c}: ${r.status}`);
  },
  saude: async (c: Condicao) => {
    const r = await fetch(`${urls[c]}/api/saude`);
    await r.text();
    if (r.status !== 200) throw new Error(`saude ${c}: ${r.status}`);
  },
};
type Rota = keyof typeof rotas;

const permutacoes: Condicao[][] = [
  ["sem", "sem2", "com"], ["sem", "com", "sem2"], ["sem2", "sem", "com"], ["sem2", "com", "sem"], ["com", "sem", "sem2"], ["com", "sem2", "sem"],
]; // prettier-ignore

const percentil = (v: number[], p: number) => [...v].sort((a, b) => a - b)[Math.min(v.length, Math.max(1, Math.ceil(p * v.length))) - 1] as number;
const media = (v: number[]) => v.reduce((a, b) => a + b, 0) / v.length;
const r3 = (x: number) => Math.round(x * 1000) / 1000;
const resumo = (v: number[]) => ({ n: v.length, p50_ms: r3(percentil(v, 0.5)), p95_ms: r3(percentil(v, 0.95)), media_ms: r3(media(v)) });

const resultado: Record<string, unknown> = {};
for (const rota of Object.keys(rotas) as Rota[]) {
  for (const c of CONDICOES) for (let i = 0; i < AQUECIMENTO; i++) await rotas[rota](c);
  const tempos: Record<Condicao, number[]> = { sem: [], sem2: [], com: [] };
  for (let i = 0; i < MEDIDAS; i++) {
    for (const c of permutacoes[i % permutacoes.length] as Condicao[]) {
      const t0 = performance.now();
      await rotas[rota](c);
      tempos[c].push(performance.now() - t0);
    }
  }
  const s = { sem: resumo(tempos.sem), sem2: resumo(tempos.sem2), com: resumo(tempos.com) };
  const dif = (a: ReturnType<typeof resumo>, b: ReturnType<typeof resumo>) => ({ p50_ms: r3(a.p50_ms - b.p50_ms), p95_ms: r3(a.p95_ms - b.p95_ms), media_ms: r3(a.media_ms - b.media_ms) });
  resultado[rota] = { ...s, diferenca_com_menos_sem: dif(s.com, s.sem), ruido_sem2_menos_sem: dif(s.sem2, s.sem) };
  console.log(`${rota}: sem p50 ${s.sem.p50_ms} ms | sem2 ${s.sem2.p50_ms} | com ${s.com.p50_ms} | com-sem p50 ${dif(s.com, s.sem).p50_ms} ms, p95 ${dif(s.com, s.sem).p95_ms} ms (ruído p50 ${dif(s.sem2, s.sem).p50_ms})`);
}

const t0 = performance.now();
await registrador.aguardar();
const drenar = Math.round(performance.now() - t0);
const esperadas = (AQUECIMENTO + MEDIDAS) * 2;
let linhas = 0;
for (const nome of (await (await import("node:fs/promises")).readdir(pastaLogs))) linhas += (await readFile(join(pastaLogs, nome), "utf-8")).split("\n").filter((l) => l.trim() !== "").length;

const saida = {
  nome: values.nome,
  data: new Date().toISOString().slice(0, 10),
  comando: "npm run avaliar:telemetria",
  medidas_por_condicao_e_rota: MEDIDAS,
  aquecimento: AQUECIMENTO,
  ...resultado,
  fila: { drenar_depois_da_ultima_requisicao_ms: drenar, linhas_gravadas: linhas, linhas_esperadas: esperadas },
};
await mkdir(join(RAIZ, "eval", "resultados"), { recursive: true });
await writeFile(join(RAIZ, "eval", "resultados", `${values.nome}.json`), JSON.stringify(saida, null, 2) + "\n");
console.log(`fila: ${drenar} ms para esvaziar; ${linhas} de ${esperadas} linhas gravadas`);
for (const c of CONDICOES) await instancias[c].close();
await rm(pastaLogs, { recursive: true, force: true });
