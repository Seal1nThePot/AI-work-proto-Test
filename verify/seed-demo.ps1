# 灌 demo 数据（三个任务：样板链 / 回边循环 / 择一走到 100%），给只读页面看状态与检查点原文。
# 复用 demo 库 data\proto.db（5081）。若服务没起，本脚本自己起一个并在结束时保持运行。
# 用法： pwsh -File verify\seed-demo.ps1

#requires -Version 7.0
param(
    [int]$Port = 5081,
    [string]$Agent = 'agent-demo'
)

$ErrorActionPreference = 'Stop'
$testRoot = Split-Path -Parent $PSScriptRoot
$apiProject = Join-Path $testRoot 'backend\WorkProto.Api'
$dll = Join-Path $apiProject 'bin\Debug\net10.0\WorkProto.Api.dll'
$dbDir = Join-Path $testRoot 'data'
$dbPath = Join-Path $dbDir 'proto.db'
$base = "http://127.0.0.1:$Port"

function Prop($obj, [string]$name, $default = $null) {
    if ($null -eq $obj) { return $default }
    $p = $obj.PSObject.Properties[$name]
    if ($null -eq $p) { return $default }
    return $p.Value
}

function Api([string]$method, [string]$path, $body = $null) {
    $params = @{ Method = $method; Uri = "$base$path"; SkipHttpErrorCheck = $true; TimeoutSec = 30 }
    if ($null -ne $body) {
        $params.Body = ($body | ConvertTo-Json -Depth 12 -Compress)
        $params.ContentType = 'application/json; charset=utf-8'
    }
    $resp = Invoke-WebRequest @params
    $parsed = $null
    try { $parsed = $resp.Content | ConvertFrom-Json } catch { }
    [pscustomobject]@{ status = [int]$resp.StatusCode; body = $parsed }
}

# ---------- 确保服务在跑 ----------

$running = $false
try {
    $h = Invoke-WebRequest "$base/api/health" -SkipHttpErrorCheck -TimeoutSec 3
    $running = ([int]$h.StatusCode -eq 200)
} catch { }

if (-not $running) {
    New-Item -ItemType Directory -Force -Path $dbDir | Out-Null
    & dotnet build $apiProject -v q --nologo | Out-Null
    $env:PROTO_PORT = "$Port"
    $env:PROTO_DB = $dbPath
    $logOut = Join-Path $dbDir 'seed-server.out.log'
    $logErr = Join-Path $dbDir 'seed-server.err.log'
    Start-Process -FilePath 'dotnet' -ArgumentList @($dll) -WindowStyle Hidden `
        -RedirectStandardOutput $logOut -RedirectStandardError $logErr | Out-Null
    for ($i = 0; $i -lt 60; $i++) {
        Start-Sleep -Milliseconds 300
        try {
            $h = Invoke-WebRequest "$base/api/health" -SkipHttpErrorCheck -TimeoutSec 3
            if ([int]$h.StatusCode -eq 200) { $running = $true; break }
        } catch { }
    }
    if (-not $running) { throw "后端没起来，看 $logErr" }
    Write-Host "已在 $base 起后端（库 $dbPath）"
} else {
    $health = (Api GET '/api/health').body
    Write-Host "复用已在跑的后端 $base（库 $(Prop $health 'databasePath')）"
}

function Reset-DemoTask([string]$id) {
    $r = Api DELETE "/api/tasks/$id"
    if ($r.status -eq 200) { Write-Host "  清掉旧数据 $id" }
}

# ---------- 任务一：样板链（A–E → F → G → RV → H） ----------

$chainId = 't-demo-chain'
Reset-DemoTask $chainId
$chain = @{
    id = $chainId
    title = '样板链：五份材料 → 写作 → 排版 → 人工审核 → 交付准备'
    goalLine = '按目标、文献、案例、统计、补充材料写一份可交付稿件'
    nodes = @(
        @{ id = 'A'; title = '目标说明'; goalLine = '写清这件事要什么'; seq = 1 }
        @{ id = 'B'; title = '文献'; goalLine = '找齐可引用的三份'; seq = 2 }
        @{ id = 'C'; title = '案例'; goalLine = '选一个能对标的案例'; seq = 3 }
        @{ id = 'D'; title = '统计'; goalLine = '把关键数字核准'; seq = 4 }
        @{ id = 'E'; title = '补充材料'; goalLine = '补齐边角证据'; seq = 5 }
        @{ id = 'F'; title = '写作'; goalLine = '形成文本稿 F_FINAL'; seq = 6 }
        @{ id = 'G'; title = '排版'; goalLine = '按目标要求排版成 G_FINAL'; seq = 7 }
        @{ id = 'RV'; title = '人工审核'; goalLine = '人来点头，不看程序自判'; seq = 8; kind = 'review_human' }
        @{ id = 'H'; title = '交付准备'; goalLine = '只采用一条路线成包'; seq = 9 }
    )
    edges = @(
        @{ id = 'eAF'; from = 'A'; to = 'F' }, @{ id = 'eBF'; from = 'B'; to = 'F' }
        @{ id = 'eCF'; from = 'C'; to = 'F' }, @{ id = 'eDF'; from = 'D'; to = 'F' }
        @{ id = 'eEF'; from = 'E'; to = 'F' }
        @{ id = 'eAG'; from = 'A'; to = 'G' }, @{ id = 'eFG'; from = 'F'; to = 'G' }
        @{ id = 'eGRV'; from = 'G'; to = 'RV' }
        @{ id = 'eRVH'; from = 'RV'; to = 'H' }, @{ id = 'eFH'; from = 'F'; to = 'H' }
    )
    groups = @(
        @{ id = 'gF'; nodeId = 'F'; mode = 'k_of_n'; needCount = 3; items = @('eAF', 'eBF', 'eCF', 'eDF', 'eEF') }
        @{ id = 'gG'; nodeId = 'G'; mode = 'all'; items = @('eAG', 'eFG') }
        @{ id = 'gRV'; nodeId = 'RV'; mode = 'all'; items = @('eGRV') }
        @{ id = 'gH'; nodeId = 'H'; mode = 'pick_one'; items = @('eFH', 'eRVH') }
    )
    cycles = @()
}
$r = Api POST '/api/tasks' $chain
if ($r.status -ne 201) { throw "建样板链失败：$($r.status)" }

Api POST "/api/tasks/$chainId/claim" @{ agent = $Agent } | Out-Null
foreach ($n in 'A', 'B', 'C', 'D', 'E') { Api POST "/api/nodes/$n/complete" @{ by = $Agent } | Out-Null }
foreach ($c in @(
        @{ doing = '先读五份材料的结论'; next = '把目标里的三个问题摘出来'; goal = '一份能被复核的文本稿'; verdict = 'progress' },
        @{ doing = '在写第二节，引用文献与案例'; next = '补统计口径'; goal = '一份能被复核的文本稿'; verdict = 'progress' },
        @{ doing = '整体过一遍口径一致'; next = '交给排版'; goal = '一份能被复核的文本稿'; verdict = 'progress' }
    )) {
    Api POST "/api/tasks/$chainId/checkpoint" @{
        nodeId = 'F'; doing = $c.doing; nextStep = $c.next; goal = $c.goal; verdict = $c.verdict; by = $Agent
    } | Out-Null
}
Api POST '/api/nodes/F/complete' @{ by = $Agent } | Out-Null
Api POST '/api/nodes/G/complete' @{ by = $Agent } | Out-Null
Api POST "/api/tasks/$chainId/node-groups" @{ title = '前五份材料'; nodeIds = @('A', 'B', 'C', 'D', 'E') } | Out-Null
Api POST "/api/tasks/$chainId/node-groups" @{ title = '成稿到交付'; nodeIds = @('F', 'G', 'RV') } | Out-Null
Write-Host '任务一：A–G 已完成，RV 人工审核在等，H 择一未定；另建两个节点组（纯视觉）'

# ---------- 任务二：回边循环跑到上限并判无进展 ----------

$loopId = 't-demo-loop'
Reset-DemoTask $loopId
$loop = @{
    id = $loopId
    title = '回边循环：起草 → 测量 → 再一轮'
    goalLine = '每轮检查一次，跑满上限先出检查点'
    nodes = @(
        @{ id = 'K-H'; title = 'H 起草'; goalLine = '按目标起草第 N 轮'; seq = 1; cycleRegion = 'R1' }
        @{ id = 'K-M'; title = 'M 测量'; goalLine = '量结果，决定要不要再来一轮'; seq = 2; cycleRegion = 'R1' }
    )
    edges = @(
        @{ id = 'eHM'; from = 'K-H'; to = 'K-M' }
        @{ id = 'eMH'; from = 'K-M'; to = 'K-H'; kind = 'loop' }
    )
    groups = @()
    cycles = @(@{ id = 'cy-R1'; regionKey = 'R1'; head = 'K-H'; tail = 'K-M'; limit = 3 })
}
$r = Api POST '/api/tasks' $loop
if ($r.status -ne 201) { throw "建循环任务失败：$($r.status)" }

Api POST "/api/tasks/$loopId/claim" @{ agent = "$Agent-loop" } | Out-Null
for ($round = 1; $round -le 3; $round++) {
    Api POST '/api/nodes/K-H/complete' @{ by = "$Agent-loop" } | Out-Null
    $m = Api POST '/api/nodes/K-M/complete' @{ by = "$Agent-loop" }
}
Api POST "/api/tasks/$loopId/checkpoint" @{
    nodeId = 'K-H'; doing = '第 3 轮只改了三处措辞，数字没动'
    nextStep = '想再跑一轮换一个论证角度'
    goal = '让结论经得起复核'
    verdict = 'no_progress'; by = "$Agent-loop"
} | Out-Null
Write-Host '任务二：跑满 3 轮 → 检查点判无进展 → 待人工（blocked）'

# ---------- 任务三：择一（3 选 1）走到 100% ----------

$pickId = 't-demo-pick'
Reset-DemoTask $pickId
$pick = @{
    id = $pickId
    title = '择一 3 选 1：三条路线只采用一条'
    goalLine = '选中的走到已解决，未选的落 skipped，进度能到 100%'
    nodes = @(
        @{ id = 'S-A'; title = '路线 A：自建'; goalLine = '自己写'; seq = 1 }
        @{ id = 'S-B'; title = '路线 B：采购'; goalLine = '买现成'; seq = 2 }
        @{ id = 'S-C'; title = '路线 C：混合'; goalLine = '买一半自己写一半'; seq = 3 }
        @{ id = 'S-H'; title = 'H 交付准备'; goalLine = '只采用一条路线成包'; seq = 4 }
    )
    edges = @(
        @{ id = 'eAH'; from = 'S-A'; to = 'S-H' }
        @{ id = 'eBH'; from = 'S-B'; to = 'S-H' }
        @{ id = 'eCH'; from = 'S-C'; to = 'S-H' }
    )
    groups = @(@{ id = 'gH2'; nodeId = 'S-H'; mode = 'pick_one'; items = @('eAH', 'eBH', 'eCH') })
    cycles = @()
}
$r = Api POST '/api/tasks' $pick
if ($r.status -ne 201) { throw "建择一任务失败：$($r.status)" }

Api POST "/api/tasks/$pickId/claim" @{ agent = "$Agent-pick" } | Out-Null
foreach ($n in 'S-A', 'S-B', 'S-C') { Api POST "/api/nodes/$n/complete" @{ by = "$Agent-pick" } | Out-Null }
Api POST "/api/tasks/$pickId/pick" @{ groupId = 'gH2'; edgeId = 'eAH'; by = 'master' } | Out-Null
Api POST '/api/nodes/S-H/complete' @{ by = "$Agent-pick" } | Out-Null
Write-Host '任务三：A 被选中 → B/C skipped → 进度 100%'

Write-Host ''
$list = (Api GET '/api/tasks').body
foreach ($t in (Prop $list 'tasks' @())) {
    Write-Host ("  {0,-14} {1,3}%  {2}  {3}" -f $t.id, $t.progress, $t.status, $t.title)
}
Write-Host ''
Write-Host "打开 $base/ 看只读页面（点节点看输入条件、检查点原文、上次被拒原因）"
