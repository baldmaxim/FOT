#Requires -Version 5.1
<#
    Launcher MCP-сервера PostgreSQL для read-only доступа к FOT_Prod.

    Секретов не содержит: строка подключения без пароля берётся из FOT_MCP_PGURL,
    пароль — из FOT_MCP_PGPASSWORD и передаётся серверу через PGPASSWORD, а не argv.

    ВАЖНО: stdout занят JSON-RPC транспортом MCP — сюда нельзя писать ничего.
    Все диагностические сообщения идут в stderr и никогда не содержат значений переменных.
#>
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

function Write-Fail {
    param([string]$Message)
    [Console]::Error.WriteLine("[mcp-yandex-pg] $Message")
    exit 1
}

# Process-окружение приоритетнее: клиент мог пробросить переменные сам.
function Get-EnvValue {
    param([string]$Name)
    $value = [Environment]::GetEnvironmentVariable($Name, 'Process')
    if ([string]::IsNullOrWhiteSpace($value)) {
        $value = [Environment]::GetEnvironmentVariable($Name, 'User')
    }
    return $value
}

function Get-NormalizedPath {
    param([string]$Path)
    try { return [IO.Path]::GetFullPath($Path).TrimEnd('\').ToLowerInvariant() }
    catch { return $null }
}

$EXPECTED_USER = 'mcp_readonly'
$EXPECTED_HOST = 'rc1d-m4ubd0uem0j9gqqc.mdb.yandexcloud.net'
$EXPECTED_PORT = 6432
$EXPECTED_PATH = '/FOT_Prod'

$url      = Get-EnvValue 'FOT_MCP_PGURL'
$password = Get-EnvValue 'FOT_MCP_PGPASSWORD'

if ([string]::IsNullOrWhiteSpace($url)) {
    Write-Fail 'FOT_MCP_PGURL не задана (пусто и в process-, и в user-окружении)'
}
if ([string]::IsNullOrWhiteSpace($password)) {
    Write-Fail 'FOT_MCP_PGPASSWORD не задана (пусто и в process-, и в user-окружении)'
}

# --- Валидация URL: подменённый адрес увёл бы PGPASSWORD на чужой сервер.
$uri = $null
try { $uri = [Uri]$url } catch { Write-Fail 'FOT_MCP_PGURL не разбирается как URI' }

if (@('postgres', 'postgresql') -notcontains $uri.Scheme) {
    Write-Fail "недопустимая схема URL: $($uri.Scheme)"
}
if ($uri.UserInfo -ne $EXPECTED_USER) {
    Write-Fail "в URL должен быть пользователь $EXPECTED_USER и не должно быть пароля"
}
if ($uri.Host -ne $EXPECTED_HOST) { Write-Fail "неожиданный хост: $($uri.Host)" }
if ($uri.Port -ne $EXPECTED_PORT) { Write-Fail "неожиданный порт: $($uri.Port)" }
if ($uri.AbsolutePath -ne $EXPECTED_PATH) { Write-Fail "неожиданная база: $($uri.AbsolutePath)" }

$query = @{}
foreach ($pair in ($uri.Query.TrimStart('?') -split '&')) {
    if ([string]::IsNullOrWhiteSpace($pair)) { continue }
    $kv = $pair -split '=', 2
    $key = [Uri]::UnescapeDataString($kv[0])
    $query[$key] = if ($kv.Count -gt 1) { [Uri]::UnescapeDataString($kv[1]) } else { '' }
}

if (-not $query.ContainsKey('sslmode') -or $query['sslmode'] -ne 'verify-full') {
    Write-Fail 'в URL требуется sslmode=verify-full'
}

$repoRoot   = Split-Path -Parent $PSScriptRoot
$expectedCa = Join-Path $repoRoot '.migration\yandex-ca.pem'

if (-not $query.ContainsKey('sslrootcert')) { Write-Fail 'в URL требуется sslrootcert' }
# Сверяем именно путь, а не только существование файла: подменённый CA снимает смысл verify-full.
if ((Get-NormalizedPath $query['sslrootcert']) -ne (Get-NormalizedPath $expectedCa)) {
    Write-Fail 'sslrootcert не совпадает с каноническим .migration\yandex-ca.pem'
}
if (-not (Test-Path -LiteralPath $expectedCa -PathType Leaf)) {
    Write-Fail "CA-файл не найден: $expectedCa"
}

# --- Запуск сервера абсолютными путями.
$node = Join-Path $env:ProgramFiles 'nodejs\node.exe'
if (-not (Test-Path -LiteralPath $node -PathType Leaf)) {
    Write-Fail "node.exe не найден: $node"
}

$server = Join-Path $repoRoot 'tools\mcp-postgres\node_modules\@modelcontextprotocol\server-postgres\dist\index.js'
if (-not (Test-Path -LiteralPath $server -PathType Leaf)) {
    Write-Fail "MCP-сервер не установлен: $server (выполните npm ci --ignore-scripts --prefix tools/mcp-postgres)"
}

$env:PGPASSWORD = $password
& $node $server $url
exit $LASTEXITCODE
