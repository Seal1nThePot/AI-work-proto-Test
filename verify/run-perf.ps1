# 服务端往返体检：同一个 build，跑两遍——PROTO_SYNC=FULL（每笔提交等磁盘）与 NORMAL（WAL 默认）。
# 用法：pwsh -File verify\run-perf.ps1            # 5090 + 临时库，跑完自清
#       pwsh -File verify\run-perf.ps1 -Keep      # 留着临时库看
param([int]$Port = 5090, [switch]$Keep)

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot                       # test\
$dll = Join-Path $root "backend\WorkProto.Api\bin\Debug\net10.0\WorkProto.Api.dll"
$src = Join-Path $root "data\proto.db"
$tmp = Join-Path $PSScriptRoot ".tmp"
New-Item -ItemType Directory -Force -Path $tmp | Out-Null
$db = Join-Path $tmp "perf.db"

if (-not (Test-Path $dll)) { throw "先构建：dotnet build backend\WorkProto.Api\WorkProto.Api.csproj" }
if (-not (Test-Path $src)) { throw "没有 demo 库：先 pwsh -File verify\seed-demo.ps1" }

function Stop-OnPort([int]$p) {
  $q = (Get-NetTCPConnection -LocalPort $p -State Listen -ErrorAction SilentlyContinue).OwningProcess
  if ($q) { Stop-Process -Id $q -Force; Start-Sleep -Milliseconds 500 }
}

function Start-Proto([int]$p, [string]$sync) {
  $env:PROTO_PORT = "$p"; $env:PROTO_DB = $db; $env:PROTO_SYNC = $sync
  $proc = Start-Process dotnet -ArgumentList $dll -PassThru -WindowStyle Hidden
  $base = "http://127.0.0.1:$p"
  for ($i = 0; $i -lt 60; $i++) {
    Start-Sleep -Milliseconds 200
    try { Invoke-RestMethod "$base/api/health" -TimeoutSec 2 | Out-Null; return $proc } catch { }
  }
  Stop-Process -Id $proc.Id -Force -ErrorAction SilentlyContinue
  throw "服务没起来（端口 $p）"
}

function Median([double[]]$xs) { $s = $xs | Sort-Object; $s[[int]($s.Count / 2)] }

function Time-It($label, [scriptblock]$work, [int]$n = 10) {
  $xs = @()
  for ($i = 0; $i -lt $n; $i++) {
    $sw = [Diagnostics.Stopwatch]::StartNew()
    & $work | Out-Null
    $sw.Stop(); $xs += $sw.Elapsed.TotalMilliseconds
  }
  [pscustomobject]@{ 接口 = $label; 中位 = [math]::Round((Median $xs), 1); 最小 = [math]::Round(($xs | Measure-Object -Min).Minimum, 1); 最大 = [math]::Round(($xs | Measure-Object -Max).Maximum, 1) }
}

function Measure-Once($sync) {
  Stop-OnPort $Port
  foreach ($f in @($db, "$db-wal", "$db-shm")) { if (Test-Path $f) { Remove-Item $f -Force } }
  Copy-Item $src $db
  $proc = Start-Proto $Port $sync
  $base = "http://127.0.0.1:$Port"
  try {
    $tasks = Invoke-RestMethod "$base/api/tasks"
    $task = @($tasks.tasks | Where-Object { $_.nodeCount -ge 5 })[0]
    if (-not $task) { $task = @($tasks.tasks)[0] }
    $g = Invoke-RestMethod "$base/api/tasks/$($task.id)/graph"
    $ids = @($g.nodes | ForEach-Object { $_.id })
    $has = @{}
    foreach ($e in $g.edges) { $has["$($e.fromNodeId)|$($e.toNodeId)"] = $true }
    $pair = $null
    foreach ($a in $ids) { foreach ($b in $ids) { if ($a -ne $b -and -not $has.ContainsKey("$a|$b")) { $pair = @($a, $b); break } }; if ($pair) { break } }
    if (-not $pair) { throw "这个任务里没有可画的新线" }

    $moveBody = @{ x = 300; y = 400 } | ConvertTo-Json
    $edgeBody = @{ from = $pair[0]; to = $pair[1]; kind = "transfer" } | ConvertTo-Json

    $rows = @()
    $rows += Time-It "GET /api/health" { Invoke-RestMethod "$base/api/health" }
    $rows += Time-It "GET /api/nodes/{id}" { Invoke-RestMethod "$base/api/nodes/$($ids[0])" }
    $rows += Time-It "GET graph" { Invoke-RestMethod "$base/api/tasks/$($task.id)/graph" }
    $rows += Time-It "POST /nodes/{id}/move（1 次提交）" { Invoke-RestMethod "$base/api/nodes/$($ids[0])/move" -Method Post -ContentType "application/json" -Body $moveBody }

    # 画一条线：边 + 规则组 + 放行 + 起步 + 两条留痕（原来 8 次自提交）
    $xs = @()
    for ($i = 0; $i -lt 3; $i++) {
      if ($i -gt 0) {
        $g2 = Invoke-RestMethod "$base/api/tasks/$($task.id)/graph"
        $ids2 = @($g2.nodes | ForEach-Object { $_.id })
        $has2 = @{}; foreach ($e in $g2.edges) { $has2["$($e.fromNodeId)|$($e.toNodeId)"] = $true }
        $p2 = $null
        foreach ($a in $ids2) { foreach ($b in $ids2) { if ($a -ne $b -and -not $has2.ContainsKey("$a|$b")) { $p2 = @($a, $b); break } }; if ($p2) { break } }
        $edgeBody = @{ from = $p2[0]; to = $p2[1]; kind = "transfer" } | ConvertTo-Json
      }
      $sw = [Diagnostics.Stopwatch]::StartNew()
      Invoke-RestMethod "$base/api/tasks/$($task.id)/edges" -Method Post -ContentType "application/json" -Body $edgeBody | Out-Null
      $sw.Stop(); $xs += $sw.Elapsed.TotalMilliseconds
    }
    $rows += [pscustomobject]@{ 接口 = "POST /edges（新建，含规则组+放行+留痕）"; 中位 = [math]::Round((Median $xs), 1); 最小 = [math]::Round(($xs | Measure-Object -Min).Minimum, 1); 最大 = [math]::Round(($xs | Measure-Object -Max).Maximum, 1) }

    $rows += Time-It "POST /edges（同一条再画一次，判重早退）" {
      try { Invoke-RestMethod "$base/api/tasks/$($task.id)/edges" -Method Post -ContentType "application/json" -Body $edgeBody } catch { }
    }

    # 并发：16 条新线同时画，看会不会吃 SQLITE_BUSY
    $g3 = Invoke-RestMethod "$base/api/tasks/$($task.id)/graph"
    $ids3 = @($g3.nodes | ForEach-Object { $_.id })
    $has3 = @{}; foreach ($e in $g3.edges) { $has3["$($e.fromNodeId)|$($e.toNodeId)"] = $true }
    $pairs = @()
    foreach ($a in $ids3) { foreach ($b in $ids3) { if ($a -ne $b -and -not $has3.ContainsKey("$a|$b") -and $pairs.Count -lt 16) { $pairs += , @($a, $b) } } ; if ($pairs.Count -ge 16) { break } }
    $swC = [Diagnostics.Stopwatch]::StartNew()
    $codes = $pairs | ForEach-Object -Parallel {
      $b = @{ from = $_[0]; to = $_[1]; kind = "transfer" } | ConvertTo-Json
      try { (Invoke-WebRequest "$using:base/api/tasks/$($using:task.id)/edges" -Method Post -ContentType "application/json" -Body $b -SkipHttpErrorCheck).StatusCode } catch { 0 }
    } -ThrottleLimit 8
    $swC.Stop()
    $concurrency = "{0} 条并发：201={1} 其他={2}  墙钟 {3:N0} ms" -f $pairs.Count, (@($codes | Where-Object { $_ -eq 201 }).Count), (@($codes | Where-Object { $_ -ne 201 }).Count), $swC.Elapsed.TotalMilliseconds

    [pscustomobject]@{ Sync = $sync; Rows = $rows; Concurrency = $concurrency; Task = $task.id; Nodes = $g.nodes.Count; Edges = $g.edges.Count }
  }
  finally {
    Stop-Process -Id $proc.Id -Force -ErrorAction SilentlyContinue
    Start-Sleep -Milliseconds 400
  }
}

$full = Measure-Once "FULL"
$normal = Measure-Once "NORMAL"

""
"任务 $($normal.Task)：$($normal.Nodes) 节点 / $($normal.Edges) 连线（demo 库的副本）。客户端壳约 4–5 ms 已含在数字里。"
""
$table = for ($i = 0; $i -lt $normal.Rows.Count; $i++) {
  [pscustomobject]@{
    接口 = $normal.Rows[$i].接口
    "FULL(等磁盘)中位" = $full.Rows[$i].中位
    "NORMAL(默认)中位" = $normal.Rows[$i].中位
    倍数 = if ($normal.Rows[$i].中位 -gt 0) { [math]::Round($full.Rows[$i].中位 / $normal.Rows[$i].中位, 1) } else { 0 }
  }
}
$table | Format-Table -AutoSize | Out-String -Width 200
""
"FULL   $($full.Concurrency)"
"NORMAL $($normal.Concurrency)"
""
if (-not $Keep) {
  Stop-OnPort $Port
  foreach ($f in @($db, "$db-wal", "$db-shm")) { if (Test-Path $f) { Remove-Item $f -Force -ErrorAction SilentlyContinue } }
  ""
} else { "临时库留着：$db" }
