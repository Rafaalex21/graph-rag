# Revisão manual: descrição e perguntas hipotéticas de 10 tabelas (F2.7)

**Quem revisou:** Claude (o assistente), lendo cada tabela em Markdown contra a descrição e as perguntas geradas. **Não foi uma revisão humana independente**; as 10 tabelas estão listadas abaixo com a semente do sorteio para que o autor do projeto possa repetir a conferência.

**Amostra:** 10 das 62 tabelas do recorte, `random.Random(20261028).sample(range(62), 10)` ordenado (mesma semente da F1.6). Os textos das tabelas e das perguntas ficam em `data/parsed/` (fora do git, ADR-009); aqui só entram identificadores, páginas e veredictos.

**Critérios** (por pergunta): (1) respondível só com o que a tabela mostra; (2) autossuficiente (cita métrica, período, entidade e, se houver, o qualificador que distingue a tabela de outras parecidas); (3) sem valores numéricos da resposta; (4) sem "a tabela". Por descrição: dita só o que está na tabela, nas notas, no texto anterior ou no título da seção (inclusive a unidade).

## Rodada 1: prompt v1 (48 perguntas)

| # | Tabela | Pág. | Veredicto | Observação |
|--:|---|--:|---|---|
| 1 | `#/tables/5` | 13 | ok | |
| 2 | `#/tables/16` | 88 | ok | A unidade "milhões de reais" da descrição vem do título da seção ("… (R$ milhões)"); um primeiro apontamento meu de "unidade sem lastro" foi **retirado** ao ver o título completo. |
| 3 | `#/tables/39` | 115 | defeito | Uma pergunta repete a faixa de projeção (vazamento de valor); a descrição expõe o jargão interno "escala de fator …". |
| 4 | `#/tables/41` | 157 | defeito | Cenário I: nenhuma pergunta cita o cenário (colidiria com os cenários II e III); uma pergunta pede um "total" que a tabela não tem. |
| 5 | `#/tables/43` | 157 | defeito | Cenário III: idem, sem o qualificador do cenário. |
| 6 | `#/tables/47` | 204 | ok | |
| 7 | `#/tables/48` | 205 | ok | |
| 8 | `#/tables/50` | 333 | ok | Tabela de estrutura imperfeita (F1.6, tabela 4 da auditoria); as perguntas ficaram respondíveis. |
| 9 | `#/tables/60` | 367 | ok | |
| 10 | `#/tables/61` | 367 | ok | |

**Resultado v1:** 7 de 10 sem defeito; 3 com defeito. Em todo o conjunto (294 perguntas): 2 perguntas com valor numérico e 9 descrições com a palavra "fator".

**Correção:** prompt v2 (qualificador obrigatório quando a seção distingue a tabela; unidade só se declarada; respondível só com a tabela; proibido "fator"), mais validação automática (valor numérico na pergunta, "a tabela" e "fator" viram erro e disparam retentativa, até 3 respostas).

## Rodada 2: prompt v2, mesmas 10 tabelas (44 perguntas)

| # | Tabela | Pág. | Veredicto | Observação |
|--:|---|--:|---|---|
| 1 | `#/tables/5` | 13 | ok | |
| 2 | `#/tables/16` | 88 | defeito leve | "Captações de Curto Prazo" é ambígua: há várias linhas "Curto Prazo" (uma por instrumento). |
| 3 | `#/tables/39` | 115 | defeito leve | A descrição diz "valores absolutos ou índices" para PCLD e lucro, quando o cabeçalho diz "R$ bilhões ou %": ficou vaga. |
| 4 | `#/tables/41` | 157 | ok | As 4 perguntas citam "Cenário I". |
| 5 | `#/tables/43` | 157 | ok | As 4 perguntas citam "Cenário III". |
| 6 | `#/tables/47` | 204 | ok | |
| 7 | `#/tables/48` | 205 | defeito leve | A descrição chama as empresas de "controladas ou coligadas", o que a tabela não diz. |
| 8 | `#/tables/50` | 333 | ok | |
| 9 | `#/tables/60` | 367 | defeito leve | "Região com mais empregados indígenas" tem empate (Nordeste e Sudeste). |
| 10 | `#/tables/61` | 367 | ok | |

**Resultado v2:** 6 de 10 sem nenhum defeito e 4 com defeito leve (nenhuma pergunta irrespondível, nenhum vazamento de valor, nenhuma tabela sem qualificador). Das 44 perguntas, **42 estão corretas** e **2 ambíguas** (tabelas 2 e 9). Os defeitos graves da rodada 1 (falta do qualificador de cenário, vazamento de valor, jargão) não se repetem.

## O que esta revisão não prova

- É uma amostra de 10 tabelas (16%) revisada por quem escreveu o prompt; ela acha defeitos, mas não garante a ausência de outros nas outras 52.
- Não mede se as perguntas **recuperam** a tabela certa: isso é da F3 (golden set). A sonda de vizinhança do ADR-024 é só um indício.
