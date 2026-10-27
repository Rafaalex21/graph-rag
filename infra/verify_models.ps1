<#
.SYNOPSIS
  Confere tamanho e SHA-256 de cada GGUF listado em infra\models.lock.json.
  Sai com código 0 se tudo bate; 1 se algum arquivo falta ou diverge.

.EXAMPLE
  .\infra\verify_models.ps1
  .\infra\verify_models.ps1 -Rapido      # só confere a existência e o tamanho (sem hash)
#>
param([switch]$Rapido)

$lock = Get-Content (Join-Path $PSScriptRoot "models.lock.json") -Raw -Encoding UTF8 | ConvertFrom-Json
$dir = $lock.dir_modelos
$falhas = 0

foreach ($m in $lock.modelos) {
  $arq = Join-Path $dir $m.arquivo
  if (-not $m.sha256) { Write-Host "-- $($m.papel): sem sha256 no lock" -ForegroundColor Yellow; $falhas++; continue }
  if (-not (Test-Path $arq)) { Write-Host "x  $($m.papel): $($m.arquivo) não encontrado em $dir" -ForegroundColor Red; $falhas++; continue }
  $tam = (Get-Item $arq).Length
  if ($m.bytes -and $tam -ne $m.bytes) {
    Write-Host "x  $($m.papel): tamanho $tam, esperado $($m.bytes)" -ForegroundColor Red; $falhas++; continue
  }
  if ($Rapido) { Write-Host "ok $($m.papel): $($m.arquivo) ($tam bytes; hash não conferido)"; continue }
  $h = (Get-FileHash $arq -Algorithm SHA256).Hash.ToLower()
  if ($h -eq $m.sha256.ToLower()) {
    Write-Host "ok $($m.papel): $($m.arquivo)" -ForegroundColor Green
  } else {
    Write-Host "x  $($m.papel): SHA-256 diverge`n   esperado $($m.sha256)`n   obtido   $h" -ForegroundColor Red; $falhas++
  }
}

if ($falhas -gt 0) { Write-Host "`n$falhas problema(s)." -ForegroundColor Red; exit 1 }
Write-Host "`nTodos os modelos conferem." -ForegroundColor Green
exit 0
