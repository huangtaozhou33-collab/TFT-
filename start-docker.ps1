[CmdletBinding()]
param([switch]$Rag, [switch]$Riot, [switch]$ValidateOnly)
$ErrorActionPreference = 'Stop'

function New-LocalPassword {
    $bytes = New-Object byte[] 32
    $rng = [System.Security.Cryptography.RandomNumberGenerator]::Create()
    try { $rng.GetBytes($bytes) } finally { $rng.Dispose() }
    return -join ($bytes | ForEach-Object { $_.ToString('x2') })
}

$dockerCommand = Get-Command docker -ErrorAction SilentlyContinue
$dockerPath = if ($dockerCommand) { $dockerCommand.Source } else { $null }
if (-not $dockerPath) {
    $candidates = @(
        (Join-Path $env:ProgramFiles 'Docker\Docker\resources\bin\docker.exe'),
        (Join-Path $env:LOCALAPPDATA 'Programs\DockerDesktop\resources\bin\docker.exe')
    )
    $dockerPath = $candidates | Where-Object { Test-Path -LiteralPath $_ -PathType Leaf } | Select-Object -First 1
}
if (-not $dockerPath) { throw 'Docker CLI was not found. Install Docker Desktop and reopen the terminal.' }

Push-Location -LiteralPath $PSScriptRoot
$oldMilvusUrl = $env:MILVUS_URL
try {
    & $dockerPath compose version
    if ($LASTEXITCODE -ne 0) { throw 'Docker Compose V2 is required.' }
    $dockerEnvPath = Join-Path $PSScriptRoot '.env.docker'
    if (-not (Test-Path -LiteralPath $dockerEnvPath)) {
        $settings = @"
# Local Docker configuration. Keep this file private and backed up with your database.
# Generated once; this launcher never overwrites it and never reads the development .env.
TFT_PORT=3001
MYSQL_PASSWORD=$(New-LocalPassword)
MYSQL_ROOT_PASSWORD=$(New-LocalPassword)
REDIS_PASSWORD=$(New-LocalPassword)
MINIO_ROOT_PASSWORD=$(New-LocalPassword)
AI_API_KEY=
# Provider/model switching: docs/MODEL_CONFIGURATION.md
AI_PROVIDER=deepseek
DEEPSEEK_API_KEY=
QWEN_API_KEY=
OPENAI_API_KEY=
ANTHROPIC_API_KEY=
KIMI_API_KEY=
OPENAI_EMBEDDING_API_KEY=
QWEN_EMBEDDING_API_KEY=
EMBEDDING_PROVIDER=compatible
AI_BASE_URL=https://api.deepseek.com
AI_MODEL=deepseek-flash
# Riot developer key. Kept on this machine; the collector is configured separately.
RIOT_API_KEY=
RIOT_REGION=asia
RIOT_COLLECTION_INTERVAL_HOURS=24
RIOT_COLLECTION_MAX_MATCHES=25
RIOT_COLLECTION_SEEDS=3
# Embeddings remain disabled until explicitly configured and indexed.
EMBEDDING_BASE_URL=
EMBEDDING_API_KEY=
EMBEDDING_MODEL=
EMBEDDING_DIMENSIONS=0
KNOWLEDGE_MIN_VECTOR_SCORE=0.5
MILVUS_URL=
MILVUS_TOKEN=
# Leave empty to use the imported release's declared current patch.
CURRENT_GAME_PATCH=
"@
        $stream = [System.IO.File]::Open($dockerEnvPath, [System.IO.FileMode]::CreateNew, [System.IO.FileAccess]::Write)
        try {
            $bytes = [System.Text.Encoding]::UTF8.GetBytes($settings)
            $stream.Write($bytes, 0, $bytes.Length)
        } finally { $stream.Dispose() }
        Write-Host 'Created .env.docker with unique local passwords. API keys are blank.'
    }
    $composeArgs = @('compose', '--env-file', $dockerEnvPath, '-f', (Join-Path $PSScriptRoot 'compose.yaml'))
    if ($Rag) { $composeArgs += @('--profile', 'rag'); $env:MILVUS_URL = 'http://milvus:19530' }
    if ($Riot) { $composeArgs += @('--profile', 'riot') }
    & $dockerPath @composeArgs config --quiet
    if ($LASTEXITCODE -ne 0) { throw 'Compose configuration is invalid. Existing configuration was not changed.' }
    if ($ValidateOnly) { Write-Host 'Compose configuration is valid. No containers were started.'; return }
    $engineOS = & $dockerPath info --format '{{.OSType}}'
    if ($LASTEXITCODE -ne 0 -or $engineOS -ne 'linux') { throw 'Start Docker Desktop with the Linux/WSL2 engine, then run this launcher again.' }
    & $dockerPath @composeArgs up --build --detach --wait --wait-timeout 300
    if ($LASTEXITCODE -ne 0) { throw 'Startup did not finish. Run docker compose --env-file .env.docker logs app to inspect initialization.' }
    Write-Host 'TFT is ready at http://127.0.0.1:3001 (or TFT_PORT in .env.docker).'
    if ($Rag) { Write-Host 'Milvus is enabled. Configuring an embedding provider and explicitly building the index are separate steps.' }
    if ($Riot) { Write-Host 'Riot collection is enabled. Check the developer panel for progress and credential errors.' }
} finally {
    $env:MILVUS_URL = $oldMilvusUrl
    Pop-Location
}
