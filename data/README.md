# data/

Fora do git (ver `.gitignore`). Estrutura esperada:

- `raw/` — o documento original e o recorte de ≤ 80 páginas (F1.1–F1.2)
- `parsed/` — saída do Docling (JSON) e árvore de seções
- `cache/` — respostas dos LLMs memorizadas por hash do trecho + versão do prompt

O documento escolhido e sua origem ficam registrados em `docs/adr/ADR-009-documento.md`. Hoje: `raw/banco_do_brasil_formulario_referencia_2026.pdf` (FRE 2026 do Banco do Brasil, v7, 423 páginas). Recorte da F1.2: `raw/bb_fre_2026_recorte.pdf` (79 páginas) e `raw/bb_fre_2026_recorte_mapa.json`.
