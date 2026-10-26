param(
  [string]$Server = '156.225.76.31',
  [int]$Port = 1108,
  [string]$IdentityFile = 'C:\Users\zevro\.ssh\id_ed25519',
  [switch]$SkipTests
)
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new()
Set-Location (Split-Path -Parent $PSScriptRoot)
if (-not $SkipTests) { npm test; if ($LASTEXITCODE -ne 0) { throw 'Tests failed' } }
npm run build
if ($LASTEXITCODE -ne 0) { throw 'Build failed' }
$revision = (git rev-parse --short HEAD).Trim()
$release = "$(Get-Date -Format 'yyyyMMdd-HHmmss')-$revision"
$staging = Join-Path (Get-Location) '.deploy'
New-Item -ItemType Directory -Force -Path $staging | Out-Null
$archive = Join-Path $staging "$release.tar.gz"
tar -czf $archive package.json package-lock.json dist dist-server deploy scripts/smoke.mjs
if ($LASTEXITCODE -ne 0) { throw 'Packaging failed' }
$sshArgs = @('-i', $IdentityFile, '-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=yes')
scp @sshArgs $archive "root@${Server}:/tmp/texas-$release.tar.gz"
if ($LASTEXITCODE -ne 0) { throw 'Upload failed' }
ssh @sshArgs "root@$Server" "mkdir -p /opt/texas-holdem/releases/$release && tar -xzf /tmp/texas-$release.tar.gz -C /opt/texas-holdem/releases/$release && bash /opt/texas-holdem/releases/$release/deploy/install.sh /opt/texas-holdem/releases/$release $Server $Port"
if ($LASTEXITCODE -ne 0) { throw 'Deployment failed; inspect server logs' }
ssh @sshArgs "root@$Server" "rm -f /tmp/texas-$release.tar.gz"
