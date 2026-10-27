<#
.SYNOPSIS
  Sobe o llama-swap (porta 8080, só em 127.0.0.1) com infra\llama-swap.yaml.
  Define GRAG_ROOT (barras normais) e GRAG_ROOT_WIN (barras invertidas), usadas pelo YAML.

.EXAMPLE
  .\infra\swap.ps1                 # sobe e fica em primeiro plano (Ctrl+C encerra)
  .\infra\swap.ps1 -Validar        # só valida o YAML
  .\infra\swap.ps1 -Porta 8080
#>
param([switch]$Validar, [int]$Porta = 8080)

$raiz = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$env:GRAG_ROOT_WIN = $raiz
$env:GRAG_ROOT = $raiz -replace '\\', '/'
$exe = Join-Path $raiz "infra\bin\llama-swap-v267\llama-swap.exe"
$cfg = Join-Path $raiz "infra\llama-swap.yaml"
if (-not (Test-Path $exe)) { throw "Não achei $exe (veja infra\models.lock.json, chave llama_swap)." }

if ($Validar) { & $exe -config $cfg -validate; exit $LASTEXITCODE }
& $exe -config $cfg -listen "127.0.0.1:$Porta"
