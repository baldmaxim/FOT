param(
  [Parameter(ValueFromRemainingArguments = $true)]
  [string[]]$Args
)

$ErrorActionPreference = 'Stop'
$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path

$sshPkg = Join-Path $repoRoot 'scripts\fot-ssh'
if (-not (Test-Path (Join-Path $sshPkg 'node_modules\ssh2'))) {
  Push-Location $sshPkg
  npm install --omit=dev 2>&1 | Out-Null
  Pop-Location
}

if ($Args.Count -eq 0) {
  node (Join-Path $sshPkg 'run.mjs')
  exit $LASTEXITCODE
}

node (Join-Path $sshPkg 'run.mjs') @Args
exit $LASTEXITCODE
