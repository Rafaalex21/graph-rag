<#
.SYNOPSIS
  F9.5 (eval/f95-medida-congelamento.md): refaz a escada A3ts, A4 e A5 e mede as metas da Â§1.3 no cÃ³digo congelado.
  ServiÃ§os no ar antes: .\infra\neo4j.ps1 iniciar ; .\infra\swap.ps1 (em outra janela). RetomÃ¡vel: as CLIs pulam o que jÃ¡ estÃ¡ gravado
  (a medida de latÃªncia e a do redator recomeÃ§am do zero se interrompidas: sÃ£o curtas).

.EXAMPLE
  .\infra\rodar-f95.ps1 -Fase metas      # RNF-1, 2, 3, 7, 8 (API) e RNF-6 (redator, 60 e 24)
  .\infra\rodar-f95.ps1 -Fase escada     # A3ts, A4, A5: gerar (60) e julgar
  .\infra\rodar-f95.ps1 -Fase tabela     # uv run python -m indexer.f95 v1
#>
param([ValidateSet("tudo", "metas", "escada", "tabela")][string]$Fase = "tudo")

$ErrorActionPreference = "Continue"
$raiz = Split-Path $PSScriptRoot -Parent
Set-Location $raiz
. (Join-Path $PSScriptRoot "dev-env.ps1") | Out-Null
$log = Join-Path $raiz "data\avaliacao\f95-rodadas.log"
New-Item -ItemType Directory -Force (Split-Path $log) | Out-Null

function Registrar([string]$m) { Add-Content $log "[$(Get-Date -Format 'dd/MM HH:mm:ss')] $m" }
function Passo([string]$nome, [string]$dir, [string]$comando) {
  $t = Get-Date
  Registrar "INICIO $nome"
  Set-Location (Join-Path $raiz $dir)
  Invoke-Expression $comando 2>&1 | Select-Object -Last 6 | ForEach-Object { Add-Content $log "    $_" }
  Registrar "FIM    $nome saida=$LASTEXITCODE duracao=$([int]((Get-Date) - $t).TotalMinutes) min"
  Set-Location $raiz
}

if ($Fase -in "tudo", "metas") {
  # RNF-1 (a): auditoria do cÃ³digo
  Passo "rede (auditoria do codigo)" "indexer" "uv run python -m indexer.f95 rede"
  # RNF-7 (a): hashes dos modelos
  $t = Get-Date
  Registrar "INICIO verify_models"
  & (Join-Path $PSScriptRoot "verify_models.ps1") *> $null
  $cod = $LASTEXITCODE
  @{ exit_code = $cod; hora = (Get-Date).ToString("s") } | ConvertTo-Json | Set-Content (Join-Path $raiz "eval\resultados\f95-verify.json") -Encoding utf8
  Registrar "FIM    verify_models saida=$cod duracao=$([int]((Get-Date) - $t).TotalMinutes) min"
  # RNF-7 (b) e (c): YAML x lock e bloco de prompts
  Passo "repro (YAML x lock e prompts)" "indexer" "uv run python -m indexer.f95 repro --gravar"

  # RNF-1 (b), RNF-2, RNF-3 e RNF-8: API real + amostrador de recursos
  Passo "build da API" "api" "npm run build"
  $parada = Join-Path $raiz "data\avaliacao\f95-parar.txt"
  $amostrador = Start-Process powershell -ArgumentList "-NoProfile", "-File", ("`"" + (Join-Path $PSScriptRoot "amostrar-recursos.ps1") + "`""), "-Parada", ("`"" + $parada + "`"") -PassThru -WindowStyle Hidden
  Registrar "amostrador de recursos no ar (pid $($amostrador.Id))"
  $api = Start-Process node -ArgumentList "dist/server.js" -WorkingDirectory (Join-Path $raiz "api") -PassThru -WindowStyle Hidden -RedirectStandardOutput (Join-Path $raiz "data\avaliacao\f95-api.out.log") -RedirectStandardError (Join-Path $raiz "data\avaliacao\f95-api.err.log")
  Registrar "API no ar (pid $($api.Id))"
  $pronta = $false
  foreach ($i in 1..30) { try { if ((Invoke-WebRequest "http://127.0.0.1:3000/api/saude" -UseBasicParsing -TimeoutSec 5).StatusCode -eq 200) { $pronta = $true; break } } catch { Start-Sleep -Seconds 2 } }
  Registrar "API pronta: $pronta"
  if ($pronta) { Passo "latencia pela API (RNF-2 e RNF-3)" "api" "npm run avaliar:latencia" }
  Stop-Process -Id $api.Id -Force -ErrorAction SilentlyContinue
  New-Item -ItemType File -Force $parada | Out-Null
  $amostrador.WaitForExit(30000) | Out-Null
  Registrar "API parada e amostrador encerrado"

  # RNF-6: o redator nas 60 e nas 24 (a API jÃ¡ estÃ¡ parada: o pipeline roda no processo da CLI)
  Passo "redator nas 60 (RNF-6)" "api" "npm run avaliar:redator -- --nome f95-redator"
  Passo "redator nas 24 (RNF-6)" "api" "npm run avaliar:redator -- --golden eval/golden_novas.csv --nome f95n-redator"
}

if ($Fase -in "tudo", "escada") {
  foreach ($d in "a3ts", "a4", "a5") {
    Passo "gerar f95-$d" "api" "npm run avaliar:ablacao -- --degrau $d --nome f95-$d"
  }
  foreach ($d in "a3ts", "a4", "a5") {
    Passo "julgar f95-$d" "indexer" "uv run python -m indexer.avaliar executar --nome f95-$d --degrau $d"
  }
}

if ($Fase -in "tudo", "tabela") {
  Passo "v1.md" "indexer" "uv run python -m indexer.f95 v1"
}
Registrar "FASE $Fase PRONTA"

