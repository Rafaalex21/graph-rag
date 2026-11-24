<#
.SYNOPSIS
  F10.2: sobe tudo com um comando. Neo4j e llama-swap; se o documento ainda não foi indexado, a indexação completa
  (leitura do PDF até o último índice, o "run-all"), retomando de onde parou se ela foi interrompida; depois a API e a
  interface, e espera as duas responderem. Repetir o comando só faz o que falta. -Parar desliga tudo.

.DESCRIPTION
  Pré-requisitos: .\infra\instalar.ps1 já rodou, e o PDF está em data\raw\banco_do_brasil_formulario_referencia_2026.pdf.
  O llama-swap, a API e a interface abrem cada um numa janela minimizada (feche-as ou use -Parar).
  A indexação leva de 10 a 14 h na primeira vez; o andamento fica em data\logs\f58_estado.txt.

.EXAMPLE
  .\infra\up.ps1           # sobe (e indexa, se precisar)
  .\infra\up.ps1 -Parar    # desliga a interface, a API, o llama-swap e o Neo4j
#>
param([switch]$Parar)

$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$raiz = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$logs = Join-Path $raiz "data\logs"
$etapasLog = Join-Path $logs "f58_etapas.log"

function Passo([string]$t) { Write-Host ("{0:HH:mm:ss} {1}" -f (Get-Date), $t) -ForegroundColor Cyan }
function Escutando([int]$porta) { [bool](Get-NetTCPConnection -State Listen -LocalPort $porta -ErrorAction SilentlyContinue) }
function Responde([string]$url) {
  try { (Invoke-WebRequest -UseBasicParsing -Uri $url -TimeoutSec 5).StatusCode -eq 200 } catch { $false }
}
function Esperar([string]$nome, [string]$url, [int]$segundos) {
  $limite = (Get-Date).AddSeconds($segundos)
  while ((Get-Date) -lt $limite) { if (Responde $url) { Passo "$nome no ar ($url)"; return }; Start-Sleep -Seconds 2 }
  throw "$nome não respondeu em $segundos s ($url). Veja a janela dele."
}
# Abre uma janela minimizada do PowerShell que roda $comando na pasta do projeto, com o ambiente de dev-env.ps1.
function Janela([string]$titulo, [string]$comando) {
  $cmd = "`$host.UI.RawUI.WindowTitle = '$titulo'; Set-Location '$raiz'; . .\infra\dev-env.ps1 | Out-Null; $comando"
  Start-Process powershell -WindowStyle Minimized -ArgumentList "-NoExit", "-ExecutionPolicy", "Bypass", "-Command", $cmd | Out-Null
}
if ($Parar) {
  Passo "parando a interface, a API e o llama-swap"
  # as janelas que este script abre (com os filhos: node, llama-swap, llama-servers) e quem estiver nas portas 4200, 3000 e 8080
  $pids = @(Get-CimInstance Win32_Process -Filter "Name='powershell.exe'" |
    Where-Object { $_.CommandLine -like "*graphrag llama-swap*" -or $_.CommandLine -like "*graphrag api*" -or $_.CommandLine -like "*graphrag web*" } |
    ForEach-Object { $_.ProcessId })
  $pids += @(Get-NetTCPConnection -State Listen -LocalPort 4200, 3000, 8080 -ErrorAction SilentlyContinue | ForEach-Object { $_.OwningProcess })
  foreach ($id in ($pids | Sort-Object -Unique)) { & taskkill.exe /PID $id /T /F 2>$null | Out-Null }
  Passo "parando o Neo4j"
  & (Join-Path $PSScriptRoot "neo4j.ps1") parar
  Passo "tudo parado"
  return
}

# ---------------------------------------------------------------- pré-requisitos
foreach ($req in "infra\bin\llama-swap-v267\llama-swap.exe", "api\node_modules", "web\node_modules", "indexer\.venv", ".env") {
  if (-not (Test-Path (Join-Path $raiz $req))) { throw "Falta ${req}: rode antes .\infra\instalar.ps1" }
}
if (-not (Test-Path (Join-Path $raiz "data\raw\banco_do_brasil_formulario_referencia_2026.pdf"))) {
  throw "Falta o PDF em data\raw\banco_do_brasil_formulario_referencia_2026.pdf (passo 3 do README)."
}

# ---------------------------------------------------------------- Neo4j e llama-swap
if (Escutando 7687) { Passo "Neo4j já estava no ar" }
else { Passo "subindo o Neo4j"; & (Join-Path $PSScriptRoot "neo4j.ps1") iniciar }  # sem pipe: com pipe ele não volta
if (Escutando 8080) { Passo "llama-swap já estava no ar" }
else {
  Passo "subindo o llama-swap (janela minimizada 'graphrag llama-swap')"
  Janela "graphrag llama-swap" "& .\infra\swap.ps1"
}
Esperar "llama-swap" "http://127.0.0.1:8080/v1/models" 60

# ---------------------------------------------------------------- indexação (run-all), só se precisar
$etapas = "parse", "normalize", "sections", "chunks", "tabelas-gerar", "extrair", "lastro", "catalogo-mapear", "aberta",
  "neo4j-limpar", "grafo", "embeddings", "indice-busca", "tabelas-carregar", "importar", "catalogo-medir",
  "resolver", "resumos", "comunidades", "relatorios", "entidades-vec"
# Nome de uma linha "inicio <rótulo>" do log -> nome que o -De aceita (resolver-planejar -> resolver, entidades-embutir -> entidades-vec).
function Etapa-De([string]$rotulo) {
  if ($etapas -contains $rotulo) { return $rotulo }
  $base = $rotulo -replace "-[^-]+$", ""
  if ($etapas -contains $base) { return $base }
  $achada = $etapas | Where-Object { $_ -like "$base*" } | Select-Object -First 1
  if ($achada) { return $achada }
  throw "Não sei retomar da etapa '$rotulo' (veja data\logs\f58_etapas.log)."
}
$linhas = @(if (Test-Path $etapasLog) { Get-Content $etapasLog -Encoding UTF8 | Where-Object { $_.Trim() } })
$ultima = if ($linhas) { $linhas[-1] } else { "" }
if ($ultima -match "\bpronto\s*$") {
  Passo "documento já indexado (f58_etapas.log termina em 'pronto')"
} else {
  $de = "parse"
  # a última etapa começada e não terminada é onde retomar (as chamadas ao LLM ficam em cache)
  $abertas = @{}
  foreach ($l in $linhas) {
    if ($l -match "^\S+\s+inicio\s+(\S+)") { $abertas[$Matches[1]] = $true }
    elseif ($l -match "^\S+\s+fim\s+(\S+)") { $abertas.Remove($Matches[1]) }
  }
  $ultimaInicio = ($linhas | Where-Object { $_ -match "^\S+\s+inicio\s+(\S+)" } | Select-Object -Last 1)
  if ($ultimaInicio -match "^\S+\s+inicio\s+(\S+)" -and $abertas.ContainsKey($Matches[1])) { $de = Etapa-De $Matches[1] }
  elseif ($linhas) {
    # tudo o que começou terminou, mas sem 'pronto': segue da etapa depois da última que terminou
    $ultimoFim = ($linhas | Where-Object { $_ -match "^\S+\s+fim\s+(\S+)" } | Select-Object -Last 1)
    if ($ultimoFim -match "^\S+\s+fim\s+(\S+)") {
      $rot = $Matches[1]; $base = Etapa-De $rot
      if ($rot -ne $base) { $de = $base }  # parte de uma etapa composta (ex.: embeddings-embutir): refaz a composta
      else {
        $i = [array]::IndexOf($etapas, $base)
        $de = if ($i -ge 0 -and $i + 1 -lt $etapas.Count) { $etapas[$i + 1] } else { $etapas[-1] }
      }
    }
  }
  Passo "indexando o documento a partir de '$de' (10 a 14 h na primeira vez; andamento em data\logs\f58_estado.txt)"
  & (Join-Path $PSScriptRoot "indexar-documento.ps1") -De $de
  Passo "indexação pronta"
}

# ---------------------------------------------------------------- API e interface
if (Escutando 3000) { Passo "API já estava no ar" }
else {
  Passo "compilando a API"
  Push-Location (Join-Path $raiz "api")
  . (Join-Path $PSScriptRoot "dev-env.ps1") | Out-Null
  $velho = $ErrorActionPreference; $ErrorActionPreference = "Continue"
  & npm run build --silent | Out-Host
  $codigo = $LASTEXITCODE; $ErrorActionPreference = $velho
  Pop-Location
  if ($codigo -ne 0) { throw "A compilação da API falhou (npm run build)." }
  Passo "subindo a API (janela minimizada 'graphrag api')"
  Janela "graphrag api" "Set-Location api; npm start"
}
Esperar "API" "http://127.0.0.1:3000/api/saude" 120
if (Escutando 4200) { Passo "interface já estava no ar" }
else {
  Passo "subindo a interface (janela minimizada 'graphrag web')"
  Janela "graphrag web" "Set-Location web; npm start"
}
Esperar "interface" "http://127.0.0.1:4200/" 240

Write-Host ""
Write-Host "Pronto: abra http://127.0.0.1:4200" -ForegroundColor Green
Write-Host "Para desligar: .\infra\up.ps1 -Parar"
