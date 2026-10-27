<#
.SYNOPSIS
  Mede os LLMs da matriz com llama-bench (pp512, pp2048 e tg128) em um backend (vulkan ou hip).
  Para cada configuração grava a saída bruta (jsonl + stderr) e o pico de VRAM e o mínimo de RAM livre.

.EXAMPLE
  .\infra\bench.ps1 -Backend vulkan
  .\infra\bench.ps1 -Backend hip          # usa infra\hip-env.ps1 para as DLLs ROCm
  .\infra\bench.ps1 -Backend vulkan -So qwen36   # só as configurações cujo nome contém "qwen36"

  Saída: docs\adr\ADR-001-bruto\<backend>_<config>.jsonl|.err.txt e <backend>_resumo.jsonl
#>
param(
  [Parameter(Mandatory)][ValidateSet("vulkan", "hip")][string]$Backend,
  [string]$So = "",
  [int]$TimeoutMin = 25
)

$raiz = Split-Path $PSScriptRoot -Parent
$lock = Get-Content (Join-Path $PSScriptRoot "models.lock.json") -Raw -Encoding UTF8 | ConvertFrom-Json
$build = $lock.llama_cpp.builds.$Backend
$bench = Join-Path $raiz "$($build.pasta -replace '/', '\')\llama-bench.exe"
$out = Join-Path $raiz "docs\adr\ADR-001-bruto"
New-Item -ItemType Directory -Force $out | Out-Null
if ($Backend -eq "hip") { . (Join-Path $PSScriptRoot "hip-env.ps1") | Out-Null }

function Modelo($papel) { Join-Path $lock.dir_modelos ($lock.modelos | Where-Object papel -eq $papel).arquivo }

# Condições fixas: as mesmas flags dos perfis do llama-swap (ARQUITETURA §9)
$fixas = @("-fa", "1", "-ctk", "q8_0", "-ctv", "q8_0", "-ub", "512", "-t", "6",
           "-p", "512,2048", "-n", "128", "-r", "3", "--delay", "5", "-o", "jsonl")

$cfgs = @(
  @{ nome = "gptoss";        papel = "llm-rapido";    extra = @("-ngl", "99") },
  @{ nome = "gemma4";        papel = "juiz";          extra = @("-ngl", "99") },
  @{ nome = "qwen36_ncmoe20"; papel = "llm-principal"; extra = @("-ngl", "99", "-ncmoe", "20") },
  @{ nome = "qwen36_ncmoe24"; papel = "llm-principal"; extra = @("-ngl", "99", "-ncmoe", "24") },
  @{ nome = "qwen36_ncmoe28"; papel = "llm-principal"; extra = @("-ngl", "99", "-ncmoe", "28") },
  @{ nome = "qwen36_ncmoe32"; papel = "llm-principal"; extra = @("-ngl", "99", "-ncmoe", "32") },
  @{ nome = "qwen36_ncmoe40"; papel = "llm-principal"; extra = @("-ngl", "99", "-ncmoe", "40") }
)
if ($So) { $cfgs = $cfgs | Where-Object { $_.nome -like "*$So*" } }

function VramMB {
  try { ((Get-Counter "\GPU Adapter Memory(*)\Dedicated Usage" -ErrorAction Stop).CounterSamples | Measure-Object CookedValue -Sum).Sum / 1MB } catch { 0 }
}
function RamLivreMB { (Get-CimInstance Win32_OperatingSystem).FreePhysicalMemory / 1KB }

$resumo = Join-Path $out "${Backend}_resumo.jsonl"
$amb = Join-Path $out "ambiente_$Backend.txt"
@(
  "data: $(Get-Date -Format 's')",
  "backend: $Backend  build: $($lock.llama_cpp.versao)",
  "driver: $((Get-CimInstance Win32_VideoController | Where-Object Name -like '*Radeon*').DriverVersion)",
  "cpu: $((Get-CimInstance Win32_Processor).Name)",
  "ram total GB: $([math]::Round((Get-CimInstance Win32_OperatingSystem).TotalVisibleMemorySize/1MB,1))  livre GB: $([math]::Round((RamLivreMB)/1024,1))",
  "vram em uso antes MB: $([math]::Round((VramMB),0))",
  "energia: $((powercfg /getactivescheme) -join ' ')"
) | Set-Content $amb -Encoding UTF8

foreach ($c in $cfgs) {
  $m = Modelo $c.papel
  $base = Join-Path $out "${Backend}_$($c.nome)"
  $args = @("-m", $m) + $c.extra + $fixas
  Write-Host "[$(Get-Date -Format HH:mm:ss)] $Backend / $($c.nome)" -ForegroundColor Cyan
  "$bench $($args -join ' ')" | Set-Content "$base.cmd.txt" -Encoding UTF8

  $v0 = VramMB; $r0 = RamLivreMB; $vPico = $v0; $rMin = $r0
  $t0 = Get-Date
  $p = Start-Process -FilePath $bench -ArgumentList $args -NoNewWindow -PassThru `
         -RedirectStandardOutput "$base.jsonl" -RedirectStandardError "$base.err.txt"
  $null = $p.Handle   # sem isso, o PowerShell 5.1 devolve ExitCode vazio após WaitForExit
  $estourou = $false
  while (-not $p.HasExited) {
    Start-Sleep -Seconds 2
    $v = VramMB; if ($v -gt $vPico) { $vPico = $v }
    $r = RamLivreMB; if ($r -lt $rMin) { $rMin = $r }
    if (((Get-Date) - $t0).TotalMinutes -gt $TimeoutMin) { $p.Kill(); $estourou = $true; break }
  }
  $p.WaitForExit()
  $seg = [math]::Round(((Get-Date) - $t0).TotalSeconds, 0)
  $ok = ($p.ExitCode -eq 0) -and (-not $estourou)
  $linha = [ordered]@{
    backend = $Backend; config = $c.nome; exit = $p.ExitCode; timeout = $estourou; segundos = $seg
    vram_base_mb = [math]::Round($v0, 0); vram_pico_mb = [math]::Round($vPico, 0)
    ram_livre_base_mb = [math]::Round($r0, 0); ram_livre_min_mb = [math]::Round($rMin, 0)
    comando = "llama-bench $($args -join ' ')"
  } | ConvertTo-Json -Compress
  Add-Content $resumo $linha -Encoding UTF8
  if ($ok) { Write-Host "   ok em ${seg}s  VRAM pico $([math]::Round($vPico,0)) MB  RAM livre min $([math]::Round($rMin,0)) MB" -ForegroundColor Green }
  else     { Write-Host "   FALHOU (exit $($p.ExitCode)) em ${seg}s; veja $base.err.txt" -ForegroundColor Red }
  Start-Sleep -Seconds 5
}
Write-Host "Fim. Resumo em $resumo"
