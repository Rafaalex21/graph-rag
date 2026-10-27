<#
.SYNOPSIS
  Cria o repositório no GitHub a partir desta pasta e sincroniza marcos e issues com docs/ETAPAS.md.

.EXAMPLE
  .\tools\bootstrap-github.ps1                       # repositório privado "graph-rag"
  .\tools\bootstrap-github.ps1 -Visibilidade public
  .\tools\bootstrap-github.ps1 -SoIssues            # repositório já existe: só sincroniza o ETAPAS.md
  .\tools\bootstrap-github.ps1 -Simular             # mostra o que faria, sem tocar em nada

  Pré-requisitos: git, GitHub CLI (gh) e Python 3.10+.
#>
param(
  [string]$Nome = "graph-rag",
  [ValidateSet("private", "public")][string]$Visibilidade = "private",
  [switch]$SoIssues,
  [switch]$Simular
)

$raiz = Split-Path $PSScriptRoot -Parent
Set-Location $raiz

function Falhar($msg) { Write-Host "x $msg" -ForegroundColor Red; exit 1 }
function Passo($msg)  { Write-Host "`n== $msg" -ForegroundColor Cyan }

# Um arquivo sem extensão chamado "git" no PATH (ex.: C:\Windows\System32\git) sombreia o git.exe; o alias garante o executável.
Set-Alias -Name git -Value git.exe -Scope Script

Passo "Verificando ferramentas"
foreach ($c in "git", "gh") {
  if (-not (Get-Command $c -ErrorAction SilentlyContinue)) { Falhar "'$c' não está no PATH." }
}
$py = @("python", "py") | Where-Object { Get-Command $_ -ErrorAction SilentlyContinue } | Select-Object -First 1
if (-not $py) { Falhar "Python não encontrado (precisa do 3.10+)." }

Passo "Validando docs/ETAPAS.md"
& $py tools/etapas.py check
if ($LASTEXITCODE -ne 0) { Falhar "ETAPAS.md inválido; corrija antes de seguir." }

if ($Simular) {
  & $py tools/etapas_to_issues.py --dry-run
  Write-Host "`n(simulação: nada foi criado)" -ForegroundColor Yellow
  exit 0
}

Passo "Autenticação no GitHub"
gh auth status *> $null
if ($LASTEXITCODE -ne 0) {
  gh auth login
  if ($LASTEXITCODE -ne 0) { Falhar "Login no GitHub não concluído." }
}

if (-not $SoIssues) {
  Passo "Arquivos do GitHub (.github)"
  # As ferramentas remotas não podem escrever em .github, então vêm de tools\github e são movidas para cá.
  if (Test-Path tools\github) {
    New-Item -ItemType Directory -Force .github | Out-Null
    Copy-Item tools\github\* .github -Recurse -Force
    Remove-Item tools\github -Recurse -Force
    Write-Host "Workflows, modelos de issue e de PR instalados em .github\"
  }

  Passo "Repositório git local"
  if (-not (Test-Path .git)) { git init -b main | Out-Null }
  if (-not (git config user.name) -or -not (git config user.email)) {
    Falhar "Defina sua identidade: git config --global user.name 'Seu Nome'; git config --global user.email 'voce@exemplo.com'"
  }
  git add -A
  git diff --cached --quiet
  if ($LASTEXITCODE -ne 0) {
    git commit -m "chore: esqueleto do repositório e especificação v0.1 (F0.1)"
    if ($LASTEXITCODE -ne 0) { Falhar "git commit falhou." }
  }

  # O push fica para depois da sincronia: ele dispara a ação ETAPAS, que, rodando ao mesmo tempo, duplicaria as issues.
  Passo "Repositório no GitHub ($Nome, $Visibilidade)"
  gh repo view $Nome *> $null
  if ($LASTEXITCODE -eq 0) {
    Write-Host "O repositório já existe."
    $dono = gh repo view $Nome --json owner --jq .owner.login
    if (-not (git remote)) { git remote add origin "https://github.com/$dono/$Nome.git" }
  } else {
    gh repo create $Nome "--$Visibilidade" --source . --remote origin `
      --description "GraphRAG 100% local (llama.cpp + Neo4j + Angular) sobre um documento financeiro"
  }
  if ($LASTEXITCODE -ne 0) { Falhar "Falha ao criar o repositório." }
}

Passo "Marcos, rótulos e issues a partir do ETAPAS.md"
& $py tools/etapas_to_issues.py
if ($LASTEXITCODE -ne 0) { Falhar "A sincronia terminou com erro (rode de novo: ela é idempotente)." }

if (-not $SoIssues) {
  Passo "Enviando a branch main"
  git push -u origin main
  if ($LASTEXITCODE -ne 0) { Falhar "git push falhou." }
}

Passo "Pronto"
gh repo view --web
