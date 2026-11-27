# ADR-084 · Subida com dois comandos: `instalar.ps1` e `up.ps1` levam um clone limpo ao assistente respondendo

- **Estado:** aceita (27/11/2026); regras de `eval/f102-medida-subida.md` aplicadas como estavam, sem nenhum veredito trocado depois do resultado
- **Data:** 2026-11-27
- **Tarefa(s):** F10.2

## Contexto

O aceite da F10.2 é "máquina limpa → assistente respondendo com dois comandos (fora o download dos modelos)". A medida foi fixada antes do código em `eval/f102-medida-subida.md`:

- clone novo, com o PDF v7 posto à mão em `data\raw`;
- `.\infra\instalar.ps1` e depois `.\infra\up.ps1`, sem nenhum outro comando;
- repetir o comando 2 depois de uma pausa vale, e cada repetição é registrada;
- o critério de "subido" é o mesmo da F10.1: `GET /` em 200, e a T01 pelo `POST /api/chat` até o `fim`, com ao menos uma citação e o texto mencionando a União.

Uma falha do script reprova a rodada. O conserto vai numa errata, antes de uma rodada nova num clone novo.

## Decisão

O `infra/up.ps1` (com a indexação completa embutida, o "run-all" do `indexar-documento.ps1`) é o caminho curto de subida e entra no README como atalho dos passos 4 a 7.

| Rodada | Resultado | O que mudou depois |
|---|---|---|
| r1 | invalidada por erro meu de operação: rodei o instalador com `*>&1`, e no PowerShell 5.1 o aviso do `neo4j-admin` no stderr virou erro fatal | nada no código; a r2 rodou o comando como está |
| r2 | falhou em `resolver-planejar` depois de ~9 h: o LLM devolveu um JSON com uma metade solta de par UTF-16 (`\ud835`) e a gravação do cache caiu nas 3 tentativas | errata 1: `cache_json` limpa e devolve o dado limpo, e as 7 etapas usam o retorno; `up.ps1 -Parar` não cai mais com um processo já encerrado |
| **r3** | **cumprida**: `UP-FIM ok` às 17:01:47; `GET /` 200; T01 em `fim` com 2 citações (p. 6 e p. 145) e "União Federal, que detém 50,0%"; ~11 h 35 de `up.ps1`, com 1 pausa e 1 repetição | — |

## Consequências

- Quem chega ao projeto pode subir tudo com dois comandos e uma noite de GPU. A retomada depois de uma pausa é o mesmo comando, e foi exercitada na r3.
- **Defeito achado e consertado:** saída rara do LLM (texto que não pode ser escrito em UTF-8) derrubava qualquer etapa com cache. O defeito era anterior à F10.2 e não apareceu em nenhuma rodada da F10.1, porque o texto do LLM muda de uma rodada para outra. Agora a metade solta vira U+FFFD na gravação, e o mesmo texto limpo segue para o plano e para o grafo.
- O README perdeu a dica de guardar a saída do instalador com `*>&1 | Tee-Object`, que quebra no PowerShell 5.1. A dica nova é `Start-Transcript`.
- **Limites:** mesma máquina e mesmo usuário; os GGUF já estavam em `C:\modelos` (fora do aceite); o PDF é posto à mão, porque não é redistribuído. Outra rodada pode produzir outra saída rara do LLM. A limpeza cobre a metade solta de par UTF-16, não todo tipo de texto estranho.
- A F10.3 (vídeo) e a F10.5 (bateria) podem rodar, com a GPU livre.
