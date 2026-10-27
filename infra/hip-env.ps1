<#
.SYNOPSIS
  Prepara o PATH do processo atual para rodar o llama.cpp build HIP/ROCm (infra\bin\llama-*-hip).
  O zip do llama.cpp não traz hipblas/rocblas; elas vêm das wheels rocm-sdk instaladas em infra\bin\rocm-venv.
  Só altera o PATH desta sessão do PowerShell (nada no sistema).

.EXAMPLE
  . .\infra\hip-env.ps1
  .\infra\bin\llama-b11932-hip\llama-server.exe --list-devices
#>
$sp = Join-Path $PSScriptRoot "bin\rocm-venv\Lib\site-packages"
$dirs = @("$sp\_rocm_sdk_libraries\bin", "$sp\_rocm_sdk_core\bin")
foreach ($d in $dirs) {
  if (-not (Test-Path $d)) { throw "Não achei $d. Crie o venv (python -m venv infra\bin\rocm-venv) e instale as wheels listadas em infra\models.lock.json (llama_cpp.builds.hip.rocm_wheels)." }
}
$env:PATH = ($dirs -join ';') + ';' + $env:PATH
Write-Host "PATH ajustado para o HIP (rocm-sdk 10.0.0)."
