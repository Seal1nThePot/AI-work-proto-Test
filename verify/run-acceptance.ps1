# 阶段五 · 六条跑通标准（验收脚本）
# 自带临时库、自己起一个后端实例（默认 5082），跑完关掉；不连 SkyOps、不碰 demo 库。
# 用法： pwsh -File verify\run-acceptance.ps1

#requires -Version 7.0
param(
    [int]$Port = 5082,
    [switch]$KeepDb,
    # 5081 的 demo 服务在跑时会锁住 bin 里的 dll，此时加 -NoBuild 用现有构建
    [switch]$NoBuild
)

$ErrorActionPreference = 'Stop'
$testRoot = Split-Path -Parent $PSScriptRoot
$apiProject = Join-Path $testRoot 'backend\WorkProto.Api'
$dll = Join-Path $apiProject 'bin\Debug\net10.0\WorkProto.Api.dll'
$tmpDir = Join-Path $PSScriptRoot '.tmp'
$dbPath = Join-Path $tmpDir 'accept.db'
$base = "http://127.0.0.1:$Port"

$results = [System.Collections.Generic.List[object]]::new()

function Record([string]$name, [bool]$ok, [string]$detail = '') {
    $results.Add([pscustomobject]@{ name = $name; ok = $ok; detail = $detail })
    $mark = if ($ok) { 'PASS' } else { 'FAIL' }
    $color = if ($ok) { 'Green' } else { 'Red' }
    Write-Host ("[{0}] {1}{2}" -f $mark, $name, $(if ($detail) { "  —  $detail" } else { '' })) -ForegroundColor $color
}

function Prop($obj, [string]$name, $default = $null) {
    if ($null -eq $obj) { return $default }
    $p = $obj.PSObject.Properties[$name]
    if ($null -eq $p) { return $default }
    return $p.Value
}

function Api([string]$method, [string]$path, $body = $null) {
    $params = @{
        Method              = $method
        Uri                 = "$base$path"
        SkipHttpErrorCheck  = $true
        TimeoutSec          = 30
    }
    if ($null -ne $body) {
        $params.Body = ($body | ConvertTo-Json -Depth 12 -Compress)
        $params.ContentType = 'application/json; charset=utf-8'
    }
    $resp = Invoke-WebRequest @params
    $parsed = $null
    try { $parsed = $resp.Content | ConvertFrom-Json } catch { }
    [pscustomobject]@{ status = [int]$resp.StatusCode; body = $parsed; raw = $resp.Content }
}

# ---------- 起后端 ----------

New-Item -ItemType Directory -Force -Path $tmpDir | Out-Null
foreach ($f in @($dbPath, "$dbPath-wal", "$dbPath-shm")) { if (Test-Path $f) { Remove-Item -Force $f } }

if (-not $NoBuild) {
    Write-Host "构建后端…"
    & dotnet build $apiProject -v q --nologo | Out-Null
}
if (-not (Test-Path $dll)) { throw "未找到 $dll" }

$env:PROTO_PORT = "$Port"
$env:PROTO_DB = $dbPath
$logOut = Join-Path $tmpDir 'server.out.log'
$logErr = Join-Path $tmpDir 'server.err.log'
$proc = Start-Process -FilePath 'dotnet' -ArgumentList @($dll) -PassThru -WindowStyle Hidden `
    -RedirectStandardOutput $logOut -RedirectStandardError $logErr
Write-Host "后端 pid=$($proc.Id) 库=$dbPath 端口=$Port"

$ready = $false
for ($i = 0; $i -lt 60; $i++) {
    Start-Sleep -Milliseconds 300
    try {
        $h = Invoke-WebRequest "$base/api/health" -SkipHttpErrorCheck -TimeoutSec 3
        if ([int]$h.StatusCode -eq 200) { $ready = $true; break }
    } catch { }
    if ($proc.HasExited) { break }
}
if (-not $ready) {
    $err = if (Test-Path $logErr) { Get-Content $logErr -Raw } else { '' }
    throw "后端没起来。stderr:`n$err"
}

try {

# ============ S1 · 0 节点任务被拒 ============
Api POST '/api/tasks' @{
    id = 't-zero'; title = 'S1 零节点任务'; goalLine = '验证 0 节点被拒且文案不误导'
    nodes = @(); edges = @(); groups = @(); cycles = @()
} | Out-Null
$r = Api POST '/api/tasks/t-zero/claim' @{ agent = 'agent-s1' }
Record 'S1 认领 0 节点任务被拒（409）' ($r.status -eq 409) "status=$($r.status)"
Record 'S1 原因码 = no-nodes' ((Prop $r.body 'error') -eq 'no-nodes') "error=$(Prop $r.body 'error')"
Record 'S1 文案说清是没节点' ((Prop $r.body 'message') -like '*没有节点*') "$(Prop $r.body 'message')"

# ============ S2 · 全孤立节点不死锁 ============
Api POST '/api/tasks' @{
    id = 't-isolated'; title = 'S2 全孤立节点'; goalLine = '三个互不相连的节点应能同时开工'
    nodes = @(
        @{ id = 'A1'; title = '目标说明'; goalLine = '写清这个任务要什么'; seq = 1 },
        @{ id = 'B1'; title = '文献'; goalLine = '找三份可用材料'; seq = 2 },
        @{ id = 'C1'; title = '案例'; goalLine = '选一个可对标案例'; seq = 3 }
    )
    edges = @(); groups = @(); cycles = @()
} | Out-Null
$r = Api POST '/api/tasks/t-isolated/claim' @{ agent = 'agent-s2' }
$act = @(Prop $r.body 'activated' @())
Record 'S2 认领成功（200）' ($r.status -eq 200) "status=$($r.status)"
Record 'S2 三个节点同时起步' ($act.Count -eq 3) "activated=$($act -join ',')"
$g = (Api GET '/api/tasks/t-isolated/graph').body
$activeCount = @($g.nodes | Where-Object { $_.status -eq 'active' }).Count
Record 'S2 无死锁：三个都 active' ($activeCount -eq 3) "active=$activeCount"
Record 'S2 不报 409 死锁' ($r.status -ne 409) "status=$($r.status)"

# ============ S3 · 择一（3 选 1）走到 100% ============
Api POST '/api/tasks' @{
    id = 't-pick'; title = 'S3 择一 3 选 1'; goalLine = '选中一条路线，未选落 skipped，进度到 100%'
    nodes = @(
        @{ id = 'P-A'; title = 'A 目标说明'; goalLine = '交付 A_FINAL'; seq = 1 },
        @{ id = 'P-B'; title = 'B 文献'; goalLine = '交付 B_FINAL'; seq = 2 },
        @{ id = 'P-C'; title = 'C 案例'; goalLine = '交付 C_FINAL'; seq = 3 },
        @{ id = 'P-H'; title = 'H 交付准备'; goalLine = '只采用一条路线成包'; seq = 4 }
    )
    edges = @(
        @{ id = 'eAH'; from = 'P-A'; to = 'P-H'; kind = 'transfer' },
        @{ id = 'eBH'; from = 'P-B'; to = 'P-H'; kind = 'transfer' },
        @{ id = 'eCH'; from = 'P-C'; to = 'P-H'; kind = 'transfer' }
    )
    groups = @(
        @{ id = 'gH'; nodeId = 'P-H'; mode = 'pick_one'; items = @('eAH', 'eBH', 'eCH') }
    )
    cycles = @()
} | Out-Null
$r = Api POST '/api/tasks/t-pick/claim' @{ agent = 'agent-s3' }
Record 'S3 认领后三条候选同时起步' ((@(Prop $r.body 'activated' @())).Count -eq 3) "activated=$((Prop $r.body 'activated') -join ',')"
foreach ($n in 'P-A', 'P-B', 'P-C') { Api POST "/api/nodes/$n/complete" @{ by = 'agent-s3' } | Out-Null }

$r = Api POST '/api/nodes/P-H/start' @{ by = 'agent-s3' }
Record 'S3 未选路线时 H 被拒（gate-unsatisfied）' ($r.status -eq 409 -and (Prop $r.body 'error') -eq 'gate-unsatisfied') "status=$($r.status) error=$(Prop $r.body 'error')"

$r = Api POST '/api/tasks/t-pick/pick' @{ groupId = 'gH'; edgeId = 'eAH'; by = 'master' }
Record 'S3 选定 A 后 H 起步' ((@(Prop $r.body 'activated' @())) -contains 'P-H') "activated=$((Prop $r.body 'activated') -join ',')"
Record 'S3 未选分支落 skipped' ((@(Prop $r.body 'skipped' @())).Count -eq 2) "skipped=$((Prop $r.body 'skipped') -join ',')"

$r = Api POST '/api/tasks/t-pick/pick' @{ groupId = 'gH'; edgeId = 'eBH'; by = 'master' }
Record 'S3 二次择一被拒（pick-already-decided）' ($r.status -eq 409 -and (Prop $r.body 'error') -eq 'pick-already-decided') "status=$($r.status) error=$(Prop $r.body 'error')"

Api POST '/api/nodes/P-H/complete' @{ by = 'agent-s3' } | Out-Null
$g = (Api GET '/api/tasks/t-pick/graph').body
Record 'S3 进度到 100%' ((Prop $g.task 'progress') -eq 100) "progress=$(Prop $g.task 'progress')"
$statuses = ($g.nodes | ForEach-Object { "$($_.id)=$($_.status)" }) -join ' '
Record 'S3 B/C 为 skipped、H 为 approved' (($g.nodes | Where-Object { $_.id -in 'P-B', 'P-C' -and $_.status -eq 'skipped' }).Count -eq 2 -and ($g.nodes | Where-Object { $_.id -eq 'P-H' }).status -eq 'approved') $statuses

# ============ S4 · 回边循环到第 3 轮出检查点 ============
Api POST '/api/tasks' @{
    id = 't-cycle'; title = 'S4 回边循环'; goalLine = '第 3 轮跑完先出检查点，判无进展才停'
    nodes = @(
        @{ id = 'K-H'; title = 'H 起草'; goalLine = '按目标起草'; seq = 1; cycleRegion = 'R1' },
        @{ id = 'K-M'; title = 'M 测量'; goalLine = '量结果后决定要不要再来一轮'; seq = 2; cycleRegion = 'R1' }
    )
    edges = @(
        @{ id = 'eHM'; from = 'K-H'; to = 'K-M'; kind = 'transfer' },
        @{ id = 'eMH'; from = 'K-M'; to = 'K-H'; kind = 'loop' }
    )
    groups = @()
    cycles = @(
        @{ id = 'cy-R1'; regionKey = 'R1'; head = 'K-H'; tail = 'K-M'; limit = 3 }
    )
} | Out-Null
$r = Api POST '/api/tasks/t-cycle/claim' @{ agent = 'agent-s4' }
Record 'S4 认领后循环头起步' ((@(Prop $r.body 'activated' @())) -contains 'K-H') "activated=$((Prop $r.body 'activated') -join ',')"

$third = $null
for ($round = 1; $round -le 3; $round++) {
    Api POST '/api/nodes/K-H/complete' @{ by = 'agent-s4' } | Out-Null
    $r = Api POST '/api/nodes/K-M/complete' @{ by = 'agent-s4' }
    if ($round -lt 3) {
        $cyc = Prop $r.body 'cycle'
        Record "S4 第 $round 轮跑完进入下一轮" ((Prop $cyc 'executed') -eq $true -and (Prop $cyc 'cycleEpoch') -eq ($round + 1)) "cycleEpoch=$(Prop $cyc 'cycleEpoch')"
    } else {
        $third = Prop $r.body 'cycle'
    }
}
Record 'S4 第 3 轮跑完要求检查点（不执行第 4 轮）' ((Prop $third 'checkpointRequired') -eq $true -and (Prop $third 'executed') -eq $false) "checkpointRequired=$(Prop $third 'checkpointRequired')"

$r = Api POST '/api/tasks/t-cycle/checkpoint' @{
    nodeId = 'K-H'; doing = '第 3 轮改了三处措辞'; nextStep = '想再跑一轮验新假设'
    goal = '让第 3 轮的改动经得起复核'; verdict = 'no_progress'; by = 'agent-s4'
}
Record 'S4 检查点判无进展 → 节点 blocked' ((Prop (Prop $r.body 'cycle') 'nodeStatus') -eq 'blocked') "nodeStatus=$(Prop (Prop $r.body 'cycle') 'nodeStatus')"
$g = (Api GET '/api/tasks/t-cycle/graph').body
$head = $g.nodes | Where-Object { $_.id -eq 'K-H' }
Record 'S4 阻塞原因 = cycle-limit' ($head.status -eq 'blocked' -and $head.blockedReason -eq 'cycle-limit') "status=$($head.status) reason=$($head.blockedReason)"

$r = Api POST '/api/tasks/t-cycle/claim' @{ agent = 'agent-s4b' }
Record 'S4 全阻塞时认领被拒（nothing-to-do:blocked）' ($r.status -eq 409 -and (Prop $r.body 'error') -eq 'nothing-to-do:blocked') "status=$($r.status) error=$(Prop $r.body 'error')"

$r = Api POST '/api/cycles/cy-R1/raise' @{ by = 'owner'; limit = 5; reason = '越权测试' }
Record 'S4 非 master/lead 调高上限被拒（403）' ($r.status -eq 403 -and (Prop $r.body 'error') -eq 'blocked-release-forbidden') "status=$($r.status)"

$r = Api POST '/api/cycles/cy-R1/raise' @{ by = 'lead'; limit = 5; reason = '第 4 轮能验新假设，上限提到 5' }
Record 'S4 lead 调高上限并恢复（200）' ($r.status -eq 200 -and (Prop (Prop $r.body 'resumed') 'executed') -eq $true) "status=$($r.status) resumed=$(Prop (Prop $r.body 'resumed') 'executed')"
$g = (Api GET '/api/tasks/t-cycle/graph').body
$head2 = $g.nodes | Where-Object { $_.id -eq 'K-H' }
Record 'S4 恢复后循环头回到 active 且为第 4 轮' ($head2.status -eq 'active' -and $head2.cycleEpoch -eq 4) "status=$($head2.status) epoch=$($head2.cycleEpoch)"

# ============ S5 · 检查点三句话落库可查 ============
$r = Api POST '/api/tasks/t-isolated/checkpoint' @{
    nodeId = 'A1'; doing = '在写目标说明'; nextStep = '补三条完成标准'; goal = '让目标可被复核'
    verdict = 'progress'; by = 'agent-s2'
}
Record 'S5 检查点写入成功（200）' ($r.status -eq 200) "status=$($r.status)"
$d = (Api GET '/api/nodes/A1').body
$c = @(Prop $d 'checkpoints' @())
Record 'S5 三句话与起止时间可查' ($c.Count -ge 1 -and $c[0].doing -eq '在写目标说明' -and $c[0].nextStep -eq '补三条完成标准' -and $c[0].goal -eq '让目标可被复核' -and $c[0].startedAtUtc -and $c[0].endedAtUtc) "count=$($c.Count)"
Record 'S5 verdict 与轮次落库' (@($c[0].verdict -eq 'progress').Count -eq 1) "verdict=$($c[0].verdict) visit=$($c[0].cycleVisit)"
$dCycle = (Api GET '/api/nodes/K-H').body
$cCycle = @(Prop $dCycle 'checkpoints' @())
Record 'S5 循环任务的检查点带轮次号' ($cCycle.Count -ge 1 -and $cCycle[0].cycleVisit -eq 3) "cycleVisit=$($cCycle[0].cycleVisit)"

# ============ S6 · 每条拒绝都有原因码 ============
Api POST '/api/tasks' @{
    id = 't-reject'; title = 'S6 拒绝语义'; goalLine = '每条拒绝都带原因码'
    nodes = @(
        @{ id = 'R-A'; title = '上游'; goalLine = '先做完'; seq = 1 },
        @{ id = 'R-B'; title = '下游'; goalLine = '等上游材料'; seq = 2 }
    )
    edges = @(@{ id = 'eAB'; from = 'R-A'; to = 'R-B'; kind = 'transfer' })
    groups = @(@{ id = 'gB'; nodeId = 'R-B'; mode = 'all'; items = @('eAB') })
    cycles = @()
} | Out-Null
Api POST '/api/tasks/t-reject/claim' @{ agent = 'agent-s6' } | Out-Null
$r = Api POST '/api/nodes/R-B/start' @{ by = 'agent-s6' }
$waiting = Prop (Prop $r.body 'details') 'waitingOn'
Record 'S6 门未满足被拒并给出缺哪条入边' ($r.status -eq 409 -and (Prop $r.body 'error') -eq 'gate-unsatisfied' -and @($waiting).Count -ge 1) "error=$(Prop $r.body 'error') waiting=$(($waiting | ForEach-Object { $_.edgeId + '/' + $_.reason }) -join ',')"
Record 'S6 缺边原因区分「上游未完成」' (@($waiting)[0].reason -eq 'upstream-not-approved') "reason=$(@($waiting)[0].reason)"

$r = Api POST '/api/tasks/t-reject/release' @{ agent = 'agent-s6' }
Record 'S6 释放租约成功（200）' ($r.status -eq 200) "status=$($r.status)"
$r = Api POST '/api/tasks/t-reject/claim' @{ agent = 'agent-s6b' }
Record 'S6 无可起步节点时认领被拒（nothing-to-do:waiting）' ($r.status -eq 409 -and (Prop $r.body 'error') -eq 'nothing-to-do:waiting') "status=$($r.status) error=$(Prop $r.body 'error')"

$r = Api POST '/api/nodes/R-B/complete' @{ by = 'agent-s6' }
Record 'S6 非 active 节点标完成被拒（node-not-active）' ($r.status -eq 409 -and (Prop $r.body 'error') -eq 'node-not-active') "status=$($r.status) error=$(Prop $r.body 'error')"

$r = Api POST '/api/nodes/R-B/unblock' @{ by = 'owner'; reason = '越权测试' }
Record 'S6 非 master/lead 解除阻塞被拒（403）' ($r.status -eq 403) "status=$($r.status) error=$(Prop $r.body 'error')"

$r = Api GET '/api/tasks/nope/graph'
Record 'S6 不存在的任务给 404 + task-not-found' ($r.status -eq 404 -and (Prop $r.body 'error') -eq 'task-not-found') "status=$($r.status) error=$(Prop $r.body 'error')"

$d = (Api GET '/api/nodes/R-B').body
Record 'S6 节点页能读出上次被拒原因' ((Prop $d 'lastRejection') -eq 'gate-unsatisfied:eAB/upstream-not-approved') "lastRejection=$(Prop $d 'lastRejection')"

# ============ S7 · 口径 2：多任务排队，同时只跑一个 ============
Api POST '/api/tasks' @{ id = 't-q1'; title = 'S7 排队任务一'; goalLine = '先跑这个'; nodes = @(@{ id = 'Q1'; title = '第一步'; goalLine = '做完就完'; seq = 1 }); edges = @(); groups = @(); cycles = @() } | Out-Null
Api POST '/api/tasks' @{ id = 't-q2'; title = 'S7 排队任务二'; goalLine = '排队等接上'; nodes = @(@{ id = 'Q2'; title = '第一步'; goalLine = '做完就完'; seq = 1 }); edges = @(); groups = @(); cycles = @() } | Out-Null
$r1 = Api POST '/api/tasks/t-q1/claim' @{ agent = 'agent-q' }
$r2 = Api POST '/api/tasks/t-q2/claim' @{ agent = 'agent-q' }
Record 'S7 同一 agent 第一个任务 active' ((Prop $r1.body 'state') -eq 'active') "state=$(Prop $r1.body 'state')"
Record 'S7 同一 agent 第二个任务入队 queued' ((Prop $r2.body 'state') -eq 'queued') "state=$(Prop $r2.body 'state')"
$r3 = Api POST '/api/tasks/t-q1/release' @{ agent = 'agent-q' }
Record 'S7 释放后队列自动接上' ((Prop $r3.body 'promoted') -eq 't-q2') "promoted=$(Prop $r3.body 'promoted')"
$gq = (Api GET '/api/tasks/t-q2/graph').body
Record 'S7 排队任务接上后节点已起步' (($gq.nodes | Where-Object { $_.id -eq 'Q2' }).status -eq 'active') "status=$(($gq.nodes | Where-Object { $_.id -eq 'Q2' }).status)"

# ============ S8 · 新建节点（规则与建图同一套） ============
Api POST '/api/tasks' @{
    id = 't-build'; title = 'S8 新建节点'; goalLine = '往已有图里加节点'
    nodes = @(@{ id = 'NB-A'; title = 'A 已有节点'; goalLine = '先有它'; seq = 1 })
    edges = @(); groups = @(); cycles = @()
} | Out-Null
$r = Api POST '/api/tasks/t-build/claim' @{ agent = 'agent-s8' }
Record 'S8 认领时只起步已有的那一个节点' (@(Prop $r.body 'activated' @()).Count -eq 1 -and (@(Prop $r.body 'activated' @())) -contains 'NB-A') "activated=$((Prop $r.body 'activated') -join ',')"

$r = Api POST '/api/tasks/t-build/nodes' @{ title = 'B 文献'; goalLine = '找三份可用材料' }
$nb = Prop $r.body 'node'
Record 'S8 新建节点 201 且自动排在末尾' ($r.status -eq 201 -and (Prop $nb 'seq') -eq 2 -and (Prop $nb 'status') -eq 'pending') "status=$($r.status) seq=$(Prop $nb 'seq')"
Record 'S8 新节点 id 由服务端生成' ((Prop $nb 'id') -like 'nd_*') "id=$(Prop $nb 'id')"
$bId = Prop $nb 'id'

$r = Api POST '/api/tasks/t-build/nodes' @{ title = '   ' }
Record 'S8 空标题被拒（title-required）' ($r.status -eq 400 -and (Prop $r.body 'error') -eq 'title-required') "error=$(Prop $r.body 'error')"
$r = Api POST '/api/tasks/t-build/nodes' @{ title = '复合节点'; kind = 'composite' }
Record 'S8 非法 kind 被拒（kind-invalid）' ($r.status -eq 400 -and (Prop $r.body 'error') -eq 'kind-invalid') "error=$(Prop $r.body 'error')"
$r = Api POST '/api/tasks/t-build/nodes' @{ title = '抢占序号'; seq = 2 }
Record 'S8 序号撞号被拒（seq-taken）' ($r.status -eq 409 -and (Prop $r.body 'error') -eq 'seq-taken') "status=$($r.status) error=$(Prop $r.body 'error')"
$r = Api POST '/api/tasks/t-build/nodes' @{ id = 'NB-A'; title = '重名节点' }
Record 'S8 节点 id 重名被拒（node-exists）' ($r.status -eq 409 -and (Prop $r.body 'error') -eq 'node-exists') "status=$($r.status) error=$(Prop $r.body 'error')"

# ============ S9 · 新建连线：判重 / 端点 / 自环 / 自动规则组 ============
Api POST '/api/nodes/NB-A/complete' @{ by = 'agent-s8' } | Out-Null
$r = Api POST '/api/tasks/t-build/edges' @{ from = 'NB-A'; to = $bId }
Record 'S9 画线自动生成输入规则组' ($r.status -eq 201 -and (Prop $r.body 'groupCreated') -eq $true -and @(Prop $r.body 'groupItems').Count -eq 1) "status=$($r.status) groupCreated=$(Prop $r.body 'groupCreated')"
Record 'S9 画线后下游按门自动起步' ((@(Prop $r.body 'activated' @())) -contains $bId) "activated=$((Prop $r.body 'activated') -join ',')"

$r = Api POST '/api/tasks/t-build/edges' @{ from = 'NB-A'; to = $bId }
Record 'S9 同一条线重复建被拒（edge-duplicate）' ($r.status -eq 409 -and (Prop $r.body 'error') -eq 'edge-duplicate') "status=$($r.status) error=$(Prop $r.body 'error')"
$r = Api POST '/api/tasks/t-build/edges' @{ from = 'NB-A'; to = 'NOPE' }
Record 'S9 连到不存在的节点被拒（unknown-node）' ($r.status -eq 400 -and (Prop $r.body 'error') -eq 'unknown-node') "status=$($r.status) error=$(Prop $r.body 'error')"
$r = Api POST '/api/tasks/t-build/edges' @{ from = 'NB-A'; to = 'NB-A' }
Record 'S9 普通线不许自环（loop-needs-cycle）' ($r.status -eq 409 -and (Prop $r.body 'error') -eq 'loop-needs-cycle') "status=$($r.status) error=$(Prop $r.body 'error')"

# 并入已有择一组
$r = Api POST '/api/tasks/t-pick/nodes' @{ title = 'D 补充候选'; goalLine = '第四种走法' }
$dId = Prop (Prop $r.body 'node') 'id'
$r = Api POST '/api/tasks/t-pick/edges' @{ from = $dId; to = 'P-H' }
Record 'S9 新线并入已有 pick_one 组（不新建组）' ($r.status -eq 201 -and (Prop $r.body 'groupCreated') -eq $false -and @(Prop $r.body 'groupItems').Count -eq 4) "groupCreated=$(Prop $r.body 'groupCreated') items=$(@(Prop $r.body 'groupItems').Count)"

# ============ S10 · 回边必须落进已声明的循环区 ============
$r = Api POST '/api/tasks/t-build/nodes' @{ title = 'K1 循环头'; goalLine = '第 N 轮起草'; cycleRegion = 'R9' }
Record 'S10 带循环区的节点给出补齐提示（现在提的是节点组）' ($r.status -eq 201 -and (Prop $r.body 'hint') -like '*节点组*') "hint=$(Prop $r.body 'hint')"
$r = Api POST '/api/tasks/t-build/nodes' @{ title = 'K2 循环尾'; goalLine = '量完决定要不要再来'; cycleRegion = 'R9' }
Record 'S10 第二个循环区节点建成' ($r.status -eq 201) "status=$($r.status)"

$r = Api POST '/api/tasks/t-build/edges' @{ from = $bId; to = $bId; kind = 'loop' }
Record 'S10 无循环声明的回边被拒（loop-needs-cycle）' ($r.status -eq 409 -and (Prop $r.body 'error') -eq 'loop-needs-cycle') "status=$($r.status) error=$(Prop $r.body 'error')"

$regionNodes = (Api GET '/api/tasks/t-build/graph').body.nodes | Where-Object { $_.cycleRegion -eq 'R9' } | Sort-Object seq
$k1 = $regionNodes[0].id; $k2 = $regionNodes[1].id
$r = Api POST '/api/tasks/t-build/cycles' @{ regionKey = 'R9'; head = $k1; tail = $k2; limit = 3 }
Record 'S10 声明循环成功（201，上限 3）' ($r.status -eq 201 -and (Prop $r.body 'limit') -eq 3) "status=$($r.status) limit=$(Prop $r.body 'limit')"
$g = (Api GET '/api/tasks/t-build/graph').body
$loopEdges = @($g.edges | Where-Object { $_.kind -eq 'loop' })
Record 'S10 声明循环＝组＋回边＋检查点一次配齐（回边自动建好）' (@($loopEdges).Count -eq 1) "loopEdges=$(@($loopEdges).Count)"
$r9Group = @($g.nodeGroups | Where-Object { $_.title -eq 'R9' })[0]
$cyc = @($g.cycles)[0]
Record 'S10 循环区挂在组上（cycles.groupId ＝ 组的 id）' ($cyc.groupId -eq $r9Group.id -and @($r9Group.nodeIds).Count -eq 2) `
    "cycle.groupId=$($cyc.groupId) group=$($r9Group.id) members=$(@($r9Group.nodeIds).Count)"
$r = Api POST '/api/tasks/t-build/cycles' @{ regionKey = 'R9'; head = $k1; tail = $k2; limit = 3 }
Record 'S10 同一个组重复声明循环被拒（cycle-exists）' ($r.status -eq 409 -and (Prop $r.body 'error') -eq 'cycle-exists') "status=$($r.status)"
$r = Api DELETE "/api/node-groups/$($r9Group.id)"
Record 'S10 循环组不能直接删（group-is-loop）' ($r.status -eq 409 -and (Prop $r.body 'error') -eq 'group-is-loop') "status=$($r.status) error=$(Prop $r.body 'error')"

# ============ S11 · 画布位置（拖动落坐标） ============
$r = Api POST '/api/nodes/NB-A/move' @{ x = 300; y = 220 }
Record 'S11 拖动坐标落库（200）' ($r.status -eq 200 -and (Prop $r.body 'posX') -eq 300 -and (Prop $r.body 'posY') -eq 220) "pos=($(Prop $r.body 'posX'),$(Prop $r.body 'posY'))"
$g = (Api GET '/api/tasks/t-build/graph').body
$moved = $g.nodes | Where-Object { $_.id -eq 'NB-A' }
Record 'S11 图接口回带坐标（刷新后不丢）' ($moved.posX -eq 300 -and $moved.posY -eq 220) "pos=($($moved.posX),$($moved.posY))"
$r = Api POST '/api/nodes/NB-A/move' @{ x = 120 }
Record 'S11 缺坐标被拒（bad-request）' ($r.status -eq 400 -and (Prop $r.body 'error') -eq 'bad-request') "status=$($r.status) error=$(Prop $r.body 'error')"
$r = Api POST '/api/nodes/NOPE/move' @{ x = 1; y = 1 }
Record 'S11 不存在节点给 404 + node-not-found' ($r.status -eq 404 -and (Prop $r.body 'error') -eq 'node-not-found') "status=$($r.status) error=$(Prop $r.body 'error')"

# ============ S12 · 删节点（双击手滑留下的那种） ============
Api POST '/api/tasks' @{
    id = 't-del'; title = 'S12 删节点'; goalLine = '只删得起从未起步的节点'
    nodes = @(
        @{ id = 'DL-1'; title = '留着'; seq = 1 },
        @{ id = 'DL-2'; title = '手滑建的'; seq = 2 }
    )
    edges = @(); groups = @(); cycles = @()
} | Out-Null
$r = Api DELETE '/api/nodes/DL-2'
Record 'S12 删掉未起步且无连线的节点（200）' ($r.status -eq 200) "status=$($r.status)"
$g = (Api GET '/api/tasks/t-del/graph').body
Record 'S12 图里少了一个节点' (@($g.nodes).Count -eq 1) "nodes=$(@($g.nodes).Count)"

Api POST '/api/tasks' @{
    id = 't-del2'; title = 'S12 删节点反例'; goalLine = '有线或已起步的都删不了'
    nodes = @(
        @{ id = 'DM-1'; title = '上游'; seq = 1 },
        @{ id = 'DM-2'; title = '下游'; seq = 2 }
    )
    edges = @(@{ id = 'eDM'; from = 'DM-1'; to = 'DM-2' })
    groups = @(); cycles = @()
} | Out-Null
$r = Api DELETE '/api/nodes/DM-1'
Record 'S12 还挂着线的节点被拒（node-has-edges）' ($r.status -eq 409 -and (Prop $r.body 'error') -eq 'node-has-edges') "status=$($r.status) error=$(Prop $r.body 'error')"
$r = Api DELETE '/api/nodes/NB-A'
Record 'S12 已起步的节点被拒（node-not-pending）' ($r.status -eq 409 -and (Prop $r.body 'error') -eq 'node-not-pending') "status=$($r.status) error=$(Prop $r.body 'error')"

# ============ S13 · 自定义接线口 ============
Api POST '/api/tasks' @{
    id = 't-ports'; title = 'S13 接线口'; goalLine = '每个节点可自定进出线口数量'
    nodes = @(
        @{ id = 'PT-A'; title = '三出口节点'; seq = 1; outPorts = 3 }
        @{ id = 'PT-B'; title = '三入口节点'; seq = 2; inPorts = 3 }
        @{ id = 'PT-C'; title = '单口节点'; seq = 3 }
    )
    edges = @(); groups = @(); cycles = @()
} | Out-Null
$g = (Api GET '/api/tasks/t-ports/graph').body
$ptA = $g.nodes | Where-Object { $_.id -eq 'PT-A' }
Record 'S13 建图即可指定口数并回带' ($ptA.outPorts -eq 3 -and $ptA.inPorts -eq 1) "in=$($ptA.inPorts) out=$($ptA.outPorts)"

$r = Api POST '/api/tasks/t-ports/edges' @{ from = 'PT-A'; to = 'PT-B'; fromPort = 2; toPort = 1 }
Record 'S13 连线记住挂第几个口' ($r.status -eq 201 -and (Prop (Prop $r.body 'edge') 'fromPort') -eq 2 -and (Prop (Prop $r.body 'edge') 'toPort') -eq 1) "from=$(Prop (Prop $r.body 'edge') 'fromPort') to=$(Prop (Prop $r.body 'edge') 'toPort')"

$r = Api POST '/api/tasks/t-ports/edges' @{ from = 'PT-A'; to = 'PT-C'; fromPort = 3 }
Record 'S13 取不存在的出线口被拒（port-out-of-range）' ($r.status -eq 400 -and (Prop $r.body 'error') -eq 'port-out-of-range') "status=$($r.status) error=$(Prop $r.body 'error')"

$r = Api POST '/api/nodes/PT-B/ports' @{ inPorts = 1; outPorts = 1 }
Record 'S13 缩到已占用口之下被拒（port-in-use）' ($r.status -eq 409 -and (Prop $r.body 'error') -eq 'port-in-use') "status=$($r.status) error=$(Prop $r.body 'error')"

$r = Api POST '/api/nodes/PT-C/ports' @{ inPorts = 2; outPorts = 5 }
Record 'S13 改口数成功（200）' ($r.status -eq 200 -and (Prop $r.body 'inPorts') -eq 2 -and (Prop $r.body 'outPorts') -eq 5) "in=$(Prop $r.body 'inPorts') out=$(Prop $r.body 'outPorts')"

$r = Api POST '/api/nodes/PT-C/ports' @{ inPorts = 0; outPorts = 5 }
Record 'S13 口数低于 1 被拒（port-out-of-range）' ($r.status -eq 400 -and (Prop $r.body 'error') -eq 'port-out-of-range') "status=$($r.status) error=$(Prop $r.body 'error')"

# ============ S14 · 批量落坐标（框选一起拖） ============
$r = Api POST '/api/tasks/t-ports/layout' @{ nodes = @(@{ id = 'PT-A'; x = 120; y = 90 }, @{ id = 'PT-B'; x = 420; y = 300 }) }
Record 'S14 批量落坐标（200）' ($r.status -eq 200 -and (Prop $r.body 'moved') -eq 2) "moved=$(Prop $r.body 'moved')"
$g = (Api GET '/api/tasks/t-ports/graph').body
$ptb = $g.nodes | Where-Object { $_.id -eq 'PT-B' }
Record 'S14 两个节点都到位（刷新后还在）' ($ptb.posX -eq 420 -and $ptb.posY -eq 300) "pos=($($ptb.posX),$($ptb.posY))"
$r = Api POST '/api/tasks/t-ports/layout' @{ nodes = @(@{ id = 'NOPE'; x = 1; y = 1 }) }
Record 'S14 混进不存在的节点被拒（node-not-found）' ($r.status -eq 404 -and (Prop $r.body 'error') -eq 'node-not-found') "status=$($r.status) error=$(Prop $r.body 'error')"
$r = Api POST '/api/tasks/t-ports/layout' @{ nodes = @() }
Record 'S14 空列表被拒（bad-request）' ($r.status -eq 400 -and (Prop $r.body 'error') -eq 'bad-request') "status=$($r.status) error=$(Prop $r.body 'error')"

# ============ S15 · 画布没有边缘上限（负坐标照收，多大随节点而定） ============
$r = Api POST '/api/nodes/PT-A/move' @{ x = -260; y = -180 }
Record 'S15 拖到左上负坐标照收（不再夹到 0）' ($r.status -eq 200 -and (Prop $r.body 'posX') -eq -260 -and (Prop $r.body 'posY') -eq -180) "pos=($(Prop $r.body 'posX'),$(Prop $r.body 'posY'))"
$g = (Api GET '/api/tasks/t-ports/graph').body
$negA = $g.nodes | Where-Object { $_.id -eq 'PT-A' }
Record 'S15 负坐标读得回来（刷新后不被夹）' ($negA.posX -eq -260 -and $negA.posY -eq -180) "pos=($($negA.posX),$($negA.posY))"

$r = Api POST '/api/tasks/t-ports/layout' @{ nodes = @(@{ id = 'PT-A'; x = -1200; y = -900 }, @{ id = 'PT-B'; x = -40; y = -3000 }) }
Record 'S15 批量也能落到负坐标（往外交，不是边界）' ($r.status -eq 200 -and (Prop $r.body 'moved') -eq 2) "status=$($r.status) moved=$(Prop $r.body 'moved')"
$g = (Api GET '/api/tasks/t-ports/graph').body
$negA2 = $g.nodes | Where-Object { $_.id -eq 'PT-A' }
$negB2 = $g.nodes | Where-Object { $_.id -eq 'PT-B' }
Record 'S15 批量负坐标原样落库' ($negA2.posX -eq -1200 -and $negA2.posY -eq -900 -and $negB2.posX -eq -40 -and $negB2.posY -eq -3000) `
    "A=($($negA2.posX),$($negA2.posY)) B=($($negB2.posX),$($negB2.posY))"

$r = Api POST '/api/nodes/PT-A/move' @{ x = 5000000; y = -5000000 }
Record 'S15 只有防垃圾兜底（±1000000），不是画布边缘' ($r.status -eq 200 -and (Prop $r.body 'posX') -eq 1000000 -and (Prop $r.body 'posY') -eq -1000000) `
    "pos=($(Prop $r.body 'posX'),$(Prop $r.body 'posY'))"

# ============ S16 · 节点组（右键多选建的纯视觉分组） ============
Api POST '/api/tasks' @{
    id = 't-grp'; title = 'S16 节点组'; goalLine = '分组只是画布上的圈，不影响门与执行'
    nodes = @(
        @{ id = 'NG-1'; title = '甲'; seq = 1 }
        @{ id = 'NG-2'; title = '乙'; seq = 2 }
        @{ id = 'NG-3'; title = '丙'; seq = 3 }
    )
    edges = @(); groups = @(); cycles = @()
} | Out-Null

$r = Api POST '/api/tasks/t-grp/node-groups' @{ title = '前半段'; nodeIds = @('NG-1', 'NG-2') }
$groupId = Prop $r.body 'id'
Record 'S16 建节点组（201，两个成员）' ($r.status -eq 201 -and @(Prop $r.body 'nodeIds').Count -eq 2) "status=$($r.status) id=$groupId"

$g = (Api GET '/api/tasks/t-grp/graph').body
$ng1 = $g.nodes | Where-Object { $_.id -eq 'NG-1' }
$ng3 = $g.nodes | Where-Object { $_.id -eq 'NG-3' }
Record 'S16 图接口回带组与成员归属（组外节点没有 groupId）' `
    (@($g.nodeGroups).Count -eq 1 -and $ng1.groupId -eq $groupId -and -not $ng3.groupId) `
    "groups=$(@($g.nodeGroups).Count) NG-1=$($ng1.groupId) NG-3=$($ng3.groupId)"

$r = Api POST '/api/tasks/t-grp/node-groups' @{ title = '孤儿'; nodeIds = @('NG-1') }
Record 'S16 一个节点成不了组（node-group-needs-two）' ($r.status -eq 400 -and (Prop $r.body 'error') -eq 'node-group-needs-two') "status=$($r.status) error=$(Prop $r.body 'error')"

$r = Api POST '/api/tasks/t-grp/node-groups' @{ title = '外人'; nodeIds = @('NG-2', 'NOPE') }
Record 'S16 混进不存在的节点被拒（unknown-node）' ($r.status -eq 400 -and (Prop $r.body 'error') -eq 'unknown-node') "status=$($r.status) error=$(Prop $r.body 'error')"

$r = Api POST "/api/node-groups/$groupId/nodes/NG-3"
$r2 = Api POST "/api/node-groups/$groupId/nodes/NG-1"
$g = (Api GET '/api/tasks/t-grp/graph').body
$joined = $g.nodes | Where-Object { $_.id -eq 'NG-3' }
Record 'S16 单个节点可加入已有组，重复加入同一组幂等' `
    ($r.status -eq 200 -and (Prop $r.body 'changed') -eq $true -and $joined.groupId -eq $groupId -and $r2.status -eq 200 -and (Prop $r2.body 'changed') -eq $false) `
    "join=$($r.status) group=$($joined.groupId) again=$($r2.status)/changed=$(Prop $r2.body 'changed')"

$r = Api DELETE "/api/node-groups/$groupId"
Record 'S16 删组只解散、报出释放了几个节点（200）' ($r.status -eq 200 -and (Prop $r.body 'released') -eq 3) "released=$(Prop $r.body 'released')"
$g = (Api GET '/api/tasks/t-grp/graph').body
Record 'S16 解散后组没了、三个节点都在、group_id 全清' `
    (@($g.nodeGroups).Count -eq 0 -and @($g.nodes).Count -eq 3 -and @($g.nodes | Where-Object { $_.groupId }).Count -eq 0) `
    "groups=$(@($g.nodeGroups).Count) nodes=$(@($g.nodes).Count)"

$r = Api DELETE '/api/node-groups/nope'
Record 'S16 删不存在的组给 404 + node-group-not-found' ($r.status -eq 404 -and (Prop $r.body 'error') -eq 'node-group-not-found') "status=$($r.status) error=$(Prop $r.body 'error')"

# ============ S17 · 点节点改属性 ============
$r = Api POST '/api/nodes/NG-1/props' @{ title = '甲改名'; goalLine = '换成新的目标'; kind = 'review_human' }
Record 'S17 改标题/一行目标/类型（200，回带 3 项变化）' `
    ($r.status -eq 200 -and (Prop (Prop $r.body 'node') 'title') -eq '甲改名' -and (Prop (Prop $r.body 'node') 'kind') -eq 'review_human' -and @(Prop $r.body 'changed').Count -eq 3) `
    "changed=$(@(Prop $r.body 'changed').Count) title=$(Prop (Prop $r.body 'node') 'title')"

$g = (Api GET '/api/tasks/t-grp/graph').body
$ng1b = $g.nodes | Where-Object { $_.id -eq 'NG-1' }
Record 'S17 改完图里读得到（刷新不回退）' ($ng1b.title -eq '甲改名' -and $ng1b.goalLine -eq '换成新的目标') `
    "title=$($ng1b.title) goal=$($ng1b.goalLine)"

$r = Api POST '/api/nodes/NG-1/props' @{ title = '   ' }
Record 'S17 标题改空被拒（title-required）' ($r.status -eq 400 -and (Prop $r.body 'error') -eq 'title-required') "status=$($r.status) error=$(Prop $r.body 'error')"

$r = Api POST '/api/nodes/NG-1/props' @{ kind = 'bogus' }
Record 'S17 类型不合法被拒（kind-invalid）' ($r.status -eq 400 -and (Prop $r.body 'error') -eq 'kind-invalid') "status=$($r.status) error=$(Prop $r.body 'error')"

$r = Api POST '/api/nodes/NG-1/props' @{ title = '甲改名' }
Record 'S17 没差就不写事件（changed 为空）' ($r.status -eq 200 -and @(Prop $r.body 'changed').Count -eq 0) "changed=$(@(Prop $r.body 'changed').Count)"

$r = Api POST '/api/tasks/t-grp/edges' @{ from = 'NG-1'; to = 'NG-2'; kind = 'transfer' }
Record 'S17 先连一条线备用（201）' ($r.status -eq 201) "status=$($r.status)"
$r = Api POST '/api/nodes/NG-1/props' @{ cycleRegion = 'R9' }
Record 'S17 改循环区这条路已废弃（bad-request，指路节点组）' ($r.status -eq 400 -and (Prop $r.body 'error') -eq 'bad-request' -and (Prop $r.body 'message') -like '*圈进一个组*') `
    "status=$($r.status) msg=$(Prop $r.body 'message')"
$r = Api POST '/api/nodes/NG-3/props' @{ title = '丙改名' }
Record 'S17 其它属性照旧能改（200）' ($r.status -eq 200 -and (Prop (Prop $r.body 'node') 'title') -eq '丙改名') "title=$(Prop (Prop $r.body 'node') 'title')"


# ============ S18 · 收纳查看 + 删组连节点 ============
$r = Api POST '/api/tasks/t-grp/node-groups' @{ title = '要收纳的'; nodeIds = @('NG-1', 'NG-3') }
$foldId = Prop $r.body 'id'
Record 'S18 再建一个组备用（201）' ($r.status -eq 201) "id=$foldId"
$r = Api POST "/api/node-groups/$foldId/collapse" @{ collapsed = $true }
Record 'S18 收纳（200，collapsed=true）' ($r.status -eq 200 -and (Prop $r.body 'collapsed') -eq $true) "collapsed=$(Prop $r.body 'collapsed')"
$g = (Api GET '/api/tasks/t-grp/graph').body
$folded = $g.nodeGroups | Where-Object { $_.id -eq $foldId }
Record 'S18 收纳状态随图回带（刷新后还收着）' ($folded.collapsed -eq $true) "collapsed=$($folded.collapsed)"
$r = Api POST "/api/node-groups/$foldId/collapse" @{ collapsed = $false }
Record 'S18 展开（200，collapsed=false）' ($r.status -eq 200 -and (Prop $r.body 'collapsed') -eq $false) "collapsed=$(Prop $r.body 'collapsed')"
$r = Api POST '/api/node-groups/nope/collapse' @{ collapsed = $true }
Record 'S18 收纳不存在的组 404' ($r.status -eq 404 -and (Prop $r.body 'error') -eq 'node-group-not-found') "status=$($r.status)"

$r = Api DELETE "/api/node-groups/$foldId`?withNodes=true"
Record 'S18 组里有删不起的节点时整批拒绝（node-group-not-deletable）' ($r.status -eq 409 -and (Prop $r.body 'error') -eq 'node-group-not-deletable') `
    "status=$($r.status) msg=$((Prop $r.body 'message'))"
$g = (Api GET '/api/tasks/t-grp/graph').body
Record 'S18 被拒后组和节点都还在（没删一半）' ((@($g.nodeGroups | Where-Object { $_.id -eq $foldId }).Count -eq 1) -and (@($g.nodes).Count -eq 3)) `
    "groups=$(@($g.nodeGroups).Count) nodes=$(@($g.nodes).Count)"
$r = Api DELETE "/api/node-groups/$foldId"
Record 'S18 同一组换只解散就成功（200）' ($r.status -eq 200 -and (Prop $r.body 'released') -eq 2) "released=$(Prop $r.body 'released')"

# 两个干净的空节点：可以连节点一起删
Api POST '/api/tasks/t-grp/nodes' @{ id = 'NG-4'; title = '可删甲'; seq = 4 } | Out-Null
Api POST '/api/tasks/t-grp/nodes' @{ id = 'NG-5'; title = '可删乙'; seq = 5 } | Out-Null
$r = Api POST '/api/tasks/t-grp/node-groups' @{ title = '待删组'; nodeIds = @('NG-4', 'NG-5') }
$delId = Prop $r.body 'id'
$r = Api DELETE "/api/node-groups/$delId`?withNodes=true"
Record 'S18 删组连节点（200，nodesDeleted=2）' ($r.status -eq 200 -and (Prop $r.body 'nodesDeleted') -eq 2) "nodesDeleted=$(Prop $r.body 'nodesDeleted')"
$g = (Api GET '/api/tasks/t-grp/graph').body
Record 'S18 组与两个节点都没了、其余节点不动' `
    (@($g.nodeGroups | Where-Object { $_.id -eq $delId }).Count -eq 0 -and @($g.nodes | Where-Object { $_.id -in @('NG-4', 'NG-5') }).Count -eq 0 -and @($g.nodes).Count -eq 3) `
    "groups=$(@($g.nodeGroups).Count) nodes=$(@($g.nodes).Count)"

# ============ S19 · 单个节点收纳（完整 / 仅标题 / 仅关键字） ============
$r = Api POST '/api/nodes/NG-3/compact' @{ level = 1 }
Record 'S19 收纳为仅标题（200，compact=1）' ($r.status -eq 200 -and (Prop $r.body 'compact') -eq 1) "compact=$(Prop $r.body 'compact')"
$g = (Api GET '/api/tasks/t-grp/graph').body
$ng3c = $g.nodes | Where-Object { $_.id -eq 'NG-3' }
Record 'S19 图接口回带收纳级别（刷新还在）' ($ng3c.compact -eq 1) "compact=$($ng3c.compact)"
$r = Api POST '/api/nodes/NG-3/compact' @{ level = 2 }
Record 'S19 换成仅关键字（200，compact=2）' ($r.status -eq 200 -and (Prop $r.body 'compact') -eq 2) "compact=$(Prop $r.body 'compact')"
$r = Api POST '/api/nodes/NG-3/compact' @{ level = 0 }
Record 'S19 展开回完整（200，compact=0）' ($r.status -eq 200 -and (Prop $r.body 'compact') -eq 0) "compact=$(Prop $r.body 'compact')"
$r = Api POST '/api/nodes/NG-3/compact' @{ level = 9 }
Record 'S19 非法级别被拒（bad-request）' ($r.status -eq 400 -and (Prop $r.body 'error') -eq 'bad-request') "status=$($r.status) error=$(Prop $r.body 'error')"
$r = Api POST '/api/nodes/NG-3/compact' @{ collapsed = $true }
Record 'S19 也收 collapsed=true（当 1 用）' ($r.status -eq 200 -and (Prop $r.body 'compact') -eq 1) "compact=$(Prop $r.body 'compact')"
Api POST '/api/nodes/NG-3/compact' @{ level = 0 } | Out-Null
$r = Api POST '/api/nodes/NOPE/compact' @{ level = 1 }
Record 'S19 不存在的节点 404' ($r.status -eq 404 -and (Prop $r.body 'error') -eq 'node-not-found') "status=$($r.status)"

# ============ S20 · 连线本身：改走向 / 门控（人工点头才放行）/ 删线 ============
Api POST '/api/tasks' @{
    id = 't-gate'; title = 'S20 门控'; goalLine = '连线也能挂闸门'
    nodes = @(
        @{ id = 'GT-A'; title = '写稿'; seq = 1 }
        @{ id = 'GT-B'; title = '复核'; seq = 2 }
        @{ id = 'GT-C'; title = '排版'; seq = 3 }
    )
    edges = @(); groups = @(); cycles = @()
} | Out-Null

$r = Api POST '/api/tasks/t-gate/edges' @{ from = 'GT-A'; to = 'GT-B'; kind = 'transfer'; gate = 'human'; gateNote = '数字口径对过才放行' }
$gateEdge = Prop (Prop $r.body 'edge') 'id'
Record 'S20 建一条带人工门控的线（201）' ($r.status -eq 201) "id=$gateEdge"
$e = (Api GET "/api/edges/$gateEdge").body.edge
Record 'S20 读连线带出门控与两端标题' ($e.gate -eq 'human' -and $e.gateNote -eq '数字口径对过才放行' -and $e.fromTitle -eq '写稿' -and $e.toTitle -eq '复核') `
    "gate=$($e.gate) note=$($e.gateNote) $($e.fromTitle)->$($e.toTitle)"

Api POST '/api/tasks/t-gate/claim' @{ agent = 'gate-tester' } | Out-Null
Api POST '/api/nodes/GT-A/complete' @{ by = 'gate-tester' } | Out-Null
$g = (Api GET '/api/tasks/t-gate/graph').body
$gtB = $g.nodes | Where-Object { $_.id -eq 'GT-B' }
Record 'S20 上游做完但门控没点头 → 下游仍 pending' ($gtB.status -eq 'pending') "status=$($gtB.status)"
$n = (Api GET '/api/nodes/GT-B').body
$item = @($n.input.items) | Where-Object { $_.edgeId -eq $gateEdge }
Record 'S20 拒因写明是「门控待确认」（gate-needs-confirm）' ($item.reason -eq 'gate-needs-confirm' -and -not $item.released) `
    "reason=$($item.reason) released=$($item.released)"

$r = Api POST "/api/edges/$gateEdge/confirm" @{ by = 'master'; reason = '对过了' }
Record 'S20 人点头后立刻放行并起步下游（activated 含 GT-B）' `
    ($r.status -eq 200 -and (Prop $r.body 'edge') -and @(Prop $r.body 'activated') -contains 'GT-B') `
    "activated=$((Prop $r.body 'activated') -join ',')"
$g = (Api GET '/api/tasks/t-gate/graph').body
$gtB2 = $g.nodes | Where-Object { $_.id -eq 'GT-B' }
Record 'S20 下游确实起来了（active）' ($gtB2.status -eq 'active') "status=$($gtB2.status)"

$r = Api POST "/api/edges/$gateEdge/confirm" @{}
Record 'S20 同一条线重复点头也安全（放行幂等）' ($r.status -eq 200 -and @(Prop $r.body 'activated').Count -eq 0) `
    "activated=$(@(Prop $r.body 'activated').Count)"

$r = Api POST "/api/edges/$gateEdge" @{ to = 'GT-C' }
Record 'S20 已放过行的线不许改走向（edge-already-released）' ($r.status -eq 409 -and (Prop $r.body 'error') -eq 'edge-already-released') `
    "status=$($r.status) error=$(Prop $r.body 'error')"
$r = Api POST "/api/edges/$gateEdge" @{ gate = 'auto'; gateNote = '算了，自动吧' }
Record 'S20 已放过行的线可以放宽门控（human→auto，200）' ($r.status -eq 200 -and (Prop (Prop $r.body 'edge') 'gate') -eq 'auto') "gate=$(Prop (Prop $r.body 'edge') 'gate')"
$r = Api POST "/api/edges/$gateEdge" @{ gate = 'human' }
Record 'S20 已放过行的线不许事后加闸门（edge-already-released）' ($r.status -eq 409 -and (Prop $r.body 'error') -eq 'edge-already-released') "status=$($r.status)"
$r = Api DELETE "/api/edges/$gateEdge"
Record 'S20 已放过行的线不许删（edge-already-released）' ($r.status -eq 409 -and (Prop $r.body 'error') -eq 'edge-already-released') "status=$($r.status)"

# 还没放行过的线：可以改走向、可以删
$r = Api POST '/api/tasks/t-gate/edges' @{ from = 'GT-B'; to = 'GT-C'; kind = 'transfer' }
$spareEdge = Prop (Prop $r.body 'edge') 'id'
Record 'S20 再建一条普通线（201）' ($r.status -eq 201) "id=$spareEdge"
$r = Api POST "/api/edges/$spareEdge" @{ fromPort = 0; toPort = 0; gate = 'human' }
Record 'S20 未放行的线可改门控与端口（200，changed 有记录）' ($r.status -eq 200 -and @(Prop $r.body 'changed').Count -ge 1) `
    "changed=$((Prop $r.body 'changed') -join ';')"
$r = Api POST "/api/edges/$spareEdge" @{ to = 'GT-B' }
Record 'S20 改成自环被拒（loop-needs-cycle）' ($r.status -eq 409 -and (Prop $r.body 'error') -eq 'loop-needs-cycle') "status=$($r.status)"
$r = Api DELETE "/api/edges/$spareEdge"
Record 'S20 未放行的线能删（200）' ($r.status -eq 200) "status=$($r.status)"
$g = (Api GET '/api/tasks/t-gate/graph').body
Record 'S20 删完图里少一条线、规则组只剩那条旧线' `
    (@($g.edges).Count -eq 1) "edges=$(@($g.edges).Count)"
$n = (Api GET '/api/nodes/GT-C').body
Record 'S20 规则组按现存入边重算（目标节点没有残留边）' (@($n.input.items).Count -eq 0) "items=$(@($n.input.items).Count)"

$r = Api POST '/api/edges/nope/confirm' @{}
Record 'S20 确认不存在的线 404（edge-not-found）' ($r.status -eq 404 -and (Prop $r.body 'error') -eq 'edge-not-found') "status=$($r.status)"
$r = Api POST "/api/tasks/t-gate/edges" @{ from = 'GT-A'; to = 'GT-C'; kind = 'transfer'; gate = 'weird' }
Record 'S20 非法门控值被拒（bad-request）' ($r.status -eq 400 -and (Prop $r.body 'error') -eq 'bad-request') "status=$($r.status)"

# ============ S21 · 预设（节点预设 / 组预设 / 套用模板） ============
Api POST '/api/tasks' @{
    id = 't-tpl'; title = 'S21 预设'; goalLine = '存一次、到处套'
    nodes = @(
        @{ id = 'TP-1'; title = '读材料'; goalLine = '收三份可用材料'; seq = 1 }
        @{ id = 'TP-2'; title = '写稿'; seq = 2 }
    )
    edges = @(); groups = @(); cycles = @()
} | Out-Null
Api POST '/api/tasks/t-tpl/node-groups' @{ title = '写作段'; nodeIds = @('TP-1', 'TP-2') } | Out-Null
Api POST '/api/tasks/t-tpl/edges' @{ from = 'TP-1'; to = 'TP-2'; kind = 'transfer' } | Out-Null
$g = (Api GET '/api/tasks/t-tpl/graph').body
$tplGroupId = @($g.nodeGroups)[0].id

$r = Api POST '/api/templates/nodes' @{ nodeId = 'TP-1' }
$nodeTplId = Prop $r.body 'id'
Record 'S21 从一个节点存成节点预设（201，带标题/目标/类型/口数）' `
    ($r.status -eq 201 -and (Prop $r.body 'title') -eq '读材料' -and (Prop $r.body 'goalLine') -eq '收三份可用材料') `
    "id=$nodeTplId title=$(Prop $r.body 'title')"

$r = Api POST '/api/templates/groups' @{ groupId = $tplGroupId }
$groupTplId = Prop $r.body 'id'
Record 'S21 从一个组存成组预设（201，2 节点 1 条组内线）' `
    ($r.status -eq 201 -and (Prop $r.body 'nodeCount') -eq 2 -and (Prop $r.body 'edgeCount') -eq 1) `
    "id=$groupTplId nodes=$(Prop $r.body 'nodeCount') edges=$(Prop $r.body 'edgeCount')"

$t = (Api GET '/api/templates').body
Record 'S21 模板库列出两类预设' `
    (@($t.nodeTemplates).Count -ge 1 -and (@($t.groupTemplates | Where-Object { $_.id -eq $groupTplId }).Count -eq 1)) `
    "nodeTemplates=$(@($t.nodeTemplates).Count) groupTemplates=$(@($t.groupTemplates).Count)"

$r = Api POST '/api/tasks/t-tpl/apply-node-template' @{ templateId = $nodeTplId; x = 900; y = 120 }
Record 'S21 套用节点预设（201，落在给定坐标、字段照预设）' `
    ($r.status -eq 201 -and (Prop (Prop $r.body 'node') 'posX') -eq 900 -and (Prop (Prop $r.body 'node') 'title') -eq '读材料' -and (Prop (Prop $r.body 'node') 'goalLine') -eq '收三份可用材料') `
    "pos=($(Prop (Prop $r.body 'node') 'posX'),$(Prop (Prop $r.body 'node') 'posY'))"

$r = Api POST '/api/tasks/t-tpl/apply-group-template' @{ templateId = $groupTplId; x = 600; y = 400 }
$newIds = @(Prop $r.body 'nodes')
Record 'S21 套用组预设（201，两个节点 + 组内连线 + 圈成一个组）' `
    ($r.status -eq 201 -and $newIds.Count -eq 2 -and (Prop $r.body 'groupId') -and @(Prop $r.body 'edges').Count -eq 1) `
    "nodes=$($newIds.Count) group=$(Prop $r.body 'groupId')"
$g = (Api GET '/api/tasks/t-tpl/graph').body
$newNodes = @($g.nodes | Where-Object { $newIds -contains $_.id })
Record 'S21 套用后的节点按预设相对位置落位（左上角＝给定坐标）' `
    (($newNodes | Measure-Object -Property posX -Minimum).Minimum -eq 600 -and ($newNodes | Measure-Object -Property posY -Minimum).Minimum -eq 400) `
    "minX=$(($newNodes | Measure-Object -Property posX -Minimum).Minimum) minY=$(($newNodes | Measure-Object -Property posY -Minimum).Minimum)"
Record 'S21 套用后组内连线也建好了（新任务里多一条边）' (@($g.edges).Count -ge 2) "edges=$(@($g.edges).Count)"
Record 'S21 套用后自动圈成一个节点组（同名）' (@($g.nodeGroups | Where-Object { $_.id -eq (Prop $r.body 'groupId') }).Count -eq 1) `
    "nodeGroups=$(@($g.nodeGroups).Count)"

$r = Api POST '/api/tasks/t-tpl/apply-group-template' @{ templateId = 'nope' }
Record 'S21 套用不存在的预设 404（template-not-found）' ($r.status -eq 404 -and (Prop $r.body 'error') -eq 'template-not-found') "status=$($r.status)"
$r = Api POST '/api/templates/nodes' @{ nodeId = 'NOPE' }
Record 'S21 拿不存在的节点存预设 404（node-not-found）' ($r.status -eq 404 -and (Prop $r.body 'error') -eq 'node-not-found') "status=$($r.status)"
$r = Api POST '/api/templates/nodes' @{ title = '单字段预设'; name = '手写'; kind = 'review_human'; inPorts = 2 }
Record 'S21 也可以不挂节点、直接手写一个节点预设（201）' ($r.status -eq 201 -and (Prop $r.body 'inPorts') -eq 2) "status=$($r.status)"

$r = Api DELETE "/api/templates/nodes/$nodeTplId"
Record 'S21 删节点预设（200）' ($r.status -eq 200) "status=$($r.status)"
$r = Api DELETE "/api/templates/groups/$groupTplId"
Record 'S21 删组预设（200）' ($r.status -eq 200) "status=$($r.status)"
$r = Api DELETE '/api/templates/groups/nope'
Record 'S21 删不存在的预设 404' ($r.status -eq 404 -and (Prop $r.body 'error') -eq 'template-not-found') "status=$($r.status)"
$t = (Api GET '/api/templates').body
Record 'S21 删完只剩那个手写预设' `
    (@($t.nodeTemplates | Where-Object { $_.id -eq $nodeTplId }).Count -eq 0 -and @($t.groupTemplates | Where-Object { $_.id -eq $groupTplId }).Count -eq 0) `
    "nodeTemplates=$(@($t.nodeTemplates).Count) groupTemplates=$(@($t.groupTemplates).Count)"

# ============ S22 · 循环区＝组＋回边＋检查点（概念合并） ============
Api POST '/api/tasks' @{
    id = 't-loopgrp'; title = 'S22 组即循环区'; goalLine = '组加回边加检查点'
    nodes = @(
        @{ id = 'LG-1'; title = '起草'; seq = 1 }
        @{ id = 'LG-2'; title = '测量'; seq = 2 }
        @{ id = 'LG-3'; title = '外圈节点'; seq = 3 }
    )
    edges = @(); groups = @(); cycles = @()
} | Out-Null
$r = Api POST '/api/tasks/t-loopgrp/node-groups' @{ title = '迭代区'; nodeIds = @('LG-1', 'LG-2') }
$lgGroup = Prop $r.body 'id'
Record 'S22 先把两个节点圈成普通组（201）' ($r.status -eq 201) "group=$lgGroup"

$r = Api POST "/api/node-groups/$lgGroup/loop" @{ head = 'LG-1'; tail = 'LG-2'; limit = 2 }
Record 'S22 给组声明循环（201，自动带回边）' `
    ($r.status -eq 201 -and (Prop $r.body 'limit') -eq 2 -and (Prop $r.body 'groupId') -eq $lgGroup) `
    "status=$($r.status) groupId=$(Prop $r.body 'groupId')"
$g = (Api GET '/api/tasks/t-loopgrp/graph').body
$lgLoop = @($g.edges | Where-Object { $_.kind -eq 'loop' })
Record 'S22 回边 tail→head 已建好（LG-2 → LG-1）' `
    (@($lgLoop).Count -eq 1 -and $lgLoop[0].fromNodeId -eq 'LG-2' -and $lgLoop[0].toNodeId -eq 'LG-1') `
    "loop=$($lgLoop[0].fromNodeId)->$($lgLoop[0].toNodeId)"
$lg1 = $g.nodes | Where-Object { $_.id -eq 'LG-1' }
Record 'S22 成员的 cycleRegion 跟着组名走（镜像字段）' ($lg1.cycleRegion -eq '迭代区') "region=$($lg1.cycleRegion)"

$r = Api POST "/api/node-groups/$lgGroup/loop" @{ head = 'LG-1'; tail = 'LG-2'; limit = 5 }
Record 'S22 同一个组再声明循环被拒（cycle-exists）' ($r.status -eq 409 -and (Prop $r.body 'error') -eq 'cycle-exists') "status=$($r.status)"

$r = Api POST '/api/tasks/t-loopgrp/node-groups' @{ title = '另一个组'; nodeIds = @('LG-2', 'LG-3') }
$otherGroup = Prop $r.body 'id'
$r = Api POST '/api/tasks/t-loopgrp/edges' @{ from = 'LG-3'; to = 'LG-1'; kind = 'loop' }
Record 'S22 跨组连回边被拒（loop-needs-cycle，两端要同组）' ($r.status -eq 409 -and (Prop $r.body 'error') -eq 'loop-needs-cycle') "status=$($r.status)"
$r = Api POST '/api/tasks/t-loopgrp/node-groups' @{ title = '单打组'; nodeIds = @('LG-3', 'LG-2') }
Record 'S22 节点被移走后原组按新入边重算（不报错）' ($r.status -eq 201 -or $r.status -eq 409) "status=$($r.status)"

# 撤循环：回边与上限一起撤，组留着
$r = Api DELETE "/api/node-groups/$lgGroup/loop"
Record 'S22 撤销循环（200，回边一并删掉）' ($r.status -eq 200 -and (Prop $r.body 'edgesDeleted') -ge 1) "edgesDeleted=$(Prop $r.body 'edgesDeleted')"
$g = (Api GET '/api/tasks/t-loopgrp/graph').body
Record 'S22 撤销后没有循环了、组还在' (@($g.cycles).Count -eq 0 -and @($g.nodeGroups | Where-Object { $_.id -eq $lgGroup }).Count -eq 1) `
    "cycles=$(@($g.cycles).Count) groups=$(@($g.nodeGroups).Count)"
$r = Api DELETE "/api/node-groups/$lgGroup"
Record 'S22 撤销循环后这个组就能删了（200）' ($r.status -eq 200) "status=$($r.status)"

# ---------- S23 视图图层与组内相对布局缓存 ----------
$r = Api POST '/api/tasks' @{
    id = 't-viewlayer'; title = '视图图层测试'; goalLine = '验组缓存与图层';
    nodes = @(
        @{ id = 'VL-1'; title = '视图一'; seq = 1; x = 100; y = 100 },
        @{ id = 'VL-2'; title = '视图二'; seq = 2; x = 420; y = 100 },
        @{ id = 'VL-3'; title = '视图三'; seq = 3; x = 800; y = 100 }
    );
    edges = @(
        @{ id = 'EVL-1'; from = 'VL-1'; to = 'VL-2'; kind = 'transfer' },
        @{ id = 'EVL-2'; from = 'VL-2'; to = 'VL-3'; kind = 'transfer' }
    );
    groups = @(); cycles = @()
}
Record 'S23 建视图测试任务（201）' ($r.status -eq 201) "status=$($r.status)"
$r = Api POST '/api/tasks/t-viewlayer/node-groups' @{ title = '视图组'; nodeIds = @('VL-1', 'VL-2') }
$vgid = Prop $r.body 'id'
Record 'S23 建组（201）' ($r.status -eq 201 -and $vgid) "group=$vgid"

$r = Api POST "/api/node-groups/$vgid/layout" @{ nodes = @(@{ id = 'VL-1'; dx = 0; dy = 0 }, @{ id = 'VL-2'; dx = 300; dy = 40 }) }
Record 'S23 保存组内相对坐标（200，回带 2 项）' ($r.status -eq 200 -and @($r.body.nodes).Count -eq 2) "status=$($r.status)"
$g = (Api GET '/api/tasks/t-viewlayer/graph').body
$vg = @($g.nodeGroups | Where-Object { $_.id -eq $vgid })[0]
Record 'S23 组布局随图回带（相对坐标可读）' (@($vg.layout).Count -eq 2 -and $vg.layout[1].dx -eq 300) "layout=$($vg.layout | ConvertTo-Json -Compress)"
$r = Api POST "/api/node-groups/$vgid/layout" @{ nodes = @(@{ id = 'NOT-IN-GROUP'; dx = 0; dy = 0 }) }
Record 'S23 非组员写缓存被拒（400 unknown-node）' ($r.status -eq 400 -and (Prop $r.body 'error') -eq 'unknown-node') "status=$($r.status)"

$r = Api GET '/api/tasks/t-viewlayer/view-layers'
Record 'S23 新任务没有视图图层（200，空表）' ($r.status -eq 200 -and @($r.body.layers).Count -eq 0) "layers=$(@($r.body.layers).Count)"
$payload = '{"version":1,"positions":{"VL-1":{"x":10,"y":20}},"groupLayouts":{},"groupView":false,"compactView":true,"allowOverlap":true,"viewport":{"scale":1,"tx":0,"ty":0}}'
$r = Api POST '/api/tasks/t-viewlayer/view-layers' @{ name = '紧凑方案'; payload = $payload }
$vlid = Prop $r.body 'id'
Record 'S23 保存视图图层（201）' ($r.status -eq 201 -and $vlid) "layer=$vlid"
$r = Api GET '/api/tasks/t-viewlayer/view-layers'
Record 'S23 图层列表能列出（1 个，带 compact/stack 模式标签）' ($r.status -eq 200 -and @($r.body.layers).Count -eq 1 -and $r.body.layers[0].name -eq '紧凑方案' -and @($r.body.layers[0].modes) -contains 'compact' -and @($r.body.layers[0].modes) -contains 'stack') "layers=$(@($r.body.layers).Count) modes=$($r.body.layers[0].modes -join ',')"
$r = Api GET "/api/view-layers/$vlid"
Record 'S23 读单个图层（payload 原样回带，modes 可读）' ($r.status -eq 200 -and (Prop $r.body 'payload').compactView -eq $true -and (Prop $r.body 'payload').allowOverlap -eq $true -and @($r.body.modes) -contains 'stack') "status=$($r.status)"
$r = Api POST "/api/view-layers/$vlid" @{ name = '改名后的图层' }
Record 'S23 图层改名（200）' ($r.status -eq 200 -and $r.body.layer.name -eq '改名后的图层') "name=$($r.body.layer.name)"
$r = Api POST '/api/tasks/t-viewlayer/view-layers' @{ name = '坏'; payload = '{not-json' }
Record 'S23 非法 payload 被拒（400 bad-request）' ($r.status -eq 400 -and (Prop $r.body 'error') -eq 'bad-request') "status=$($r.status)"
$r = Api POST '/api/tasks/t-viewlayer/view-layers' @{ name = '第二个'; payload = $payload }
$vlid2 = Prop $r.body 'id'
$r = Api DELETE "/api/view-layers/$vlid2"
Record 'S23 删图层（200）' ($r.status -eq 200) "status=$($r.status)"
$r = Api DELETE "/api/view-layers/$vlid2"
Record 'S23 删不存在的图层（404）' ($r.status -eq 404) "status=$($r.status)"

$r = Api POST '/api/tasks/t-viewlayer/view-layers' @{ payload = $payload }
$cn1 = Prop $r.body 'name'
Record 'S23 图层留空名按阿拉伯数字自动排（图层1）' ($r.status -eq 201 -and $cn1 -eq '图层1') "name=$cn1"
$r = Api POST '/api/tasks/t-viewlayer/view-layers' @{ payload = $payload }
$cn2 = Prop $r.body 'name'
Record 'S23 第二个留空名接着排（图层2）' ($r.status -eq 201 -and $cn2 -eq '图层2') "name=$cn2"



}
finally {
    if ($proc -and -not $proc.HasExited) {
        Stop-Process -Id $proc.Id -Force -ErrorAction SilentlyContinue
        Start-Sleep -Milliseconds 400
    }
    if (-not $KeepDb) {
        foreach ($f in @($dbPath, "$dbPath-wal", "$dbPath-shm")) { if (Test-Path $f) { Remove-Item -Force $f -ErrorAction SilentlyContinue } }
    }
}

$failed = @($results | Where-Object { -not $_.ok })
Write-Host ''
Write-Host ("总计 {0} 项：通过 {1}，失败 {2}" -f $results.Count, ($results.Count - $failed.Count), $failed.Count) -ForegroundColor ($(if ($failed.Count) { 'Red' } else { 'Green' }))
if ($failed.Count) {
    Write-Host '失败项：' -ForegroundColor Red
    $failed | ForEach-Object { Write-Host ("  - {0}  ({1})" -f $_.name, $_.detail) -ForegroundColor Red }
    exit 1
}
exit 0
