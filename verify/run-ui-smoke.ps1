# 页面逻辑冒烟：临时库 + 独立端口起一个后端实例，用 Node 的 DOM 桩跑 app.js 的两个写操作链路。
# 不碰 demo 库（data\proto.db），跑完删库。
# 用法： pwsh -File verify\run-ui-smoke.ps1

#requires -Version 7.0
param(
    [int]$Port = 5083,
    # 5081 的 demo 服务在跑时会锁住 bin 里的 dll，此时加 -NoBuild 用现有构建
    [switch]$NoBuild
)

$ErrorActionPreference = 'Stop'
$testRoot = Split-Path -Parent $PSScriptRoot
$apiProject = Join-Path $testRoot 'backend\WorkProto.Api'
$dll = Join-Path $apiProject 'bin\Debug\net10.0\WorkProto.Api.dll'
$tmpDir = Join-Path $PSScriptRoot '.tmp'
$dbPath = Join-Path $tmpDir 'ui-smoke.db'
$base = "http://127.0.0.1:$Port"

New-Item -ItemType Directory -Force -Path $tmpDir | Out-Null
foreach ($f in @($dbPath, "$dbPath-wal", "$dbPath-shm")) { if (Test-Path $f) { Remove-Item -Force $f } }

if (-not $NoBuild) {
    & dotnet build $apiProject -v q --nologo | Out-Null
}
if (-not (Test-Path $dll)) { throw "未找到 $dll" }
$env:PROTO_PORT = "$Port"
$env:PROTO_DB = $dbPath
$proc = Start-Process -FilePath 'dotnet' -ArgumentList @($dll) -PassThru -WindowStyle Hidden `
    -RedirectStandardOutput (Join-Path $tmpDir 'ui.out.log') -RedirectStandardError (Join-Path $tmpDir 'ui.err.log')

$ready = $false
for ($i = 0; $i -lt 60; $i++) {
    Start-Sleep -Milliseconds 300
    try {
        $h = Invoke-WebRequest "$base/api/health" -SkipHttpErrorCheck -TimeoutSec 3
        if ([int]$h.StatusCode -eq 200) { $ready = $true; break }
    } catch { }
    if ($proc.HasExited) { break }
}
if (-not $ready) { throw "后端没起来，看 $tmpDir\ui.err.log" }

try {
    $env:PROTO_BASE = $base
    node (Join-Path $PSScriptRoot 'ui-smoke.mjs')
    $code = $LASTEXITCODE
}
finally {
    if ($proc -and -not $proc.HasExited) { Stop-Process -Id $proc.Id -Force -ErrorAction SilentlyContinue }
    Start-Sleep -Milliseconds 400
    foreach ($f in @($dbPath, "$dbPath-wal", "$dbPath-shm")) { if (Test-Path $f) { Remove-Item -Force $f -ErrorAction SilentlyContinue } }
}
exit $code
