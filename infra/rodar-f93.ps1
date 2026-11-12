<#
.SYNOPSIS
  F9.3 (eval/f93-medida-embeddings.md): bake-off de embeddings. Serviços no ar antes: .\infra\neo4j.ps1 iniciar ; .\infra\swap.ps1
  (em outra janela). Retomável: embutir só grava o que falta; gerar e julgar pulam o que já está gravado.

.EXAMPLE
  .\infra\rodar-f93.ps1                    # tudo, na ordem: por candidato embutir, medir e latência; depois juiz; depois a tabela
  .\infra\rodar-f93.ps1 -Fase julgar       # candidatos | julgar | tabela
#>
param([ValidateSet("tudo", "candidatos", "julgar", "tabela")][string]$Fase = "tudo")

$ErrorActionPreference = "Continue"
$raiz = Split-Path $PSScriptRoot -Parent
Set-Location $raiz
. (Join-Path $PSScriptRoot "dev-env.ps1") | Out-Null
$log = Join-Path $raiz "data\avaliacao\f93-rodadas.log"
New-Item -ItemType Directory -Force (Split-Path $log) | Out-Null
$candidatos = "qwen06", "qwen4b", "gemma2", "bgem3"

function Registrar([string]$m) { Add-Content $log "[$(Get-Date -Format 'dd/MM HH:mm:ss')] $m" }
function Passo([string]$nome, [string]$comando) {
  $t = Get-Date
  Registrar "INICIO $nome"
  Set-Location (Join-Path $raiz "indexer")
  Invoke-Expression $comando 2>&1 | Select-Object -Last 8 | ForEach-Object { Add-Content $log "    $_" }
  Registrar "FIM    $nome saida=$LASTEXITCODE duracao=$([int]((Get-Date) - $t).TotalMinutes) min"
  Set-Location $raiz
}

if ($Fase -in "tudo", "candidatos") {
  foreach ($c in $candidatos) {
    Passo "embutir $c" "uv run python -m indexer.bakeoff_embeddings embutir --candidato $c"
    Passo "medir $c" "uv run python -m indexer.bakeoff_embeddings medir --candidato $c"
    Passo "latencia $c" "uv run python -m indexer.bakeoff_embeddings latencia --candidato $c"
  }
}
if ($Fase -in "tudo", "julgar") {
  foreach ($c in $candidatos) { Passo "julgar $c" "uv run python -m indexer.bakeoff_embeddings julgar --candidato $c" }
}
if ($Fase -in "tudo", "tabela") { Passo "tabela" "uv run python -m indexer.f93" }
Registrar "FASE $Fase PRONTA"
