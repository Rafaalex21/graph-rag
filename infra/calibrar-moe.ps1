<#
.SYNOPSIS
  F0.5: calibra --n-cpu-moe (e --moe-cache-mib) do Qwen3.6-35B-A3B para 2 slots de 16K de contexto.
  Sobe o llama-server de cada configuração, envia dois prompts de ~15K tokens ao mesmo tempo e depois um sozinho,
  e registra picos de VRAM (total do adaptador, desktop incluído) e de RAM usada, e tok/s de prompt e de geração.

.EXAMPLE
  .\infra\calibrar-moe.ps1 -Backend vulkan
  .\infra\calibrar-moe.ps1 -Backend hip -So ncmoe28
  Saída: docs\adr\ADR-010-bruto\<backend>_<config>.* e <backend>_resumo.jsonl
#>
param(
  [ValidateSet("vulkan", "hip")][string]$Backend = "vulkan",
  [string]$So = "",
  [int]$Porta = 8099,
  [int]$AlvoTokens = 15000,
  [string]$LoadMode = ""      # "none" = sem mmap (-lm none); vazio = padrão do llama.cpp (mmap)
)

$raiz = Split-Path $PSScriptRoot -Parent
$lock = Get-Content (Join-Path $PSScriptRoot "models.lock.json") -Raw -Encoding UTF8 | ConvertFrom-Json
$build = $lock.llama_cpp.builds.$Backend
$server = Join-Path $raiz "$($build.pasta -replace '/', '\')\llama-server.exe"
$modelo = Join-Path $lock.dir_modelos ($lock.modelos | Where-Object papel -eq "llm-principal").arquivo
$out = Join-Path $raiz "docs\adr\ADR-010-bruto"
New-Item -ItemType Directory -Force $out | Out-Null
if ($Backend -eq "hip") { . (Join-Path $PSScriptRoot "hip-env.ps1") | Out-Null }
$base = "http://127.0.0.1:$Porta"

# nome, --n-cpu-moe, --moe-cache-mib
$cfgs = @(
  @{ nome = "ncmoe24";            ncmoe = 24; cache = 0 },
  @{ nome = "ncmoe28";            ncmoe = 28; cache = 0 },
  @{ nome = "ncmoe32";            ncmoe = 32; cache = 0 },
  @{ nome = "ncmoe32_cache2048";  ncmoe = 32; cache = 2048 },
  @{ nome = "ncmoe40_cache4096";  ncmoe = 40; cache = 4096 },
  @{ nome = "ncmoe40_cache8192";  ncmoe = 40; cache = 8192 }
)
if ($So) { $cfgs = $cfgs | Where-Object { $_.nome -like "*$So*" } }

$ramTotalMB = (Get-CimInstance Win32_OperatingSystem).TotalVisibleMemorySize / 1KB
function VramMB { try { ((Get-Counter "\GPU Adapter Memory(*)\Dedicated Usage" -ErrorAction Stop).CounterSamples | Measure-Object CookedValue -Sum).Sum / 1MB } catch { 0 } }
function RamUsadaMB { $ramTotalMB - (Get-CimInstance Win32_PerfFormattedData_PerfOS_Memory).AvailableMBytes }

function Post($rota, $obj, $seg = 60) {
  $json = $obj | ConvertTo-Json -Depth 6 -Compress
  Invoke-RestMethod -Uri "$base$rota" -Method Post -ContentType "application/json; charset=utf-8" `
    -Body ([Text.Encoding]::UTF8.GetBytes($json)) -TimeoutSec $seg
}
function Tokens($texto) { (Post "/tokenize" @{ content = $texto }).tokens.Count }

# Prompts: dois recortes diferentes de ARQUITETURA.md + ETAPAS.md, ajustados a ~$AlvoTokens tokens cada
function Ajusta($texto, [bool]$inicio) {
  $n = $texto.Length
  for ($i = 0; $i -lt 3; $i++) {
    $trecho = if ($inicio) { $texto.Substring(0, [math]::Min($n, $texto.Length)) } else { $texto.Substring($texto.Length - [math]::Min($n, $texto.Length)) }
    $t = Tokens $trecho
    if ([math]::Abs($t - $AlvoTokens) -lt 250) { return @{ texto = $trecho; tokens = $t } }
    $n = [int]($n * $AlvoTokens / $t)
  }
  $trecho = if ($inicio) { $texto.Substring(0, $n) } else { $texto.Substring($texto.Length - $n) }
  return @{ texto = $trecho; tokens = (Tokens $trecho) }
}

$resumo = Join-Path $out "${Backend}_resumo.jsonl"
$prompts = $null

foreach ($c in $cfgs) {
  $sufixo = if ($LoadMode) { "_lm$LoadMode" } else { "" }
  $pref = Join-Path $out "${Backend}_$($c.nome)$sufixo"
  $args = @("--host", "127.0.0.1", "--port", "$Porta", "-m", $modelo, "-c", "32768", "-np", "2", "-ngl", "99",
            "-ncmoe", "$($c.ncmoe)", "-fa", "on", "-ctk", "q8_0", "-ctv", "q8_0", "--jinja")
  if ($c.cache -gt 0) { $args += @("--moe-cache-mib", "$($c.cache)") }
  if ($LoadMode) { $args += @("-lm", $LoadMode) }
  "$server $($args -join ' ')" | Set-Content "$pref.cmd.txt" -Encoding UTF8
  Write-Host "[$(Get-Date -Format HH:mm:ss)] $Backend / $($c.nome)" -ForegroundColor Cyan

  $vBase = VramMB; $rBase = RamUsadaMB; $vPico = $vBase; $rPico = $rBase; $wsPico = 0
  $privPico = 0
  $r = [ordered]@{ backend = $Backend; config = "$($c.nome)$sufixo"; ncmoe = $c.ncmoe; moe_cache_mib = $c.cache; load_mode = $(if ($LoadMode) { $LoadMode } else { "auto" })
                   vram_base_mb = [int]$vBase; ram_usada_base_mb = [int]$rBase; status = "falhou" }
  $p = Start-Process -FilePath $server -ArgumentList $args -NoNewWindow -PassThru `
         -RedirectStandardOutput "$pref.out.txt" -RedirectStandardError "$pref.err.txt"
  $null = $p.Handle
  $amostra = {
    $v = VramMB; if ($v -gt $script:vPico) { $script:vPico = $v }
    $m = RamUsadaMB; if ($m -gt $script:rPico) { $script:rPico = $m }
    try {
      $p.Refresh()
      if ($p.WorkingSet64 / 1MB -gt $script:wsPico) { $script:wsPico = $p.WorkingSet64 / 1MB }
      if ($p.PrivateMemorySize64 / 1MB -gt $script:privPico) { $script:privPico = $p.PrivateMemorySize64 / 1MB }
    } catch {}
  }

  try {
    # 1. espera o servidor ficar pronto
    $t0 = Get-Date; $pronto = $false
    while (-not $p.HasExited -and ((Get-Date) - $t0).TotalSeconds -lt 420) {
      & $amostra
      try { if ((Invoke-WebRequest -Uri "$base/health" -UseBasicParsing -TimeoutSec 3).StatusCode -eq 200) { $pronto = $true; break } } catch {}
      Start-Sleep -Seconds 2
    }
    if (-not $pronto) { throw "servidor não ficou pronto (saiu=$($p.HasExited)); veja $pref.err.txt" }
    $r.segundos_carga = [int]((Get-Date) - $t0).TotalSeconds
    $r.vram_apos_carga_mb = [int](VramMB)

    # 2. prompts (uma vez, com o tokenizador do próprio modelo)
    if (-not $prompts) {
      $fonte = (Get-Content (Join-Path $raiz "docs\ARQUITETURA.md") -Raw -Encoding UTF8) + "`n" + (Get-Content (Join-Path $raiz "docs\ETAPAS.md") -Raw -Encoding UTF8)
      $a = Ajusta $fonte $true; $b = Ajusta $fonte $false
      $prompts = @(
        @{ texto = $a.texto + "`n`nResuma o texto acima em tópicos curtos:`n-"; tokens = $a.tokens },
        @{ texto = $b.texto + "`n`nResuma o texto acima em tópicos curtos:`n-"; tokens = $b.tokens })
      Write-Host "   prompts: $($prompts[0].tokens) e $($prompts[1].tokens) tokens"
    }
    $r.prompt_tokens = @($prompts[0].tokens, $prompts[1].tokens)

    $sb = {
      param($url, $json)
      $x = Invoke-RestMethod -Uri $url -Method Post -ContentType "application/json; charset=utf-8" `
             -Body ([Text.Encoding]::UTF8.GetBytes($json)) -TimeoutSec 2400
      $x | ConvertTo-Json -Depth 8 -Compress
    }
    function Corpo($i) { @{ prompt = $prompts[$i].texto; n_predict = 200; temperature = 0; cache_prompt = $false; id_slot = $i } | ConvertTo-Json -Compress }
    function Rodada($indices, $rotulo) {
      $t = Get-Date
      $jobs = $indices | ForEach-Object { Start-Job -ScriptBlock $sb -ArgumentList "$base/completion", (Corpo $_) }
      while (($jobs | Where-Object State -eq "Running")) { & $amostra; Start-Sleep -Seconds 2 }
      $res = $jobs | ForEach-Object { Receive-Job $_ | ConvertFrom-Json }
      $jobs | Remove-Job -Force
      $res | ConvertTo-Json -Depth 8 | Set-Content "$pref.$rotulo.json" -Encoding UTF8
      $r["${rotulo}_segundos"] = [int]((Get-Date) - $t).TotalSeconds
      $r["${rotulo}_pp_tok_s"] = @($res | ForEach-Object { [math]::Round($_.timings.prompt_per_second, 1) })
      $r["${rotulo}_tg_tok_s"] = @($res | ForEach-Object { [math]::Round($_.timings.predicted_per_second, 1) })
      $r["${rotulo}_tg_tokens"] = @($res | ForEach-Object { $_.timings.predicted_n })
    }
    # 3. dois slots ao mesmo tempo, depois um sozinho (já com o contexto do outro descartado)
    Rodada @(0, 1) "dois_slots"
    Rodada @(0) "um_slot"
    $r.status = "ok"
  } catch {
    $r.erro = "$_"
    Write-Host "   FALHOU: $_" -ForegroundColor Red
  } finally {
    $r.vram_pico_mb = [int]$vPico; $r.ram_usada_pico_mb = [int]$rPico; $r.server_ws_pico_mb = [int]$wsPico; $r.server_privado_pico_mb = [int]$privPico
    if (-not $p.HasExited) { $p.Kill(); $p.WaitForExit() }
    ($r | ConvertTo-Json -Compress -Depth 6) | Add-Content $resumo -Encoding UTF8
    Start-Sleep -Seconds 8
  }
  if ($r.status -eq "ok") {
    Write-Host ("   ok  VRAM pico {0} MB  RAM usada pico {1} MB  tg 2 slots {2}  tg 1 slot {3}" -f $r.vram_pico_mb, $r.ram_usada_pico_mb, ($r.dois_slots_tg_tok_s -join "/"), ($r.um_slot_tg_tok_s -join "/")) -ForegroundColor Green
  }
}
Write-Host "Fim. Resumo em $resumo"
