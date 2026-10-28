# ADR-009 · Escolha do documento financeiro

- **Estado:** proposta: levantamento de candidatos feito em 28/10/2026; **a decisão é do usuário e está pendente**
- **Data:** 2026-10-28
- **Tarefa(s):** F1.1

## Contexto

A ARQUITETURA §16 pede um documento com: (1) ≥ 200 páginas; (2) PDF nativo; (3) mistura de narrativa e tabelas; (4) muitas entidades (subsidiárias, executivos, contrapartes, reguladores); (5) vários períodos comparados; (6) idealmente, gabarito público. Este registro reúne candidatos com fonte, páginas, idioma e condições de uso **verificados na fonte**, sem baixar nenhum documento.

### Como foi medido

- **Páginas:** leitura parcial do PDF por HTTP Range (início e fim do arquivo), usando o campo `/N` de PDFs linearizados (contagem confiável) ou o `/Count` da árvore `/Pages` (confiável quando a raiz é única). Nenhum PDF foi baixado ou salvo.
- **Condições de uso:** ficha do conjunto no Hugging Face, metadados do CKAN da CVM e páginas dos emissores, quando acessíveis.
- **Metadados de filings:** API `data.sec.gov/submissions` do EDGAR.

## Candidatos

| # | Documento | Idioma | Páginas | Arquivo | Gabarito público | Uso |
|---|---|---|---:|---|---|---|
| A | **Petrobras, Formulário de Referência 2026** (ano-base 2025, protocolado na CVM em 22/05/2026) | PT | **423** | PDF de 8,72 MB com camada de texto, no RI da Petrobras | **Sim, estruturado:** o mesmo formulário em dados abertos da CVM (`fre_cia_aberta_2026.zip`, 8,2 MB, 34 CSVs: auditor, capital social, posição acionária, participações em sociedades, remuneração, partes relacionadas, comitês, administradores, subordinação) | Dados da CVM sob **ODbL**; o PDF é um documento público protocolado na CVM, e os termos de reuso do site da Petrobras não foram verificados |
| B | **Petrobras, Form 20-F FY2025** (SEC, abr/2026) | EN | não medida: no EDGAR é **HTML** (58,0 MB); **PDF oficial não localizado** | HTML no EDGAR | Parcial: números financeiros também existem como dados XBRL no EDGAR (não verificado para este arquivo) | Documento público do EDGAR; política de reuso do emissor não verificada |
| C | **Vale, Form 20-F FY2025** (SEC, 27/03/2026) | EN | **193** (cópia de terceiro, minedocs) · 207 no 20-F 2024 do RI da Vale | PDF de 4,4 MB (terceiro); no EDGAR, HTML de 169,5 MB | Não | Cópia de terceiro não é fonte oficial; o EDGAR é a oficial (HTML) |
| D | **FinanceBench, 10-K 2022**: American Express | EN | **260** (2,44 MB) | PDF já no repositório do FinanceBench | **Sim:** 7 perguntas abertas com resposta e página de evidência | Conjunto sob **CC BY-NC 4.0** (ficha no Hugging Face): uso não comercial; o README do repositório não declara licença |
| E | FinanceBench, 10-K 2022: Boeing · AMD | EN | **190** · **121** | PDFs no repositório | Sim: 7 perguntas abertas cada | CC BY-NC 4.0 |
| F | **BCB, Relatório de Estabilidade Financeira** (out/2026) | PT | **117** (13,5 MB) | PDF no site do BCB | Não | Termos do BCB não verificados |
| G | Relatório Anual Integrado de 2025 (ex.: Itaú Unibanco) | PT | **não verificado**: o site do RI devolve HTTP 403 a acesso automatizado | n/d | Não | n/d |

Contexto do FinanceBench: o conjunto aberto tem **150 perguntas em 84 documentos** (no máximo 7 por documento), de três tipos (50 de cada: geradas por métrica, relevantes ao domínio, inéditas). Os PDFs são 10-K, 10-Q, 8-K e releases de resultados de empresas dos EUA.

## Aderência aos critérios da §16

| Critério | A · FRE Petrobras | B · 20-F Petrobras | C · 20-F Vale | D · 10-K AmEx | F · REF BCB |
|---|---|---|---|---|---|
| ≥ 200 páginas | **sim (423)** | provável, não medida | **não (193 a 207, no limite)** | **sim (260)** | **não (117)** |
| PDF nativo | **sim** | **não localizado** (HTML) | só de terceiro | **sim** | sim |
| Narrativa e tabelas | sim | sim | sim | sim | sim |
| Muitas entidades | **sim** (controladas, administradores, acionistas, partes relacionadas) | sim | sim (subsidiárias, litígios) | média | poucas empresas |
| Vários períodos | parcial (remuneração e resultados de 3 exercícios, segundo a estrutura padrão do FRE; não conferido neste documento) | sim | sim | sim (2020 a 2022) | sim (séries macro) |
| Gabarito público | **sim, estruturado (ODbL)** | parcial | não | **sim, mas só 7 perguntas** | não |

## Consequências de cada escolha (para a decisão)

- **Idioma:** A e F em português combinam com os prompts, o `analisador` `brazilian` do índice full-text e o mapeamento terminológico PT↔EN; B, C e D em inglês exercitam embeddings translíngues (a ARQUITETURA §16 já nota que perguntas em português sobre documento em inglês são um bom teste).
- **Gabarito do golden set (F3.1):** com D, só 7 das 60 perguntas teriam gabarito público; com A, os CSVs da CVM permitem derivar gabarito estruturado (Cypher ou valor) para perguntas de agregação, filtro e multi-hop sobre administradores, acionistas, controladas e partes relacionadas. Para perguntas numéricas de demonstrações financeiras, o FRE é mais fraco que um 20-F ou 10-K.
- **Tempo de indexação:** a estimativa da ARQUITETURA §5.2 (~4,6 h) foi feita para ~300 páginas; escala aproximadamente com o tamanho, então ~6,5 h para 423 páginas (A) e ~4 h para 260 (D). Antes do documento inteiro, o ciclo F1 a F5 roda num recorte de até 80 páginas (F1.2).
- **Condições de uso:** D e E têm licença **não comercial** (CC BY-NC 4.0) no conjunto de perguntas; A usa dados ODbL (exige atribuição e compartilhamento de bases derivadas sob a mesma licença).

## Decisão

*Pendente.* Esta seção será preenchida quando o usuário escolher, com fonte, número de páginas, idioma e condições de uso do documento escolhido (critério de aceite da F1.1).

## Evidência

Fontes consultadas em 28/10/2026: ficha do conjunto `PatronusAI/financebench` no Hugging Face (licença `cc-by-nc-4.0`) e repositório `patronus-ai/financebench` (`data/financebench_open_source.jsonl`, `financebench_document_information.jsonl`, `pdfs/`); EDGAR `data.sec.gov/submissions` (Petrobras CIK 1119639, Vale CIK 917851, Itaú CIK 1132597); CKAN da CVM (`cia_aberta-doc-fre`, licença `odc-odbl`, atualizado em 26/10/2026) e o diretório do ZIP `fre_cia_aberta_2026.zip`; PDFs: Formulário de Referência 2026 no RI da Petrobras (423 páginas), `REF` de outubro de 2026 no site do BCB (117 páginas), `Vale-20F-12312025.pdf` no minedocs (193 páginas) e 20-F 2024 no RI da Vale (207 páginas).
