<#
.SYNOPSIS
  F5.8: indexa o documento inteiro (423 páginas) com o pipeline das fases F2 a F5, em etapas retomáveis.
  Parse, normalização, seções e chunks (F1/F2.1) já saem de comandos próprios; aqui ficam as etapas com LLM e o Neo4j.

.DESCRIPTION
  Cada etapa grava uma linha em data\logs\f58.log e o estado em data\logs\f58_estado.txt (uma linha, cabe no celular).
  As etapas com LLM têm cache por hash em data\parsed; repetir o comando só refaz o que falta.
  Para ao primeiro erro. -De e -Ate escolhem um trecho. -Esvaziar autoriza apagar o grafo antes da carga (o usuário autorizou
  em 05/11/2026; o ponto de restauração é data\backups\neo4j.dump).

.EXAMPLE
  .\infra\indexar-documento.ps1 -Esvaziar              # tudo, na ordem
  .\infra\indexar-documento.ps1 -De importar           # retoma de uma etapa
#>
param(
  [string]$De = "tabelas-gerar",
  [string]$Ate = "fim",
  [switch]$Esvaziar
)

$ErrorActionPreference = "Stop"
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$OutputEncoding = [System.Text.Encoding]::UTF8
$raiz = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
. (Join-Path $PSScriptRoot "dev-env.ps1") | Out-Null
Set-Location (Join-Path $raiz "indexer")

$logs = Join-Path $raiz "data\logs"
New-Item -ItemType Directory -Force -Path $logs | Out-Null
$log = Join-Path $logs "f58.log"
$etapasLog = Join-Path $logs "f58_etapas.log"
$estado = Join-Path $logs "f58_estado.txt"
$p = "../data/parsed/banco_do_brasil_formulario_referencia_2026"
$doc = "bb-fre-2026-v7"
$inicio = Get-Date

$etapas = @(
  "tabelas-gerar", "extrair", "lastro", "catalogo-mapear", "aberta",
  "neo4j-limpar", "grafo", "embeddings", "indice-busca", "tabelas-carregar", "importar", "catalogo-medir",
  "resolver", "resumos", "comunidades", "relatorios", "entidades-vec", "fim"
)
if ($etapas -notcontains $De -or $etapas -notcontains $Ate) { throw "Etapa desconhecida. Use: $($etapas -join ', ')" }
$ativa = $false

function Registrar($texto) {
  $linha = "{0:HH:mm:ss} {1}" -f (Get-Date), $texto
  # arquivo só de eventos (f58_etapas.log): quem acompanha lê por varredura, sem segurar o arquivo aberto;
  # o f58.log fica com a saída crua dos comandos. Repete se alguém estiver lendo no mesmo instante.
  for ($i = 0; $i -lt 10; $i++) {
    try { Add-Content -Path $etapasLog -Value $linha -Encoding UTF8 -ErrorAction Stop; break } catch { Start-Sleep -Milliseconds 500 }
  }
  Write-Host $linha
}

function Rodar($rotulo, [string]$comando) {
  $t0 = Get-Date
  $decorrido = [int]((Get-Date) - $inicio).TotalMinutes
  Set-Content -Path $estado -Value ("{0:HH:mm} [{1} min] {2}" -f (Get-Date), $decorrido, $rotulo) -Encoding UTF8
  Registrar "inicio  $rotulo"
  # chcp 65001: o título com acento chega ao Python em UTF-8; caminho relativo do log: sem aspas dentro do cmd
  # até 3 tentativas: um HTTP 500 do llama-swap no meio da noite não pode parar tudo; os caches por hash
  # fazem a repetição custar só o que faltava
  for ($tentativa = 1; $tentativa -le 3; $tentativa++) {
    cmd /c "chcp 65001 >nul & $comando >> ..\data\logs\f58.log 2>&1"
    if ($LASTEXITCODE -eq 0) { break }
    Registrar "falhou  $rotulo (codigo $LASTEXITCODE, tentativa $tentativa de 3)"
    if ($tentativa -lt 3) { Start-Sleep -Seconds 60 }
  }
  if ($LASTEXITCODE -ne 0) {
    Set-Content -Path $estado -Value ("{0:HH:mm} ERRO em {1} (codigo {2})" -f (Get-Date), $rotulo, $LASTEXITCODE) -Encoding UTF8
    Registrar "ERRO    $rotulo (codigo $LASTEXITCODE)"
    throw "Falhou: $rotulo"
  }
  Registrar ("fim     {0} em {1:N1} min" -f $rotulo, ((Get-Date) - $t0).TotalMinutes)
}

foreach ($e in $etapas) {
  if ($e -eq $De) { $ativa = $true }
  if (-not $ativa) { continue }
  switch ($e) {
    "tabelas-gerar" {
      Rodar $e "uv run python -m indexer.tabelas gerar $p.docling.json $p.normalizado.json $p.secoes.json --doc-id $doc"
    }
    "extrair" { Rodar $e "uv run python -m indexer.extrair executar $p" }
    "lastro" { Rodar $e "uv run python -m indexer.lastro $p" }
    "catalogo-mapear" { Rodar $e "uv run python -m indexer.catalogo mapear $p" }
    "aberta" { Rodar $e "uv run python -m indexer.extracao_aberta executar $p --saida aberta" }
    "neo4j-limpar" {
      & (Join-Path $PSScriptRoot "neo4j.ps1") iniciar | Out-Null
      if ($Esvaziar) {
        if (-not (Test-Path (Join-Path $raiz "data\backups\neo4j.dump"))) { throw "Sem dump em data\backups: não apago." }
        Registrar "esvaziando o grafo (autorizado; restauração em data\backups\neo4j.dump)"
        & (Join-Path $PSScriptRoot "neo4j.ps1") cypher "MATCH (n) CALL (n) { DETACH DELETE n } IN TRANSACTIONS OF 5000 ROWS" | Out-Null
        Registrar "grafo vazio"
      } else {
        Registrar "neo4j no ar, sem esvaziar (use -Esvaziar na primeira carga)"
      }
    }
    "grafo" {
      Rodar "grafo-carregar" "uv run python -m indexer.grafo carregar $p.chunks.json $p.secoes.json --doc-id $doc --titulo `"Formulário de Referência 2026 (ano-base 2025), v7`" --emissor `"Banco do Brasil S.A.`" --ano 2025 --arquivo banco_do_brasil_formulario_referencia_2026.pdf --paginas 423 --paginas-indexadas 423"
      Rodar "grafo-sanidade" "uv run python -m indexer.grafo sanidade --esperado $p.chunks.json --secoes $p.secoes.json"
    }
    "embeddings" {
      Rodar "embeddings-embutir" "uv run python -m indexer.embeddings embutir"
      Rodar "embeddings-autoteste" "uv run python -m indexer.embeddings autoteste"
    }
    "indice-busca" { Rodar $e "uv run python -m indexer.busca criar-indice" }
    "tabelas-carregar" { Rodar $e "uv run python -m indexer.tabelas carregar $p.tabelas.json --doc-id $doc" }
    "importar" { Rodar $e "uv run python -m indexer.importar executar $p --doc-id $doc" }
    "catalogo-medir" { Rodar $e "uv run python -m indexer.catalogo medir $p --doc-id $doc" }
    "resolver" {
      Rodar "resolver-planejar" "uv run python -m indexer.resolver planejar $p --doc-id $doc"
      Rodar "resolver-aplicar" "uv run python -m indexer.resolver aplicar $p --doc-id $doc"
    }
    "resumos" {
      Rodar "resumos-executar" "uv run python -m indexer.resumos executar $p"
      Rodar "resumos-verificar" "uv run python -m indexer.resumos verificar $p"
    }
    "comunidades" {
      Rodar "comunidades-executar" "uv run python -m indexer.comunidades executar"
      Rodar "comunidades-verificar" "uv run python -m indexer.comunidades verificar"
    }
    "relatorios" {
      Rodar "relatorios-gerar" "uv run python -m indexer.relatorios gerar"
      Rodar "relatorios-embutir" "uv run python -m indexer.relatorios embutir"
      Rodar "relatorios-autoteste" "uv run python -m indexer.relatorios autoteste"
      Rodar "relatorios-verificar" "uv run python -m indexer.relatorios verificar"
    }
    "entidades-vec" {
      Rodar "entidades-embutir" "uv run python -m indexer.entidades_vec embutir"
      Rodar "entidades-autoteste" "uv run python -m indexer.entidades_vec autoteste"
      Rodar "entidades-verificar" "uv run python -m indexer.entidades_vec verificar"
    }
    "fim" { }
  }
  if ($e -eq $Ate) { break }
}
Set-Content -Path $estado -Value ("{0:HH:mm} PRONTO ({1} min)" -f (Get-Date), [int]((Get-Date) - $inicio).TotalMinutes) -Encoding UTF8
Registrar "pronto"
