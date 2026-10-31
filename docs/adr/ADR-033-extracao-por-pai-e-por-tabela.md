# ADR-033 · Extração dirigida a esquema por Pai e por Tabela

- **Estado:** aceita (31/10/2026)
- **Data:** 2026-10-31
- **Tarefa(s):** F4.2

## Contexto

O aceite da F4.2 é: 100% de JSON válido e, ao interromper e retomar, nenhuma chamada repetida. A extração roda no perfil `indexar` (Qwen3.6-35B-A3B) com `response_format: json_schema` do contêiner `ExtracaoDirigida` ([ADR-032](./ADR-032-esquemas-de-extracao.md)), sobre os Pais e as 62 Tabelas do recorte de 79 páginas. A §5 I-5 supõe que a gramática do `llama-server` garante a saída "válida por construção"; esta tarefa é a primeira a testar isso.

## Decisão

1. **`indexer/src/indexer/extrair.py`** (`python -m indexer.extrair executar|resumo`). Uma unidade por Pai com pelo menos 30 tokens (102 dos 116; os outros 14 são títulos e linhas soltas) e por Tabela (62), cada uma com o caminho da seção, as páginas e, nas tabelas, o texto anterior, as notas e a escala declarada.
2. **Um pedido, o schema inteiro:** o modelo devolve as sete listas numa chamada, temperatura 0,1, sem raciocínio, saída de até 8.000 tokens, 2 chamadas em paralelo (os 2 *slots* do perfil).
3. **Validação Pydantic + uma retentativa** com a mensagem de erro anexada (se a saída foi cortada por tamanho, o pedido é devolver menos fatos).
4. **Cache por hash** (versão do prompt, maior.menor do schema, modelo e pedido), gravação atômica (`.tmp` + `os.replace`). **Só entrada válida é reaproveitada**; as inválidas são tentadas de novo. O cache guarda o que o LLM devolveu; os ajustes do item 6 são aplicados na leitura e contados.
5. **Contrato 1.1.2** (de 1.0.0), pelo que a medição mostrou:
   - `scale` voltou a **obrigatório** (1 = sem escala), como no exemplo da §5 I-5: com `scale` opcional o modelo o omitia sempre, e "85,2 mil funcionários" virava `85.2` sem escala (a decisão da F4.1 estava errada);
   - `financial_facts` com **`maxItems: 60`**, imposto pela gramática: sem teto, uma tabela grande estourou os 6.000 tokens de saída, a resposta veio cortada e a retentativa piorou;
   - o `pattern` do período virou de âncora única (`^\d{4}-(FY|Q[1-4]|\d{2}-\d{2})$`) e a `unit` ganhou uma descrição com cada valor.
6. **Reparo e ajustes determinísticos, todos contados:**
   - `unit = basis_points` com R$ ou US$ e sem "pontos-base" na evidência vira `currency` (o Qwen3.6 rotulou assim valores em "R$ bilhões"; o próprio texto desmente o rótulo); sem R$ nem pontos-base continua inválido;
   - `period_type` é derivado do `period` (FY, trimestre ou data);
   - `currency` ausente em fato monetário é preenchido pelo símbolo R$ ou US$ da evidência.

## Verificação do aceite da F4.2

Evidência: `docs/adr/ADR-033-bruto/resumo.json` (só contagens, sem texto do documento). Comando: `uv run python -m indexer.extrair executar ../data/parsed/bb_fre_2026_recorte`, a partir de `indexer/`, com o llama-swap no perfil `indexar`.

| Medida | Resultado |
|---|---|
| **Unidades com JSON válido** | **164 de 164 (100%)** (102 Pais + 62 Tabelas) |
| Válidas na primeira chamada | 142 de 164 (87%); as outras 22 precisaram da retentativa |
| **Retomada** | execução final com **0 chamadas** ao modelo (164 do cache, 1 s) |
| Retomada de verdade | as execuções 2 e 3 reaproveitaram 159 e 162 unidades do cache e só chamaram o modelo para as inválidas (10 e 2 chamadas) |
| Teste de interrupção | `test_interrompida_no_meio_so_repete_o_que_faltou`: a chamada que cai não é gravada e a segunda execução refaz só ela |
| Execução inicial | 184 chamadas, 231,7 mil tokens de entrada e 213,9 mil de saída, 95 min de relógio (2 em paralelo; 11,4 mil s de LLM) |
| Itens extraídos | 1.225 fatos financeiros, 139 organizações, 15 pessoas, 12 segmentos, 9 riscos, 5 instrumentos e **0 eventos** |
| Unidades sem nenhum item | 43 (39 Pais, 4 Tabelas); a mediana dos Pais vazios é de 96 tokens, ou seja, quase todos são parágrafos curtos |
| Fatos no teto de 60 | 1 unidade |

O caminho até os 100%: a execução inicial deixou 5 unidades inválidas (3 por `unit = basis_points` em valores de R$, 1 por período fora do padrão e 1 por saída cortada); a correção do contrato e o reparo da unidade (itens 5 e 6) recuperaram 3, e a 3ª execução, com o teto de 60 fatos e 8.000 tokens, as 2 restantes. As 159 unidades que já eram válidas **não** foram refeitas: o patch do schema (1.1.1 e 1.1.2) não entra na chave do cache.

## O que a medição mudou na ARQUITETURA

A §5 I-5 dizia que a saída é "JSON válido por construção". Medido: a gramática garante o JSON, os tipos, os *enums*, os campos obrigatórios e o `maxItems`, mas **não impõe o `pattern`** (o modelo emitiu períodos fora do formato mesmo com a âncora única) e aceita rótulos errados que cabem no *enum*. A §5 I-5 foi corrigida com essa ressalva, e os ajustes determinísticos entram na guarda 2. O `period_type`, por ser redundante com `period`, é derivado em código; **proposta para a próxima versão do contrato:** tirá-lo do schema.

## Consequências e ressalvas

- **Válido não é correto.** O aceite pede JSON válido; a correção dos fatos é a F4.3 (lastro numérico e 30 fatos auditados). Sinais de atenção para ela: o modelo errou `period_type` em 80% dos fatos (988 de 1.225 ajustados) e errou `unit` em valores de R$ bilhões; 3 fatos `basis_points` aceitos no cache nunca foram conferidos; e 521 de 687 fatos monetários seguem sem o código da moeda (a evidência de uma linha de tabela não traz R$, a moeda está no cabeçalho; F4.3 ou F4.6 resolvem com a `Table.currency`).
- **Variância entre chamadas:** a mesma unidade já devolveu listas diferentes (uma vez 0 e outra 6 organizações e 2 eventos), apesar da temperatura 0,1. **Zero eventos no recorte é suspeito**, não resultado: o recorte tem pelo menos a aquisição da Cielo. Vale checar na F4.3/F5 se um segundo passe (ou o *gleaning*) recupera o que ficou de fora.
- **O teto de 60 fatos é uma perda conhecida** em tabelas muito grandes (1 unidade chegou ao teto); o prompt manda priorizar totais e o exercício mais recente. Se a F4.3 achar a perda relevante, a saída é fatiar a tabela por linhas.
- **O prompt diz "no máximo 40 fatos"**, o schema impõe 60; o 40 é só um alvo (o modelo o ignora). Alinhar exige subir a versão do prompt e refazer a extração (95 min).
- **Custo no documento inteiro:** 164 unidades em 95 min no recorte (79 de 423 páginas) projetados por páginas dão da ordem de 8 h de relógio no documento inteiro (95 min × 423/79), contra 1,1 h estimada na §5.2 (que supunha ~210 chamadas com 0,6 mil tokens de saída; a saída real foi de 1,3 mil por chamada, a cerca de 19 tokens/s por chamada). A F5.8 deve rever o orçamento.
- O `data/parsed/*.extracao.json` e o cache ficam fora do git (`data/*`); as evidências trazem trechos literais do documento.
- **Defeito corrigido no fim da tarefa:** o regex de "pontos-base" (`PONTOS_BASE`) saiu das execuções com as alternativas `bps` e `p.b.` quebradas (as barras invertidas do escape viraram caracteres de controle ao gerar o arquivo). Nas execuções valeu só "pontos-base"; como a única consequência era um `basis_points` legítimo com "bps" na evidência (e também R$) ser reparado para `currency`, e nenhuma evidência do recorte usa "bps" ou "p.b.", nada mudou nas contagens. O teste agora cobre as quatro grafias.
