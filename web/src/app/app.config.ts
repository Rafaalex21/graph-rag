import { ApplicationConfig, EnvironmentProviders, Provider, provideBrowserGlobalErrorListeners } from '@angular/core';
import { DefaultUrlSerializer, UrlSerializer, UrlTree, provideRouter, withComponentInputBinding } from '@angular/router';
import { routes } from './app.routes';

/**
 * Um endereço malformado (`/%E0%A4%A`) faria o roteador voltar para `/` sem avisar. Aqui ele vira um caminho que não existe,
 * e a rota `**` mostra "Página não encontrada".
 */
export class SerializadorTolerante extends DefaultUrlSerializer {
  override parse(url: string): UrlTree {
    try {
      return super.parse(url);
    } catch {
      return super.parse('/endereco-invalido');
    }
  }
}

/** Os provedores do roteador, em um lugar só para a aplicação e os testes usarem os mesmos. */
export const provedoresDoRoteador: (Provider | EnvironmentProviders)[] = [
  // `data` da rota entra como `input()` do componente (usado pelas abas do painel)
  provideRouter(routes, withComponentInputBinding()),
  { provide: UrlSerializer, useClass: SerializadorTolerante },
];

export const appConfig: ApplicationConfig = {
  providers: [provideBrowserGlobalErrorListeners(), ...provedoresDoRoteador],
};
