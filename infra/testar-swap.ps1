<#
.SYNOPSIS
  Aceite da F0.6: com o llama-swap no ar (infra\swap.ps1), percorre os cinco perfis e mede
  o tempo de cada chamada (inclui carga do modelo), a VRAM do adaptador e a RAM usada em regime.

.EXAMPLE
  .\infra\testar-swap.ps1
  Saída: tabela no console e docs\adr\ADR-011-bruto\testar-swap.jsonl
#>
param([string]$Base = "http://127.0.0.1:8080")

$raiz = Split-Path $PSScriptRoot -Parent
$out = Join-Path $raiz "docs\adr\ADR-011-bruto"
New-Item -ItemType Directory -Force $out | Out-Null
$arq = Join-Path $out "testar-swap.jsonl"
Remove-Item $arq -ErrorAction SilentlyContinue
$ramTotalMB = (Get-CimInstance Win32_OperatingSystem).TotalVisibleMemorySize / 1KB

function VramMB { try { ((Get-Counter "\GPU Adapter Memory(*)\Dedicated Usage" -ErrorAction Stop).CounterSamples | Measure-Object CookedValue -Sum).Sum / 1MB } catch { 0 } }
function RamMB { $ramTotalMB - (Get-CimInstance Win32_PerfFormattedData_PerfOS_Memory).AvailableMBytes }

function Passo($perfil, $rotulo, $rota, $corpo) {
  $json = $corpo | ConvertTo-Json -Depth 8 -Compress
  $t = Get-Date; $ok = $true; $detalhe = ""
  try {
    $r = Invoke-RestMethod -Uri "$Base$rota" -Method Post -ContentType "application/json; charset=utf-8" `
           -Body ([Text.Encoding]::UTF8.GetBytes($json)) -TimeoutSec 600
    if ($rota -like "*embeddings*") { $detalhe = "dim=$($r.data[0].embedding.Count)" }
    elseif ($rota -like "*rerank*") { $detalhe = ($r.results | ForEach-Object { "{0}:{1:N2}" -f $_.index, $_.relevance_score }) -join " " }
    else { $detalhe = ($r.choices[0].message.content -replace '\s+', ' ').Trim(); if ($detalhe.Length -gt 60) { $detalhe = $detalhe.Substring(0, 60) } }
  } catch { $ok = $false; $detalhe = "$_" }
  $seg = [math]::Round(((Get-Date) - $t).TotalSeconds, 1)
  Start-Sleep -Seconds 2
  $linha = [ordered]@{ perfil = $perfil; passo = $rotulo; ok = $ok; segundos = $seg
                       vram_mb = [int](VramMB); ram_usada_mb = [int](RamMB); detalhe = $detalhe }
  ($linha | ConvertTo-Json -Compress) | Add-Content $arq -Encoding UTF8
  "{0,-17} {1,-34} {2,-5} {3,7}s  VRAM {4,6} MB  RAM {5,6} MB  {6}" -f $perfil, $rotulo, $(if ($ok) { "ok" } else { "ERRO" }), $seg, $linha.vram_mb, $linha.ram_usada_mb, $detalhe
}

$msg = @(@{ role = "user"; content = "Responda só com a palavra: pronto." })
$chat = { param($m) @{ model = $m; messages = $msg; max_tokens = 24; temperature = 0; chat_template_kwargs = @{ enable_thinking = $false } } }

# /v1/models
$m = Invoke-RestMethod -Uri "$Base/v1/models"
$ids = @($m.data | ForEach-Object { $_.id })
"/v1/models lista $($ids.Count) modelos: $($ids -join ', ')"
($ids | ConvertTo-Json -Compress) | Add-Content $arq -Encoding UTF8
"VRAM em repouso: $([int](VramMB)) MB  RAM usada: $([int](RamMB)) MB"

Passo "consultar"         "embeddings (CPU)"            "/v1/embeddings"       @{ model = "qwen3-embed-0.6b"; input = @("Qual foi a receita líquida em 2025?") }
Passo "consultar"         "rerank (GPU)"                "/v1/rerank"           @{ model = "qwen3-rerank-0.6b"; query = "receita líquida de 2025"; documents = @("A receita líquida de 2025 foi de R$ 10 bilhões.", "O auditor independente é a empresa X.", "A sede fica em São Paulo.") }
Passo "consultar"         "LLM Qwen3.6 (carga + resposta)" "/v1/chat/completions" (& $chat "qwen36-35b-a3b")
Passo "consultar"         "embeddings com Qwen residente" "/v1/embeddings"      @{ model = "qwen3-embed-0.6b"; input = @("teste") }
Passo "vetorizar"         "embeddings em lote (GPU)"    "/v1/embeddings"       @{ model = "qwen3-embed-0.6b-lote"; input = @("a", "b", "c") }
Passo "consultar-rapido"  "LLM gpt-oss-20b"             "/v1/chat/completions" (& $chat "gpt-oss-20b")
Passo "consultar-rapido"  "embeddings (CPU)"            "/v1/embeddings"       @{ model = "qwen3-embed-0.6b"; input = @("teste") }
Passo "consultar-rapido"  "rerank (GPU) com gpt-oss"    "/v1/rerank"           @{ model = "qwen3-rerank-0.6b"; query = "receita"; documents = @("receita líquida", "auditor") }
Passo "avaliar"           "juiz Gemma 4 (HIP)"          "/v1/chat/completions" (& $chat "gemma4-26b-a4b-juiz")
Passo "indexar"           "LLM Qwen3.6 (volta do juiz)" "/v1/chat/completions" (& $chat "qwen36-35b-a3b")
"Resultado bruto em $arq"
