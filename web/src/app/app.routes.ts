import { Routes } from '@angular/router';

const SUFIXO = 'GraphRAG local';

/**
 * As páginas são carregadas sob demanda. O painel do chat (Rastro, Fontes, Grafo) é uma rota filha de `/chat`: a aba ativa
 * fica na URL, e as tarefas F8.3 a F8.5 trocam o componente de cada aba sem mexer no resto.
 */
export const routes: Routes = [
  { path: '', pathMatch: 'full', redirectTo: 'chat' },
  {
    path: 'chat',
    title: `Chat · ${SUFIXO}`,
    loadComponent: () => import('./paginas/chat/chat.page').then((m) => m.ChatPage),
    children: [
      { path: '', pathMatch: 'full', redirectTo: 'rastro' },
      {
        path: 'rastro',
        loadComponent: () => import('./paginas/painel/painel-vazio').then((m) => m.PainelVazio),
        data: { titulo: 'Rastro', texto: 'Aqui aparece o caminho de cada resposta: a pergunta reescrita, a rota escolhida, o Cypher, as evidências e a crítica.' },
      },
      {
        path: 'fontes',
        loadComponent: () => import('./paginas/painel/painel-vazio').then((m) => m.PainelVazio),
        data: { titulo: 'Fontes', texto: 'Aqui abre a página do documento que sustenta cada afirmação, com o trecho destacado.' },
      },
      {
        path: 'grafo',
        loadComponent: () => import('./paginas/painel/painel-vazio').then((m) => m.PainelVazio),
        data: { titulo: 'Grafo', texto: 'Aqui aparece o subgrafo usado na resposta, com a vizinhança de cada entidade a um clique.' },
      },
    ],
  },
  {
    path: 'configuracoes',
    title: `Configurações · ${SUFIXO}`,
    loadComponent: () => import('./paginas/configuracoes/configuracoes.page').then((m) => m.ConfiguracoesPage),
  },
  {
    path: '**',
    title: `Página não encontrada · ${SUFIXO}`,
    loadComponent: () => import('./paginas/nao-encontrada/nao-encontrada.page').then((m) => m.NaoEncontradaPage),
  },
];
