<#
.SYNOPSIS
  Neo4j 2026.10 nativo no Windows (ADR-012): instala a configuração, sobe, para, mostra o estado e roda Cypher.
  Usa o JDK 21 portátil de infra\bin (JAVA_HOME só neste processo) e os plugins APOC e GDS de neo4j\plugins.

.EXAMPLE
  .\infra\neo4j.ps1 instalar                    # config, pastas de dados e senha inicial (lida do .env)
  .\infra\neo4j.ps1 iniciar                     # sobe em segundo plano e espera o Bolt (127.0.0.1:7687)
  .\infra\neo4j.ps1 estado
  .\infra\neo4j.ps1 cypher "RETURN gds.version(), apoc.version()"
  .\infra\neo4j.ps1 parar
#>
param(
  [Parameter(Position = 0)][ValidateSet("instalar", "iniciar", "parar", "estado", "cypher")][string]$Acao = "estado",
  [Parameter(Position = 1)][string]$Consulta = "RETURN 1"
)

$raiz = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$neo = Join-Path $raiz "infra\bin\neo4j-community-2026.10.1"
$jdk = Join-Path $raiz "infra\bin\jdk-21.0.12.1+1"
$dados = Join-Path $raiz "infra\neo4j"
$envf = Join-Path $raiz ".env"
foreach ($d in $neo, $jdk) { if (-not (Test-Path $d)) { throw "Não achei $d (veja infra\models.lock.json, chave neo4j)." } }

$env:JAVA_HOME = $jdk
$env:NEO4J_HOME = $neo
$env:PATH = "$jdk\bin;$env:PATH"

function Ler-Env($chave) {
  if (-not (Test-Path $envf)) { return $null }
  $l = Get-Content $envf -Encoding UTF8 | Where-Object { $_ -match "^\s*$chave\s*=" } | Select-Object -First 1
  if ($l) { return ($l -split "=", 2)[1].Trim() }
}
function Processo-Neo4j {
  # o Neo4j sobe um java "lançador" e um java filho que de fato abre as portas; preferimos o dono da porta Bolt
  $todos = @(Get-CimInstance Win32_Process -Filter "Name='java.exe'" | Where-Object { $_.CommandLine -like "*neo4j-community-2026.10.1*" })
  if (-not $todos) { return $null }
  $dono = (Get-NetTCPConnection -State Listen -LocalPort 7687 -ErrorAction SilentlyContinue | Select-Object -First 1).OwningProcess
  $achado = $todos | Where-Object { $_.ProcessId -eq $dono } | Select-Object -First 1
  if ($achado) { $achado } else { $todos[0] }
}

switch ($Acao) {
  "instalar" {
    # 1) .env com senha gerada (nunca impressa)
    if (-not (Test-Path $envf)) { Copy-Item (Join-Path $raiz ".env.example") $envf }
    $senha = Ler-Env "NEO4J_PASSWORD"
    if (-not $senha -or $senha -eq "troque-esta-senha") {
      $rng = [Security.Cryptography.RandomNumberGenerator]::Create(); $b = New-Object byte[] 48; $rng.GetBytes($b)
      $senha = (([Convert]::ToBase64String($b)) -replace '[^A-Za-z0-9]', '').Substring(0, 28)
      $linhas = Get-Content $envf -Encoding UTF8 | ForEach-Object { if ($_ -match '^\s*NEO4J_PASSWORD\s*=') { "NEO4J_PASSWORD=$senha" } else { $_ } }
      [IO.File]::WriteAllLines($envf, [string[]]$linhas, (New-Object Text.UTF8Encoding($false)))   # sem BOM
      Write-Host "Senha gerada e gravada em .env (não versionado)."
    }
    # 2) pastas de dados e logs fora do pacote
    New-Item -ItemType Directory -Force "$dados\data", "$dados\logs" | Out-Null
    # 3) bloco de configuração (substitui o anterior, se houver)
    $conf = Join-Path $neo "conf\neo4j.conf"
    $txt = Get-Content $conf -Raw -Encoding UTF8
    $txt = [regex]::Replace($txt, "(?s)\r?\n# >>> graph-rag.*?# <<< graph-rag\r?\n", "`n")
    $d = $dados -replace '\\', '/'
    $bloco = @"

# >>> graph-rag (infra/neo4j.ps1, ADR-012)
server.default_listen_address=127.0.0.1
server.memory.heap.initial_size=1G
server.memory.heap.max_size=1G
server.memory.pagecache.size=512M
server.directories.data=$d/data
server.directories.logs=$d/logs
dbms.security.procedures.unrestricted=apoc.*,gds.*
dbms.security.procedures.allowlist=apoc.*,gds.*
# <<< graph-rag

"@
    # UTF-8 sem BOM: o Neo4j lê o BOM como parte da primeira chave e rejeita o arquivo
    [IO.File]::WriteAllText($conf, ($txt.TrimEnd() + "`n" + $bloco), (New-Object Text.UTF8Encoding($false)))
    Write-Host "neo4j.conf atualizado."
    # 4) senha inicial (só antes do primeiro start)
    if (-not (Test-Path "$dados\data\dbms\auth.ini") -and -not (Test-Path "$dados\data\databases")) {
      & "$neo\bin\neo4j-admin.bat" dbms set-initial-password $senha
      if ($LASTEXITCODE -ne 0) { throw "set-initial-password falhou" }
    } else { Write-Host "Dados já inicializados; senha inicial mantida." }
  }
  "iniciar" {
    if (Processo-Neo4j) { Write-Host "Neo4j já está rodando."; break }
    Start-Process -FilePath "$neo\bin\neo4j.bat" -ArgumentList "console" -WindowStyle Hidden `
      -RedirectStandardOutput "$dados\logs\console.out.txt" -RedirectStandardError "$dados\logs\console.err.txt" | Out-Null
    $t0 = Get-Date
    while (((Get-Date) - $t0).TotalSeconds -lt 180) {
      if (Get-NetTCPConnection -LocalPort 7687 -State Listen -ErrorAction SilentlyContinue) { Write-Host ("Bolt no ar em {0:N0} s." -f ((Get-Date) - $t0).TotalSeconds); break }
      Start-Sleep -Seconds 2
    }
    if (-not (Get-NetTCPConnection -LocalPort 7687 -State Listen -ErrorAction SilentlyContinue)) { throw "Neo4j não abriu a porta 7687 em 180 s; veja $dados\logs." }
  }
  "parar" {
    $p = Processo-Neo4j
    if ($p) { & taskkill /PID $p.ProcessId /T /F | Out-Null; Write-Host "Neo4j parado." } else { Write-Host "Neo4j não está rodando." }
  }
  "estado" {
    $p = Processo-Neo4j
    if (-not $p) { Write-Host "Neo4j parado."; break }
    $proc = Get-Process -Id $p.ProcessId
    Write-Host ("rodando (PID {0}); RAM: conjunto de trabalho {1:N0} MB, privada {2:N0} MB" -f $p.ProcessId, ($proc.WorkingSet64 / 1MB), ($proc.PrivateMemorySize64 / 1MB))
    Get-NetTCPConnection -State Listen -OwningProcess $p.ProcessId -ErrorAction SilentlyContinue | Select-Object LocalAddress, LocalPort | Sort-Object LocalPort | Format-Table -AutoSize
  }
  "cypher" {
    $env:NEO4J_USERNAME = (Ler-Env "NEO4J_USER"); if (-not $env:NEO4J_USERNAME) { $env:NEO4J_USERNAME = "neo4j" }
    $env:NEO4J_PASSWORD = (Ler-Env "NEO4J_PASSWORD")
    & "$neo\bin\cypher-shell.bat" -a "bolt://127.0.0.1:7687" --format plain $Consulta
  }
}
