# ADR-009 · Escolha do documento financeiro

- **Estado:** aceita (28/10/2026): o usuário escolheu o Formulário de Referência 2026 do **Banco do Brasil** (v7, PDF); o levantamento de candidatos tem uma errata (ver abaixo)
- **Data:** 2026-10-28
- **Tarefa(s):** F1.1

## Contexto

A ARQUITETURA §16 pede um documento com: (1) ≥ 200 páginas; (2) PDF nativo; (3) mistura de narrativa e tabelas; (4) muitas entidades (subsidiárias, executivos, contrapartes, reguladores); (5) vários períodos comparados; (6) idealmente, gabarito público. Este registro reúne candidatos com fonte, páginas, idioma e condições de uso verificados na fonte.

### Como foi medido

- **Páginas:** leitura parcial do PDF por HTTP Range (campo `/N` de PDFs linearizados ou `/Count` da árvore `/Pages`). Para o PDF baixado, contagem confirmada com `pypdf` (423 páginas).
- **Condições de uso:** ficha do conjunto no Hugging Face, metadados do CKAN da CVM e páginas de termos dos emissores, quando acessíveis.
- **Metadados de filings:** API `data.sec.gov/submissions` do EDGAR e o índice `fre_cia_aberta_2026.csv` da CVM.

## Errata (28/10/2026)

A primeira versão deste ADR atribuiu à **Petrobras** um PDF de **423 páginas** (8,72 MB) achado no site de RI de uma empresa. Ao baixar o arquivo e abri-lo, a página 2 dizia *"Banco do Brasil S.A. | Relações com Investidores"*: **o PDF é do Banco do Brasil, não da Petrobras**. O erro veio de uma busca sobre a Petrobras que listou o PDF do BB (a própria busca já avisava) e do nome genérico do arquivo (`Formulário de Referência 2026.pdf`), que não conferi. As linhas A e A2 da tabela abaixo estão corrigidas. Verificações que passam a ser regra neste levantamento: abrir o arquivo e conferir o emissor na capa antes de registrar páginas.

## Candidatos

| # | Documento | Idioma | Páginas | Arquivo | Gabarito público | Uso |
|---|---|---|---:|---|---|---|
| A | **Petrobras, Formulário de Referência 2026** (ano-base 2025; **12 versões** entre 22/05 e 11/09/2026) | PT | **PDF não localizado.** A CVM entrega o FRE como **XML estruturado** (ZIP de 8,4 MB, XML de 19 MB, v12), sem paginação | XML no RAD/ENET da CVM; o PDF só existiria no RI da Petrobras, que não localizei | **Sim, estruturado:** dados abertos da CVM (`fre_cia_aberta_2026.zip`, 34 CSVs) | Dados da CVM sob **ODbL**. Termos do RI da Petrobras: uso pessoal e impressão permitidos; **reprodução, distribuição, divulgação e uso comercial exigem autorização escrita** |
| A2 | **Banco do Brasil, Formulário de Referência 2026** (v7, 21/09/2026; 7 versões desde 29/05/2026) | PT | **423** (confirmado com `pypdf`) | PDF de 8,72 MB, Adobe Acrobat, com camada de texto (59 de 60 páginas amostradas, ~2.700 caracteres por página); **já baixado** em `data/raw/` | **Sim, estruturado:** o mesmo dataset da CVM (7 linhas do BB) | Dados da CVM sob ODbL. O site de RI do BB **não declara condições de uso** (só um link de política de privacidade, não lido) |
| B | Petrobras, Form 20-F FY2025 (SEC, abr/2026) | EN | não medida: no EDGAR é **HTML** (58,0 MB); PDF oficial não localizado | HTML no EDGAR | Parcial (XBRL, não verificado) | Público; reuso não verificado |
| C | Vale, Form 20-F FY2025 (SEC, 27/03/2026) | EN | **193** (cópia de terceiro, minedocs) · 207 no 20-F 2024 do RI da Vale | PDF de 4,4 MB (terceiro); EDGAR em HTML (169,5 MB) | Não | Cópia de terceiro não é fonte oficial |
| D | **FinanceBench, 10-K 2022: American Express** | EN | **260** (2,44 MB) | PDF já no repositório do FinanceBench | **Sim:** 7 perguntas abertas com resposta e página | Conjunto sob **CC BY-NC 4.0**: uso não comercial |
| E | FinanceBench, 10-K 2022: Boeing · AMD | EN | 190 · 121 | PDFs no repositório | 7 perguntas abertas cada | CC BY-NC 4.0 |
| F | BCB, Relatório de Estabilidade Financeira (out/2026) | PT | **117** (13,5 MB) | PDF no site do BCB | Não | Termos do BCB não verificados |
| G | Relatório Anual Integrado de 2025 (ex.: Itaú) | PT | não verificado (site do RI devolve HTTP 403 a acesso automatizado) | n/d | Não | n/d |

Contexto do FinanceBench: 150 perguntas abertas em 84 documentos (no máximo 7 por documento), de três tipos (50 de cada).

## Aderência aos critérios da §16

| Critério | A · FRE Petrobras | A2 · FRE Banco do Brasil | C · 20-F Vale | D · 10-K AmEx | F · REF BCB |
|---|---|---|---|---|---|
| ≥ 200 páginas | **sem páginas** (XML) | **sim (423)** | não (193 a 207, no limite) | **sim (260)** | não (117) |
| PDF nativo | **não localizado** (XML) | **sim** | só de terceiro | **sim** | sim |
| Narrativa e tabelas | sim | sim | sim | sim | sim |
| Muitas entidades | sim | sim (controladas, administradores, acionistas, partes relacionadas) | sim | média | poucas empresas |
| Vários períodos | não conferido | não conferido neste documento | sim | sim (2020 a 2022) | sim (séries macro) |
| Gabarito público | **sim, estruturado (ODbL)** | **sim, estruturado (ODbL)** | não | sim, mas só **7 perguntas** | não |
| Condições de reuso | **restritivas** (autorização para reproduzir ou divulgar) | **não declaradas** no RI | cópia de terceiro | CC BY-NC 4.0 | não verificadas |

## Consequências de cada escolha (para a decisão)

- **Versão do documento:** o FRE é reapresentado a cada atualização (Petrobras: 12 versões em 4 meses; BB: 7). O projeto precisa **congelar uma versão com hash** (RNF-7). O PDF do BB já em mãos é a v7.
- **Páginas e citação:** a citação `[p. N]` exige PDF. Com o XML da CVM não há páginas; usar o XML mudaria o parser (F1.3 a F1.5) e a citação.
- **Divulgação (F10):** README com GIF, vídeo e artigo vão exibir trechos do documento. Com a Petrobras, os termos pedem autorização escrita para reproduzir ou divulgar; com o BB, os termos não estão declarados (um e-mail à RI do emissor resolveria); com o FinanceBench, o uso é só não comercial.
- **Gabarito do golden set (F3.1):** com D, só 7 das 60 perguntas têm gabarito público; com A ou A2, os CSVs da CVM permitem derivar gabarito para agregação, filtro e multi-hop (administradores, acionistas, controladas, partes relacionadas, remuneração). Para perguntas numéricas de demonstrações financeiras, o FRE é mais fraco que um 20-F ou 10-K.
- **Idioma:** PT combina com os prompts e o índice `brazilian`; EN exercita embeddings translíngues.
- **Tempo de indexação:** a estimativa da ARQUITETURA §5.2 (~4,6 h) é para ~300 páginas; escala para ~6,5 h com 423 páginas. O ciclo F1 a F5 roda antes num recorte de até 80 páginas.

## Decisão

Usar o **Formulário de Referência 2026 (ano-base 2025) do Banco do Brasil S.A., versão 7, de 21/09/2026**, como documento do projeto. A escolha foi do usuário, depois da errata sobre o PDF da Petrobras.

| Item | Valor |
|---|---|
| Emissor | Banco do Brasil S.A. (banco; CNPJ 00.000.000/0001-91) |
| Documento | Formulário de Referência 2026, ano-base 2025, **versão 7** (a página 2 do PDF lista as 7 versões, de 29/05 a 21/09/2026, idêntico ao índice da CVM: `ID_DOC` 161398, recebido em 21/09/2026) |
| Fonte do PDF | Site de Relações com Investidores do BB (arquivo hospedado em `api.mziq.com`): `https://api.mziq.com/mzfilemanager/v2/d/5760dff3-15e1-4962-9e81-322a0b3d0bbd/8ddd4264-6e9d-e147-24c6-8941de61c467?origin=2` |
| Páginas | **423** físicas (confirmado com `pypdf`); PDF 1.7, 8.719.214 bytes, sem criptografia, criado com Adobe Acrobat em 21/09/2026 |
| Camada de texto | 59 de 60 páginas amostradas com texto (média de ~2.700 caracteres por página) |
| Idioma | Português do Brasil |
| Versão congelada | SHA-256 `b0d175661531fdd672a0db7abd44931cb43b05a122264a33cbe9e6186e3432b4` (o FRE é reapresentado a cada atualização; o projeto trabalha sempre sobre este arquivo, RNF-7) |
| Arquivo local | `data/raw/banco_do_brasil_formulario_referencia_2026.pdf` (fora do git) |
| Dados estruturados (gabarito) | Dataset de FRE da CVM, `fre_cia_aberta_2026.zip` (ODbL), com as 7 versões do BB; **ainda não baixado** (será pedido o OK na F3.1) |

### Condições de uso

- **Dados estruturados da CVM:** licença **ODbL** (atribuição e compartilhamento sob a mesma licença das bases derivadas).
- **O PDF:** documento público protocolado na CVM. O site de RI do BB **não declara condições de uso** (só uma política de privacidade, que não li). O arquivo fica **fora do git**, para uso interno do projeto.
- **Divulgação (F10):** README com GIF, vídeo e artigo exibirão trechos do documento. **Antes de publicar qualquer trecho, pedir autorização à RI do Banco do Brasil**; esta pendência fica registrada na F10.1.

### Por que este documento

Atende aos critérios da §16: 423 páginas (≥ 200), PDF nativo com texto, mistura de narrativa e tabelas, muitas entidades (controladas, administradores, acionistas, partes relacionadas) e gabarito público estruturado nos dados abertos da CVM. É um banco, o que combina com o domínio "financeiro", e está em português, o idioma dos prompts e do índice `brazilian`.

### Contrapartidas assumidas

- O FRE é mais fraco que um 20-F ou 10-K para perguntas sobre demonstrações financeiras completas; a seção de comentários dos diretores traz resultados, não as demonstrações. O golden set (F3.1) terá mais perguntas de entidades, governança e riscos do que de números de balanço.
- A comparação de vários períodos não foi conferida neste documento.
- Tempo de indexação estimado em ~6,5 h para 423 páginas (ARQUITETURA §5.2, escalado); o ciclo F1 a F5 roda antes num recorte de até 80 páginas (F1.2).
- **Numeração de páginas:** o PDF tem 423 páginas físicas, mas o número impresso é a página física menos 1 (a capa não é numerada; o sumário usa a numeração impressa, por exemplo a seção 1 começa na impressa 5, física 6). **As citações do projeto usam a página física**, a mesma do `pdf.js` (F8.4); a F1.5 deve registrar o deslocamento ao comparar o sumário.

## Arquivos baixados (não versionados, em `data/raw/`)

| Arquivo | Conteúdo | Tamanho | SHA-256 |
|---|---|---:|---|
| `banco_do_brasil_formulario_referencia_2026.pdf` | FRE 2026 do Banco do Brasil (v7), PDF de 423 páginas | 8.719.214 bytes | `b0d175661531fdd672a0db7abd44931cb43b05a122264a33cbe9e6186e3432b4` |
| `petrobras_fre_2026_v12_cvm.zip` | **Não usado.** FRE 2026 da Petrobras (v12) em XML, da CVM (`009512FRE31-12-2026v12.xml`, 19.065.346 bytes, e `FormularioCadastral.xml`); guardado só como material do levantamento | 8.405.591 bytes | `d0c4fd090b954b481a04bce7e701d16f3e3a617a7837bd0bcb87179aced8ca1c` |

## Evidência

Fontes consultadas em 28/10/2026: ficha do conjunto `PatronusAI/financebench` no Hugging Face (`cc-by-nc-4.0`) e repositório `patronus-ai/financebench`; EDGAR `data.sec.gov/submissions` (Petrobras CIK 1119639, Vale CIK 917851, Itaú CIK 1132597); CKAN da CVM (`cia_aberta-doc-fre`, licença `odc-odbl`, atualizado em 26/10/2026) e o índice `fre_cia_aberta_2026.csv` (2.239 linhas; Petrobras CNPJ 33.000.167/0001-01 com 12 versões, BB com 7); download do FRE da Petrobras no RAD da CVM (`frmDownloadDocumento.aspx`, `NumeroSequencialDocumento=161309`); termos de uso do RI da Petrobras (`investidorpetrobras.com.br/politicas-e-termos-de-uso/`, atualizado em 11/03/2021) e página do RI do BB (`ri.bb.com.br`); abertura do PDF do BB com `pypdf` (423 páginas, sem criptografia, criado em 21/09/2026).
