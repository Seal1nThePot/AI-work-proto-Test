# 用途: 等原型起来（轮询 /api/health）再拉起浏览器窗口，避免打开就是 ERR_CONNECTION_REFUSED
# 暴露: 无（由 启动点.bat 调用）
# 依赖: 原型即将在 -Port 上开服；Chrome / Edge / Firefox 任一
# 被依赖: 启动点.bat
param(
  [int]$Port = 5081,
  [string]$Browser = '',
  [int]$TimeoutSec = 40,
  [switch]$NoLaunch,
  [switch]$DryRun
)

$ErrorActionPreference = 'SilentlyContinue'
$url = 'http://127.0.0.1:' + $Port + '/'

function Resolve-Browser([string]$want) {
  if ($want) {
    switch ($want.ToLower()) {
      'chrome'  { return 'C:\Program Files\Google\Chrome\Application\chrome.exe' }
      'edge'    { return 'C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe' }
      'firefox' { return 'C:\Program Files\Mozilla Firefox\firefox.exe' }
      default   { return '' }
    }
  }
  # 默认优先 Edge（本机默认浏览器，实测能正常开新窗口），再 Chrome，再 Firefox；
  # 想指定就 启动点.bat chrome / edge / firefox，或设 PROTO_BROWSER。
  $cands = @(
    'C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe',
    'C:\Program Files\Microsoft\Edge\Application\msedge.exe',
    'C:\Program Files\Google\Chrome\Application\chrome.exe',
    "$env:LOCALAPPDATA\Google\Chrome\Application\chrome.exe",
    'C:\Program Files (x86)\Google\Chrome\Application\chrome.exe',
    'C:\Program Files\Mozilla Firefox\firefox.exe'
  )
  foreach ($c in $cands) { if (Test-Path $c) { return $c } }
  return ''
}

$want = if ($Browser) { $Browser } elseif ($env:PROTO_BROWSER) { $env:PROTO_BROWSER } else { '' }
$exe = Resolve-Browser $want
$name = if ($exe) { Split-Path -Leaf $exe } else { '(系统默认浏览器)' }

if ($DryRun) {
  'browser = ' + $name
  'target  = ' + $url
  exit 0
}

$deadline = (Get-Date).AddSeconds($TimeoutSec)
$ok = $false
$tries = 0
while ((Get-Date) -lt $deadline) {
  $tries++
  try {
    $r = Invoke-WebRequest -UseBasicParsing -Uri ($url + 'api/health') -TimeoutSec 1
    if ($r.StatusCode -eq 200) { $ok = $true; break }
  } catch { }
  Start-Sleep -Milliseconds 400
}

if (-not $ok) {
  '等 ' + $TimeoutSec + ' 秒还没起来（' + $url + '），不自动开窗口。'
  exit 1
}
if ($NoLaunch) { 'health ok after ' + $tries + ' 次探测'; exit 0 }

if ($exe) {
  Start-Process -FilePath $exe -ArgumentList '--new-window', $url
  '已用 ' + $name + ' 打开 ' + $url
} else {
  Start-Process $url
  '已用系统默认浏览器打开 ' + $url
}
exit 0
