/**
 * O posicionamento dos nós do explorador (F8.5): uma força dirigida de Fruchterman–Reingold, sem sorteio (o mesmo grafo dá sempre
 * o mesmo desenho). Função pura. Os nós `fixos` não se mexem (é o que mantém a tela estável quando uma expansão traz vizinhos
 * novos); os nós sem posição nascem numa espiral em volta de `centro`.
 */

export interface PontoNo {
  id: string;
  x: number;
  y: number;
}

export interface EntradaNo {
  id: string;
  x?: number;
  y?: number;
}

export interface OpcoesLayout {
  /** Ids que não se movem. */
  fixos?: ReadonlySet<string>;
  /** Onde nascem os nós sem posição. */
  centro?: { x: number; y: number };
  iteracoes?: number;
}

/** A distância ideal entre vizinhos, nas unidades do desenho. */
export const DISTANCIA = 70;
const ANGULO_DOURADO = Math.PI * (3 - Math.sqrt(5));

export function posicionar(nos: readonly EntradaNo[], arestas: readonly { origem: string; destino: string }[], opcoes: OpcoesLayout = {}): PontoNo[] {
  const fixos = opcoes.fixos ?? new Set<string>();
  const centro = opcoes.centro ?? { x: 0, y: 0 };
  const iteracoes = opcoes.iteracoes ?? 220;

  let novos = 0;
  const pontos = nos.map((n) => {
    if (n.x !== undefined && n.y !== undefined) return { id: n.id, x: n.x, y: n.y, fixo: fixos.has(n.id) };
    const i = novos++;
    const raio = DISTANCIA * 0.6 + 14 * Math.sqrt(i + 1) * 2;
    return { id: n.id, x: centro.x + raio * Math.cos(i * ANGULO_DOURADO), y: centro.y + raio * Math.sin(i * ANGULO_DOURADO), fixo: fixos.has(n.id) };
  });
  const indice = new Map(pontos.map((p, i) => [p.id, i]));
  const pares: [number, number][] = [];
  for (const a of arestas) {
    const o = indice.get(a.origem);
    const d = indice.get(a.destino);
    if (o !== undefined && d !== undefined && o !== d) pares.push([o, d]);
  }
  const n = pontos.length;
  if (n < 2 || pontos.every((p) => p.fixo)) return pontos.map(({ id, x, y }) => ({ id, x, y }));

  const k = DISTANCIA;
  const dx = new Float64Array(n);
  const dy = new Float64Array(n);
  for (let it = 0; it < iteracoes; it++) {
    const temperatura = k * (1 - it / iteracoes) * 0.5 + 0.5;
    dx.fill(0);
    dy.fill(0);
    for (let i = 0; i < n; i++) {
      const a = pontos[i]!;
      for (let j = i + 1; j < n; j++) {
        const b = pontos[j]!;
        let vx = a.x - b.x;
        let vy = a.y - b.y;
        let d2 = vx * vx + vy * vy;
        if (d2 < 0.01) {
          // dois nós no mesmo ponto: separa na direção de um ângulo que depende dos índices (determinístico)
          vx = Math.cos(i + j);
          vy = Math.sin(i + j);
          d2 = 1;
        }
        const f = (k * k) / d2; // repulsão de módulo k²/d: (k²/d) · (v/d) = v · k²/d²
        dx[i]! += vx * f;
        dy[i]! += vy * f;
        dx[j]! -= vx * f;
        dy[j]! -= vy * f;
      }
    }
    for (const [o, d] of pares) {
      const a = pontos[o]!;
      const b = pontos[d]!;
      const vx = a.x - b.x;
      const vy = a.y - b.y;
      const dist = Math.max(Math.hypot(vx, vy), 0.01);
      const f = (dist * dist) / k; // atração: d²/k
      dx[o]! -= (vx / dist) * f;
      dy[o]! -= (vy / dist) * f;
      dx[d]! += (vx / dist) * f;
      dy[d]! += (vy / dist) * f;
    }
    for (let i = 0; i < n; i++) {
      const p = pontos[i]!;
      if (p.fixo) continue;
      // a gravidade mantém perto do centro os componentes que não se ligam a nada (sem ela, a repulsão os espalha por milhares de unidades)
      dx[i]! -= (p.x - centro.x) * 0.2;
      dy[i]! -= (p.y - centro.y) * 0.2;
      const deslocamento = Math.hypot(dx[i]!, dy[i]!);
      if (deslocamento > 0) {
        const passo = Math.min(deslocamento, temperatura);
        p.x += (dx[i]! / deslocamento) * passo;
        p.y += (dy[i]! / deslocamento) * passo;
      }
    }
  }
  return pontos.map(({ id, x, y }) => ({ id, x, y }));
}
