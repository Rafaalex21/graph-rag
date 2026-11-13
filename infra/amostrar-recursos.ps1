<#
.SYNOPSIS
  F9.5 (eval/f95-medida-congelamento.md, RNF-1 e RNF-8): amostra a cada 2 s, até existir o arquivo de parada,
  a VRAM do adaptador (desktop incluído), a RAM usada do sistema e as conexões TCP dos processos node, llama-server,
  llama-swap e java com endereço remoto fora de loopback. Grava o CSV e o resumo em eval\resultados\<nome>.json.

.EXAMPLE
  .\infra\amostrar-recursos.ps1 -Parada data\avaliacao\f95-parar.txt
#>
param(
  [Parameter(Mandatory)][string]$Parada,
  [string]$Nome = "f95-recursos",
  [int]$Intervalo = 2
)

$ErrorActionPreference = "Continue"
$raiz = Split-Path $PSScriptRoot -Parent
$csv = Join-Path $raiz "data\avaliacao\$Nome.csv"
$json = Join-Path $raiz "eval\resultados\$Nome.json"
$nomes = "node", "llama-server", "llama-swap", "java"
$loop = "127.0.0.1", "::1", "0.0.0.0", "::", "::ffff:127.0.0.1"
New-Item -ItemType Directory -Force (Split-Path $csv) | Out-Null
Remove-Item $Parada -ErrorAction SilentlyContinue
"hora,vram_mb,ram_usada_mb" | Set-Content $csv

function VramMB { try { ((Get-Counter "\GPU Adapter Memory(*)\Dedicated Usage" -ErrorAction Stop).CounterSamples | Measure-Object CookedValue -Sum).Sum / 1MB } catch { -1 } }
function RamUsadaMB { $o = Get-CimInstance Win32_OperatingSystem; [int](($o.TotalVisibleMemorySize - $o.FreePhysicalMemory) / 1KB) }

$inicio = Get-Date
$remotas = @{}
$vram = New-Object System.Collections.Generic.List[double]
$ram = New-Object System.Collections.Generic.List[double]
$n = 0
while (-not (Test-Path $Parada)) {
  $v = VramMB; $r = RamUsadaMB
  if ($v -ge 0) { $vram.Add($v) }
  $ram.Add($r); $n++
  Add-Content $csv ("{0},{1},{2}" -f (Get-Date -Format "HH:mm:ss"), [int]$v, $r)
  $ids = @(Get-Process -Name $nomes -ErrorAction SilentlyContinue | ForEach-Object { $_.Id })
  if ($ids.Count -gt 0) {
    foreach ($c in (Get-NetTCPConnection -ErrorAction SilentlyContinue | Where-Object { $ids -contains $_.OwningProcess -and $_.State -ne "Listen" -and $_.RemoteAddress -notin $loop })) {
      $p = (Get-Process -Id $c.OwningProcess -ErrorAction SilentlyContinue).ProcessName
      $remotas["$p -> $($c.RemoteAddress):$($c.RemotePort) ($($c.State))"] = $true
    }
  }
  Start-Sleep -Seconds $Intervalo
}
$fim = Get-Date
$o = [ordered]@{
  nome = $Nome
  inicio = $inicio.ToString("s"); fim = $fim.ToString("s"); amostras = $n; intervalo_s = $Intervalo
  vram_primeira_mb = if ($vram.Count) { [int]$vram[0] } else { $null }
  vram_pico_mb = if ($vram.Count) { [int]($vram | Measure-Object -Maximum).Maximum } else { $null }
  ram_usada_primeira_mb = [int]$ram[0]
  ram_usada_pico_mb = [int]($ram | Measure-Object -Maximum).Maximum
  conexoes_remotas_fora_de_loopback = @($remotas.Keys | Sort-Object)
  processos_vigiados = $nomes
}
$o | ConvertTo-Json -Depth 4 | Set-Content $json -Encoding utf8
Remove-Item $Parada -ErrorAction SilentlyContinue
