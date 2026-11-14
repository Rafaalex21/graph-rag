<#
.SYNOPSIS
  Instala tudo o que o projeto usa, nas versões de infra\models.lock.json, sem tocar no sistema: baixa cada arquivo,
  confere tamanho e SHA-256 contra o lock e extrai em infra\bin. Os modelos GGUF vão para a pasta dir_modelos do lock
  (C:\modelos); um GGUF que já esteja lá com o tamanho e o hash certos é aproveitado, sem baixar de novo.
  Repetir o comando só refaz o que falta.

.DESCRIPTION
  Obrigatórios (para subir o assistente e indexar): Node, uv, llama.cpp (Vulkan), llama-swap, JDK, Neo4j com APOC e GDS,
  Qwen3.6-35B-A3B (22,4 GB), Qwen3-Embedding-0.6B e Qwen3-Reranker-0.6B, os modelos do Docling e as dependências de
  indexer\, api\ e web\. Opcionais: -ComOpcionais baixa gpt-oss-20b, o juiz Gemma 4 26B-A4B e o Text2Cypher Gemma 3 4B
  (só para a avaliação e os bake-offs); -ComHip instala o build HIP do llama.cpp e as bibliotecas ROCm (só o juiz usa).
  Requisitos: Windows 10/11 x64, PowerShell 5.1, Python 3.12 instalado, git, curl.exe e tar.exe (vêm com o Windows).

.EXAMPLE
  .\infra\instalar.ps1
  .\infra\instalar.ps1 -ComOpcionais -ComHip
#>
param([switch]$ComOpcionais, [switch]$ComHip)

$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"
$raiz = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$bin = Join-Path $raiz "infra\bin"
$dl = Join-Path $bin "dl"
New-Item -ItemType Directory -Force $dl | Out-Null
$lock = Get-Content (Join-Path $PSScriptRoot "models.lock.json") -Raw -Encoding UTF8 | ConvertFrom-Json

function Passo([string]$t) { Write-Host "`n== $t" -ForegroundColor Cyan }
# Programas externos (curl, tar, uv, npm, pip) escrevem progresso no stderr. Com a saída redirecionada (`*>&1`, `Tee-Object`),
# o PowerShell 5.1 transforma cada linha do stderr num erro e, com ErrorActionPreference = Stop, para o script. Aqui eles rodam
# com Continue, e o que decide se deu certo é o código de saída ($LASTEXITCODE), conferido logo depois de cada chamada.
function Nativo([scriptblock]$b) {
  $velho = $ErrorActionPreference; $ErrorActionPreference = "Continue"
  try { & $b } finally { $ErrorActionPreference = $velho }
}
function Hash([string]$arq) { (Get-FileHash $arq -Algorithm SHA256).Hash.ToLower() }

# Baixa $url em $destino (curl com retomada) e confere tamanho e sha256; não baixa se o arquivo já confere.
function Baixar([string]$url, [string]$destino, [string]$sha, $bytes) {
  if (Test-Path $destino) {
    if ((-not $bytes -or (Get-Item $destino).Length -eq [int64]$bytes) -and (Hash $destino) -eq $sha.ToLower()) {
      Write-Host "   ok (já baixado): $(Split-Path $destino -Leaf)"; return
    }
  }
  Write-Host "   baixando $(Split-Path $destino -Leaf)…"
  Nativo { & curl.exe -L --fail --retry 3 --progress-bar -C - -o $destino $url }
  if ($LASTEXITCODE -ne 0) { throw "Falhou o download de $url (curl $LASTEXITCODE)." }
  $h = Hash $destino
  if ($h -ne $sha.ToLower()) { throw "SHA-256 diverge em $destino`n  esperado $sha`n  obtido   $h`nApague o arquivo e rode de novo." }
  Write-Host "   ok: $(Split-Path $destino -Leaf)"
}

# Extrai um zip em $destino com o tar.exe do Windows (mais rápido que Expand-Archive), se a pasta-alvo ainda não existe.
function Extrair([string]$zip, [string]$destino, [string]$confere) {
  if (Test-Path $confere) { Write-Host "   ok (já extraído): $confere"; return }
  New-Item -ItemType Directory -Force $destino | Out-Null
  Nativo { & tar.exe -xf $zip -C $destino }
  if ($LASTEXITCODE -ne 0 -or -not (Test-Path $confere)) { throw "Falhou ao extrair $zip em $destino." }
}

# ---------------------------------------------------------------- binários
Passo "Node $($lock.node.versao)"
$z = Join-Path $dl $lock.node.arquivo
Baixar $lock.node.fonte $z $lock.node.sha256 $lock.node.bytes
Extrair $z $bin (Join-Path $raiz $lock.node.pasta)

Passo "uv $($lock.uv.versao)"
$z = Join-Path $dl $lock.uv.arquivo
Baixar "https://github.com/astral-sh/uv/releases/download/$($lock.uv.versao)/$($lock.uv.arquivo)" $z $lock.uv.sha256 $lock.uv.bytes
Extrair $z (Join-Path $raiz $lock.uv.pasta) (Join-Path $raiz "$($lock.uv.pasta)\uv.exe")

Passo "llama.cpp $($lock.llama_cpp.versao) (Vulkan)"
$v = $lock.llama_cpp.builds.vulkan
$z = Join-Path $dl $v.arquivo
Baixar "https://github.com/ggml-org/llama.cpp/releases/download/$($lock.llama_cpp.versao)/$($v.arquivo)" $z $v.sha256 $null
Extrair $z (Join-Path $raiz $v.pasta) (Join-Path $raiz "$($v.pasta)\llama-server.exe")

Passo "llama-swap $($lock.llama_swap.versao)"
$s = $lock.llama_swap
$z = Join-Path $dl $s.arquivo
Baixar "https://github.com/mostlygeek/llama-swap/releases/download/$($s.versao)/$($s.arquivo)" $z $s.sha256 $null
Extrair $z (Join-Path $raiz $s.pasta) (Join-Path $raiz "$($s.pasta)\llama-swap.exe")

Passo "JDK $($lock.jdk.versao) (para o Neo4j)"
$z = Join-Path $dl $lock.jdk.arquivo
Baixar $lock.jdk.fonte $z $lock.jdk.sha256 $lock.jdk.bytes
Extrair $z $bin (Join-Path $raiz $lock.jdk.pasta)

Passo "Neo4j $($lock.neo4j.versao) com APOC e GDS"
$n = $lock.neo4j
$z = Join-Path $dl $n.zip.arquivo
Baixar $n.zip.fonte $z $n.zip.sha256 $n.zip.bytes
Extrair $z $bin (Join-Path $raiz $n.zip.pasta)
$plugins = Join-Path $raiz "$($n.zip.pasta)\plugins"
$apoc = Join-Path $plugins $n.apoc.arquivo
if (-not (Test-Path $apoc)) { Copy-Item (Join-Path $raiz "$($n.zip.pasta)\labs\$($n.apoc.arquivo)") $apoc }
if ((Hash $apoc) -ne $n.apoc.sha256) { throw "SHA-256 do APOC diverge ($apoc)." }
Baixar $n.gds.fonte (Join-Path $plugins $n.gds.arquivo) $n.gds.sha256 $n.gds.bytes

if ($ComHip) {
  Passo "llama.cpp $($lock.llama_cpp.versao) (HIP) e bibliotecas ROCm (só o juiz da avaliação usa)"
  $h = $lock.llama_cpp.builds.hip
  $z = Join-Path $dl $h.arquivo
  Baixar "https://github.com/ggml-org/llama.cpp/releases/download/$($lock.llama_cpp.versao)/$($h.arquivo)" $z $h.sha256 $null
  Extrair $z (Join-Path $raiz $h.pasta) (Join-Path $raiz "$($h.pasta)\llama-server.exe")
  $venv = Join-Path $raiz $h.rocm_wheels.venv
  if (-not (Test-Path "$venv\Scripts\python.exe")) { Nativo { & py -3.12 -m venv $venv }; if ($LASTEXITCODE -ne 0) { throw "Falhou ao criar $venv (precisa do Python 3.12)." } }
  Nativo { & "$venv\Scripts\python.exe" -m pip install --quiet --index-url $h.rocm_wheels.indice $h.rocm_wheels.pacotes }
  if ($LASTEXITCODE -ne 0) { throw "Falhou a instalação das bibliotecas ROCm." }
}

# ---------------------------------------------------------------- modelos GGUF
$obrigatorios = "llm-principal", "embeddings", "reranker"
$dir = $lock.dir_modelos -replace "/", "\"
New-Item -ItemType Directory -Force $dir | Out-Null
foreach ($m in $lock.modelos) {
  if (-not $ComOpcionais -and $obrigatorios -notcontains $m.papel) { continue }
  Passo "Modelo $($m.papel): $($m.arquivo) ($([math]::Round($m.bytes / 1GB, 1)) GB)"
  Baixar "https://huggingface.co/$($m.repo)/resolve/main/$($m.arquivo)" (Join-Path $dir $m.arquivo) $m.sha256 $m.bytes
}

# ---------------------------------------------------------------- dependências dos três apps
. (Join-Path $PSScriptRoot "dev-env.ps1") | Out-Null
Passo "indexer: dependências Python (com o grupo parse, do Docling)"
Push-Location (Join-Path $raiz "indexer")
Nativo { & uv sync --group parse }
if ($LASTEXITCODE -ne 0) { Pop-Location; throw "uv sync falhou (o Python 3.12 está instalado?)." }
Passo "Modelos do Docling (layout e TableFormer)"
$md = Join-Path $raiz $lock.docling.pasta_modelos
Nativo { & uv run --group parse docling-tools models download layout tableformer -o $md }
if ($LASTEXITCODE -ne 0) { Pop-Location; throw "Falhou o download dos modelos do Docling." }
Pop-Location
foreach ($dm in $lock.docling.modelos) {
  $a = Join-Path $md (($dm.repo -replace "/", "--") + "\" + ($dm.arquivo -replace "/", "\"))
  if (-not (Test-Path $a) -or (Hash $a) -ne $dm.sha256) { throw "Modelo do Docling ausente ou com hash diferente do lock: $a" }
  Write-Host "   ok: $($dm.papel) confere com o lock"
}
foreach ($app in "api", "web") {
  Passo "${app}: npm ci (o aviso 'install-scripts … not yet covered by allowScripts' é esperado e não atrapalha)"
  Push-Location (Join-Path $raiz $app)
  Nativo { & npm ci --no-fund --no-audit }
  if ($LASTEXITCODE -ne 0) { Pop-Location; throw "npm ci falhou em $app." }
  Pop-Location
}

# ---------------------------------------------------------------- Neo4j: configuração e senha
Passo "Neo4j: configuração e senha inicial (gravada em .env, que o git ignora)"
& (Join-Path $PSScriptRoot "neo4j.ps1") instalar

Write-Host "`nTudo instalado. Próximo passo no README: subir os serviços e preparar o documento." -ForegroundColor Green
