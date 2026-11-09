# F8.6: medida de "trocar o modo muda a rota observada no Rastro" (definição fixada ANTES de rodar)

Aceite da etapa: "trocar o modo muda a rota observada no Rastro".

## O que a etapa entrega (para a medida fazer sentido)

Até a F8.5 a API só aceitava `mode: "auto"` (os outros valores davam 400). A F8.6 implementa os modos na API e a tela de Configurações que os escolhe. Um modo diferente de `auto` **força a ferramenta** da subpergunta, sem passar pelo roteador do LLM; o resto do ciclo (reescrita, crítico, redator) segue igual:

| Modo | Ferramenta forçada |
|---|---|
| `trechos` | `buscar_trechos` |
| `tabelas` | `buscar_tabelas` |
| `local` | `entidade` |
| `global` | `panorama` |
| `cypher` | `consultar_grafo` |
| `auto` | a que o roteador escolher |

## Definições

- **Perguntas**: **T15** (factual de texto), **N01** (numérica) e **G03** (de grafo), as mesmas três da medida do Rastro (F8.3). Cada uma é feita 6 vezes: `auto` e os 5 modos forçados.
- **Como se troca o modo**: pela interface, na página Configurações (escolher o modo, voltar ao chat e perguntar). A medida não manda `mode` por fora do navegador.
- **Rota observada**: a lista (sem repetir, em ordem) das ferramentas dos passos "Rota" da aba **Rastro** da resposta (`data-ferramentas` de cada passo `rota`, todas as rodadas), lida do DOM depois de "Resposta pronta." ou do fim com erro. A busca de trechos que o agente acrescenta às ferramentas especializadas (o complemento) não é um passo "Rota" e não conta.
- **Esperado no modo forçado**: exatamente a ferramenta da tabela acima.

## Regra de aceite (fixada agora)

- Cumprido só se as **15 de 15** execuções forçadas (3 perguntas × 5 modos) tiverem como rota observada **exatamente** a ferramenta do modo, **e**, em cada pergunta, as 5 rotas forçadas forem diferentes entre si e pelo menos 4 delas diferentes da rota do `auto` (a do `auto` pode coincidir com uma só).
- O pedido que o navegador manda também é conferido: o `mode` do corpo de `POST /api/chat` tem de ser o escolhido.
- Se não, a etapa fica `[~]` com os números como saíram, e a regra não muda depois: uma reescrita do aceite só por decisão do dono, registrada como pós-hoc.

## Medidas à parte, sem entrar no aceite

- Se a resposta terminou ("Resposta pronta.") ou deu erro, o estado do ciclo (`suficiente`, `incompleta`, `ausente`) e o número de evidências, por execução: **a qualidade da resposta num modo forçado não é medida**; um modo que não serve para a pergunta (por exemplo `tabelas` para uma pergunta de texto) pode acabar em "o documento não tem esse dado".
- O tempo de cada execução.
- Uma execução do perfil `consultar-rapido` (T15, modo `auto`) pela interface: o corpo traz `profile: "consultar-rapido"` e o Rastro não tem "Rodada 2".

Limites já sabidos: n = 3 perguntas, 1 execução por par; a rota do `auto` depende do Qwen e pode mudar de uma execução para outra; o modo `local` passa a pergunta inteira como "nome" da entidade (a ferramenta foi feita para um nome), o que pode devolver pouco.

Reprodução: ver o ADR-072.
