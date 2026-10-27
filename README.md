# GraphRAG local

Assistente que responde, com citações, perguntas sobre um documento financeiro extenso — usando **somente modelos locais** (llama.cpp numa RX 9070 de 16 GB, 32 GB de RAM), um grafo no Neo4j e uma interface em Angular.

Baseado em *Essential GraphRAG* (Bratanič & Hane, Manning, 2025).

> Estado: especificação v0.1 pronta; implementação começando pela fase **F0**. O andamento real está nas [issues](../../issues) e nos [marcos](../../milestones).

## Onde está o quê

| Documento | Para quê |
|---|---|
| [`docs/ARQUITETURA.md`](docs/ARQUITETURA.md) | O desenho: pipeline de indexação, modelo de grafo, agente, matriz de modelos, perfis do `llama-swap`, avaliação, riscos e ADRs |
| [`docs/ETAPAS.md`](docs/ETAPAS.md) | O plano: 11 fases, 72 tarefas, cada uma com critério de aceite e dependências |
| [`docs/adr/`](docs/adr) | Decisões de arquitetura, uma por arquivo |

## Como o plano vira trabalho

`docs/ETAPAS.md` é a fonte da verdade. Cada fase é um **marco** e cada tarefa uma **issue** (`F2.3 · …`).

- Mudou o plano ou concluiu uma tarefa? Edite o `ETAPAS.md` (`[~]` em andamento, `[x]` concluída, `[!]` bloqueada) e faça o *push*. A ação **ETAPAS** valida o arquivo e sincroniza as issues (fecha, reabre, cria).
- Conferir o arquivo localmente: `python tools/etapas.py check` · progresso: `python tools/etapas.py resumo`.
- Sincronizar à mão: `python tools/etapas_to_issues.py` (ou `--dry-run` para ver o plano).
- O painel visual (`etapas-graphrag.html`) lê o mesmo arquivo.

Uma tarefa só vira `[x]` quando o **critério de aceite** foi verificado.

## Primeiros passos

```powershell
# 1) cria o repositório no GitHub, envia o código e gera marcos + issues
.\tools\bootstrap-github.ps1            # privado por padrão; -Visibilidade public se preferir
# (-Simular mostra o que faria, sem tocar em nada)

# 2) siga a fase F0 (docs/ETAPAS.md): llama.cpp, modelos, Neo4j, esqueleto dos apps
```

Requisitos para o passo 1: Git, GitHub CLI (`gh`) e Python 3.10+.

## Estrutura

```
docs/        especificação, plano e ADRs
infra/       docker-compose, llama-swap, lock de modelos, scripts de subida
contracts/   esquema do grafo e contrato da API (a fronteira entre indexador e API)
indexer/     Python — parsing, extração, grafo, embeddings
api/         TypeScript — agente, ferramentas, SSE
web/         Angular 22 — interface do assistente
eval/        golden set, métricas e resultados
data/        documentos e artefatos (fora do git)
tools/       automação do plano e do GitHub (tools/github vira .github no bootstrap)
```

## Licença

A definir. Enquanto não houver arquivo `LICENSE`, todos os direitos permanecem com o autor.
