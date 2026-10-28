# ADR-014 · Docling: versão, modelos e configuração do parsing

- **Estado:** aceita (28/10/2026)
- **Data:** 2026-10-28
- **Tarefa(s):** F1.3

## Contexto

A ARQUITETURA §5 (I-1) escolheu o Docling (layout Heron + TableFormer) para converter o PDF em um `DoclingDocument` com ordem de leitura, títulos e tabelas. A F1.3 instala o Docling, fixa versão e modelos e mede a conversão do recorte de 79 páginas (ADR-009).

## Decisão

1. **Docling 2.144.0** num **grupo opcional `parse`** do `indexer` (`uv sync --group parse`), fora do grupo padrão. O resolvedor traz 128 pacotes, entre eles o `torch` (build de CPU no Windows); no Linux do CI o `torch` viria com as bibliotecas CUDA (alguns GB), e o CI não precisa delas.
2. **Modelos fixados por commit** e baixados só os arquivos usados, em `infra/bin/modelos-docling` (fora do git), com SHA-256 conferido contra o publicado pelo Hugging Face:
   - layout `docling-project/docling-layout-heron` @ `8f39ad3c0b4c` (171,7 MB, Apache-2.0); o padrão do Docling aponta para `main`, que é flutuante;
   - TableFormer *accurate* de `docling-project/docling-models` @ `v2.3.0` (`fc0f2d45e221`, 212,8 MB, CDLA-Permissive-2.0 e Apache-2.0).
3. **Configuração:** OCR desligado, `TableFormerMode.ACCURATE`, CPU com 6 threads (a RX 9070 não tem CUDA e o llama.cpp já ocupa a GPU), conversão **offline** (`HF_HUB_OFFLINE=1`, RNF-1).
4. **Código:** `indexer/src/indexer/parse.py` (`converter_pdf`, `cobertura_texto` e uma CLI); o Docling é importado só dentro de `converter_pdf`, então os testes e o CI não dependem do grupo `parse`.
5. A saída é o `DoclingDocument` em JSON (`data/parsed/<pdf>.docling.json`, fora do git) mais um resumo de tempo e cobertura (`<pdf>.tempo.json`, copiado para `ADR-014-bruto/`).

## Alternativas consideradas

- **TableFormer *fast*.** Mais rápido, mas o aceite e a ARQUITETURA pedem *accurate* para tabelas financeiras (145,5 MB a menos de download; pode voltar se o tempo da F5.8 virar problema).
- **OCR ligado.** O documento é PDF nativo com camada de texto (ADR-009); o OCR só acrescentaria tempo e erros.
- **Docling como dependência padrão.** Faria o CI baixar o `torch` com CUDA no Linux a cada execução.
- **GPU.** Sem CUDA e disputando a VRAM com os LLMs; a CPU basta para esta etapa.

## Consequências

- **Nunca** rodar `uv sync` puro depois de `uv sync --group parse` sem `--group parse`: o Docling é removido. Usar `uv sync --group parse` e `uv run --group parse ...`.
- O `.venv` do indexador passa de ~40 MB para **~1,06 GB**; os modelos ocupam 384 MB em `infra/bin/`.
- A página de um item no JSON é a do **recorte** (1 a 79); a página original vem do mapa `bb_fre_2026_recorte_mapa.json` (ADR-009).

## Verificação do aceite da F1.3

| Critério | Resultado |
|---|---|
| 100% das páginas com texto | **79 de 79** páginas com ao menos um item de texto ou tabela; páginas sem texto: nenhuma |
| Tempo de conversão registrado | **201.0 s** para 79 páginas (**2.54 s por página**), mais 7.7 s para carregar os modelos; parede total de 220 s |
| Itens detectados | 925 itens de texto e **66 tabelas** |

Extrapolação: ~18 min para as 423 páginas (F5.8), como limite superior provável: o recorte tem 0,84 tabela por página e o documento inteiro tem proporcionalmente menos tabelas.

## Qualidade, amostra

Uma tabela financeira (recorte p. 16, original p. 90) saiu com cabeçalho, três exercícios e as colunas de variação; números no formato pt-BR e negativos entre parênteses preservados, e a variação 2024/2023 do "Saldo de Liquidez" (2,0) confere com os valores (268.591 / 263.344). O Docling também separou títulos de seção (170), cabeçalhos (78) e rodapés (153) de página, úteis para a F1.4.

## Ressalvas

1. Medição de **uma execução**; o tempo inclui o aquecimento do PyTorch.
2. O Docling emitiu um aviso: em uma tabela 5×3, 3 de 18 células do PDF não casaram com nenhuma linha ou coluna e foram descartadas. A auditoria de 15 tabelas (F1.6) deve procurar esse tipo de perda.
3. A cobertura mede presença de texto, **não correção**; a correção das tabelas é da F1.6.
4. Docling 2.144.0 foi publicado no dia da instalação; a versão exata está fixada em `indexer/uv.lock`.

## Evidência

Metadados do PyPI (`docling`, `docling-slim`), código do release `v2.144.0` (modelos padrão e `TableFormerMode`), Hugging Face (árvore e `lfs.oid` dos commits fixados) e o resumo da conversão em [`ADR-014-bruto/bb_fre_2026_recorte.tempo.json`](ADR-014-bruto/bb_fre_2026_recorte.tempo.json).
