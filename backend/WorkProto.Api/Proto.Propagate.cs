// ────────── Proto.Propagate.cs ──────────「传播与循环迭代」
// 用途: 传播：节点完成后激活后继、跳过未选、循环迭代落账
// 暴露: Activate Propagation Propagate Settle LoopIteration
// 依赖: Proto.Infra.cs Proto.Gate.cs
// 被依赖: Proto.Lifecycle.cs Proto.Edge.cs Proto.Group.cs
using System.Text.Json;
using Microsoft.Data.Sqlite;

namespace WorkProto.Api;

public static partial class Proto
{
    private static bool Activate(SqliteConnection c, NodeRow node)
    {
        var changed = ExecCount(c, "UPDATE nodes SET status='active', active_since_utc=@now, updated_at_utc=@now, blocked_reason=NULL WHERE id=@id AND status='pending'",
            ("@now", Now()), ("@id", node.Id));
        if (changed > 0) Event(c, node.TaskId, node.Id, "activate", "gate", "门条件满足，节点进入 active");
        return changed > 0;
    }

    private sealed record Propagation(List<string> Activated, List<string> Skipped, object? Cycle);

    private static Propagation Propagate(SqliteConnection c, NodeRow from, string by)
    {
        var activated = new List<string>();
        var skipped = new List<string>();
        object? cycleInfo = null;

        foreach (var edge in ReadEdges(c, from.TaskId).Where(e => e.FromNodeId == from.Id))
        {
            var target = ReadNode(c, edge.ToNodeId);
            if (target is null) continue;

            if (edge.Kind == "transfer")
            {
                TryRelease(c, edge, target, by);
                activated.AddRange(Settle(c, target, by));
            }
            else
            {
                cycleInfo = LoopIteration(c, edge, target, from, by);
            }
        }
        return new Propagation(activated, skipped, cycleInfo);
    }

    /// <summary>目标节点处于 pending 时按门判定，满足则起。</summary>
    private static List<string> Settle(SqliteConnection c, NodeRow target, string by)
    {
        var result = new List<string>();
        var fresh = ReadNode(c, target.Id)!;
        if (fresh.Status != "pending") return result;
        var gate = EvaluateGate(c, fresh);
        if (gate.Satisfied && Activate(c, fresh)) result.Add(fresh.Id);
        return result;
    }

    // ---------- 循环 ----------

    private static object? LoopIteration(SqliteConnection c, EdgeRow loopEdge, NodeRow head, NodeRow tail, string by)
    {
        var cycle = ReadCycleByHead(c, loopEdge.TaskId, head.Id);
        if (cycle is null) return new { executed = false, reason = "no-cycle-row" };

        // 刚跑完的是第 completed 轮（节点 cycle_epoch 即轮次号）
        var completed = head.CycleEpoch;
        var allowed = cycle.LimitKind == "perpetual" || completed < cycle.LimitCount;
        if (!allowed)
        {
            Exec(c, "UPDATE cycles SET visited=@v, paused_reason='checkpoint-required' WHERE id=@id", ("@v", completed), ("@id", cycle.Id));
            Event(c, cycle.TaskId, head.Id, "cycle", by,
                $"第 {completed} 轮跑完，上限 {cycle.LimitCount}，下一轮不执行，需一次检查点");
            return new
            {
                executed = false,
                checkpointRequired = true,
                cycleId = cycle.Id,
                visited = completed,
                limit = cycle.LimitCount,
                limitKind = cycle.LimitKind,
                message = "到达轮次上限：先出检查点（三句话 + verdict），判定无进展才置待人工"
            };
        }

        var newEpoch = completed + 1;
        var next = completed;
        // 循环区＝节点组：一轮结束时把「这个组」的成员全部打回 pending，轮次号 +1
        if (!string.IsNullOrWhiteSpace(cycle.GroupId))
        {
            Exec(c, "UPDATE nodes SET status='pending', cycle_epoch=@e, blocked_reason=NULL, updated_at_utc=@now WHERE group_id=@g",
                ("@e", newEpoch), ("@now", Now()), ("@g", cycle.GroupId));
        }
        else
        {
            Exec(c, "UPDATE nodes SET status='pending', cycle_epoch=@e, blocked_reason=NULL, updated_at_utc=@now WHERE task_id=@t AND cycle_region=@r",
                ("@e", newEpoch), ("@now", Now()), ("@t", cycle.TaskId), ("@r", cycle.RegionKey));
        }
        var headFresh = ReadNode(c, head.Id)!;
        TryRelease(c, loopEdge, headFresh, by, newEpoch);
        Exec(c, "UPDATE nodes SET status='active', active_since_utc=@now, updated_at_utc=@now WHERE id=@id", ("@now", Now()), ("@id", head.Id));
        Exec(c, "UPDATE cycles SET visited=@v, paused_reason=NULL WHERE id=@id", ("@v", next), ("@id", cycle.Id));
        Event(c, cycle.TaskId, head.Id, "cycle", by, $"回边放行：进入第 {newEpoch} 轮（上限 {cycle.LimitCount}）");

        return new { executed = true, cycleId = cycle.Id, cycleEpoch = newEpoch, visited = next, limit = cycle.LimitCount };
    }
}
