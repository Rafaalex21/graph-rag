<#
.SYNOPSIS
  Rotina diária da telemetria (F7.14): gera o relatório do dia anterior e remove os logs com mais de N dias.
  Só toca em data\logs\telemetria\AAAA-MM-DD.jsonl (data que existe), e nunca apaga um log sem antes ter o relatório daquele dia.
  Os relatórios (relatorio-*.md e .json) e o feedback.jsonl ficam. Sem log de ontem não é erro.

.PARAMETER Dias
  Remove o log com MAIS de Dias dias (padrão 30; 30 fica, 31 sai). Inteiro a partir de 1.
.PARAMETER Simular
  Só diz o que faria: não grava relatório nem apaga nada.
.PARAMETER Hoje
  AAAA-MM-DD; padrão a data local de hoje. Existe para teste.
.PARAMETER Pasta
  Pasta dos logs; padrão data\logs\telemetria.
.PARAMETER Feedback
  Arquivo de notas; padrão data\logs\feedback.jsonl.
.PARAMETER Log
  Onde acrescentar a saída desta rodada (padrão data\logs\telemetria\diaria.log; o nome não é de um log de telemetria,
  então a própria rotina não o apaga). Código de saída: 0 certo, 1 erro de relatório ou de remoção, 2 argumento inválido.

.EXAMPLE
  .\infra\relatorio-diario.ps1 -Simular            # vê o que faria
  .\infra\relatorio-diario.ps1                     # relatório de ontem + limpeza de 30 dias
  .\infra\relatorio-diario.ps1 -Dias 60

.NOTES
  Para rodar sozinho todo dia seria preciso registrar uma tarefa no Agendador do Windows, o que muda o sistema e só se faz
  com o aval do dono do projeto (ADR-067). Este script não registra nada.
#>
param(
  [ValidateRange(1, 36500)][int]$Dias = 30,
  [switch]$Simular,
  [string]$Hoje,
  [string]$Pasta,
  [string]$Feedback,
  [string]$Log
)

$raiz = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
. (Join-Path $PSScriptRoot "dev-env.ps1") | Out-Null
if (-not $Log) { $Log = Join-Path $raiz "data\logs\telemetria\diaria.log" }

$argumentos = @("src/telemetria/cli-diaria.ts", "--dias", "$Dias")
if ($Hoje) { $argumentos += @("--hoje", $Hoje) }
if ($Pasta) { $argumentos += @("--pasta", $Pasta) }
if ($Feedback) { $argumentos += @("--feedback", $Feedback) }
if ($Simular) { $argumentos += "--simular" }

# o stderr do node não pode virar exceção do PowerShell 5.1: o código de saída é quem diz se deu certo
$ErrorActionPreference = "Continue"
Push-Location (Join-Path $raiz "api")
try {
  $saida = @(& node @argumentos 2>&1 | ForEach-Object { "$_" })
  $codigo = $LASTEXITCODE
} finally {
  Pop-Location
}
$saida | ForEach-Object { Write-Output $_ }

try {
  New-Item -ItemType Directory -Force -Path (Split-Path $Log) | Out-Null
  $cabecalho = "=== {0} (Dias={1}{2}) código {3}" -f (Get-Date -Format "yyyy-MM-dd HH:mm:ss"), $Dias, $(if ($Simular) { ", simulação" } else { "" }), $codigo
  Add-Content -LiteralPath $Log -Value (@($cabecalho) + $saida) -Encoding UTF8
} catch {
  Write-Warning "Não foi possível gravar $Log : $($_.Exception.Message)"
}
exit $codigo
