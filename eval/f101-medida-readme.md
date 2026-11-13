# F10.1: medida do README (definição fixada ANTES de rodar)

Aceite da etapa: "alguém de fora sobe o projeto seguindo só o README". Entregas: README com arquitetura, tabela de ablações e GIF de demonstração. Decisões do dono (13/11/2026): **o teste de fora é feito por um subagente num clone limpo**; **o GIF pode ser publicado com trechos curtos do documento e a fonte citada** (muda a regra do ADR-009, registrada nele).

## O que é "subir o projeto"

O assistente respondendo pela interface, do zero: instalar as dependências fixadas, preparar o documento, **indexar o documento inteiro** (nada derivado do documento está no git, ADR-009) e responder uma pergunta. Conta como subido quando, no clone, com os serviços que o README manda subir:

1. `GET http://127.0.0.1:4200/` responde 200 com a página da interface; e
2. `POST http://127.0.0.1:4200/api/chat` (pelo proxy da interface) com a pergunta T01 do golden ("Quem é o acionista controlador do Banco do Brasil e qual percentual do capital ele detém?") devolve um fluxo SSE que termina em `fim`, com ao menos uma citação e um texto que menciona "União".

A qualidade da resposta não é medida aqui (é a da F9.5); o que se mede é se o caminho do README leva até ela.

## O teste de fora

- **Quem:** um subagente novo a cada rodada, sem o histórico desta conversa. O enunciado dele é fixo (abaixo) e só diz onde está o clone e que siga **só o README** (e os arquivos que o README mandar abrir). Ele não pode ler outros arquivos do repositório por conta própria nem consertar nada no repositório; pode ler a saída dos comandos e os logs que eles indicarem.
- **Onde:** um clone novo do GitHub (`git clone`, na branch `main` no commit em teste) em `C:\Users\Rafael\graphrag-teste-<rodada>`, fora da pasta do projeto. Os serviços do projeto principal ficam parados (as portas 7474, 7687, 8080, 3000 e 4200 precisam estar livres).
- **O que pode reaproveitar:** os GGUF que já estão em `C:\modelos`, **se o README disser** como usar uma pasta de modelos já baixada (o script confere tamanho e sha256 antes de aceitar). Nenhum cache de LLM, nenhum `data/`, nenhum `.env` e nenhum binário da pasta do projeto principal.
- **Atrito:** todo passo em que o subagente travou, teve de adivinhar algo que o README não diz, ou executou um comando que falhou por defeito do README ou dos scripts. O subagente lista cada atrito com o passo, o que fez e o que faltava.
- **Intervenção:** qualquer ajuda de fora durante a rodada (minha ou do dono), incluindo consertar o README e retomar. Uma rodada com intervenção não vale para o aceite.

**Duas fases, pelo custo** (a indexação completa leva de 8 a 9 h de GPU):

| Fase | Até onde vai | Para quê |
|---|---|---|
| **Curta** | instalar tudo, subir Neo4j e llama-swap, preparar o PDF (download e parse) e iniciar a indexação; para no primeiro passo com LLM em lote | achar os buracos do README sem gastar uma noite |
| **Completa** | do `git clone` até o critério de "subido" acima, sem parar | é a que vale para o aceite |

Cada fase pode ter várias rodadas. Entre rodadas, o README e os scripts podem ser consertados (cada conserto é commitado com a lista de atritos que o motivou, **antes** da rodada seguinte), e a rodada seguinte começa de um clone novo com um subagente novo.

## Regra de aceite (fixada agora)

Cumprida só se tudo valer:

1. `README.md` traz: o que é o projeto, a arquitetura (diagrama e componentes), a tabela de ablações e as metas tiradas de `eval/resultados/v1.md` (números iguais aos de lá, com o link), os desvios da v1, o GIF de demonstração com a fonte do documento citada, requisitos de hardware e software, e o caminho completo para subir.
2. **Uma rodada da fase completa termina com o critério de "subido" cumprido, sem intervenção**, seguindo só o README. Atritos que o subagente contornou sozinho são listados e contados, mas não reprovam; um atrito que o impede de seguir reprova a rodada.
3. Toda rodada (curta ou completa) é contada e registrada aqui, com os atritos e o commit do README que ela usou. **Não se apaga rodada que falhou.**
4. O GIF tem no máximo 10 MB, mostra uma pergunta, a resposta com citação, o Rastro e a página citada no visualizador, e o README diz de onde vem o documento ("Banco do Brasil S.A., Formulário de Referência 2026, protocolado na CVM").

Se a fase completa não passar sem intervenção, a F10.1 fica `[~]` com os atritos registrados.

## Enunciado fixo do subagente

> Você é uma pessoa que nunca viu este projeto. O repositório está clonado em `<pasta>`. Siga **somente** o `README.md` dessa pasta (e os arquivos que ele mandar abrir) para subir o projeto até o fim: a interface respondendo uma pergunta. [Fase curta: pare quando a indexação chegar ao primeiro passo com LLM em lote e diga o comando em que parou.] Não leia outros arquivos do repositório por conta própria e não altere nada que esteja versionado no git. Pode ler a saída dos comandos e os logs que eles indicarem. Quando algo falhar ou o README não disser o que fazer, anote o atrito (passo, o que fez, o que faltava) e decida sozinho se dá para seguir; se não der, pare. No fim, informe: os passos executados com o tempo de cada um, a lista de atritos, e [fase completa] o resultado do critério de "subido": o status do `GET /` e o fim do fluxo do `POST /api/chat` com a pergunta T01.

## Limites já sabidos

- O "alguém de fora" é um agente, não uma pessoa: ele não tem o histórico do projeto, mas é da mesma família do modelo que escreveu o README e roda na mesma máquina (mesmo Windows, mesma GPU, mesmo usuário). O teste mostra que o README basta **nesta máquina**; outra máquina pode ter atritos de driver, de PATH ou de rede que ele não vê.
- O reaproveitamento dos GGUF de `C:\modelos` evita baixar de novo ~24 GB (os três modelos obrigatórios; os opcionais somam mais ~31 GB); o download é testado só pelo caminho do script (tamanho e sha256), não pela velocidade da rede.
- A indexação no clone é uma execução nova do LLM: o grafo sai parecido com o da v1, não igual (o Qwen a 0,2 não é determinístico).

## Errata 0 (13/11/2026, antes de qualquer rodada): o documento

Ao conferir o link do PDF (ADR-009) para o README, descobri que ele **agora entrega outra versão** do Formulário de Referência (criada em 11/11/2026, 8.695.992 bytes), não a v7 indexada (21/09/2026, 8.719.214 bytes, SHA-256 `b0d17566…`); não há cópia arquivada pública da v7. Decisão do dono: o projeto continua na **v7**, **o PDF não é publicado** (nem em release), e o README explica as duas saídas (copiar a v7 que a pessoa tiver, conferindo o hash, ou baixar a versão atual sabendo que o índice sai parecido, não igual). Para o teste de fora:

- **O PDF da v7 é posto em `<clone>\data\raw\banco_do_brasil_formulario_referencia_2026.pdf` antes da rodada**, como os GGUF em `C:\modelos`: é um insumo de fora do README. O subagente segue o ramo "se você tem o arquivo da versão 7" do README e confere o hash. **Não conta como intervenção.** O enunciado fixo ganha uma frase, igual em todas as rodadas: "Você já tem o PDF da versão 7: ele está em `data\raw\banco_do_brasil_formulario_referencia_2026.pdf` dentro do clone."
- O ramo "baixar a versão atual" **não é testado** pelo subagente (só a resposta do link foi conferida por mim: HTTP 200, `application/pdf`). Fica como limite.

## Execuções (toda rodada é contada)

(preenchido durante e depois das rodadas)

## Resultado por item da regra

(preenchido no fim)
