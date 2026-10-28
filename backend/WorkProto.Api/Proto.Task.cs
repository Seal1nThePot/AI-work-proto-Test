// ────────── Proto.Task.cs ──────────「任务级写操作」
// 用途: 任务级：建图（一次贴整张图）/ 删任务 / 删节点 / 从返回体取 id
// 暴露: ReadGroupId DeleteNode DeleteTask CreateTask
// 依赖: Proto.Infra.cs Proto.Group.cs
// 被依赖: Program.cs
using System.Text.Json;
using Microsoft.Data.Sqlite;

namespace WorkProto.Api;

public static partial class Proto
{
    /// <summary>从 CreateNodeGroup 的返回体里把组 id 抠出来（ApiResult 只带 object）。</summary>
    private static string? ReadGroupId(ApiResult r)
    {
        var json = JsonSerializer.Serialize(r.Body);
        using var doc = JsonDocument.Parse(json);
        return doc.RootElement.TryGetProperty("id", out var v) ? v.GetString() : null;
    }

    /// <summary>删节点：只允许删「从未起步、且没挂线」的 pending 节点（双击手滑留下的那种）。</summary>
    public static ApiResult DeleteNode(string nodeId, string by)
    {
        using var c = ProtoDb.Open();
        var node = ReadNode(c, nodeId);
        if (node is null) return ApiResult.Fail(404, Reasons.NodeNotFound, $"节点 {nodeId} 不存在");
        if (node.Status != "pending")
            return ApiResult.Fail(409, "node-not-pending", $"节点已是 {node.Status}，只有从未起步的 pending 节点能删");

        var edges = Convert.ToInt32(Scalar(c,
            "SELECT COUNT(*) FROM edges WHERE task_id=@t AND (from_node_id=@n OR to_node_id=@n)",
            ("@t", node.TaskId), ("@n", nodeId)));
        if (edges > 0)
            return ApiResult.Fail(409, "node-has-edges", $"节点上还连着 {edges} 条线；先断线再删，别悄悄改别人的门条件");

        using var tx = c.BeginTransaction();
        Exec(c, "DELETE FROM input_groups WHERE node_id=@n", ("@n", nodeId));
        Exec(c, "DELETE FROM nodes WHERE id=@n", ("@n", nodeId));
        // 组里剩不到两个就没意义了：散掉，别留一个「一个节点的组」
        if (node.GroupId is not null)
        {
            var left = Convert.ToInt32(Scalar(c, "SELECT COUNT(*) FROM nodes WHERE group_id=@g", ("@g", node.GroupId)));
            if (left < 2)
            {
                Exec(c, "UPDATE nodes SET group_id=NULL WHERE group_id=@g", ("@g", node.GroupId));
                Exec(c, "DELETE FROM node_groups WHERE id=@g", ("@g", node.GroupId));
            }
        }
        tx.Commit();
        Event(c, node.TaskId, null, "node-delete", by, $"删掉节点「{node.Title}」");
        return ApiResult.Ok(new { deleted = nodeId });
    }

    // ---------- 删任务（原型清理用，不是业务流程） ----------

    public static ApiResult DeleteTask(string taskId)
    {
        using var c = ProtoDb.Open();
        if (Scalar(c, "SELECT id FROM tasks WHERE id=@id", ("@id", taskId)) is null)
            return ApiResult.Fail(404, Reasons.TaskNotFound, $"任务 {taskId} 不存在");
        using var tx = c.BeginTransaction();
        foreach (var sql in new[]
                 {
                     "DELETE FROM checkpoints WHERE task_id=@t",
                     "DELETE FROM releases WHERE task_id=@t",
                     "DELETE FROM input_groups WHERE task_id=@t",
                     "DELETE FROM node_groups WHERE task_id=@t",
                     "DELETE FROM cycles WHERE task_id=@t",
                     "DELETE FROM leases WHERE task_id=@t",
                     "DELETE FROM events WHERE task_id=@t",
                     "DELETE FROM edges WHERE task_id=@t",
                     "DELETE FROM nodes WHERE task_id=@t",
                     "DELETE FROM tasks WHERE id=@t"
                 })
        {
            Exec(c, sql, ("@t", taskId));
        }
        tx.Commit();
        return ApiResult.Ok(new { deleted = taskId });
    }

    // ---------- 建图 ----------

    public static ApiResult CreateTask(CreateTaskRequest req)
    {
        if (string.IsNullOrWhiteSpace(req.Title)) return ApiResult.Fail(400, Reasons.BadRequest, "title 必填");
        var taskId = string.IsNullOrWhiteSpace(req.Id) ? "tsk_" + Guid.NewGuid().ToString("N")[..12] : req.Id!;
        var nodes = req.Nodes ?? [];
        var edges = req.Edges ?? [];
        var groups = req.Groups ?? [];
        var cycles = req.Cycles ?? [];
        var nodeIds = nodes.Select(n => n.Id).Where(i => !string.IsNullOrWhiteSpace(i)).ToHashSet();

        foreach (var e in edges)
        {
            if (!nodeIds.Contains(e.From) || !nodeIds.Contains(e.To))
                return ApiResult.Fail(400, Reasons.BadRequest, $"边 {e.Id} 引用了不存在的节点：{e.From} → {e.To}");
        }
        foreach (var g in groups)
        {
            if (!nodeIds.Contains(g.NodeId))
                return ApiResult.Fail(400, Reasons.BadRequest, $"规则组 {g.Id} 指向不存在的节点 {g.NodeId}");
        }

        using var c = ProtoDb.Open();
        if (Scalar(c, "SELECT id FROM tasks WHERE id=@id", ("@id", taskId)) is not null)
            return ApiResult.Fail(409, "task-exists", $"任务 {taskId} 已存在");

        using var tx = c.BeginTransaction();
        Exec(c, "INSERT INTO tasks(id,title,goal_line,status,created_at_utc) VALUES(@id,@t,@g,'open',@now)",
            ("@id", taskId), ("@t", req.Title), ("@g", req.GoalLine ?? ""), ("@now", Now()));

        var seq = 0;
        foreach (var n in nodes)
        {
            seq++;
            if (n.InPorts is < 1 or > MaxPorts || n.OutPorts is < 1 or > MaxPorts)
                return ApiResult.Fail(400, Reasons.PortOutOfRange, $"节点「{n.Title}」的进出端口数只能是 1–{MaxPorts}");
            // cycleRegion 只是「加入同名组」的糖（循环区由组承载）
            var regionGroup = string.IsNullOrWhiteSpace(n.CycleRegion) ? null : EnsureRegionGroup(c, taskId, n.CycleRegion!);
            Exec(c, "INSERT INTO nodes(id,task_id,title,goal_line,kind,status,seq,attempt,cycle_region,cycle_epoch,artifact_state,pos_x,pos_y,in_ports,out_ports,group_id,updated_at_utc) " +
                    "VALUES(@id,@t,@title,@g,@k,'pending',@s,0,@r,1,'none',@x,@y,@ip,@op,@grp,@now)",
                ("@id", n.Id), ("@t", taskId), ("@title", n.Title), ("@g", n.GoalLine ?? ""),
                ("@k", string.IsNullOrWhiteSpace(n.Kind) ? "work" : n.Kind), ("@s", n.Seq ?? seq),
                ("@r", n.CycleRegion), ("@x", n.X), ("@y", n.Y),
                ("@ip", n.InPorts ?? 1), ("@op", n.OutPorts ?? 1), ("@grp", regionGroup), ("@now", Now()));
        }

        foreach (var e in edges)
        {
            var gate = string.IsNullOrWhiteSpace(e.Gate) ? "auto" : e.Gate!.Trim();
            if (!EdgeGates.Contains(gate))
                return ApiResult.Fail(400, Reasons.BadRequest, $"边 {e.Id} 的门控只有 auto / human，收到 {gate}");
            var edgeId = e.Id;
            Exec(c, "INSERT INTO edges(id,task_id,from_node_id,to_node_id,kind,transfer_condition,target_step_id,from_port,to_port,gate,gate_note,graph_version) VALUES(@id,@t,@f,@to,@k,'auto','',@fp,@tp,@gate,@note,1)",
                ("@id", edgeId), ("@t", taskId), ("@f", e.From), ("@to", e.To), ("@k", string.IsNullOrWhiteSpace(e.Kind) ? "transfer" : e.Kind),
                ("@fp", e.FromPort ?? 0), ("@tp", e.ToPort ?? 0), ("@gate", gate), ("@note", (e.GateNote ?? "").Trim()));
        }

        foreach (var g in groups)
        {
            Exec(c, "INSERT INTO input_groups(id,task_id,node_id,mode,need_count,items_json) VALUES(@id,@t,@n,@m,@k,@items)",
                ("@id", g.Id), ("@t", taskId), ("@n", g.NodeId), ("@m", string.IsNullOrWhiteSpace(g.Mode) ? "all" : g.Mode),
                ("@k", g.NeedCount ?? 0), ("@items", JsonSerializer.Serialize(g.Items ?? [])));
        }

        foreach (var cy in cycles)
        {
            // 循环区由组承载：建图时声明循环＝按 regionKey 建/取同名组，并把它标成循环区
            var cyGroup = EnsureRegionGroup(c, taskId, cy.RegionKey);
            Exec(c, "UPDATE nodes SET group_id=@g WHERE task_id=@t AND cycle_region=@r",
                ("@g", cyGroup), ("@t", taskId), ("@r", cy.RegionKey));
            Exec(c, "INSERT INTO cycles(id,task_id,region_key,group_id,head_node_id,tail_node_id,limit_count,limit_kind,visited) VALUES(@id,@t,@r,@g,@h,@tl,@l,@lk,0)",
                ("@id", cy.Id), ("@t", taskId), ("@r", cy.RegionKey), ("@g", cyGroup), ("@h", cy.Head), ("@tl", cy.Tail),
                ("@l", cy.Limit ?? 3), ("@lk", string.IsNullOrWhiteSpace(cy.LimitKind) ? "bounded" : cy.LimitKind));
        }

        tx.Commit();
        Event(c, taskId, null, "create", "api", $"建图：{nodes.Length} 节点 / {edges.Length} 边 / {groups.Length} 规则组 / {cycles.Length} 循环");

        return ApiResult.Created(new { id = taskId, title = req.Title, nodes = nodes.Length, edges = edges.Length, groups = groups.Length, cycles = cycles.Length });
    }
}
