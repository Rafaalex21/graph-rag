<#
.SYNOPSIS
  F9.2 (eval/f92-medida-bakeoff.md): roda o bake-off inteiro. Serviços no ar antes: .\infra\neo4j.ps1 iniciar ; .\infra\swap.ps1
  (em outra janela). Retomável: as CLIs pulam o que já está gravado. A extração é a exceção: se for interrompida no meio,
  apague data\parsed\f92_cache_<modelo> e o arquivo .f92_<modelo>.json daquele modelo e rode de novo (o cache diluiria o tempo).

.EXAMPLE
  .\infra\rodar-f92.ps1                    # tudo, na ordem: sondas, extração, geração, juiz, tabela
  .\infra\rodar-f92.ps1 -Fase sondas       # sondas | extracao | gerar | julgar | tabela
#>
param([ValidateSet("tudo", "sondas", "extracao", "gerar", "julgar", "tabela")][string]$Fase = "tudo")

$ErrorActionPreference = "Continue"
$raiz = Split-Path $PSScriptRoot -Parent
Set-Location $raiz
. (Join-Path $PSScriptRoot "dev-env.ps1") | Out-Null
$log = Join-Path $raiz "data\avaliacao\f92-rodadas.log"
New-Item -ItemType Directory -Force (Split-Path $log) | Out-Null
$doc = "../data/parsed/banco_do_brasil_formulario_referencia_2026"
$desafiantes = "gptoss", "gemma"
$todos = "qwen", "gptoss", "gemma"
$modeloSwap = @{ qwen = "qwen36-35b-a3b"; gptoss = "gpt-oss-20b"; gemma = "gemma4-26b-a4b" }

function Registrar([string]$m) { Add-Content $log "[$(Get-Date -Format 'dd/MM HH:mm:ss')] $m" }
function Passo([string]$nome, [string]$dir, [string]$comando) {
  $t = Get-Date
  Registrar "INICIO $nome"
  Set-Location (Join-Path $raiz $dir)
  Invoke-Expression $comando 2>&1 | Select-Object -Last 6 | ForEach-Object { Add-Content $log "    $_" }
  Registrar "FIM    $nome saida=$LASTEXITCODE duracao=$([int]((Get-Date) - $t).TotalMinutes) min"
  Set-Location $raiz
}
function IniciarVram([string]$arq) {
  Start-Job -ArgumentList $arq -ScriptBlock {
    param($arq)
    while ($true) {
      try { $v = ((Get-Counter "\GPU Adapter Memory(*)\Dedicated Usage" -ErrorAction Stop).CounterSamples | Measure-Object CookedValue -Sum).Sum / 1MB
            Add-Content $arq ([int]$v) } catch {}
      Start-Sleep -Seconds 3
    }
  }
}
function PicoVram([string]$arq) {
  if (-not (Test-Path $arq)) { return $null }
  (Get-Content -LiteralPath $arq | ForEach-Object { [int]$_ } | Measure-Object -Maximum).Maximum
}
function GravarVram {
  $f = Join-Path $raiz "eval\resultados\f92-vram.json"
  $o = [ordered]@{}
  foreach ($m in $todos) {
    $s = PicoVram (Join-Path $raiz "data\avaliacao\f92-vram-sonda-$m.csv")
    $c = PicoVram (Join-Path $raiz "data\avaliacao\f92-vram-completa-$m.csv")
    $o[$m] = [ordered]@{ sonda_pico_mb = $s; completa_pico_mb = $c }
  }
  ($o | ConvertTo-Json -Depth 4) | Set-Content $f -Encoding UTF8
}

if ($Fase -in "tudo", "sondas") {
  foreach ($m in $todos) {
    $csv = Join-Path $raiz "data\avaliacao\f92-vram-sonda-$m.csv"
    $j = IniciarVram $csv
    Passo "sonda $m" "api" "npm run avaliar:ablacao -- --degrau a6 --nome f92-sonda-$m --modelo $m --limite 8"
    Stop-Job $j; Remove-Job $j -Force
  }
  GravarVram
}

if ($Fase -in "tudo", "extracao") {
  foreach ($m in $todos) {
    Registrar "aquecendo $m"
    try {
      $corpo = @{ model = $modeloSwap[$m]; messages = @(@{ role = "user"; content = "ok" }); max_tokens = 8 } | ConvertTo-Json -Depth 4 -Compress
      Invoke-RestMethod -Uri "http://127.0.0.1:8080/v1/chat/completions" -Method Post -ContentType "application/json; charset=utf-8" `
        -Body ([Text.Encoding]::UTF8.GetBytes($corpo)) -TimeoutSec 900 | Out-Null
    } catch { Registrar "aquecimento de $m falhou: $_" }
    Passo "extracao $m" "indexer" "uv run python -m indexer.extracao_aberta executar $doc --amostra 30 --semente 92 --modelo $m --cache ../data/parsed/f92_cache_$m --saida f92_$m --paralelismo 2"
  }
}

if ($Fase -in "tudo", "gerar") {
  foreach ($m in $desafiantes) {
    $csv = Join-Path $raiz "data\avaliacao\f92-vram-completa-$m.csv"
    $j = IniciarVram $csv
    Passo "gerar f92-a6-$m" "api" "npm run avaliar:ablacao -- --degrau a6 --nome f92-a6-$m --modelo $m"
    Passo "gerar f92n-a6-$m" "api" "npm run avaliar:ablacao -- --degrau a6 --nome f92n-a6-$m --modelo $m --golden eval/golden_novas.csv"
    Stop-Job $j; Remove-Job $j -Force
  }
  GravarVram
}

if ($Fase -in "tudo", "julgar") {
  foreach ($m in $desafiantes) {
    Passo "julgar f92-a6-$m" "indexer" "uv run python -m indexer.avaliar executar --nome f92-a6-$m --degrau a6"
    Passo "julgar f92n-a6-$m" "indexer" "uv run python -m indexer.avaliar executar --nome f92n-a6-$m --degrau a6 --golden ../eval/golden_novas.csv"
  }
}

if ($Fase -in "tudo", "tabela") {
  Passo "tabela" "indexer" "uv run python -m indexer.f92"
}
Registrar "FASE $Fase PRONTA"
