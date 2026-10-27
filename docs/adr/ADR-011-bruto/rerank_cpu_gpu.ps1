$raiz = "C:\Users\Rafael\Documents\Graph Rag"
$server = "$raiz\infra\bin\llama-b11932-vulkan\llama-server.exe"
$modelo = "C:\modelos\qwen3-reranker-0.6b-q8_0.gguf"
$porta = 8098
$texto = (Get-Content "$raiz\docs\ARQUITETURA.md" -Raw -Encoding UTF8)
# 24 trechos de ~4800 caracteres (~1200 tokens), de posições diferentes
$docs = 0..23 | ForEach-Object { $ini = ($_ * 1700) % ($texto.Length - 4800); $texto.Substring($ini, 4800) }
$corpo = @{ query = "Qual foi a receita líquida de 2025?"; documents = $docs; top_n = 6 } | ConvertTo-Json -Depth 4 -Compress
$bytes = [Text.Encoding]::UTF8.GetBytes($corpo)

function VramMB { ((Get-Counter "\GPU Adapter Memory(*)\Dedicated Usage").CounterSamples | Measure-Object CookedValue -Sum).Sum / 1MB }

foreach ($cfg in @(@{ nome = "GPU (-ngl 99)"; ngl = 99 }, @{ nome = "CPU (-ngl 0)"; ngl = 0 })) {
  $v0 = VramMB
  $p = Start-Process -FilePath $server -NoNewWindow -PassThru -RedirectStandardOutput "$env:TEMP\rr.out" -RedirectStandardError "$env:TEMP\rr.err" `
        -ArgumentList @("--host", "127.0.0.1", "--port", "$porta", "-m", $modelo, "--reranking", "--pooling", "rank", "-ngl", "$($cfg.ngl)", "-c", "32768", "-ub", "2048", "-np", "24", "-kvu")
  $null = $p.Handle
  for ($i = 0; $i -lt 90; $i++) { try { if ((Invoke-WebRequest "http://127.0.0.1:$porta/health" -UseBasicParsing -TimeoutSec 2).StatusCode -eq 200) { break } } catch {}; Start-Sleep 1 }
  $res = @()
  foreach ($rep in 1..3) {
    $t = Get-Date
    try {
      $r = Invoke-RestMethod -Uri "http://127.0.0.1:$porta/v1/rerank" -Method Post -ContentType "application/json; charset=utf-8" -Body $bytes -TimeoutSec 900
      $res += [math]::Round(((Get-Date) - $t).TotalSeconds, 2)
      $n = @($r.results).Count
    } catch { $res += "ERRO: $_"; break }
  }
  $v1 = VramMB
  "{0,-14} 24 trechos x ~1200 tokens: {1} s  (resultados: {2})  VRAM +{3:N0} MB" -f $cfg.nome, ($res -join " / "), $n, ($v1 - $v0)
  Stop-Process -Id $p.Id -Force; Start-Sleep 4
}
