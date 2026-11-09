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
        loadComponent: () => import('./paginas/rastro/rastro.page').then((m) => m.RastroPage),
      },
      {
        path: 'fontes',
        loadComponent: () => import('./paginas/fontes/fontes.page').then((m) => m.FontesPage),
      },
      {
        path: 'grafo',
        loadComponent: () => import('./paginas/grafo/grafo.page').then((m) => m.GrafoPage),
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
