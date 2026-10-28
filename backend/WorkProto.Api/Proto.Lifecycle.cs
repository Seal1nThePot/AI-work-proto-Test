// ────────── Proto.Lifecycle.cs ──────────「节点生命周期」
// 用途: 节点生命周期：开始 / 完成 / 返工 / 择一 / 跳过 / 检查点 / 提循环上限 / 解阻塞
// 暴露: StartNode CompleteNode ReworkNode Pick SkipUnselected Checkpoint RaiseLimit Unblock
// 依赖: Proto.Infra.cs Proto.Gate.cs Proto.Propagate.cs Proto.Group.cs(ReadCycleByGroup)
// 被依赖: Program.cs
using System.Text.Json;
using Microsoft.Data.Sqlite;

namespace WorkProto.Api;

public static partial class Proto
{
    // ---------- 动作 2：放行 / 节点推进 ----------

    public static ApiResult StartNode(string nodeId, string by)
    {
        using var c = ProtoDb.Open();
        var node = ReadNode(c, nodeId);
        if (node is null) return ApiResult.Fail(404, Reasons.NodeNotFound, $"节点 {nodeId} 不存在");
        if (node.Status != "pending")
        {
            var code = IsResolved(node.Status) ? Reasons.AlreadyResolved : Reasons.NodeNotActive;
            return ApiResult.Fail(409, code, $"节点当前状态是 {node.Status}，不能重新起步");
        }
        var gate = EvaluateGate(c, node);
        if (!gate.Satisfied)
        {
            var waitingOn = gate.Items.Where(i => !i.Released).Select(i => new { edgeId = i.EdgeId, fromNodeId = i.FromNodeId, reason = i.Reason }).ToList();
            Event(c, node.TaskId, node.Id, "reject", by, Reasons.GateUnsatisfied + ":" + string.Join(",", gate.Missing.Select(m => m.EdgeId + "/" + m.Reason)));
            return ApiResult.Fail(409, Reasons.GateUnsatisfied,
                $"入边条件未满足（{gate.Mode}）：缺 {gate.Missing.Count} 条",
                new { mode = gate.Mode, needCount = gate.NeedCount, waitingOn });
        }
        Activate(c, node);
        return ApiResult.Ok(new { nodeId, status = "active", gate = GateDto(gate) });
    }

    public static ApiResult CompleteNode(string nodeId, string by)
    {
        using var c = ProtoDb.Open();
        var node = ReadNode(c, nodeId);
        if (node is null) return ApiResult.Fail(404, Reasons.NodeNotFound, $"节点 {nodeId} 不存在");
        if (node.Status != "active")
            return ApiResult.Fail(409, Reasons.NodeNotActive, $"节点当前状态是 {node.Status}，只有 active 才能标完成");

        Exec(c, "UPDATE nodes SET status='approved', updated_at_utc=@now WHERE id=@id", ("@now", Now()), ("@id", nodeId));
        Event(c, node.TaskId, node.Id, "approve", by, "节点完成");

        var prop = Propagate(c, ReadNode(c, nodeId)!, by);
        return ApiResult.Ok(new { nodeId, status = "approved", activated = prop.Activated, cycle = prop.Cycle });
    }

    public static ApiResult ReworkNode(string nodeId, string by, string? reason)
    {
        using var c = ProtoDb.Open();
        var node = ReadNode(c, nodeId);
        if (node is null) return ApiResult.Fail(404, Reasons.NodeNotFound, $"节点 {nodeId} 不存在");
        if (node.Status is not ("active" or "review"))
            return ApiResult.Fail(409, Reasons.NodeNotActive, $"节点当前状态是 {node.Status}，不能打回");
        if (string.IsNullOrWhiteSpace(reason)) return ApiResult.Fail(400, Reasons.BadRequest, "打回必须带理由");

        Exec(c, "UPDATE nodes SET status='active', attempt=attempt+1, active_since_utc=@now, updated_at_utc=@now WHERE id=@id", ("@now", Now()), ("@id", nodeId));
        Event(c, node.TaskId, node.Id, "rework", by, reason);
        return ApiResult.Ok(new { nodeId, status = "active", attempt = node.Attempt + 1, reason });
    }

    public static ApiResult Pick(string taskId, PickRequest req)
    {
        using var c = ProtoDb.Open();
        if (req.GroupId is null || req.EdgeId is null) return ApiResult.Fail(400, Reasons.BadRequest, "groupId 与 edgeId 必填");
        using (var check = Q(c, "SELECT id FROM input_groups WHERE id=@id AND task_id=@t", ("@id", req.GroupId), ("@t", taskId)))
            if (check.ExecuteScalar() is null) return ApiResult.Fail(404, "group-not-found", $"规则组 {req.GroupId} 不存在");

        var group = ReadGroup(c, (Scalar(c, "SELECT node_id FROM input_groups WHERE id=@id", ("@id", req.GroupId)) as string)!);
        if (group is null) return ApiResult.Fail(404, "group-not-found", "规则组不存在");
        if (group.Mode != "pick_one") return ApiResult.Fail(409, "not-pick-one", $"规则组模式是 {group.Mode}，不是择一");
        if (group.ChosenEdgeId is not null) return ApiResult.Fail(409, Reasons.PickAlreadyDecided, $"已经选过路线（{group.ChosenEdgeId}），不擅自改选");
        if (!group.Items.Contains(req.EdgeId)) return ApiResult.Fail(400, Reasons.BadRequest, $"{req.EdgeId} 不在该规则组的候选项里");

        var by = string.IsNullOrWhiteSpace(req.By) ? "master" : req.By!;
        Exec(c, "UPDATE input_groups SET chosen_edge_id=@e, decided_at_utc=@now WHERE id=@id", ("@e", req.EdgeId), ("@now", Now()), ("@id", group.Id));
        Event(c, taskId, group.NodeId, "pick", by, $"选定路线 {req.EdgeId}");

        var target = ReadNode(c, group.NodeId)!;
        var chosenEdge = ReadEdges(c, taskId).First(e => e.Id == req.EdgeId);
        var fromNode = ReadNode(c, chosenEdge.FromNodeId);
        var released = fromNode is not null && IsResolved(fromNode.Status) && TryRelease(c, chosenEdge, target, by);
        var activated = Settle(c, target, by);
        var skipped = SkipUnselected(c, group, req.EdgeId, by);

        return ApiResult.Ok(new { groupId = group.Id, chosen = req.EdgeId, released, activated, skipped });
    }

    /// <summary>择一未选的分支：只有「已批准、且没有别的去处」的节点才落 skipped。</summary>
    private static List<string> SkipUnselected(SqliteConnection c, GroupRow group, string chosenEdgeId, string by)
    {
        var skipped = new List<string>();
        var edges = ReadEdges(c, group.TaskId);
        foreach (var edgeId in group.Items.Where(i => i != chosenEdgeId))
        {
            var edge = edges.FirstOrDefault(e => e.Id == edgeId);
            if (edge is null) continue;
            var from = ReadNode(c, edge.FromNodeId);
            if (from is null || from.Status != "approved") continue;
            var others = edges.Where(e => e.FromNodeId == from.Id && e.Id != edgeId).ToList();
            var usedElsewhere = others.Any(e =>
            {
                var g = ReadGroup(c, e.ToNodeId);
                return g is null || g.ChosenEdgeId != edgeId && (g.Mode != "pick_one" || g.ChosenEdgeId is null);
            });
            if (usedElsewhere) continue;
            Exec(c, "UPDATE nodes SET status='skipped', updated_at_utc=@now WHERE id=@id AND status='approved'", ("@now", Now()), ("@id", from.Id));
            Event(c, group.TaskId, from.Id, "skip", by, $"择一未选：路线 {edgeId} 未被采用");
            skipped.Add(from.Id);
        }
        return skipped;
    }

    // ---------- 动作 3：检查点 ----------

    public static ApiResult Checkpoint(string taskId, CheckpointRequest req)
    {
        using var c = ProtoDb.Open();
        if (req.NodeId is null || req.Doing is null || req.NextStep is null || req.Goal is null || req.Verdict is null)
            return ApiResult.Fail(400, Reasons.BadRequest, "nodeId / doing / nextStep / goal / verdict 五项必填");
        if (req.Verdict is not ("progress" or "no_progress"))
            return ApiResult.Fail(400, Reasons.BadRequest, "verdict 只能是 progress 或 no_progress");
        var node = ReadNode(c, req.NodeId);
        if (node is null) return ApiResult.Fail(404, Reasons.NodeNotFound, $"节点 {req.NodeId} 不存在");

        var by = string.IsNullOrWhiteSpace(req.By) ? "unknown" : req.By!;
        var started = node.ActiveSinceUtc ?? Now();
        var ended = Now();
        var id = "ckp_" + Guid.NewGuid().ToString("N")[..16];
        var cycle = ReadCycleByHead(c, taskId, node.Id);
        Exec(c,
            "INSERT INTO checkpoints(id,task_id,node_id,cycle_visit,started_at_utc,ended_at_utc,doing,next_step,goal,verdict,created_by) " +
            "VALUES(@id,@t,@n,@v,@s,@e,@d,@nx,@g,@verdict,@by)",
            ("@id", id), ("@t", taskId), ("@n", node.Id), ("@v", cycle?.Visited ?? 0), ("@s", started), ("@e", ended),
            ("@d", req.Doing), ("@nx", req.NextStep), ("@g", req.Goal), ("@verdict", req.Verdict), ("@by", by));
        Event(c, taskId, node.Id, "checkpoint", by, req.Verdict!);

        object? cycleOutcome = null;
        if (cycle is not null && cycle.PausedReason is "checkpoint-required" or "limit-reached")
        {
            if (req.Verdict == "no_progress")
            {
                Exec(c, "UPDATE nodes SET status='blocked', blocked_reason='cycle-limit', updated_at_utc=@now WHERE id=@id", ("@now", Now()), ("@id", cycle.HeadNodeId));
                Exec(c, "UPDATE cycles SET paused_reason='blocked-cycle-limit' WHERE id=@id", ("@id", cycle.Id));
                Event(c, taskId, cycle.HeadNodeId, "blocked", "program", $"检查点判无进展（轮次 {cycle.Visited}/{cycle.LimitCount}）→ blocked，解除者：master 或 lead");
                cycleOutcome = new { verdict = "no_progress", nodeStatus = "blocked", blockedNodeId = cycle.HeadNodeId, blockedReason = "cycle-limit", releasableBy = "master|lead" };
            }
            else
            {
                Exec(c, "UPDATE cycles SET paused_reason='limit-reached' WHERE id=@id", ("@id", cycle.Id));
                cycleOutcome = new { verdict = "progress", nodeStatus = "approved", message = "有进展：循环停在轮次上限，等 master/lead 决定是否调高上限（调高要留记录）" };
            }
        }

        return ApiResult.Ok(new { checkpointId = id, nodeId = node.Id, verdict = req.Verdict, startedAtUtc = started, endedAtUtc = ended, cycle = cycleOutcome });
    }

    public static ApiResult RaiseLimit(string cycleId, RaiseRequest req)
    {
        using var c = ProtoDb.Open();
        var cycle = ReadCycle(c, cycleId);
        if (cycle is null) return ApiResult.Fail(404, Reasons.CycleNotFound, $"循环 {cycleId} 不存在");
        var by = req.By ?? "";
        if (!Resolvers.Contains(by))
            return ApiResult.Fail(403, Reasons.BlockedReleaseForbidden, "只有 master 或 lead 能调高上限 / 解除轮次阻塞");
        var limit = req.Limit ?? cycle.LimitCount;
        if (limit < 1) return ApiResult.Fail(400, Reasons.BadRequest, "上限至少 1");

        Exec(c, "UPDATE cycles SET limit_count=@l, raised_by=@by, raised_reason=@r, raised_at_utc=@now WHERE id=@id",
            ("@l", limit), ("@by", by), ("@r", req.Reason ?? ""), ("@now", Now()), ("@id", cycle.Id));
        Event(c, cycle.TaskId, cycle.HeadNodeId, "cycle-raise", by, $"上限 {cycle.LimitCount} → {limit}；理由：{req.Reason}");

        object? resumed = null;
        if (cycle.PausedReason is "limit-reached" or "blocked-cycle-limit" or "checkpoint-required")
        {
            if (!string.IsNullOrWhiteSpace(cycle.GroupId))
            {
                Exec(c, "UPDATE nodes SET blocked_reason=NULL WHERE group_id=@g AND status='blocked'", ("@g", cycle.GroupId));
            }
            else
            {
                Exec(c, "UPDATE nodes SET blocked_reason=NULL WHERE task_id=@t AND cycle_region=@r AND status='blocked'",
                    ("@t", cycle.TaskId), ("@r", cycle.RegionKey));
            }
            var loopEdge = ReadEdges(c, cycle.TaskId).FirstOrDefault(e => e.Kind == "loop" && e.FromNodeId == cycle.TailNodeId && e.ToNodeId == cycle.HeadNodeId);
            if (loopEdge is not null)
            {
                var pseudoTail = ReadNode(c, cycle.TailNodeId)!;
                resumed = LoopIteration(c, loopEdge, ReadNode(c, cycle.HeadNodeId)!, pseudoTail, by);
            }
        }
        return ApiResult.Ok(new { cycleId = cycle.Id, limit, raisedBy = by, resumed });
    }

    public static ApiResult Unblock(string nodeId, ByRequest req)
    {
        using var c = ProtoDb.Open();
        var node = ReadNode(c, nodeId);
        if (node is null) return ApiResult.Fail(404, Reasons.NodeNotFound, $"节点 {nodeId} 不存在");
        var by = req.By ?? "";
        if (!Resolvers.Contains(by))
            return ApiResult.Fail(403, Reasons.BlockedReleaseForbidden, "只有 master 或 lead 能解除 blocked");
        if (node.Status != "blocked") return ApiResult.Fail(409, "node-not-blocked", $"节点当前状态是 {node.Status}");

        Exec(c, "UPDATE nodes SET status='active', blocked_reason=NULL, active_since_utc=@now, updated_at_utc=@now WHERE id=@id",
            ("@now", Now()), ("@id", nodeId));
        Event(c, node.TaskId, node.Id, "blocked-release", by, $"解除阻塞（原 {node.BlockedReason}）；理由：{req.Reason}");
        return ApiResult.Ok(new { nodeId, status = "active", releasedBy = by, reason = req.Reason, previousReason = node.BlockedReason });
    }
}
