<#
.SYNOPSIS
  F9.4 (eval/f94-medida-correcao.md): refaz o A6 nas 60 e nas 24 perguntas com a mudança da rodada e aplica a regra.
  Serviços no ar antes: .\infra\neo4j.ps1 iniciar ; .\infra\swap.ps1 (em outra janela). Retomável: as CLIs pulam o que já está gravado.

.EXAMPLE
  .\infra\rodar-f94.ps1 -Rodada r1                 # gerar, julgar e tabela
  .\infra\rodar-f94.ps1 -Rodada r1 -Fase julgar    # gerar | julgar | tabela
#>
param([Parameter(Mandatory)][ValidatePattern('^r\d$')][string]$Rodada, [ValidateSet("tudo", "gerar", "julgar", "tabela")][string]$Fase = "tudo")

$ErrorActionPreference = "Continue"
$raiz = Split-Path $PSScriptRoot -Parent
Set-Location $raiz
. (Join-Path $PSScriptRoot "dev-env.ps1") | Out-Null
$log = Join-Path $raiz "data\avaliacao\f94-rodadas.log"
New-Item -ItemType Directory -Force (Split-Path $log) | Out-Null
$todas = @(@{ nome = "f94$Rodada-a6"; golden = "eval/golden.csv" }, @{ nome = "f94${Rodada}n-a6"; golden = "eval/golden_novas.csv" })

function Registrar([string]$m) { Add-Content $log "[$(Get-Date -Format 'dd/MM HH:mm:ss')] $m" }
function Passo([string]$nome, [string]$dir, [string]$comando) {
  $t = Get-Date
  Registrar "INICIO $nome"
  Set-Location (Join-Path $raiz $dir)
  Invoke-Expression $comando 2>&1 | Select-Object -Last 6 | ForEach-Object { Add-Content $log "    $_" }
  Registrar "FIM    $nome saida=$LASTEXITCODE duracao=$([int]((Get-Date) - $t).TotalMinutes) min"
  Set-Location $raiz
}

if ($Fase -in "tudo", "gerar") {
  foreach ($c in $todas) { Passo "gerar $($c.nome)" "api" "npm run avaliar:ablacao -- --degrau a6 --nome $($c.nome) --golden $($c.golden)" }
}
if ($Fase -in "tudo", "julgar") {
  foreach ($c in $todas) { Passo "julgar $($c.nome)" "indexer" "uv run python -m indexer.avaliar executar --nome $($c.nome) --degrau a6 --golden ../$($c.golden)" }
}
if ($Fase -in "tudo", "tabela") {
  Passo "tabela" "indexer" "uv run python -m indexer.f94 --rodadas $Rodada"
}
Registrar "FASE $Fase PRONTA"
