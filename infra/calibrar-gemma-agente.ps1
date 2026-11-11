<#
.SYNOPSIS
  F9.2: calibra --n-cpu-moe do Gemma 4 26B-A4B (Vulkan) como LLM do agente e redator, junto com o reranker na GPU.
  Para cada valor sobe o llama-server do Gemma e o do reranker (o embedding fica na CPU e não usa VRAM), manda uma
  chamada de ~6K tokens (o tamanho de um prompt do redator), mede pico de VRAM (total do adaptador, desktop incluído),
  RAM usada e tok/s, e grava uma linha por configuração.

.EXAMPLE
  .\infra\calibrar-gemma-agente.ps1
  .\infra\calibrar-gemma-agente.ps1 -Valores 0,6,12
  Saída: eval/resultados/f92-calibracao-gemma.jsonl
#>
param(
  [int[]]$Valores = @(0, 6, 10, 14),
  [int]$Porta = 8099,
  [int]$PortaRerank = 8098,
  [int]$AlvoTokens = 6000
)

$raiz = Split-Path $PSScriptRoot -Parent
$server = Join-Path $raiz "infra\bin\llama-b11932-vulkan\llama-server.exe"
$gemma = "C:\modelos\gemma-4-26B_q4_0-it.gguf"
$rerank = "C:\modelos\qwen3-reranker-0.6b-q8_0.gguf"
$saida = Join-Path $raiz "eval\resultados\f92-calibracao-gemma.jsonl"
$ramTotalMB = (Get-CimInstance Win32_OperatingSystem).TotalVisibleMemorySize / 1KB
function VramMB { try { ((Get-Counter "\GPU Adapter Memory(*)\Dedicated Usage" -ErrorAction Stop).CounterSamples | Measure-Object CookedValue -Sum).Sum / 1MB } catch { 0 } }
function RamMB { $ramTotalMB - (Get-CimInstance Win32_PerfFormattedData_PerfOS_Memory).AvailableMBytes }
function Post($base, $rota, $obj, $seg = 300) {
  $json = $obj | ConvertTo-Json -Depth 6 -Compress
  Invoke-RestMethod -Uri "$base$rota" -Method Post -ContentType "application/json; charset=utf-8" `
    -Body ([Text.Encoding]::UTF8.GetBytes($json)) -TimeoutSec $seg
}
function Espera($base) {
  for ($i = 0; $i -lt 180; $i++) { try { if ((Invoke-RestMethod "$base/health" -TimeoutSec 2).status -eq "ok") { return $true } } catch {}; Start-Sleep 2 }
  return $false
}

# Texto de ~$AlvoTokens tokens: recortes da ARQUITETURA (prompt de redator tem esse tamanho)
$texto = [string](Get-Content (Join-Path $raiz "docs\ARQUITETURA.md") -Raw -Encoding UTF8)
$base = "http://127.0.0.1:$Porta"; $baseR = "http://127.0.0.1:$PortaRerank"

foreach ($n in $Valores) {
  Write-Host "[$(Get-Date -Format HH:mm:ss)] n-cpu-moe=$n" -ForegroundColor Cyan
  $vRepouso = [int](VramMB); $rRepouso = [int](RamMB)
  $a = @("--host", "127.0.0.1", "--port", "$Porta", "-m", $gemma, "-c", "32768", "-np", "2", "-ngl", "99", "-fa", "on",
         "-ctk", "q8_0", "-ctv", "q8_0", "--jinja", "--reasoning-budget", "0")
  if ($n -gt 0) { $a += @("--n-cpu-moe", "$n") }
  $p1 = Start-Process $server -ArgumentList $a -PassThru -WindowStyle Hidden
  $p2 = Start-Process $server -ArgumentList @("--host", "127.0.0.1", "--port", "$PortaRerank", "-m", $rerank, "--reranking",
                                                "--pooling", "rank", "-ngl", "99", "-c", "4096", "-ub", "2048") -PassThru -WindowStyle Hidden
  $linha = [ordered]@{ n_cpu_moe = $n; vram_repouso_mb = $vRepouso; ok = $false }
  try {
    if (-not ((Espera $base) -and (Espera $baseR))) { throw "servidor nao subiu" }
    $tok = (Post $base "/tokenize" @{ content = $texto }).tokens.Count
    $trecho = $texto.Substring(0, [int]($texto.Length * [math]::Min(1.0, $AlvoTokens / $tok)))
    $vPico = 0; $rPico = 0; $t = Get-Date
    $msg = @(@{ role = "user"; content = "Resuma em 5 frases:`n$trecho" })
    $job = Start-Job { param($u, $b) Invoke-RestMethod -Uri $u -Method Post -ContentType "application/json; charset=utf-8" -Body ([Text.Encoding]::UTF8.GetBytes($b)) -TimeoutSec 600 } `
      -ArgumentList "$base/v1/chat/completions", (@{ model = "g"; messages = $msg; max_tokens = 300; temperature = 0 } | ConvertTo-Json -Depth 6 -Compress)
    while ($job.State -eq "Running") { $vPico = [math]::Max($vPico, (VramMB)); $rPico = [math]::Max($rPico, (RamMB)); Start-Sleep -Milliseconds 700 }
    $r = Receive-Job $job; Remove-Job $job
    $seg = ((Get-Date) - $t).TotalSeconds
    $linha.ok = $true; $linha.prompt_tokens = $r.usage.prompt_tokens; $linha.gerados = $r.usage.completion_tokens
    $linha.segundos = [math]::Round($seg, 1)
    $linha.tok_s_geral = [math]::Round(($r.usage.prompt_tokens + $r.usage.completion_tokens) / $seg, 1)
    if ($r.timings) { $linha.prompt_tok_s = [math]::Round($r.timings.prompt_per_second, 1); $linha.gen_tok_s = [math]::Round($r.timings.predicted_per_second, 1) }
    $linha.vram_pico_mb = [int]$vPico; $linha.ram_pico_mb = [int]$rPico
  } catch { $linha.erro = "$_" }
  ($linha | ConvertTo-Json -Compress) | Add-Content $saida -Encoding UTF8
  ($linha | ConvertTo-Json -Compress) | Write-Host
  Stop-Process -Id $p1.Id, $p2.Id -Force -ErrorAction SilentlyContinue
  Start-Sleep 6
}
