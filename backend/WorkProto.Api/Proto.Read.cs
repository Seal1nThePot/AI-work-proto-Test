// ────────── Proto.Read.cs ──────────「读端点」
// 用途: 读端点：任务列表、摘要、整图（含节点/边/组/循环）、单节点
// 暴露: ListTasks Summary GetGraph GetNode
// 依赖: Proto.Infra.cs
// 被依赖: Program.cs
using System.Text.Json;
using Microsoft.Data.Sqlite;

namespace WorkProto.Api;

public static partial class Proto
{
    // ---------- 动作 4：读 ----------

    public static ApiResult ListTasks()
    {
        using var c = ProtoDb.Open();
        var ids = new List<string>();
        using (var cmd = Q(c, "SELECT id FROM tasks ORDER BY created_at_utc"))
        using (var r = cmd.ExecuteReader())
            while (r.Read()) ids.Add(r.GetString(0));
        var list = ids.Select(id => Summary(c, id)).ToList();
        return ApiResult.Ok(new { tasks = list });
    }

    private static object Summary(SqliteConnection c, string taskId)
    {
        var title = Scalar(c, "SELECT title FROM tasks WHERE id=@id", ("@id", taskId)) as string ?? "";
        var goal = Scalar(c, "SELECT goal_line FROM tasks WHERE id=@id", ("@id", taskId)) as string ?? "";
        var status = Scalar(c, "SELECT status FROM tasks WHERE id=@id", ("@id", taskId)) as string ?? "";
        var total = Convert.ToInt32(Scalar(c, "SELECT COUNT(*) FROM nodes WHERE task_id=@t", ("@t", taskId)));
        var resolved = Convert.ToInt32(Scalar(c, "SELECT COUNT(*) FROM nodes WHERE task_id=@t AND status IN ('approved','skipped')", ("@t", taskId)));
        var blocked = Convert.ToInt32(Scalar(c, "SELECT COUNT(*) FROM nodes WHERE task_id=@t AND status='blocked'", ("@t", taskId)));
        return new
        {
            id = taskId, title, goalLine = goal, status,
            nodeCount = total, resolvedCount = resolved, blockedCount = blocked,
            progress = total == 0 ? 0 : (int)Math.Round(resolved * 100.0 / total)
        };
    }

    public static ApiResult GetGraph(string taskId)
    {
        using var c = ProtoDb.Open();
        if (Scalar(c, "SELECT id FROM tasks WHERE id=@id", ("@id", taskId)) is null)
            return ApiResult.Fail(404, Reasons.TaskNotFound, $"任务 {taskId} 不存在");

        var nodes = ReadNodes(c, taskId);
        var edges = ReadEdges(c, taskId);
        var groups = new List<object>();
        foreach (var n in nodes)
        {
            var g = ReadGroup(c, n.Id);
            if (g is not null) groups.Add(new { id = g.Id, nodeId = g.NodeId, mode = g.Mode, needCount = g.NeedCount, items = g.Items, chosenEdgeId = g.ChosenEdgeId });
        }
        var cycles = new List<object>();
        using (var cmd = Q(c, "SELECT id FROM cycles WHERE task_id=@t", ("@t", taskId)))
        using (var r = cmd.ExecuteReader())
        {
            var ids = new List<string>();
            while (r.Read()) ids.Add(r.GetString(0));
            r.Close();
            foreach (var id in ids)
            {
                var cy = ReadCycle(c, id)!;
                cycles.Add(new
                {
                    id = cy.Id, groupId = cy.GroupId, regionKey = cy.RegionKey, headNodeId = cy.HeadNodeId, tailNodeId = cy.TailNodeId,
                    limit = cy.LimitCount, limitKind = cy.LimitKind, visited = cy.Visited, pausedReason = cy.PausedReason
                });
            }
        }
        var leases = new List<object>();
        using (var cmd = Q(c, "SELECT agent,state,seq FROM leases WHERE task_id=@t AND state<>'released' ORDER BY seq", ("@t", taskId)))
        using (var r = cmd.ExecuteReader())
            while (r.Read()) leases.Add(new { agent = r.GetString(0), state = r.GetString(1), seq = r.GetInt32(2) });

        var nodeGroups = ReadNodeGroups(c, taskId)
            .Select(g => new
            {
                id = g.Id, title = g.Title, collapsed = g.Collapsed,
                nodeIds = nodes.Where(n => n.GroupId == g.Id).Select(n => n.Id).ToArray()
            })
            .ToArray();

        return ApiResult.Ok(new
        {
            task = Summary(c, taskId),
            nodes = nodes.Select(n => new
            {
                id = n.Id, seq = n.Seq, title = n.Title, goalLine = n.GoalLine, kind = n.Kind, status = n.Status,
                attempt = n.Attempt, cycleRegion = n.CycleRegion, cycleEpoch = n.CycleEpoch,
                blockedReason = n.BlockedReason, artifactState = n.ArtifactState,
                posX = n.PosX, posY = n.PosY,
                inPorts = n.InPorts, outPorts = n.OutPorts, groupId = n.GroupId, compact = n.Compact,
                releasableBy = n.Status == "blocked" ? "master|lead" : null
            }),
            edges = edges.Select(e => new
            {
                id = e.Id, fromNodeId = e.FromNodeId, toNodeId = e.ToNodeId, kind = e.Kind,
                fromPort = e.FromPort, toPort = e.ToPort, graphVersion = e.GraphVersion,
                gate = e.Gate, gateNote = e.GateNote, gateConfirmedBy = e.GateConfirmedBy, gateConfirmedAt = e.GateConfirmedAt
            }),
            groups, cycles, leases, nodeGroups
        });
    }

    public static ApiResult GetNode(string nodeId)
    {
        using var c = ProtoDb.Open();
        var node = ReadNode(c, nodeId);
        if (node is null) return ApiResult.Fail(404, Reasons.NodeNotFound, $"节点 {nodeId} 不存在");

        var gate = EvaluateGate(c, node);
        var checkpoints = new List<object>();
        using (var cmd = Q(c, "SELECT doing,next_step,goal,verdict,started_at_utc,ended_at_utc,cycle_visit FROM checkpoints WHERE node_id=@n ORDER BY ended_at_utc DESC LIMIT 3", ("@n", nodeId)))
        using (var r = cmd.ExecuteReader())
            while (r.Read())
                checkpoints.Add(new
                {
                    doing = r.GetString(0), nextStep = r.GetString(1), goal = r.GetString(2), verdict = r.GetString(3),
                    startedAtUtc = r.GetString(4), endedAtUtc = r.GetString(5), cycleVisit = r.GetInt32(6)
                });

        string? lastRejection = null;
        using (var cmd = Q(c, "SELECT body FROM events WHERE node_id=@n AND kind='reject' ORDER BY at_utc DESC LIMIT 1", ("@n", nodeId)))
            lastRejection = cmd.ExecuteScalar() as string;

        var cycle = ReadCycleByHead(c, node.TaskId, node.Id);
        return ApiResult.Ok(new
        {
            node = new
            {
                id = node.Id, taskId = node.TaskId, seq = node.Seq, title = node.Title, goalLine = node.GoalLine,
                kind = node.Kind, status = node.Status, attempt = node.Attempt, cycleRegion = node.CycleRegion,
                cycleEpoch = node.CycleEpoch, blockedReason = node.BlockedReason, artifactState = node.ArtifactState,
                activeSinceUtc = node.ActiveSinceUtc, posX = node.PosX, posY = node.PosY,
                inPorts = node.InPorts, outPorts = node.OutPorts, groupId = node.GroupId, compact = node.Compact
            },
            input = GateDto(gate),
            checkpoints,
            lastRejection,
            cycle = cycle is null ? null : new { id = cycle.Id, groupId = cycle.GroupId, regionKey = cycle.RegionKey, limit = cycle.LimitCount, limitKind = cycle.LimitKind, visited = cycle.Visited, pausedReason = cycle.PausedReason, headNodeId = cycle.HeadNodeId, tailNodeId = cycle.TailNodeId }
        });
    }
}
