import { Injectable, computed, effect, inject, signal, untracked } from '@angular/core';
import { ChatService } from '../chat/chat.service';
import { buscarVizinhanca, type LigacaoDoGrafo, type NoDoGrafo, type Vizinhanca } from './grafo-api';
import { posicionar } from './layout';

/** Quantas entidades da resposta viram ponto de partida do subgrafo. */
export const MAX_SEMENTES = 6;

export interface NoDesenhado extends NoDoGrafo {
  x: number;
  y: number;
  /** Veio da resposta (ou do campo "Explorar"), não de uma expansão. */
  semente: boolean;
  /** A vizinhança dele já está no desenho. */
  expandido: boolean;
}

const plural = (n: number, um: string, varios: string) => `${n} ${n === 1 ? um : varios}`;

/**
 * O subgrafo do explorador (F8.5): as entidades que a última resposta usou como evidência, com a vizinhança de cada uma
 * (`GET /api/grafo/vizinhanca`), e o que o usuário expande por clique. O estado fica aqui (não na aba) para sobreviver à troca
 * de aba. O desenho recomeça a cada resposta nova e quando se explora uma entidade pelo nome; uma expansão só acrescenta, e
 * os nós que já estavam na tela não se mexem.
 */
@Injectable({ providedIn: 'root' })
export class GrafoService {
  private readonly chat = inject(ChatService);

  readonly nos = signal<NoDesenhado[]>([]);
  readonly ligacoes = signal<LigacaoDoGrafo[]>([]);
  readonly truncado = signal(false);
  readonly carregando = signal(false);
  readonly expandindo = signal<string | null>(null);
  /** Uma mensagem neutra sobre a última ação (por exemplo, "nenhuma ligação nova"). */
  readonly aviso = signal<string | null>(null);
  readonly erro = signal<string | null>(null);
  /** A última resposta pronta não tinha entidade nenhuma como evidência. */
  readonly semEntidades = signal(false);

  readonly resumo = computed(() => {
    const n = this.nos().length;
    return n === 0 ? null : `${plural(n, 'entidade', 'entidades')} e ${plural(this.ligacoes().length, 'ligação', 'ligações')}`;
  });
  readonly avisoDeTruncado = computed(() => (this.truncado() ? `Mostrando ${this.nos().length} entidades; há mais ligações que não couberam.` : null));
  /** Os tipos que aparecem no desenho, na ordem em que apareceram, com o índice da cor. */
  readonly tipos = computed(() => {
    const vistos: string[] = [];
    for (const n of this.nos()) if (!vistos.includes(n.tipo)) vistos.push(n.tipo);
    return vistos.map((tipo) => ({ tipo, rotulo: tipo === '' ? 'sem tipo' : tipo, cor: this.cores.get(tipo) ?? 0 }));
  });

  private readonly cores = new Map<string, number>();
  private geracao = 0;
  private controle: AbortController | null = null;
  private chaveDaResposta: number | null = null;
  private origem: 'resposta' | 'manual' | null = null;

  constructor() {
    effect(() => {
      const mensagens = this.chat.mensagens();
      untracked(() => this.aoMudarAConversa(mensagens));
    });
  }

  /** Explora uma entidade pelo nome ou id: troca o desenho (se ela existir). */
  async explorar(entidade: string): Promise<void> {
    const q = entidade.trim();
    if (q === '') return;
    await this.montar([q], 'manual');
  }

  /** Traz a vizinhança de uma entidade do desenho e a junta ao que já está na tela. */
  async expandir(id: string): Promise<void> {
    const alvo = this.nos().find((n) => n.id === id);
    if (!alvo || alvo.expandido || this.expandindo() !== null || this.carregando()) return;
    const geracao = this.geracao;
    this.aviso.set(null);
    this.erro.set(null);
    this.expandindo.set(id);
    const r = await buscarVizinhanca(id, this.novoControle().signal);
    if (geracao !== this.geracao) return;
    this.expandindo.set(null);
    if (r.estado === 'erro') {
      this.erro.set(`Não foi possível expandir ${alvo.rotulo}. Tente de novo.`);
      return;
    }
    if (r.estado === 'nao_encontrada') {
      this.aviso.set(`Nenhuma ligação nova para ${alvo.rotulo}.`);
      this.marcarExpandido(id);
      return;
    }
    const antes = this.nos().length;
    const antesLigacoes = this.ligacoes().length;
    this.juntar(r.dados, id);
    if (this.nos().length === antes && this.ligacoes().length === antesLigacoes) this.aviso.set(`Nenhuma ligação nova para ${alvo.rotulo}.`);
  }

  private aoMudarAConversa(mensagens: ReturnType<ChatService['mensagens']>): void {
    let pronta: (typeof mensagens)[number] | undefined;
    for (let i = mensagens.length - 1; i >= 0; i--) {
      const m = mensagens[i];
      if (m?.papel === 'assistente' && m.estado === 'pronta') {
        pronta = m;
        break;
      }
    }
    const chave = pronta?.id ?? null;
    if (chave === this.chaveDaResposta) return;
    this.chaveDaResposta = chave;
    if (!pronta) {
      // a conversa foi zerada: some o desenho que veio de uma resposta (o que se explorou à mão fica)
      if (this.origem === 'resposta') this.zerar();
      this.semEntidades.set(false);
      return;
    }
    const ids: string[] = [];
    for (const e of pronta.eventos) {
      if (e.evento !== 'evidencia') continue;
      const d = e.dados;
      if ((d.tipo === 'entidade' || d.id.startsWith('ent:')) && !ids.includes(d.id)) ids.push(d.id);
    }
    this.semEntidades.set(ids.length === 0);
    if (ids.length === 0) {
      this.zerar();
      return;
    }
    void this.montar(ids.slice(0, MAX_SEMENTES), 'resposta');
  }

  private zerar(): void {
    this.geracao++;
    this.controle?.abort();
    this.nos.set([]);
    this.ligacoes.set([]);
    this.truncado.set(false);
    this.carregando.set(false);
    this.expandindo.set(null);
    this.aviso.set(null);
    this.erro.set(null);
    this.origem = null;
  }

  private novoControle(): AbortController {
    this.controle = new AbortController();
    return this.controle;
  }

  /** Consulta as sementes (em paralelo) e desenha o subgrafo delas do zero. */
  private async montar(ids: string[], origem: 'resposta' | 'manual'): Promise<void> {
    const geracao = ++this.geracao;
    this.controle?.abort();
    const sinal = this.novoControle().signal;
    this.carregando.set(true);
    this.expandindo.set(null);
    this.aviso.set(null);
    this.erro.set(null);
    const resultados = await Promise.all(ids.map((id) => buscarVizinhanca(id, sinal)));
    if (geracao !== this.geracao) return;
    this.carregando.set(false);

    const achadas = resultados.flatMap((r) => (r.estado === 'ok' ? [r.dados] : []));
    if (achadas.length === 0) {
      if (origem === 'resposta') {
        // o desenho que ficou era de uma resposta anterior: não deixa a tela contando outra história
        this.nos.set([]);
        this.ligacoes.set([]);
        this.truncado.set(false);
      }
      if (resultados.some((r) => r.estado === 'erro')) this.erro.set('Não foi possível consultar o grafo agora. Tente de novo em instantes.');
      else if (origem === 'manual') this.aviso.set(`Entidade não encontrada: ${ids[0]}.`);
      else this.aviso.set('Nenhuma das entidades desta resposta está no grafo.');
      return;
    }
    this.origem = origem;
    const nos = new Map<string, NoDoGrafo>();
    const ligacoes = new Map<string, LigacaoDoGrafo>();
    for (const v of achadas) this.acumular(nos, ligacoes, v);
    const sementes = new Set(achadas.map((v) => v.entidade.id));
    const pontos = new Map(posicionar([...nos.values()], [...ligacoes.values()]).map((p) => [p.id, p]));
    this.nos.set(
      [...nos.values()].map((n) => ({ ...n, x: pontos.get(n.id)?.x ?? 0, y: pontos.get(n.id)?.y ?? 0, semente: sementes.has(n.id), expandido: sementes.has(n.id) })),
    );
    this.ligacoes.set([...ligacoes.values()]);
    this.truncado.set(achadas.some((v) => v.truncado));
  }

  private acumular(nos: Map<string, NoDoGrafo>, ligacoes: Map<string, LigacaoDoGrafo>, v: Vizinhanca): void {
    for (const n of v.nos) {
      if (!nos.has(n.id)) nos.set(n.id, n);
      if (!this.cores.has(n.tipo)) this.cores.set(n.tipo, this.cores.size);
    }
    for (const a of v.arestas) ligacoes.set(`${a.origem}\u0000${a.destino}\u0000${a.tipo}`, a);
  }

  /** Junta a vizinhança de `id` ao desenho: os nós que já estavam ficam onde estavam e os novos nascem em volta dele. */
  private juntar(v: Vizinhanca, id: string): void {
    const atuais = this.nos();
    const existentes = new Map<string, NoDoGrafo>(atuais.map((n) => [n.id, n]));
    const ligacoes = new Map(this.ligacoes().map((a) => [`${a.origem}\u0000${a.destino}\u0000${a.tipo}`, a]));
    this.acumular(existentes, ligacoes, v);
    const centro = atuais.find((n) => n.id === id);
    const entradas = [...existentes.values()].map((n) => {
      const antigo = atuais.find((a) => a.id === n.id);
      return antigo ? { id: n.id, x: antigo.x, y: antigo.y } : { id: n.id };
    });
    const pontos = new Map(posicionar(entradas, [...ligacoes.values()], { fixos: new Set(atuais.map((n) => n.id)), centro: centro ? { x: centro.x, y: centro.y } : undefined }).map((p) => [p.id, p]));
    this.nos.set(
      [...existentes.values()].map((n) => {
        const antigo = atuais.find((a) => a.id === n.id);
        const p = pontos.get(n.id);
        return antigo ? { ...antigo, expandido: antigo.expandido || n.id === id } : { ...n, x: p?.x ?? 0, y: p?.y ?? 0, semente: false, expandido: false };
      }),
    );
    this.ligacoes.set([...ligacoes.values()]);
    if (v.truncado) this.truncado.set(true);
  }

  private marcarExpandido(id: string): void {
    this.nos.update((l) => l.map((n) => (n.id === id ? { ...n, expandido: true } : n)));
  }
}
