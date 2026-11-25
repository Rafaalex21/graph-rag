# ADR-083 · README validado pelo teste "de fora": a p4 subiu o projeto seguindo só o README, depois de três rodadas que falharam

- **Estado:** aceita (25/11/2026); regras de `eval/f101-medida-readme.md` aplicadas como estavam, sem nenhum veredito trocado depois do resultado
- **Data:** 2026-11-25
- **Tarefa(s):** F10.1

## Contexto

O aceite da F10.1 é "alguém de fora sobe o projeto seguindo só o README". A medida foi fixada antes de qualquer rodada, em `eval/f101-medida-readme.md`. O "alguém de fora" é um subagente sem o histórico do projeto, num clone limpo, com um enunciado fixo. A rodada que vale é a fase completa, do clone até `GET http://127.0.0.1:4200/` em 200 e a pergunta T01 respondida pelo `POST /api/chat` até o evento `fim`. Toda rodada é contada.

## Decisão

O README do commit `3e13de1` é aceito como caminho de subida do projeto. O resultado está em `eval/f101-medida-readme.md`:

| Rodada | Resultado | O que mudou depois |
|---|---|---|
| c1 (curta) | chegou ao fim da fase curta | errata 1: consertos dos atritos de instalação |
| p1 | interrompida (o dono precisou do PC) | errata 2: tempos reais da indexação e regra de pausa a pedido do dono |
| p2 | falhou no critério: a interface escutava só em `::1` | errata 3: `ng serve` em `127.0.0.1` |
| p3 | falhou: o Qwen não carregava (um programa de fora do projeto ocupava 88 GB) | errata 4: `relatorios gerar` deixa de engolir falha do LLM; seção "Se algo der errado" |
| **p4** | **passou**: `GET /` 200; T01 em `fim` com 2 citações (p. 6 e p. 145) e "União Federal, que detém 50,0%" | — |

A p4 levou de 24/11 07:44 a 25/11 12:24, cerca de 13 h 40 de trabalho efetivo. No caminho houve uma pausa a pedido do dono, três quedas de luz e um desligamento do PC. Cada uma foi tratada pela regra de pausa da errata 2: um subagente novo, com o mesmo enunciado e uma frase fixa, sem nenhuma informação minha sobre a etapa. As quedas de luz entraram nessa regra por decisão registrada antes da primeira retomada depois de uma queda. Nas cinco retomadas, o subagente achou o ponto de parada pelo README e pelos logs. O critério foi conferido por mim depois do relatório do subagente.

## Consequências

- O caminho de **retomada** do README foi o que mais se exercitou, cinco vezes. É o caminho que quem indexa em casa vai usar.
- **Defeito do projeto achado:** os caches da indexação são gravados sem escrita atômica e lidos sem tolerância. Uma queda de luz durante a gravação deixou 3 arquivos de `metricas_cache` inválidos, e a retomada caiu com `JSONDecodeError` até o subagente tirar os arquivos do caminho. O conserto (gravar em arquivo temporário e renomear; tratar arquivo inválido como ausente) entra antes da rodada ao vivo da F10.2, que também indexa por ~13 h. Junto vão os atritos de leitura do log na retomada, como confirmar que uma etapa longa não travou, os avisos inofensivos do Neo4j, o contador do `f58_estado.txt` e o `pergunta.json` sem `.gitignore`.
- **Limites:** o "alguém de fora" é um agente da mesma família, na mesma máquina; outra máquina pode ter atritos de driver, PATH ou rede. O ramo "baixar a versão atual" do PDF não foi testado. O README depende do ambiente ter memória livre: a p3 mostrou que um programa de fora pode impedir o Qwen de carregar, e o README agora diz onde ver isso.
- A F10.2 (subida com dois comandos) e a F10.3 (vídeo) passam a poder rodar, com a GPU livre.
