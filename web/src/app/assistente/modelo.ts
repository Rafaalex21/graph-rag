/**
 * O que a tela do assistente (F8.9) mostra de cada resposta, em português simples, a partir do que o chat já guarda (os eventos
 * SSE de `Mensagem.eventos`): o selo de estado, os cartões de fonte e o passo a passo "Como cheguei a esta resposta". Funções
 * puras, sem DOM. Nada aqui inventa dado: o selo vem de `metricas.estado`, os cartões das evidências citadas e os passos dos
 * mesmos eventos que o Rastro técnico mostra (o Cypher e os nomes das ferramentas ficam de fora, de propósito).
 */
import type { Mensagem } from '../chat/chat.service';
import { montarRastro, type PassoRastro } from '../chat/rastro';
import type { Modo } from '../configuracoes/configuracoes.service';

export type ChaveDoSelo = 'encontrado' | 'parcial' | 'ausente' | 'erro';

export interface Selo {
  chave: ChaveDoSelo;
  texto: string;
}

export interface CartaoFonte {
  id: string;
  /** O rótulo da página como veio (`p. 9-10`). */
  rotulo: string;
  /** A primeira página do rótulo (`9`), a que o painel abre. */
  pagina: string;
  tipo: string;
  trecho: string;
}

const SELOS: Record<ChaveDoSelo, string> = {
  encontrado: 'Encontrado no documento',
  parcial: 'Encontrei só em parte',
  ausente: 'Não consta no documento',
  erro: 'Não consegui responder',
};

/** O nome de cada modo de busca para quem não é desenvolvedor (os valores são os mesmos de Configurações). */
export const MODOS_DA_TELA: readonly { valor: Modo; rotulo: string; dica: string }[] = [
  {
    valor: 'auto',
    rotulo: 'Automático',
    dica: 'O sistema escolhe onde procurar. É o melhor para a maioria das perguntas.',
  },
  { valor: 'trechos', rotulo: 'Textos', dica: 'Procura só nos textos do formulário.' },
  { valor: 'tabelas', rotulo: 'Tabelas', dica: 'Procura só nas tabelas do formulário.' },
  {
    valor: 'local',
    rotulo: 'Pessoas e empresas',
    dica: 'Para perguntas sobre quem é uma pessoa ou uma empresa citada.',
  },
  {
    valor: 'global',
    rotulo: 'Visão geral',
    dica: 'Para perguntas amplas, que resumem o documento todo.',
  },
  {
    valor: 'cypher',
    rotulo: 'Dados organizados',
    dica: 'Consulta os dados já organizados em forma de grafo.',
  },
];

export const rotuloDoModoNaTela = (modo: string): string =>
  MODOS_DA_TELA.find((m) => m.valor === modo)?.rotulo ?? modo;

export const SUGESTOES: readonly string[] = [
  'Qual foi o lucro líquido ajustado em 2025?',
  'Quais são os principais fatores de risco de crédito?',
  'Quem é a Diretora Presidente do Banco do Brasil?',
];

const temEvidencia = (m: Mensagem): boolean => m.eventos.some((e) => e.evento === 'evidencia');

/** O selo da resposta; `null` quando não há o que dizer (em andamento, interrompida, ou uma resposta sem nenhuma evidência). */
export function seloDaResposta(m: Mensagem): Selo | null {
  if (m.estado === 'erro') return { chave: 'erro', texto: SELOS.erro };
  if (m.estado !== 'pronta' || !m.metricas) return null;
  switch (m.metricas.estado) {
    case 'ausente':
      return { chave: 'ausente', texto: SELOS.ausente };
    case 'incompleta':
      return { chave: 'parcial', texto: SELOS.parcial };
    case 'suficiente':
      return temEvidencia(m) ? { chave: 'encontrado', texto: SELOS.encontrado } : null;
    default:
      return null;
  }
}

const MAXIMO_SEM_CITACAO = 3;

/**
 * Um cartão por fonte citada na resposta que tenha página, sem repetir. Se nenhuma citada tem página, as primeiras evidências com
 * página (até três): a resposta se apoiou nelas mesmo sem marcar.
 */
export function cartoesDeFonte(m: Mensagem): CartaoFonte[] {
  const todas = montarRastro(m.eventos)
    .filter((p): p is Extract<PassoRastro, { tipo: 'evidencias' }> => p.tipo === 'evidencias')
    .flatMap((p) => p.evidencias);
  const vistos = new Set<string>();
  const comPagina: CartaoFonte[] = [];
  for (const ev of todas) {
    if (ev.pagina === null || ev.primeiraPagina === null || vistos.has(ev.id)) continue;
    vistos.add(ev.id);
    comPagina.push({
      id: ev.id,
      rotulo: ev.pagina,
      pagina: ev.primeiraPagina,
      tipo: ev.tipo,
      trecho: ev.trecho,
    });
  }
  const citadas = new Set((m.citacoes ?? []).map((c) => c.id));
  const dasCitadas = comPagina.filter((c) => citadas.has(c.id));
  return dasCitadas.length > 0 ? dasCitadas : comPagina.slice(0, MAXIMO_SEM_CITACAO);
}

/** O nome do tipo de fonte no cartão. */
export function nomeDoTipoDeFonte(tipo: string): string {
  switch (tipo) {
    case 'pai':
    case 'filho':
    case 'texto':
      return 'Texto do formulário';
    case 'tabela':
      return 'Tabela';
    case 'fato':
      return 'Dado financeiro';
    case 'entidade':
      return 'Pessoa ou empresa';
    default:
      return 'Fonte';
  }
}

interface NomeDaFerramenta {
  /** "Procurei <em>…". */
  em: string;
  /** "Não consegui consultar <obj>". */
  obj: string;
}

const FERRAMENTAS: Record<string, NomeDaFerramenta> = {
  buscar_trechos: { em: 'nos textos do formulário', obj: 'os textos do formulário' },
  buscar_tabelas: { em: 'nas tabelas do formulário', obj: 'as tabelas do formulário' },
  entidade: { em: 'entre as pessoas e empresas citadas', obj: 'as pessoas e empresas citadas' },
  panorama: { em: 'na visão geral do documento', obj: 'a visão geral do documento' },
  consultar_grafo: {
    em: 'nos dados organizados do documento',
    obj: 'os dados organizados do documento',
  },
  fato_financeiro: { em: 'nos indicadores financeiros', obj: 'os indicadores financeiros' },
  serie_metrica: { em: 'na série histórica do indicador', obj: 'a série histórica do indicador' },
  comparar_segmentos: { em: 'na comparação entre segmentos', obj: 'a comparação entre segmentos' },
  riscos: { em: 'nos riscos descritos', obj: 'os riscos descritos' },
  eventos: { em: 'nos eventos relevantes', obj: 'os eventos relevantes' },
  pessoas_cargos: { em: 'nos cargos e pessoas', obj: 'os cargos e as pessoas' },
  resposta_ja_dada: { em: 'na resposta anterior', obj: 'a resposta anterior' },
};

const nomeDe = (ferramenta: string): NomeDaFerramenta =>
  FERRAMENTAS[ferramenta] ?? {
    em: `em ${ferramenta.replaceAll('_', ' ')}`,
    obj: ferramenta.replaceAll('_', ' '),
  };

function resultados(n: number | null): string {
  if (n === null) return '';
  if (n === 0) return ' e não achei nada';
  return n === 1 ? ' e achei 1 resultado' : ` e achei ${n} resultados`;
}

/** "3,4 s" até 10 s, "12 s" depois; abaixo de 1 s, "menos de 1 s". */
export function duracaoEmTexto(ms: number): string {
  if (ms < 1000) return 'menos de 1 s';
  const s = ms / 1000;
  return s < 10 ? `${s.toFixed(1).replace('.', ',')} s` : `${Math.round(s)} s`;
}

function passo(p: PassoRastro): string | null {
  switch (p.tipo) {
    case 'reescrita':
      return p.rodada !== null && p.rodada >= 2
        ? 'Reformulei a pergunta para buscar o que faltava'
        : 'Entendi a pergunta';
    case 'rota':
      return p.forcado === null
        ? null
        : `Busca escolhida por você: ${rotuloDoModoNaTela(p.forcado)}`;
    case 'ferramenta_fim':
      return p.erro === null
        ? `Procurei ${nomeDe(p.ferramenta).em}${resultados(p.evidencias)}`
        : `Não consegui consultar ${nomeDe(p.ferramenta).obj}`;
    case 'critica':
      if (p.decisao === 'buscar_mais') return 'Faltava informação, então busquei de novo';
      if (p.decisao === 'suficiente') return 'Conferi que as informações bastavam';
      if (p.decisao === 'ausente') return 'Concluí que o documento não traz esse dado';
      return null;
    case 'reparo':
      return 'Corrigi frases sem base nas fontes';
    default:
      return null;
  }
}

/**
 * Os passos de "Como cheguei a esta resposta", na ordem em que aconteceram. Vazio quando a resposta não buscou nada (uma saudação,
 * um assunto fora do documento): só a reescrita da pergunta não conta, e a tela nem oferece o botão. O último passo ("Pronto em
 * …") só aparece se houve busca.
 */
export function passosDaResposta(m: Mensagem): string[] {
  const rastro = montarRastro(m.eventos);
  const buscou = rastro.some(
    (p) => p.tipo === 'ferramenta_fim' || (p.tipo === 'evidencias' && p.evidencias.length > 0),
  );
  if (!buscou) return [];
  const passos = rastro.map(passo).filter((s): s is string => s !== null);
  if (temEvidencia(m) && m.estado === 'pronta')
    passos.push('Escrevi a resposta com base nas fontes encontradas');
  if (m.metricas) passos.push(`Pronto em ${duracaoEmTexto(m.metricas.latenciaMs)}`);
  return passos;
}

export const LIMITE_TITULO = 48;

/** O título de uma conversa na lista: a primeira pergunta, cortada. */
export function tituloDaConversa(primeiraPergunta: string): string {
  const limpo = primeiraPergunta.replace(/\s+/g, ' ').trim();
  return limpo.length <= LIMITE_TITULO ? limpo : `${limpo.slice(0, LIMITE_TITULO - 1).trimEnd()}…`;
}

/** Um arquivo para baixar: o formato, o nome que o navegador salva, o tamanho e o endereço (sempre `/api/arquivos/<id>`). */
export interface ArquivoParaBaixar {
  formato: 'xlsx' | 'docx' | 'pptx' | 'svg';
  nome: string;
  bytes: number;
  url: string;
  /** "Baixar planilha (.xlsx)" */
  rotulo: string;
}

/** O material gerado (F8.10) como a tela o desenha: já validado, só texto e endereços do próprio servidor. */
export interface MaterialGerado {
  titulo: string;
  unidade: string;
  grafico: { url: string; descricao: string } | null;
  colunas: string[];
  linhas: string[][];
  arquivos: ArquivoParaBaixar[];
  removidos: number;
}

const ROTULO_DO_ARQUIVO: Record<ArquivoParaBaixar['formato'], string> = {
  xlsx: 'Baixar planilha (.xlsx)',
  docx: 'Baixar documento (.docx)',
  pptx: 'Baixar apresentação (.pptx)',
  svg: 'Baixar gráfico (.svg)',
};
/** Só o que a própria API serve: um endereço de outro lugar, `javascript:` ou `data:` nunca vira imagem nem link. */
const ENDERECO_DE_ARQUIVO = /^\/api\/arquivos\/[A-Za-z0-9-]{1,64}$/;
const LIMITE_LINHAS = 200;
const LIMITE_COLUNAS = 6;

const objeto = (x: unknown): x is Record<string, unknown> =>
  typeof x === 'object' && x !== null && !Array.isArray(x);
const texto = (x: unknown, max: number): string => (typeof x === 'string' ? x.slice(0, max) : '');

/** `p. 9-10` → `9`; sem número → `null` (para a página da tabela abrir o visualizador). */
export function paginaDaCelula(celula: string): string | null {
  return /^p\.\s*(\d+)/.exec(celula)?.[1] ?? null;
}

/** O tamanho em palavras de gente: "812 bytes", "24 KB". */
export function tamanhoEmTexto(bytes: number): string {
  if (bytes < 1024) return `${bytes} bytes`;
  return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

/**
 * O evento `artefato` da resposta, validado: o que vem fora da forma é descartado (nunca quebra a tela), o endereço que não é do
 * servidor some, e um formato desconhecido não vira link. `null` se a resposta não tem material ou ele não tem tabela.
 */
export function materialDaResposta(m: Mensagem): MaterialGerado | null {
  const e = m.eventos.find((x) => x.evento === 'artefato');
  if (e?.evento !== 'artefato') return null;
  const d = e.dados;
  const tabela = objeto(d['tabela']) ? d['tabela'] : null;
  const colunas = tabela && Array.isArray(tabela['colunas']) ? tabela['colunas'] : [];
  const linhas = tabela && Array.isArray(tabela['linhas']) ? tabela['linhas'] : [];
  if (colunas.length === 0 || colunas.length > LIMITE_COLUNAS) return null;
  const grafico = objeto(d['grafico']) ? d['grafico'] : null;
  const urlDoGrafico = grafico && typeof grafico['url'] === 'string' ? grafico['url'] : '';
  const arquivos: ArquivoParaBaixar[] = [];
  for (const a of Array.isArray(d['arquivos']) ? d['arquivos'] : []) {
    if (!objeto(a)) continue;
    const formato = a['formato'];
    const url = a['url'];
    if (
      (formato !== 'xlsx' && formato !== 'docx' && formato !== 'pptx' && formato !== 'svg') ||
      typeof url !== 'string' ||
      !ENDERECO_DE_ARQUIVO.test(url)
    )
      continue;
    const bytes = typeof a['bytes'] === 'number' && a['bytes'] >= 0 ? Math.trunc(a['bytes']) : 0;
    const nome = texto(a['nome'], 100).replace(/[^A-Za-z0-9._-]/g, '_') || `material.${formato}`;
    arquivos.push({ formato, nome, bytes, url, rotulo: ROTULO_DO_ARQUIVO[formato] });
  }
  return {
    titulo: texto(d['titulo'], 200),
    unidade: texto(d['unidade'], 60),
    grafico:
      grafico && ENDERECO_DE_ARQUIVO.test(urlDoGrafico)
        ? { url: urlDoGrafico, descricao: texto(grafico['descricao'], 1500) }
        : null,
    colunas: colunas.map((c) => texto(c, 80)),
    linhas: linhas
      .slice(0, LIMITE_LINHAS)
      .filter((l): l is unknown[] => Array.isArray(l))
      .map((l) => colunas.map((_, i) => texto(l[i], 120))),
    arquivos,
    removidos:
      typeof d['removidos'] === 'number' && d['removidos'] > 0 ? Math.trunc(d['removidos']) : 0,
  };
}
