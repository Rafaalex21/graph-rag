<#
.SYNOPSIS
  Prepara o ambiente de desenvolvimento desta sessão do PowerShell: Node 24 e uv portáteis (infra\bin) no PATH,
  caches do npm e do uv dentro de infra\bin, sem analytics e sem download de Pythons. Nada no sistema é alterado.

.EXAMPLE
  . .\infra\dev-env.ps1
  uv run pytest            # em indexer\
  npm test                 # em api\
  npx ng test              # em web\
#>
$raiz = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$node = Join-Path $raiz "infra\bin\node-v24.22.1-win-x64"
$uv = Join-Path $raiz "infra\bin\uv-0.13.6"
foreach ($d in $node, $uv) { if (-not (Test-Path $d)) { throw "Não achei $d (veja infra\models.lock.json, chaves node e uv)." } }

$env:PATH = "$node;$uv;$env:PATH"
$env:npm_config_cache = Join-Path $raiz "infra\bin\npm-cache"
$env:npm_config_update_notifier = "false"
$env:npm_config_fund = "false"
$env:npm_config_audit = "false"
$env:NG_CLI_ANALYTICS = "false"
$env:UV_CACHE_DIR = Join-Path $raiz "infra\bin\uv-cache"
$env:UV_PYTHON_DOWNLOADS = "never"
$env:UV_LINK_MODE = "copy"
Write-Host "Ambiente de desenvolvimento: node $(& "$node\node.exe" --version), $(& "$uv\uv.exe" --version)"
