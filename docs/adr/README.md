# Decisões de arquitetura (ADRs)

Uma decisão por arquivo: `ADR-NNN-assunto.md`. As nove decisões iniciais estão resumidas na tabela da §15 de [`../ARQUITETURA.md`](../ARQUITETURA.md); cada uma ganha seu arquivo aqui quando a fase que a confirma (ou refuta) for concluída.

| ADR | Assunto | Onde se fecha |
|---|---|---|
| [001](ADR-001-backend.md) | Backend de inferência (Vulkan × HIP) | F0.4 — aceita, revisada na F0.5 |
| [010](ADR-010-offload-moe.md) | Offload de experts do Qwen3.6 (`-lm none`, `--n-cpu-moe`) | F0.5 — aceita, com as medições |
| [011](ADR-011-perfis-swap.md) | Perfis do `llama-swap` (motor `matrix`) e orçamento de VRAM | F0.6 — aceita |
| [012](ADR-012-neo4j-nativo.md) | Neo4j nativo no Windows, sem Docker nem WSL2 | F0.7 — aceita |
| [013](ADR-013-ferramentas-dev.md) | Ferramentas de desenvolvimento portáteis e TypeScript 6.0 fixado | F0.8 — aceita |
| [009](ADR-009-documento.md) | Documento escolhido | F1.1: proposta, aguardando a decisão |

Modelo em [`ADR-000-modelo.md`](ADR-000-modelo.md).
