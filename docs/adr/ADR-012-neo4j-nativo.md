# ADR-012 · Neo4j nativo no Windows, sem Docker nem WSL2

- **Estado:** aceita (28/10/2026)
- **Data:** 2026-10-28
- **Tarefa(s):** F0.7

## Contexto

A especificação (ARQUITETURA §10 e a tarefa F0.7) previa o Neo4j em contêiner, no Docker Desktop sobre o WSL2, com `.wslconfig` limitando a VM a 8 GB. A inspeção do ambiente na F0.7 (só leitura) encontrou:

- **Docker não instalado:** nenhuma entrada no registro, nenhuma pasta, nenhum `docker.exe`.
- **WSL2 não instalado:** o `wsl.exe` só imprime a ajuda, `wsl --status` volta vazio, não há pacote Appx nem distribuição, e o `.wslconfig` não existe.
- **Virtualização desligada no firmware:** `VirtualizationFirmwareEnabled = False` e `HypervisorPresent = False`; no Ryzen 5 5600X é o SVM Mode da BIOS.
- **Java:** só o Java 8 (JRE); o Neo4j 2026.10 suporta Java 21 e 25.
- **RAM justa:** a F0.5 mediu 25,3 GB de RAM usados no perfil `consultar`, **sem o Neo4j rodando**, contra o teto de 28 GB do RNF-8.

## Decisão

Rodar o **Neo4j Community 2026.10.1 nativo no Windows**, com:

1. **JDK 21 portátil** (Temurin) extraído em `infra/bin/`, sem instalador e sem tocar no `PATH` nem no Java 8 do sistema; o `infra/neo4j.ps1` aponta `JAVA_HOME` só para o processo.
2. **APOC core** copiado de `labs/` do próprio zip do Neo4j para `plugins/` (não há download extra) e **GDS 2026.10.1** (JAR) em `plugins/`.
3. **Dados fora do pacote**, em `infra/neo4j/data` (já ignorado pelo git), para sobreviver a reinstalações.
4. **Memória pequena:** heap de 1 GB (inicial = máximo) e page cache de 512 MB; escuta só em `127.0.0.1` (RNF-1).
5. **Senha** só no `.env` (ignorado pelo git), nunca no repositório nem em logs.
6. O `infra/neo4j.ps1` instala, sobe, para e consulta o estado. O critério de aceite da F0.7 troca "WSL2 ≤ 8 GB" por "processo do Neo4j com ≤ 2 GB de RAM".

## Alternativas consideradas

- **Docker Desktop sobre WSL2 (plano original).** Exigiria ligar o SVM na BIOS, instalar o recurso WSL em administrador, instalar o Docker Desktop (~600 MB, com aceite de termos) e reiniciar duas vezes; além disso, a VM do WSL2 e o Docker Desktop somam memória (~1 a 2 GB) a um orçamento de RAM que não tem folga. Fica como alternativa futura; o `infra/docker-compose.yml` permanece só como referência.
- **Java 25 em vez do 21.** Suportado e menor (141 MB), mas o 21 é a versão LTS mais consolidada nas combinações de plataforma da documentação do Neo4j.
- **Neo4j como serviço do Windows.** Exige administrador e deixa o processo sempre ligado; o modo console, iniciado e parado por script, é suficiente.

## Consequências

- Nada de BIOS, administrador, reinício ou licença do Docker nesta etapa.
- Ficam como pendências conhecidas: nesta máquina, **a reprodutibilidade "máquina limpa → dois comandos" (F10.2)** passa a depender do `infra/neo4j.ps1` baixar o Neo4j e o JDK, e não de uma imagem de contêiner.
- O Neo4j em produção costuma ser em Linux; para uso local de desenvolvimento, o Windows é suportado, mas qualquer comportamento específico do Windows (caminhos, permissões) é problema nosso.
- O orçamento de RAM do `consultar` (25,3 GB) mais ~2 GB do Neo4j dá ~27,3 GB, apertado frente aos 28 GB; o aceite mede o processo e o sistema inteiro.

## Downloads (todos para `infra/bin/`, ignorada pelo git)

| Arquivo | Origem | Tamanho | SHA-256 |
|---|---|---:|---|
| `neo4j-community-2026.10.1-windows.zip` | `dist.neo4j.org` | 246.525.398 bytes | `675655653b16fe2f300dae8686d6afe6fef902ef2550be14d4facd289f6ae295` (publicado pelo Neo4j) |
| `neo4j-graph-data-science-2026.10.1.jar` | `graphdatascience.ninja` | 69.791.957 bytes | **não publicado** (o host devolve 403 para `.sha256`); o hash calculado é registrado no lock |
| `OpenJDK21U-jdk_x64_windows_hotspot_21.0.12.1_1.zip` | `github.com/adoptium/temurin21-binaries` | ~205,1 MB | `f9d6e191ab098c0d416e7d588a24420a8621cd2f4720dab2459b8b7b2d2d8b4e` (API do Adoptium) |

## Ressalvas

1. **GDS sem hash publicado:** a confiança no JAR vem do domínio oficial (o mesmo que a imagem Docker do Neo4j usa em `versions.json`) e do TLS, não de um hash independente.
2. **Temurin no Windows 11:** a tabela de plataformas do Neo4j lista Temurin 21/25 nos servidores e OracleJDK/Zulu 21/25 no Windows 11; o Temurin é o mesmo OpenJDK, e o aceite (`gds.version()` e `apoc.version()` respondendo) valida a combinação.
3. Os nomes das chaves do `neo4j.conf` na 2026.10 são validados na instalação.

## Evidência

Inspeção feita em 28/10/2026 com `Get-ItemProperty` (registro), `Get-AppxPackage`, `Get-CimInstance Win32_Processor` e `systeminfo`; versões e tamanhos pela API do Docker Hub (tag `neo4j:2026.10.1`, 380 MB), por `graphdatascience.ninja/versions.json` (GDS 2026.10.1 para o Neo4j 2026.10.1), pelo diretório central do zip do Neo4j lido por HTTP Range (contém `labs/apoc-2026.10.1-core.jar`, 15.175.292 bytes) e pela documentação de requisitos do Neo4j (Java SE 21 e 25).
