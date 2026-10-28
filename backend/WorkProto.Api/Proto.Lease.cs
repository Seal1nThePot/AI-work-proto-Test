// ────────── Proto.Lease.cs ──────────「认领与租约」
// 用途: 认领与租约：抢锁排队、超时回收
// 暴露: Claim ReleaseLease
// 依赖: Proto.Infra.cs
// 被依赖: Program.cs
using System.Text.Json;
using Microsoft.Data.Sqlite;

namespace WorkProto.Api;

public static partial class Proto
{
    // ---------- 动作 1：认领 / 排队 ----------

    public static ApiResult Claim(string taskId, string agent)
    {
        if (string.IsNullOrWhiteSpace(agent)) return ApiResult.Fail(400, Reasons.BadRequest, "agent 必填");
        using var c = ProtoDb.Open();
        var taskTitle = Scalar(c, "SELECT title FROM tasks WHERE id=@id", ("@id", taskId));
        if (taskTitle is null) return ApiResult.Fail(404, Reasons.TaskNotFound, $"任务 {taskId} 不存在");

        var nodeCount = Convert.ToInt32(Scalar(c, "SELECT COUNT(*) FROM nodes WHERE task_id=@t", ("@t", taskId)));
        if (nodeCount == 0)
        {
            Event(c, taskId, null, "reject", agent, Reasons.NoNodes);
            return ApiResult.Fail(409, Reasons.NoNodes, "这个任务没有节点：先拆节点再认领（认领一个没有节点的任务只会白占租约）");
        }

        // 已有 active 租约：本任务＝复用，别的任务＝排队
        var activeTask = Scalar(c, "SELECT task_id FROM leases WHERE agent=@a AND state='active'", ("@a", agent)) as string;
        if (activeTask == taskId)
        {
            return ApiResult.Ok(new { state = "active", reused = true, taskId, message = "已持有本任务" });
        }
        if (activeTask is not null)
        {
            var seq = Convert.ToInt32(Scalar(c, "SELECT COALESCE(MAX(seq),0)+1 FROM leases WHERE agent=@a", ("@a", agent)));
            Exec(c, "INSERT INTO leases(id,agent,task_id,seq,state,created_at_utc) VALUES(@id,@a,@t,@s,'queued',@now)",
                ("@id", "lse_" + Guid.NewGuid().ToString("N")[..16]), ("@a", agent), ("@t", taskId), ("@s", seq), ("@now", Now()));
            Event(c, taskId, null, "queue", agent, $"agent 已有在跑任务 {activeTask}，本任务排队（排位 {seq}）");
            return ApiResult.Ok(new
            {
                state = "queued", taskId, position = seq, runningTaskId = activeTask,
                message = "已排队：同一 agent 同时只跑一个任务，前面的跑完自动接上"
            });
        }

        // 可起步节点
        var nodes = ReadNodes(c, taskId);
        var startable = nodes.Where(n => n.Status == "pending" && EvaluateGate(c, n).Satisfied).ToList();
        if (startable.Count == 0)
        {
            var blockedAny = nodes.Any(n => n.Status == "blocked");
            var waitingOn = nodes.Where(n => n.Status == "pending")
                .Select(n => new { nodeId = n.Id, title = n.Title, waitingOn = EvaluateGate(c, n).Missing.Select(m => new { edgeId = m.EdgeId, reason = m.Reason }) })
                .ToList();
            Event(c, taskId, null, "reject", agent, blockedAny ? Reasons.NothingToDoBlocked : Reasons.NothingToDoWaiting);
            return blockedAny
                ? ApiResult.Fail(409, Reasons.NothingToDoBlocked, "没有可起步的节点：存在 blocked 节点，先解除阻塞", new { waitingOn })
                : ApiResult.Fail(409, Reasons.NothingToDoWaiting, "没有可起步的节点：全在等上游材料，任务保持未认领（不制造僵尸租约）", new { waitingOn });
        }

        var leaseId = "lse_" + Guid.NewGuid().ToString("N")[..16];
        Exec(c, "INSERT INTO leases(id,agent,task_id,seq,state,created_at_utc,expires_at_utc) VALUES(@id,@a,@t,1,'active',@now,@exp)",
            ("@id", leaseId), ("@a", agent), ("@t", taskId), ("@now", Now()), ("@exp", DateTime.UtcNow.AddMinutes(LeaseMinutes).ToString("O")));
        Exec(c, "UPDATE tasks SET status='running' WHERE id=@id AND status='open'", ("@id", taskId));

        var started = startable.Where(n => Activate(c, n)).Select(n => n.Id).ToList();
        Event(c, taskId, null, "claim", agent, $"认领成功，启动节点 {started.Count} 个：{string.Join(",", started)}");

        return ApiResult.Ok(new
        {
            state = "active", taskId, leaseId, activated = started,
            expiresAtUtc = DateTime.UtcNow.AddMinutes(LeaseMinutes).ToString("O"),
            message = started.Count == 0 ? "认领成功，但暂无可起步节点" : $"认领成功，启动 {started.Count} 个节点"
        });
    }

    public static ApiResult ReleaseLease(string taskId, string agent)
    {
        using var c = ProtoDb.Open();
        if (Scalar(c, "SELECT id FROM tasks WHERE id=@id", ("@id", taskId)) is null)
            return ApiResult.Fail(404, Reasons.TaskNotFound, $"任务 {taskId} 不存在");
        var leaseId = Scalar(c, "SELECT id FROM leases WHERE agent=@a AND task_id=@t AND state='active'", ("@a", agent), ("@t", taskId)) as string;
        if (leaseId is null) return ApiResult.Fail(409, "no-active-lease", $"{agent} 当前没有持有 {taskId}");
        Exec(c, "UPDATE leases SET state='released', released_at_utc=@now WHERE id=@id", ("@now", Now()), ("@id", leaseId));
        Event(c, taskId, null, "release-lease", agent, "释放租约");

        var queued = Scalar(c, "SELECT task_id FROM leases WHERE agent=@a AND state='queued' ORDER BY seq LIMIT 1", ("@a", agent)) as string;
        if (queued is null) return ApiResult.Ok(new { released = leaseId, promoted = (string?)null });

        var nextLease = Scalar(c, "SELECT id FROM leases WHERE agent=@a AND task_id=@t AND state='queued' ORDER BY seq LIMIT 1", ("@a", agent), ("@t", queued)) as string;
        Exec(c, "UPDATE leases SET state='active', expires_at_utc=@exp WHERE id=@id",
            ("@exp", DateTime.UtcNow.AddMinutes(LeaseMinutes).ToString("O")), ("@id", nextLease));
        var activated = new List<string>();
        foreach (var n in ReadNodes(c, queued))
        {
            if (n.Status == "pending" && EvaluateGate(c, n).Satisfied && Activate(c, n)) activated.Add(n.Id);
        }
        Event(c, queued, null, "claim", agent, "排队任务自动接上");
        return ApiResult.Ok(new { released = leaseId, promoted = queued, activated });
    }
}
