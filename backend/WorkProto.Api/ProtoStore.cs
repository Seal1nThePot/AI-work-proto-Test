using System.Text.Json;
using Microsoft.Data.Sqlite;

namespace WorkProto.Api;

public sealed record ApiResult(int Status, object Body)
{
    public static ApiResult Ok(object body) => new(200, body);
    public static ApiResult Created(object body) => new(201, body);

    public static ApiResult Fail(int status, string error, string message, object? details = null)
        => new(status, details is null
            ? new { error, message }
            : new { error, message, details });
}

/// <summary>拒绝原因码：每条拒绝都必须带一个，文案不许与实情不符。</summary>
public static class Reasons
{
    public const string TaskNotFound = "task-not-found";
    public const string NodeNotFound = "node-not-found";
    public const string NoNodes = "no-nodes";
    public const string NothingToDoBlocked = "nothing-to-do:blocked";
    public const string NothingToDoWaiting = "nothing-to-do:waiting";
    public const string NodeNotActive = "node-not-active";
    public const string GateUnsatisfied = "gate-unsatisfied";
    public const string CheckpointRequired = "checkpoint-required";
    public const string BlockedReleaseForbidden = "blocked-release-forbidden";
    public const string PickAlreadyDecided = "pick-already-decided";
    public const string CycleNotPaused = "cycle-not-paused";
    public const string CycleNotFound = "cycle-not-found";
    public const string BadRequest = "bad-request";
    public const string AlreadyResolved = "already-resolved";
    public const string TitleRequired = "title-required";
    public const string TitleTooLong = "title-too-long";
    public const string KindInvalid = "kind-invalid";
    public const string NodeExists = "node-exists";
    public const string SeqTaken = "seq-taken";
    public const string UnknownNode = "unknown-node";
    public const string EdgeDuplicate = "edge-duplicate";
    public const string LoopNeedsCycle = "loop-needs-cycle";
    public const string PortOutOfRange = "port-out-of-range";
    public const string PortInUse = "port-in-use";
    public const string NodeGroupNotFound = "node-group-not-found";
    public const string NodeGroupNeedsTwo = "node-group-needs-two";
    public const string NodeGroupNotDeletable = "node-group-not-deletable";
}

public sealed record NodeSpec(string? Id, string Title, string? GoalLine, string? Kind, int? Seq, string? CycleRegion, int? X = null, int? Y = null, int? InPorts = null, int? OutPorts = null);
public sealed record EdgeSpec(string? Id, string From, string To, string? Kind, int? FromPort = null, int? ToPort = null, string? Gate = null, string? GateNote = null);

/// <summary>改连线：给哪几项改哪几项。改 from/to/kind/端口 会被「已经放过行」挡住。</summary>
public sealed record EdgePatchRequest(string? From, string? To, string? Kind, int? FromPort, int? ToPort, string? Gate, string? GateNote);
public sealed record GroupSpec(string? Id, string NodeId, string? Mode, int? NeedCount, string[]? Items);
public sealed record CycleSpec(string? Id, string RegionKey, string Head, string Tail, int? Limit, string? LimitKind);

public sealed record CreateTaskRequest(
    string? Id, string Title, string? GoalLine,
    NodeSpec[]? Nodes, EdgeSpec[]? Edges, GroupSpec[]? Groups, CycleSpec[]? Cycles);

public sealed record ClaimRequest(string? Agent);
public sealed record ByRequest(string? By, string? Reason);
public sealed record CheckpointRequest(string? NodeId, string? Doing, string? NextStep, string? Goal, string? Verdict, string? By);
public sealed record PickRequest(string? GroupId, string? EdgeId, string? By);
public sealed record RaiseRequest(string? By, int? Limit, string? Reason);
public sealed record MoveRequest(int? X, int? Y);
public sealed record MoveNodeItem(string? Id, int? X, int? Y);
public sealed record MoveBatchRequest(MoveNodeItem[]? Nodes);
public sealed record PortsRequest(int? InPorts, int? OutPorts);

/// <summary>节点组＝画布上的纯视觉分组，不参与门、不参与执行。</summary>
public sealed record NodeGroupSpec(string? Id, string? Title, string[]? NodeIds);

public sealed record CollapseRequest(bool? Collapsed);

/// <summary>节点收纳级别：0 完整 / 1 仅标题 / 2 仅关键字。也收 collapsed=true 当 1 用。</summary>
public sealed record CompactRequest(int? Level, bool? Collapsed);

/// <summary>点节点改属性：只给哪几项就改哪几项（标题/一行目标/类型/循环区）。</summary>
public sealed record NodePatchRequest(string? Title, string? GoalLine, string? Kind, string? CycleRegion);

/// <summary>循环区声明：谁是头、谁是尾、跑几轮。组＋回边＋检查点＝循环区。</summary>
public sealed record LoopSpecRequest(string? Head, string? Tail, int? Limit, string? LimitKind);

/// <summary>节点预设：一次存、到处套（标题/一行目标/类型/口数）。</summary>
public sealed record NodeTemplateSpec(string? NodeId, string? Name, string? Title, string? GoalLine, string? Kind, int? InPorts, int? OutPorts);

/// <summary>组预设：从一个组（或一组节点）快照下来，套用时整块落到画布上。</summary>
public sealed record GroupTemplateSpec(string? GroupId, string? Name, string[]? NodeIds);

/// <summary>套用预设：给落点（世界坐标左上角），不给就放在默认位置。</summary>
public sealed record ApplyTemplateRequest(string? TemplateId, int? X, int? Y);

internal sealed class NodeRow
{
    public required string Id, TaskId, Title, GoalLine, Kind, Status, ArtifactState;
    public int Seq, Attempt, CycleEpoch;
    public string? CycleRegion, BlockedReason, ActiveSinceUtc, GroupId;
    public int? PosX, PosY;
    public int InPorts = 1, OutPorts = 1;
    public int Compact;          // 0=完整卡片 1=只留标题 2=只留关键字（一行目标）
}

internal sealed class EdgeRow
{
    public required string Id, TaskId, FromNodeId, ToNodeId, Kind, TransferCondition;
    public int GraphVersion;
    public string TargetStepId = "";
    public int FromPort, ToPort;
    // 连线级门控：auto＝上游做完就放行；human＝还要人在这条线上点头
    public string Gate = "auto";
    public string GateNote = "";
    public string? GateConfirmedBy, GateConfirmedAt;
}

internal sealed class GroupRow
{
    public required string Id, TaskId, NodeId, Mode;
    public int NeedCount;
    public List<string> Items = [];
    public string? ChosenEdgeId;
}

internal sealed class CycleRow
{
    public required string Id, TaskId, RegionKey, HeadNodeId, TailNodeId, LimitKind;
    public int LimitCount, Visited;
    public string? PausedReason, GroupId;    // 循环区由节点组承载：group_id 才是归属，region_key 只是显示名
}

public static class Proto
{
    private const int LeaseMinutes = 30;
    private static readonly string[] Resolvers = ["master", "lead"];

    public static string Now() => DateTime.UtcNow.ToString("O");

    /// <summary>
    /// 一次写操作要落多行（连线 + 规则组 + 放行 + 留痕）时，整段包进一个事务：
    /// 要么全成要么全不动，顺便把「每行一次提交」变成一次提交。
    /// 事务挂在 AsyncLocal 上，由 Q 自动接到每条命令（SqliteConnection.Transaction 是 internal，取不到）。
    /// </summary>
    private static readonly AsyncLocal<SqliteTransaction?> AmbientTx = new();

    private sealed class WriteBatch : IDisposable
    {
        private readonly SqliteTransaction _tx;
        private bool _done;
        public WriteBatch(SqliteConnection c)
        {
            _tx = c.BeginTransaction();
            AmbientTx.Value = _tx;
        }
        public void Commit()
        {
            _tx.Commit();
            _done = true;
        }
        public void Dispose()
        {
            if (!_done) _tx.Rollback();
            _tx.Dispose();
            AmbientTx.Value = null;
        }
    }

    private static SqliteCommand Q(SqliteConnection c, string sql, params (string Name, object? Value)[] args)
    {
        var cmd = c.CreateCommand();
        cmd.CommandText = sql;
        // 连接上已经开着事务时命令必须挂同一个事务（Microsoft.Data.Sqlite 会校验）
        var tx = AmbientTx.Value;
        if (tx is not null && ReferenceEquals(tx.Connection, c)) cmd.Transaction = tx;
        foreach (var (name, value) in args) cmd.Parameters.AddWithValue(name, value ?? DBNull.Value);
        return cmd;
    }

    private static void Exec(SqliteConnection c, string sql, params (string, object?)[] args)
    {
        using var cmd = Q(c, sql, args);
        cmd.ExecuteNonQuery();
    }

    private static int ExecCount(SqliteConnection c, string sql, params (string, object?)[] args)
    {
        using var cmd = Q(c, sql, args);
        return cmd.ExecuteNonQuery();
    }

    private static object? Scalar(SqliteConnection c, string sql, params (string, object?)[] args)
    {
        using var cmd = Q(c, sql, args);
        return cmd.ExecuteScalar();
    }

    private static void Event(SqliteConnection c, string? taskId, string? nodeId, string kind, string by, string body = "")
        => Exec(c, "INSERT INTO events(task_id,node_id,kind,by,body,at_utc) VALUES(@t,@n,@k,@b,@body,@at)",
            ("@t", taskId), ("@n", nodeId), ("@k", kind), ("@b", by), ("@body", body), ("@at", Now()));

    // ---------- 读 ----------

    private const string NodeColumns = "id,task_id,title,goal_line,kind,status,seq,attempt,cycle_region,cycle_epoch,blocked_reason,artifact_state,active_since_utc,pos_x,pos_y,in_ports,out_ports,group_id,compact";

    private static NodeRow MapNode(SqliteDataReader r) => new()
    {
        Id = r.GetString(0), TaskId = r.GetString(1), Title = r.GetString(2), GoalLine = r.GetString(3),
        Kind = r.GetString(4), Status = r.GetString(5), Seq = r.GetInt32(6), Attempt = r.GetInt32(7),
        CycleRegion = r.IsDBNull(8) ? null : r.GetString(8), CycleEpoch = r.GetInt32(9),
        BlockedReason = r.IsDBNull(10) ? null : r.GetString(10), ArtifactState = r.GetString(11),
        ActiveSinceUtc = r.IsDBNull(12) ? null : r.GetString(12),
        PosX = r.IsDBNull(13) ? null : r.GetInt32(13),
        PosY = r.IsDBNull(14) ? null : r.GetInt32(14),
        InPorts = r.GetInt32(15), OutPorts = r.GetInt32(16),
        GroupId = r.IsDBNull(17) ? null : r.GetString(17),
        Compact = r.GetInt32(18)
    };

    private static NodeRow? ReadNode(SqliteConnection c, string id)
    {
        using var cmd = Q(c, $"SELECT {NodeColumns} FROM nodes WHERE id=@id", ("@id", id));
        using var r = cmd.ExecuteReader();
        return r.Read() ? MapNode(r) : null;
    }

    private sealed record NodeGroupRow(string Id, string TaskId, string Title, bool Collapsed);

    private static List<NodeGroupRow> ReadNodeGroups(SqliteConnection c, string taskId)
    {
        var list = new List<NodeGroupRow>();
        using var cmd = Q(c, "SELECT id,task_id,title,collapsed FROM node_groups WHERE task_id=@t ORDER BY created_at_utc", ("@t", taskId));
        using var r = cmd.ExecuteReader();
        while (r.Read()) list.Add(new NodeGroupRow(r.GetString(0), r.GetString(1), r.GetString(2), r.GetInt32(3) != 0));
        return list;
    }

    private static object NodeDto(NodeRow n) => new
    {
        id = n.Id, taskId = n.TaskId, seq = n.Seq, title = n.Title, goalLine = n.GoalLine, kind = n.Kind,
        status = n.Status, attempt = n.Attempt, cycleRegion = n.CycleRegion, cycleEpoch = n.CycleEpoch,
        blockedReason = n.BlockedReason, artifactState = n.ArtifactState, posX = n.PosX, posY = n.PosY,
        inPorts = n.InPorts, outPorts = n.OutPorts, groupId = n.GroupId, compact = n.Compact
    };

    private static List<NodeRow> ReadNodes(SqliteConnection c, string taskId)
    {
        // 一条查询拿全部节点（以前是 1 条查 id + N 条逐个读，1000 个节点白花 34 ms）
        var list = new List<NodeRow>();
        using var cmd = Q(c, $"SELECT {NodeColumns} FROM nodes WHERE task_id=@t ORDER BY seq", ("@t", taskId));
        using var r = cmd.ExecuteReader();
        while (r.Read()) list.Add(MapNode(r));
        return list;
    }

    private static List<EdgeRow> ReadEdges(SqliteConnection c, string taskId)
    {
        var list = new List<EdgeRow>();
        using var cmd = Q(c, "SELECT id,task_id,from_node_id,to_node_id,kind,transfer_condition,target_step_id,graph_version,from_port,to_port,gate,gate_note,gate_confirmed_by,gate_confirmed_at_utc FROM edges WHERE task_id=@t", ("@t", taskId));
        using var r = cmd.ExecuteReader();
        while (r.Read())
        {
            list.Add(new EdgeRow
            {
                Id = r.GetString(0), TaskId = r.GetString(1), FromNodeId = r.GetString(2), ToNodeId = r.GetString(3),
                Kind = r.GetString(4), TransferCondition = r.GetString(5), TargetStepId = r.GetString(6), GraphVersion = r.GetInt32(7),
                FromPort = r.GetInt32(8), ToPort = r.GetInt32(9),
                Gate = r.GetString(10), GateNote = r.GetString(11),
                GateConfirmedBy = r.IsDBNull(12) ? null : r.GetString(12),
                GateConfirmedAt = r.IsDBNull(13) ? null : r.GetString(13)
            });
        }
        return list;
    }

    private static GroupRow? ReadGroup(SqliteConnection c, string nodeId)
    {
        using var cmd = Q(c, "SELECT id,task_id,node_id,mode,need_count,items_json,chosen_edge_id FROM input_groups WHERE node_id=@n", ("@n", nodeId));
        using var r = cmd.ExecuteReader();
        if (!r.Read()) return null;
        return new GroupRow
        {
            Id = r.GetString(0), TaskId = r.GetString(1), NodeId = r.GetString(2), Mode = r.GetString(3),
            NeedCount = r.GetInt32(4),
            Items = JsonSerializer.Deserialize<List<string>>(r.GetString(5)) ?? [],
            ChosenEdgeId = r.IsDBNull(6) ? null : r.GetString(6)
        };
    }

    private static CycleRow? ReadCycleByHead(SqliteConnection c, string taskId, string headNodeId)
    {
        using var cmd = Q(c, "SELECT id,task_id,region_key,group_id,head_node_id,tail_node_id,limit_count,limit_kind,visited,paused_reason FROM cycles WHERE task_id=@t AND head_node_id=@h", ("@t", taskId), ("@h", headNodeId));
        using var r = cmd.ExecuteReader();
        if (!r.Read()) return null;
        return MapCycle(r);
    }

    private static CycleRow? ReadCycleByGroup(SqliteConnection c, string groupId)
    {
        using var cmd = Q(c, "SELECT id,task_id,region_key,group_id,head_node_id,tail_node_id,limit_count,limit_kind,visited,paused_reason FROM cycles WHERE group_id=@g", ("@g", groupId));
        using var r = cmd.ExecuteReader();
        if (!r.Read()) return null;
        return MapCycle(r);
    }

    private static CycleRow? ReadCycle(SqliteConnection c, string id)
    {
        using var cmd = Q(c, "SELECT id,task_id,region_key,group_id,head_node_id,tail_node_id,limit_count,limit_kind,visited,paused_reason FROM cycles WHERE id=@id", ("@id", id));
        using var r = cmd.ExecuteReader();
        if (!r.Read()) return null;
        return MapCycle(r);
    }

    private static CycleRow MapCycle(SqliteDataReader r) => new()
    {
        Id = r.GetString(0), TaskId = r.GetString(1), RegionKey = r.GetString(2),
        GroupId = r.IsDBNull(3) ? null : r.GetString(3),
        HeadNodeId = r.GetString(4), TailNodeId = r.GetString(5), LimitCount = r.GetInt32(6),
        LimitKind = r.GetString(7), Visited = r.GetInt32(8),
        PausedReason = r.IsDBNull(9) ? null : r.GetString(9)
    };

    private static HashSet<string> ReleasedEdges(SqliteConnection c, NodeRow node)
    {
        var set = new HashSet<string>();
        using var cmd = Q(c, "SELECT edge_id FROM releases WHERE to_node_id=@n AND node_attempt=@a AND cycle_epoch=@e",
            ("@n", node.Id), ("@a", node.Attempt + 1), ("@e", node.CycleEpoch));
        using var r = cmd.ExecuteReader();
        while (r.Read()) set.Add(r.GetString(0));
        return set;
    }

    private static bool IsResolved(string status) => status is "approved" or "skipped";

    // ---------- 门 ----------

    private sealed record Gate(string Mode, int NeedCount, List<GateItem> Items, bool Satisfied, List<GateItem> Missing, string? ChosenEdgeId);
    private sealed record GateItem(string EdgeId, string FromNodeId, string FromTitle, string FromStatus, bool Released, string Reason);

    private static Gate EvaluateGate(SqliteConnection c, NodeRow node)
    {
        var group = ReadGroup(c, node.Id);
        var released = ReleasedEdges(c, node);
        var items = new List<GateItem>();
        var edges = ReadEdges(c, node.TaskId).ToDictionary(e => e.Id);

        if (group is null)
        {
            // 无规则组：隐式全等——所有入边（传递）都放行才可起
            var incoming = edges.Values.Where(e => e.ToNodeId == node.Id && e.Kind == "transfer").ToList();
            foreach (var e in incoming)
            {
                var from = ReadNode(c, e.FromNodeId);
                items.Add(new GateItem(e.Id, e.FromNodeId, from?.Title ?? e.FromNodeId, from?.Status ?? "missing", released.Contains(e.Id), ReasonFor(c, from, e, released.Contains(e.Id))));
            }
            var implicitMissing = items.Where(i => !i.Released).ToList();
            return new Gate(null!, 0, items, implicitMissing.Count == 0, implicitMissing, null);
        }

        foreach (var edgeId in group.Items)
        {
            var e = edges.GetValueOrDefault(edgeId);
            var from = e is null ? null : ReadNode(c, e.FromNodeId);
            items.Add(new GateItem(edgeId, e?.FromNodeId ?? "", from?.Title ?? "(未知节点)", from?.Status ?? "missing", released.Contains(edgeId), ReasonFor(c, from, e, released.Contains(edgeId))));
        }

        var notReleased = items.Where(i => !i.Released).ToList();
        bool satisfied;
        List<GateItem> missing;
        switch (group.Mode)
        {
            case "any":
                satisfied = items.Count > 0 && items.Count(i => i.Released) > 0;
                missing = satisfied ? [] : notReleased;
                break;
            case "k_of_n":
                var need = group.NeedCount > 0 ? group.NeedCount : 1;
                satisfied = items.Count(i => i.Released) >= need;
                missing = satisfied ? [] : notReleased;
                break;
            case "pick_one":
                satisfied = group.ChosenEdgeId is not null && released.Contains(group.ChosenEdgeId);
                missing = satisfied ? [] : (group.ChosenEdgeId is null
                    ? [new GateItem("", "", "（尚未选定路线）", "undecided", false, "pick-undecided")]
                    : notReleased.Where(i => i.EdgeId == group.ChosenEdgeId).ToList());
                break;
            default: // all
                satisfied = items.Count > 0 && notReleased.Count == 0;
                missing = satisfied ? [] : notReleased;
                break;
        }
        return new Gate(group.Mode, group.NeedCount, items, satisfied, missing, group.ChosenEdgeId);
    }

    private static string ReasonFor(SqliteConnection c, NodeRow? from, EdgeRow? edge = null, bool released = false)
    {
        if (from is null) return "edge-target-missing";
        // 只有「还没放行」的线才谈得上门控待确认；已经放过行的线再挂闸门是事后补账，没意义
        if (!released && edge is not null && edge.Gate == "human" && string.IsNullOrEmpty(edge.GateConfirmedBy) && IsResolved(from.Status))
            return "gate-needs-confirm";
        if (from.Status == "blocked") return "upstream-blocked";
        if (!IsResolved(from.Status)) return "upstream-not-approved";
        return "input-missing";
    }

    private static object GateDto(Gate g) => new
    {
        mode = g.Mode,
        needCount = g.NeedCount,
        chosenEdgeId = g.ChosenEdgeId,
        satisfied = g.Satisfied,
        items = g.Items.Select(i => new { edgeId = i.EdgeId, fromNodeId = i.FromNodeId, fromTitle = i.FromTitle, fromStatus = i.FromStatus, released = i.Released, reason = i.Reason }),
        missing = g.Missing.Select(i => new { edgeId = i.EdgeId, reason = i.Reason })
    };

    // ---------- 放行 ----------

    private static bool TryRelease(SqliteConnection c, EdgeRow edge, NodeRow target, string by, int? epochOverride = null)
    {
        // 人工门控：这条线没人点头就不写放行记录（下游因此起不来，原因码 gate-needs-confirm）
        if (edge.Gate == "human" && string.IsNullOrEmpty(edge.GateConfirmedBy)) return false;
        var attempt = target.Attempt + 1;
        var epoch = epochOverride ?? target.CycleEpoch;
        var changed = ExecCount(c,
            "INSERT OR IGNORE INTO releases(id,task_id,edge_id,to_node_id,node_attempt,cycle_epoch,graph_version,released_at_utc,released_by) " +
            "VALUES(@id,@t,@e,@n,@a,@ep,@gv,@now,@by)",
            ("@id", "rel_" + Guid.NewGuid().ToString("N")[..16]), ("@t", edge.TaskId), ("@e", edge.Id), ("@n", target.Id),
            ("@a", attempt), ("@ep", epoch), ("@gv", edge.GraphVersion), ("@now", Now()), ("@by", by));
        return changed > 0;
    }

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

    // ---------- 图增量：新建节点 / 新建连线 ----------

    private static readonly string[] NodeKinds = ["work", "review_auto", "review_human"];
    private static readonly string[] EdgeKinds = ["transfer", "loop"];
    private static readonly string[] EdgeGates = ["auto", "human"];
    private const int MaxPorts = 12;

    /// <summary>往已有任务图里加一个节点。规则与建图时一致：标题必填、kind 三选一、seq 不撞号。</summary>
    public static ApiResult AddNode(string taskId, NodeSpec req, string by)
    {
        using var c = ProtoDb.Open();
        if (Scalar(c, "SELECT id FROM tasks WHERE id=@id", ("@id", taskId)) is null)
            return ApiResult.Fail(404, Reasons.TaskNotFound, $"任务 {taskId} 不存在");

        var title = (req.Title ?? "").Trim();
        if (title.Length == 0) return ApiResult.Fail(400, Reasons.TitleRequired, "节点标题必填（一句白话，别写代号）");
        if (title.Length > 120) return ApiResult.Fail(400, Reasons.TitleTooLong, $"标题最长 120 字，当前 {title.Length} 字");

        var kind = string.IsNullOrWhiteSpace(req.Kind) ? "work" : req.Kind!.Trim();
        if (!NodeKinds.Contains(kind))
            return ApiResult.Fail(400, Reasons.KindInvalid, $"kind 只能是 work / review_auto / review_human，收到 {kind}");

        var inPorts = req.InPorts ?? 1;
        var outPorts = req.OutPorts ?? 1;
        if (inPorts < 1 || inPorts > MaxPorts || outPorts < 1 || outPorts > MaxPorts)
            return ApiResult.Fail(400, Reasons.PortOutOfRange, $"进出端口数只能是 1–{MaxPorts}，收到 进 {inPorts} / 出 {outPorts}");

        var nodeId = string.IsNullOrWhiteSpace(req.Id) ? "nd_" + Guid.NewGuid().ToString("N")[..10] : req.Id!.Trim();
        if (ReadNode(c, nodeId) is not null)
            return ApiResult.Fail(409, Reasons.NodeExists, $"节点 id {nodeId} 已存在");

        var maxSeq = ReadNodes(c, taskId).Select(n => n.Seq).DefaultIfEmpty(0).Max();
        var seq = req.Seq ?? maxSeq + 1;
        if (seq < 1) return ApiResult.Fail(400, Reasons.BadRequest, "seq 从 1 起");
        if (ReadNodes(c, taskId).Any(n => n.Seq == seq))
            return ApiResult.Fail(409, Reasons.SeqTaken, $"任务里已经有第 {seq} 个节点，换个 seq 或不传（自动排到末尾）");

        // cycleRegion 现在只是「加入同名节点组」的糖：循环区由组承载
        var regionGroupId = string.IsNullOrWhiteSpace(req.CycleRegion) ? null : EnsureRegionGroup(c, taskId, req.CycleRegion!);

        Exec(c, "INSERT INTO nodes(id,task_id,title,goal_line,kind,status,seq,attempt,cycle_region,cycle_epoch,artifact_state,pos_x,pos_y,in_ports,out_ports,group_id,updated_at_utc) " +
                "VALUES(@id,@t,@title,@g,@k,'pending',@s,0,@r,1,'none',@x,@y,@ip,@op,@grp,@now)",
            ("@id", nodeId), ("@t", taskId), ("@title", title), ("@g", req.GoalLine ?? ""),
            ("@k", kind), ("@s", seq), ("@r", req.CycleRegion), ("@x", req.X), ("@y", req.Y),
            ("@ip", inPorts), ("@op", outPorts), ("@grp", regionGroupId), ("@now", Now()));
        Event(c, taskId, nodeId, "node-create", by, $"新建节点「{title}」（{kind}，第 {seq} 个）");

        string? hint = null;
        if (regionGroupId is not null && ReadCycleByGroup(c, regionGroupId) is null)
            hint = $"节点已归入同名节点组「{req.CycleRegion}」；要把这里变成循环区，给它声明头/尾与上限（组＋回边＋检查点）";

        var created = ReadNode(c, nodeId)!;
        return ApiResult.Created(new
        {
            node = new
            {
                id = created.Id, taskId = created.TaskId, seq = created.Seq, title = created.Title, goalLine = created.GoalLine,
                kind = created.Kind, status = created.Status, cycleRegion = created.CycleRegion,
                posX = created.PosX, posY = created.PosY,
                inPorts = created.InPorts, outPorts = created.OutPorts
            },
            hint
        });
    }

    /// <summary>改节点的接线口数量。已有连线占用的口不能删（否则线会指向不存在的口）。</summary>
    public static ApiResult UpdatePorts(string nodeId, PortsRequest req)
    {
        using var c = ProtoDb.Open();
        var node = ReadNode(c, nodeId);
        if (node is null) return ApiResult.Fail(404, Reasons.NodeNotFound, $"节点 {nodeId} 不存在");

        var inPorts = req.InPorts ?? node.InPorts;
        var outPorts = req.OutPorts ?? node.OutPorts;
        if (inPorts < 1 || inPorts > MaxPorts || outPorts < 1 || outPorts > MaxPorts)
            return ApiResult.Fail(400, Reasons.PortOutOfRange, $"进出端口数只能是 1–{MaxPorts}，收到 进 {inPorts} / 出 {outPorts}");

        var maxIn = Convert.ToInt32(Scalar(c, "SELECT COALESCE(MAX(to_port),-1) FROM edges WHERE to_node_id=@n AND kind='transfer'", ("@n", nodeId)));
        var maxOut = Convert.ToInt32(Scalar(c, "SELECT COALESCE(MAX(from_port),-1) FROM edges WHERE from_node_id=@n AND kind='transfer'", ("@n", nodeId)));
        if (inPorts <= maxIn)
            return ApiResult.Fail(409, Reasons.PortInUse, $"还有线挂在这节点的第 {maxIn + 1} 个进线口上，进线口至少要 {maxIn + 1} 个");
        if (outPorts <= maxOut)
            return ApiResult.Fail(409, Reasons.PortInUse, $"还有线挂在这节点的第 {maxOut + 1} 个出线口上，出线口至少要 {maxOut + 1} 个");

        Exec(c, "UPDATE nodes SET in_ports=@ip, out_ports=@op, updated_at_utc=@now WHERE id=@id",
            ("@ip", inPorts), ("@op", outPorts), ("@now", Now()), ("@id", nodeId));
        Event(c, node.TaskId, nodeId, "ports", "api", $"端口数 进 {node.InPorts}→{inPorts} / 出 {node.OutPorts}→{outPorts}");
        return ApiResult.Ok(new { nodeId, inPorts, outPorts });
    }

    /// <summary>
    /// 右键多选建节点组：纯视觉分组，不进门、不参与执行、不改任何判定。
    /// 一个节点只属于一个组（再建会把它从旧组挪出来）。
    /// </summary>
    public static ApiResult CreateNodeGroup(string taskId, NodeGroupSpec req, string by)
    {
        using var c = ProtoDb.Open();
        if (Scalar(c, "SELECT id FROM tasks WHERE id=@id", ("@id", taskId)) is null)
            return ApiResult.Fail(404, Reasons.TaskNotFound, $"任务 {taskId} 不存在");

        var ids = (req.NodeIds ?? [])
            .Where(i => !string.IsNullOrWhiteSpace(i)).Select(i => i!.Trim())
            .Distinct().ToList();
        if (ids.Count < 2)
            return ApiResult.Fail(400, Reasons.NodeGroupNeedsTwo, $"节点组至少两个节点，收到 {ids.Count} 个");

        var rows = new List<NodeRow>();
        foreach (var id in ids)
        {
            var n = ReadNode(c, id);
            if (n is null || n.TaskId != taskId)
                return ApiResult.Fail(400, Reasons.UnknownNode, $"节点 {id} 不在这个任务里");
            rows.Add(n);
        }

        var title = (req.Title ?? "").Trim();
        if (title.Length == 0) title = $"组 {ReadNodeGroups(c, taskId).Count + 1}";
        if (title.Length > 60) return ApiResult.Fail(400, Reasons.TitleTooLong, $"组名最长 60 字，当前 {title.Length} 字");

        var groupId = string.IsNullOrWhiteSpace(req.Id) ? "grp_" + Guid.NewGuid().ToString("N")[..10] : req.Id!.Trim();
        if (Scalar(c, "SELECT id FROM node_groups WHERE id=@id", ("@id", groupId)) is not null)
            return ApiResult.Fail(409, "node-group-exists", $"节点组 {groupId} 已存在");

        using var tx = c.BeginTransaction();
        Exec(c, "INSERT INTO node_groups(id,task_id,title,created_at_utc) VALUES(@id,@t,@title,@now)",
            ("@id", groupId), ("@t", taskId), ("@title", title), ("@now", Now()));
        foreach (var n in rows)
            Exec(c, "UPDATE nodes SET group_id=@g, updated_at_utc=@now WHERE id=@id",
                ("@g", groupId), ("@now", Now()), ("@id", n.Id));
        tx.Commit();

        Event(c, taskId, null, "node-group-create", by,
            $"建节点组「{title}」：{string.Join("、", rows.Select(n => n.Title))}");
        return ApiResult.Created(new { id = groupId, title, nodeIds = rows.Select(n => n.Id).ToArray() });
    }

    /// <summary>
    /// 单个节点收纳：0=完整卡片，1=只留标题，2=只留关键字（一行目标）。纯看图状态，不写 events。
    /// 存的是「显示级别」而不是布尔——保留成 0/1/2 才够以后再加「只留状态」之类的一档。
    /// </summary>
    public static ApiResult SetNodeCompact(string nodeId, CompactRequest req)
    {
        using var c = ProtoDb.Open();
        var node = ReadNode(c, nodeId);
        if (node is null) return ApiResult.Fail(404, Reasons.NodeNotFound, $"节点 {nodeId} 不存在");
        var level = req.Level ?? (req.Collapsed == true ? 1 : 0);
        if (level < 0 || level > 2)
            return ApiResult.Fail(400, Reasons.BadRequest, $"收纳级别只能是 0（完整）/1（仅标题）/2（仅关键字），收到 {level}");
        Exec(c, "UPDATE nodes SET compact=@v, updated_at_utc=@now WHERE id=@id",
            ("@v", level), ("@now", Now()), ("@id", nodeId));
        return ApiResult.Ok(new { nodeId, compact = level, title = node.Title });
    }

    /// <summary>收纳/展开一个组。这是纯看图状态（跟坐标、口数一类），不写 events。</summary>
    public static ApiResult SetGroupCollapsed(string groupId, CollapseRequest req)
    {
        using var c = ProtoDb.Open();
        var title = Scalar(c, "SELECT title FROM node_groups WHERE id=@id", ("@id", groupId)) as string;
        if (title is null) return ApiResult.Fail(404, Reasons.NodeGroupNotFound, $"节点组 {groupId} 不存在");
        var collapsed = req.Collapsed ?? true;
        Exec(c, "UPDATE node_groups SET collapsed=@v WHERE id=@id", ("@v", collapsed ? 1 : 0), ("@id", groupId));
        return ApiResult.Ok(new { id = groupId, title, collapsed });
    }

    /// <summary>
    /// 删节点组，两种口径：
    /// ① 只解散（withNodes=false）——节点全留；
    /// ② 连节点一起删（withNodes=true）——**要么全删、要么一个都不动**：组里只要有一个删不起
    ///    （不是 pending、或还挂着线），整批拒绝并点名是谁，不做「删了一半」这种事。
    /// </summary>
    public static ApiResult DeleteNodeGroup(string groupId, string by, bool withNodes)
    {
        using var c = ProtoDb.Open();
        var title = Scalar(c, "SELECT title FROM node_groups WHERE id=@id", ("@id", groupId)) as string;
        if (title is null) return ApiResult.Fail(404, Reasons.NodeGroupNotFound, $"节点组 {groupId} 不存在");
        var taskId = Scalar(c, "SELECT task_id FROM node_groups WHERE id=@id", ("@id", groupId)) as string;

        var members = ReadNodes(c, taskId!).Where(n => n.GroupId == groupId).ToList();

        // 循环区由组承载：一个组还是循环区时不能直接删——先撤循环（删回边与上限）
        if (ReadCycleByGroup(c, groupId) is not null)
            return ApiResult.Fail(409, "group-is-loop",
                $"节点组「{title}」是循环区（有回边与轮次上限）；先「撤销循环」把它变回普通组，再删组");

        if (!withNodes)
        {
            using var tx0 = c.BeginTransaction();
            Exec(c, "UPDATE nodes SET group_id=NULL WHERE group_id=@g", ("@g", groupId));
            Exec(c, "DELETE FROM node_groups WHERE id=@id", ("@id", groupId));
            tx0.Commit();

            Event(c, taskId, null, "node-group-delete", by, $"解散节点组「{title}」（{members.Count} 个节点留着）");
            return ApiResult.Ok(new { deleted = groupId, released = members.Count, nodesDeleted = 0 });
        }

        var blocked = new List<string>();
        foreach (var n in members)
        {
            if (n.Status != "pending") { blocked.Add($"「{n.Title}」已是 {n.Status}"); continue; }
            var edges = Convert.ToInt32(Scalar(c,
                "SELECT COUNT(*) FROM edges WHERE task_id=@t AND (from_node_id=@n OR to_node_id=@n)",
                ("@t", taskId), ("@n", n.Id)));
            if (edges > 0) blocked.Add($"「{n.Title}」还挂着 {edges} 条线");
        }
        if (blocked.Count > 0)
            return ApiResult.Fail(409, Reasons.NodeGroupNotDeletable,
                $"组里还有删不起的节点，整批没动：{string.Join("；", blocked)}");

        using var tx = c.BeginTransaction();
        foreach (var n in members)
        {
            Exec(c, "DELETE FROM input_groups WHERE node_id=@n", ("@n", n.Id));
            Exec(c, "DELETE FROM nodes WHERE id=@n", ("@n", n.Id));
        }
        Exec(c, "DELETE FROM node_groups WHERE id=@id", ("@id", groupId));
        tx.Commit();

        Event(c, taskId, null, "node-group-delete-with-nodes", by,
            $"删掉节点组「{title}」连同 {members.Count} 个节点（{string.Join("、", members.Select(n => n.Title))}）");
        return ApiResult.Ok(new { deleted = groupId, released = 0, nodesDeleted = members.Count });
    }

    /// <summary>
    /// 点节点改属性：标题 / 一行目标 / 类型 / 循环区，给哪几项改哪几项。
    /// 拒绝文案与建节点同一套；换循环区要先断线（否则回边语义会错），组内嵌不改流程。
    /// </summary>
    public static ApiResult UpdateNode(string nodeId, NodePatchRequest req, string by)
    {
        using var c = ProtoDb.Open();
        var node = ReadNode(c, nodeId);
        if (node is null) return ApiResult.Fail(404, Reasons.NodeNotFound, $"节点 {nodeId} 不存在");

        var diffs = new List<string>();

        var title = node.Title;
        if (req.Title is not null)
        {
            title = req.Title.Trim();
            if (title.Length == 0) return ApiResult.Fail(400, Reasons.TitleRequired, "标题不能改成空（一句白话，别写代号）");
            if (title.Length > 120) return ApiResult.Fail(400, Reasons.TitleTooLong, $"标题最长 120 字，当前 {title.Length} 字");
            if (title != node.Title) diffs.Add($"标题「{node.Title}」→「{title}」");
        }

        var goal = node.GoalLine;
        if (req.GoalLine is not null)
        {
            goal = req.GoalLine.Trim();
            if (goal != node.GoalLine) diffs.Add("改了一行目标");
        }

        var kind = node.Kind;
        if (req.Kind is not null)
        {
            kind = req.Kind.Trim();
            if (!NodeKinds.Contains(kind))
                return ApiResult.Fail(400, Reasons.KindInvalid, $"kind 只能是 work / review_auto / review_human，收到 {kind}");
            if (kind != node.Kind) diffs.Add($"类型 {node.Kind} → {kind}");
        }

        var region = node.CycleRegion;
        if (req.CycleRegion is not null)
        {
            return ApiResult.Fail(400, Reasons.BadRequest,
                "循环区不再挂在节点上：把节点圈进一个组，再给那个组声明循环（组＋回边＋检查点＝循环区）");
        }

        if (diffs.Count == 0)
            return ApiResult.Ok(new { node = NodeDto(node), changed = Array.Empty<string>() });

        Exec(c, "UPDATE nodes SET title=@title, goal_line=@g, kind=@k, cycle_region=@r, updated_at_utc=@now WHERE id=@id",
            ("@title", title), ("@g", goal), ("@k", kind), ("@r", region), ("@now", Now()), ("@id", nodeId));
        Event(c, node.TaskId, nodeId, "node-update", by, string.Join("；", diffs));
        return ApiResult.Ok(new { node = NodeDto(ReadNode(c, nodeId)!), changed = diffs });
    }

    /// <summary>
    /// 画布没有边缘上限：位置就是世界坐标，可负、可一直往外交，画布多大「随当前情况而定」
    /// （有多少节点、摆在哪，它就是多大）。这里只兜掉明显是手抖/垃圾的值（防溢出与算不出来的曲线），
    /// 不是画布边界——别把它当「最多能拖这么远」来用。
    /// </summary>
    private const int PosGuard = 1_000_000;

    private static int FreePos(int v) => v < -PosGuard ? -PosGuard : v > PosGuard ? PosGuard : v;

    /// <summary>拖动后落坐标。画布位置是展示状态，不是业务流程，所以不写 events。</summary>
    public static ApiResult MoveNode(string nodeId, MoveRequest req)
    {
        using var c = ProtoDb.Open();
        if (ReadNode(c, nodeId) is null)
            return ApiResult.Fail(404, Reasons.NodeNotFound, $"节点 {nodeId} 不存在");
        if (req.X is null || req.Y is null)
            return ApiResult.Fail(400, Reasons.BadRequest, "x 与 y 都要给");

        var x = FreePos(req.X.Value);
        var y = FreePos(req.Y.Value);
        Exec(c, "UPDATE nodes SET pos_x=@x, pos_y=@y, updated_at_utc=@now WHERE id=@id",
            ("@x", x), ("@y", y), ("@now", Now()), ("@id", nodeId));
        return ApiResult.Ok(new { nodeId, posX = x, posY = y });
    }

    /// <summary>批量落坐标：框选一起拖动时一次写完，不用 N 次往返。</summary>
    public static ApiResult MoveNodes(string taskId, MoveBatchRequest req)
    {
        using var c = ProtoDb.Open();
        if (Scalar(c, "SELECT id FROM tasks WHERE id=@id", ("@id", taskId)) is null)
            return ApiResult.Fail(404, Reasons.TaskNotFound, $"任务 {taskId} 不存在");
        var items = req.Nodes ?? [];
        if (items.Length == 0) return ApiResult.Fail(400, Reasons.BadRequest, "nodes 不能为空");
        if (items.Length > 500) return ApiResult.Fail(400, Reasons.BadRequest, "一次最多挪 500 个节点");

        foreach (var item in items)
        {
            if (string.IsNullOrWhiteSpace(item.Id)) return ApiResult.Fail(400, Reasons.BadRequest, "每项都要有节点 id");
            var node = ReadNode(c, item.Id!);
            if (node is null || node.TaskId != taskId)
                return ApiResult.Fail(404, Reasons.NodeNotFound, $"节点 {item.Id} 不在这个任务里");
            if (item.X is null || item.Y is null)
                return ApiResult.Fail(400, Reasons.BadRequest, $"节点 {item.Id} 缺 x/y");
        }

        using var tx = c.BeginTransaction();
        var moved = 0;
        foreach (var item in items)
        {
            Exec(c, "UPDATE nodes SET pos_x=@x, pos_y=@y, updated_at_utc=@now WHERE id=@id",
                ("@x", FreePos(item.X!.Value)), ("@y", FreePos(item.Y!.Value)),
                ("@now", Now()), ("@id", item.Id));
            moved++;
        }
        tx.Commit();
        return ApiResult.Ok(new { moved });
    }

    /// <summary>
    /// 新建一条连线。规则与建图一致：两端必须同任务且存在、方向必填、
    /// (task,from,to,kind,target_step,graph_version) 判重、自环必须落进已声明的循环区。
    /// 画线后由程序生成/追加输入规则组（09 表二的自动生成约定）。
    /// </summary>
    public static ApiResult AddEdge(string taskId, EdgeSpec req, string by)
    {
        using var c = ProtoDb.Open();
        // 一行连线要牵出：边 + 输入规则组 + 放行记录 + 起步 + 两条留痕。半写进去的图比失败更难收拾
        using var batch = new WriteBatch(c);
        if (Scalar(c, "SELECT id FROM tasks WHERE id=@id", ("@id", taskId)) is null)
            return ApiResult.Fail(404, Reasons.TaskNotFound, $"任务 {taskId} 不存在");
        if (string.IsNullOrWhiteSpace(req.From) || string.IsNullOrWhiteSpace(req.To))
            return ApiResult.Fail(400, Reasons.BadRequest, "from 与 to 必填（连线有方向，不猜）");

        var from = ReadNode(c, req.From!);
        var to = ReadNode(c, req.To!);
        if (from is null || from.TaskId != taskId)
            return ApiResult.Fail(400, Reasons.UnknownNode, $"起点节点 {req.From} 不在这个任务里");
        if (to is null || to.TaskId != taskId)
            return ApiResult.Fail(400, Reasons.UnknownNode, $"终点节点 {req.To} 不在这个任务里");

        var kind = string.IsNullOrWhiteSpace(req.Kind) ? "transfer" : req.Kind!.Trim();
        if (!EdgeKinds.Contains(kind))
            return ApiResult.Fail(400, Reasons.KindInvalid, $"边的 kind 只能是 transfer / loop，收到 {kind}");

        var edgeId = string.IsNullOrWhiteSpace(req.Id) ? "ed_" + Guid.NewGuid().ToString("N")[..10] : req.Id!.Trim();
        if (Scalar(c, "SELECT id FROM edges WHERE id=@id", ("@id", edgeId)) is not null)
            return ApiResult.Fail(409, Reasons.EdgeDuplicate, $"边 id {edgeId} 已存在");

        var fromPort = kind == "transfer" ? (req.FromPort ?? 0) : 0;
        var toPort = kind == "transfer" ? (req.ToPort ?? 0) : 0;
        if (fromPort < 0 || fromPort >= from.OutPorts)
            return ApiResult.Fail(400, Reasons.PortOutOfRange, $"「{from.Title}」只有 {from.OutPorts} 个出线口，取不到第 {fromPort + 1} 个");
        if (toPort < 0 || toPort >= to.InPorts)
            return ApiResult.Fail(400, Reasons.PortOutOfRange, $"「{to.Title}」只有 {to.InPorts} 个进线口，取不到第 {toPort + 1} 个");

        var dup = Scalar(c,
            "SELECT id FROM edges WHERE task_id=@t AND from_node_id=@f AND to_node_id=@to AND kind=@k AND target_step_id='' AND graph_version=1",
            ("@t", taskId), ("@f", from.Id), ("@to", to.Id), ("@k", kind)) as string;
        if (dup is not null)
            return ApiResult.Fail(409, Reasons.EdgeDuplicate, $"这条线已经有了（{dup}）：同起点、同终点、同用途的同一条线不重复建");

        CycleRow? cycle = null;
        if (from.Id == to.Id && kind != "loop")
            return ApiResult.Fail(409, Reasons.LoopNeedsCycle, "自己连自己只能连成回边（kind=loop）并落进已声明的循环区，普通传递线不许自环");

        if (kind == "loop")
        {
            // 循环区＝节点组：两端必须在同一个组里，而且那个组已经声明成循环区
            if (string.IsNullOrWhiteSpace(from.GroupId) || from.GroupId != to.GroupId)
                return ApiResult.Fail(409, Reasons.LoopNeedsCycle,
                    $"回边两端要在同一个节点组里（起点组 {from.GroupId ?? "无"} / 终点组 {to.GroupId ?? "无"}）——先把它们圈进同一个组");
            cycle = ReadCycleByGroup(c, from.GroupId!);
            if (cycle is null)
                return ApiResult.Fail(409, Reasons.LoopNeedsCycle,
                    $"节点组「{GroupTitle(c, from.GroupId!) ?? from.GroupId}」还不是循环区：先给它声明头/尾与上限（组＋回边＋检查点＝循环区）");
            if (cycle.HeadNodeId != to.Id || cycle.TailNodeId != from.Id)
                return ApiResult.Fail(409, Reasons.LoopNeedsCycle,
                    $"这个循环区的头是 {cycle.HeadNodeId}、尾是 {cycle.TailNodeId}，回边只能 {cycle.TailNodeId} → {cycle.HeadNodeId}");
        }

        var gate = string.IsNullOrWhiteSpace(req.Gate) ? "auto" : req.Gate!.Trim();
        if (!EdgeGates.Contains(gate))
            return ApiResult.Fail(400, Reasons.BadRequest, $"门控只有 auto（上游做完就放行）/ human（还要人点头）两种，收到 {gate}");

        Exec(c, "INSERT INTO edges(id,task_id,from_node_id,to_node_id,kind,transfer_condition,target_step_id,from_port,to_port,gate,gate_note,graph_version) VALUES(@id,@t,@f,@to,@k,'auto','',@fp,@tp,@gate,@note,1)",
            ("@id", edgeId), ("@t", taskId), ("@f", from.Id), ("@to", to.Id), ("@k", kind), ("@fp", fromPort), ("@tp", toPort),
            ("@gate", gate), ("@note", (req.GateNote ?? "").Trim()));

        string? groupId = null;
        var groupCreated = false;
        var groupItems = new List<string>();
        var activated = new List<string>();

        if (kind == "transfer")
        {
            var group = ReadGroup(c, to.Id);
            if (group is null)
            {
                // 画线前这个节点是「隐式全等」，建组时要把已有入边一并纳进来，不能只放新线
                groupId = "grp_" + Guid.NewGuid().ToString("N")[..10];
                var existing = ReadEdges(c, taskId).Where(e => e.ToNodeId == to.Id && e.Kind == "transfer" && e.Id != edgeId).Select(e => e.Id).ToList();
                groupItems = existing.Append(edgeId).ToList();
                Exec(c, "INSERT INTO input_groups(id,task_id,node_id,mode,need_count,items_json) VALUES(@id,@t,@n,'all',0,@items)",
                    ("@id", groupId), ("@t", taskId), ("@n", to.Id), ("@items", JsonSerializer.Serialize(groupItems)));
                groupCreated = true;
                Event(c, taskId, to.Id, "group-create", by, $"画线自动生成输入规则组（all，{groupItems.Count} 条入边）");
            }
            else
            {
                groupId = group.Id;
                groupItems = group.Items.ToList();
                if (!groupItems.Contains(edgeId))
                {
                    groupItems.Add(edgeId);
                    Exec(c, "UPDATE input_groups SET items_json=@items WHERE id=@id",
                        ("@items", JsonSerializer.Serialize(groupItems)), ("@id", group.Id));
                }
                Event(c, taskId, to.Id, "group-append", by, $"新线并入规则组 {group.Id}（{group.Mode}，{groupItems.Count} 条）");
            }
            // 上游早就完工（材料已在手）：新线立刻放行，别让下游白等一条已经存在的产物
            var freshTarget = ReadNode(c, to.Id)!;
            if (from.Status == "approved")
            {
                var edgeRow = new EdgeRow
                {
                    Id = edgeId, TaskId = taskId, FromNodeId = from.Id, ToNodeId = to.Id,
                    Kind = kind, TransferCondition = "auto", TargetStepId = "", GraphVersion = 1,
                    Gate = gate, GateNote = (req.GateNote ?? "").Trim()
                };
                TryRelease(c, edgeRow, freshTarget, by);
            }
            activated = Settle(c, freshTarget, by);
        }
        else
        {
            Event(c, taskId, to.Id, "cycle-edge", by, $"回边 {from.Id} → {to.Id} 接入循环区 {cycle!.RegionKey}（上限 {cycle.LimitCount}）");
        }

        Event(c, taskId, to.Id, "edge-create", by, $"{kind} 线 {from.Id} → {to.Id}");
        batch.Commit();
        return ApiResult.Created(new
        {
            edge = new { id = edgeId, fromNodeId = from.Id, toNodeId = to.Id, kind, fromPort, toPort, targetStepId = "", graphVersion = 1 },
            groupId, groupCreated, groupItems, activated,
            cycle = cycle is null ? null : new { id = cycle.Id, groupId = cycle.GroupId, regionKey = cycle.RegionKey, limit = cycle.LimitCount }
        });
    }

    private static EdgeRow? ReadEdge(SqliteConnection c, string edgeId)
    {
        var taskId = Scalar(c, "SELECT task_id FROM edges WHERE id=@id", ("@id", edgeId)) as string;
        if (taskId is null) return null;
        return ReadEdges(c, taskId).FirstOrDefault(e => e.Id == edgeId);
    }

    private static object EdgeDto(SqliteConnection c, EdgeRow e)
    {
        var from = ReadNode(c, e.FromNodeId);
        var to = ReadNode(c, e.ToNodeId);
        return new
        {
            id = e.Id, taskId = e.TaskId,
            fromNodeId = e.FromNodeId, fromTitle = from?.Title, fromStatus = from?.Status, fromOutPorts = from?.OutPorts ?? 1,
            toNodeId = e.ToNodeId, toTitle = to?.Title, toStatus = to?.Status, toInPorts = to?.InPorts ?? 1,
            kind = e.Kind, fromPort = e.FromPort, toPort = e.ToPort, graphVersion = e.GraphVersion,
            gate = e.Gate, gateNote = e.GateNote,
            gateConfirmedBy = e.GateConfirmedBy, gateConfirmedAt = e.GateConfirmedAt,
            // 这条线上已经有放行记录？有就不允许改走向（别让流过去的材料凭空改道）
            released = Convert.ToInt32(Scalar(c, "SELECT COUNT(*) FROM releases WHERE edge_id=@id", ("@id", e.Id))) > 0
        };
    }

    /// <summary>读一条连线（点连线时右栏面板用）。</summary>
    public static ApiResult GetEdge(string edgeId)
    {
        using var c = ProtoDb.Open();
        var e = ReadEdge(c, edgeId);
        if (e is null) return ApiResult.Fail(404, "edge-not-found", $"连线 {edgeId} 不存在");
        return ApiResult.Ok(new { edge = EdgeDto(c, e) });
    }

    /// <summary>
    /// 改一条连线：走向 / 类型 / 挂哪两个口 / 门控。已经放过行的线只允许改门控与备注
    /// （改走向会让“已经流过去的东西”失去来源，得删掉重连）。
    /// </summary>
    public static ApiResult UpdateEdge(string edgeId, EdgePatchRequest req, string by)
    {
        using var c = ProtoDb.Open();
        var edge = ReadEdge(c, edgeId);
        if (edge is null) return ApiResult.Fail(404, "edge-not-found", $"连线 {edgeId} 不存在");

        var released = Convert.ToInt32(Scalar(c, "SELECT COUNT(*) FROM releases WHERE edge_id=@id", ("@id", edgeId))) > 0;

        var newFromId = string.IsNullOrWhiteSpace(req.From) ? edge.FromNodeId : req.From!.Trim();
        var newToId = string.IsNullOrWhiteSpace(req.To) ? edge.ToNodeId : req.To!.Trim();
        var newKind = string.IsNullOrWhiteSpace(req.Kind) ? edge.Kind : req.Kind!.Trim();
        var rewire = newFromId != edge.FromNodeId || newToId != edge.ToNodeId || newKind != edge.Kind;
        if (rewire && released)
            return ApiResult.Fail(409, "edge-already-released", "这条线上已经有放行记录（材料流过去了），不能改走向或类型；要改就删掉重连");

        if (!EdgeKinds.Contains(newKind))
            return ApiResult.Fail(400, Reasons.KindInvalid, $"边的 kind 只能是 transfer / loop，收到 {newKind}");

        var newFrom = ReadNode(c, newFromId);
        var newTo = ReadNode(c, newToId);
        if (newFrom is null || newFrom.TaskId != edge.TaskId)
            return ApiResult.Fail(400, Reasons.UnknownNode, $"起点节点 {newFromId} 不在这个任务里");
        if (newTo is null || newTo.TaskId != edge.TaskId)
            return ApiResult.Fail(400, Reasons.UnknownNode, $"终点节点 {newToId} 不在这个任务里");

        var dup = Scalar(c,
            "SELECT id FROM edges WHERE task_id=@t AND id<>@id AND from_node_id=@f AND to_node_id=@to AND kind=@k AND target_step_id='' AND graph_version=1",
            ("@t", edge.TaskId), ("@id", edgeId), ("@f", newFrom.Id), ("@to", newTo.Id), ("@k", newKind)) as string;
        if (dup is not null)
            return ApiResult.Fail(409, Reasons.EdgeDuplicate, $"这条线已经有了（{dup}），同一条线不会因为再画一次变成两份输入");

        if (newKind == "transfer" && newFrom.Id == newTo.Id)
            return ApiResult.Fail(409, Reasons.LoopNeedsCycle, "普通传递线不许自环；自己连自己要连成回边");

        CycleRow? cycle = null;
        if (newKind == "loop")
        {
            if (string.IsNullOrWhiteSpace(newFrom.GroupId) || newFrom.GroupId != newTo.GroupId)
                return ApiResult.Fail(409, Reasons.LoopNeedsCycle,
                    $"回边两端要在同一个节点组里（起点组 {newFrom.GroupId ?? "无"} / 终点组 {newTo.GroupId ?? "无"}）");
            cycle = ReadCycleByGroup(c, newFrom.GroupId!);
            if (cycle is null)
                return ApiResult.Fail(409, Reasons.LoopNeedsCycle, $"节点组「{GroupTitle(c, newFrom.GroupId!) ?? newFrom.GroupId}」还不是循环区");
            if (cycle.HeadNodeId != newTo.Id || cycle.TailNodeId != newFrom.Id)
                return ApiResult.Fail(409, Reasons.LoopNeedsCycle,
                    $"回边只能 {cycle.TailNodeId} → {cycle.HeadNodeId}（这个循环区的头尾）");
        }

        var fromPort = newKind == "transfer" ? (req.FromPort ?? edge.FromPort) : 0;
        var toPort = newKind == "transfer" ? (req.ToPort ?? edge.ToPort) : 0;
        if (fromPort < 0 || fromPort >= newFrom.OutPorts)
            return ApiResult.Fail(400, Reasons.PortOutOfRange, $"「{newFrom.Title}」只有 {newFrom.OutPorts} 个出线口，取不到第 {fromPort + 1} 个");
        if (toPort < 0 || toPort >= newTo.InPorts)
            return ApiResult.Fail(400, Reasons.PortOutOfRange, $"「{newTo.Title}」只有 {newTo.InPorts} 个进线口，取不到第 {toPort + 1} 个");

        var gate = string.IsNullOrWhiteSpace(req.Gate) ? edge.Gate : req.Gate!.Trim();
        if (!EdgeGates.Contains(gate))
            return ApiResult.Fail(400, Reasons.BadRequest, $"门控只有 auto / human 两种，收到 {gate}");
        // 已经放行过就别事后加闸门：材料都过去了，这时候挂个「待确认」是假账
        if (gate == "human" && edge.Gate != "human" && released)
            return ApiResult.Fail(409, "edge-already-released", "这条线已经放行过（材料过去了），事后加人工门控没有意义；要闸门就在上游做完之前挂");
        var gateNote = req.GateNote is null ? edge.GateNote : req.GateNote.Trim();
        var keepConfirm = gate == "human" && !string.IsNullOrEmpty(edge.GateConfirmedBy);

        var diffs = new List<string>();
        if (rewire) diffs.Add($"{newFrom.Title} → {newTo.Title}（{newKind}）");
        if (fromPort != edge.FromPort || toPort != edge.ToPort) diffs.Add($"端口 {edge.FromPort + 1}→{fromPort + 1} / {edge.ToPort + 1}→{toPort + 1}");
        if (gate != edge.Gate) diffs.Add($"门控 {edge.Gate} → {gate}");
        if (gateNote != edge.GateNote) diffs.Add("改了门控备注");

        using var tx = c.BeginTransaction();
        Exec(c, "UPDATE edges SET from_node_id=@f, to_node_id=@to, kind=@k, from_port=@fp, to_port=@tp, gate=@g, gate_note=@n, " +
                "gate_confirmed_by=@cb, gate_confirmed_at_utc=@ca WHERE id=@id",
            ("@f", newFrom.Id), ("@to", newTo.Id), ("@k", newKind), ("@fp", fromPort), ("@tp", toPort),
            ("@g", gate), ("@n", gateNote),
            ("@cb", keepConfirm ? edge.GateConfirmedBy : null), ("@ca", keepConfirm ? edge.GateConfirmedAt : null),
            ("@id", edgeId));
        if (rewire)
        {
            // 换了走向：两头的规则组按现存入边重算，组里不能留着已经不存在的边
            RebuildGroupItems(c, edge.TaskId, edge.ToNodeId);
            RebuildGroupItems(c, edge.TaskId, newTo.Id);
        }
        tx.Commit();

        // 门控刚放开（human→auto 或刚确认过）：上游已完工就顺手补一次放行
        var fresh = ReadEdge(c, edgeId)!;
        var activated = new List<string>();
        if (fresh.Kind == "transfer")
        {
            var fromNode = ReadNode(c, fresh.FromNodeId)!;
            var toNode = ReadNode(c, fresh.ToNodeId)!;
            if (IsResolved(fromNode.Status) && TryRelease(c, fresh, toNode, by)) activated = Settle(c, toNode, by);
        }

        if (diffs.Count > 0) Event(c, edge.TaskId, fresh.ToNodeId, "edge-update", by, $"改连线 {edgeId}：" + string.Join("；", diffs));
        return ApiResult.Ok(new { edge = EdgeDto(c, fresh), changed = diffs, activated });
    }

    /// <summary>
    /// 人工门控点头：给这条线盖章，然后立刻按门判定（上游已完工的话下游就能起来）。
    /// 章是按边盖的，不按轮次——原型阶段先这么定，循环里重复放行仍由 releases 唯一键保证幂等。
    /// </summary>
    public static ApiResult ConfirmEdgeGate(string edgeId, ByRequest req, string by)
    {
        using var c = ProtoDb.Open();
        var edge = ReadEdge(c, edgeId);
        if (edge is null) return ApiResult.Fail(404, "edge-not-found", $"连线 {edgeId} 不存在");
        if (edge.Gate != "human")
            return ApiResult.Fail(400, Reasons.BadRequest, "这条线是 auto 门控，不需要人点头（想加闸门先把门控改成 human）");

        var who = string.IsNullOrWhiteSpace(req.By) ? by : req.By!.Trim();
        Exec(c, "UPDATE edges SET gate_confirmed_by=@by, gate_confirmed_at_utc=@at WHERE id=@id",
            ("@by", who), ("@at", Now()), ("@id", edgeId));
        Event(c, edge.TaskId, edge.ToNodeId, "edge-gate-confirm", who,
            $"人工门控已确认：{edge.FromNodeId} → {edge.ToNodeId}" + (string.IsNullOrWhiteSpace(req.Reason) ? "" : $"（{req.Reason}）"));

        var fresh = ReadEdge(c, edgeId)!;
        var activated = new List<string>();
        if (fresh.Kind == "transfer")
        {
            var fromNode = ReadNode(c, fresh.FromNodeId)!;
            var toNode = ReadNode(c, fresh.ToNodeId)!;
            if (IsResolved(fromNode.Status) && TryRelease(c, fresh, toNode, who)) activated = Settle(c, toNode, who);
        }
        return ApiResult.Ok(new { edge = EdgeDto(c, fresh), activated });
    }

    /// <summary>删连线：已经有放行记录的不许删（材料流过去了，删掉会让下游来源消失）。</summary>
    public static ApiResult DeleteEdge(string edgeId, string by)
    {
        using var c = ProtoDb.Open();
        var edge = ReadEdge(c, edgeId);
        if (edge is null) return ApiResult.Fail(404, "edge-not-found", $"连线 {edgeId} 不存在");
        if (Convert.ToInt32(Scalar(c, "SELECT COUNT(*) FROM releases WHERE edge_id=@id", ("@id", edgeId))) > 0)
            return ApiResult.Fail(409, "edge-already-released", "这条线已经放过行（下游拿到过材料），删它会让那段历史失去来源；原型里不允许");

        using var batch = new WriteBatch(c);
        Exec(c, "DELETE FROM edges WHERE id=@id", ("@id", edgeId));
        RebuildGroupItems(c, edge.TaskId, edge.ToNodeId);
        Event(c, edge.TaskId, edge.ToNodeId, "edge-delete", by, $"删连线 {edge.FromNodeId} → {edge.ToNodeId}（{edge.Kind}）");
        batch.Commit();
        return ApiResult.Ok(new { deleted = edgeId });
    }

    /// <summary>把某个目标节点的输入规则组条目按现存入边重算（改接/删线之后用）。</summary>
    private static void RebuildGroupItems(SqliteConnection c, string taskId, string nodeId)    {
        var group = ReadGroup(c, nodeId);
        if (group is null) return;
        var items = ReadEdges(c, taskId).Where(e => e.ToNodeId == nodeId && e.Kind == "transfer").Select(e => e.Id).ToList();
        if (items.Count == 0)
        {
            Exec(c, "DELETE FROM input_groups WHERE id=@id", ("@id", group.Id));
            return;
        }
        var chosen = group.ChosenEdgeId is not null && items.Contains(group.ChosenEdgeId) ? group.ChosenEdgeId : null;
        Exec(c, "UPDATE input_groups SET items_json=@items, chosen_edge_id=@ch WHERE id=@id",
            ("@items", JsonSerializer.Serialize(items)), ("@ch", chosen), ("@id", group.Id));
    }

    /// <summary>把一个组声明成循环区：组 + 回边 + 检查点(上限) 三件套一次配齐，回边由 tail→head 自动建。</summary>
    public static ApiResult DeclareLoop(string groupId, LoopSpecRequest req, string by)
    {
        using var c = ProtoDb.Open();
        var title = GroupTitle(c, groupId);
        if (title is null) return ApiResult.Fail(404, Reasons.NodeGroupNotFound, $"节点组 {groupId} 不存在");
        var taskId = Scalar(c, "SELECT task_id FROM node_groups WHERE id=@id", ("@id", groupId)) as string;

        if (string.IsNullOrWhiteSpace(req.Head) || string.IsNullOrWhiteSpace(req.Tail))
            return ApiResult.Fail(400, Reasons.BadRequest, "head 与 tail 必填（谁是循环的头、谁是尾，不猜）");
        var head = ReadNode(c, req.Head!);
        var tail = ReadNode(c, req.Tail!);
        if (head is null || head.TaskId != taskId) return ApiResult.Fail(400, Reasons.UnknownNode, $"head 节点 {req.Head} 不在这个任务里");
        if (tail is null || tail.TaskId != taskId) return ApiResult.Fail(400, Reasons.UnknownNode, $"tail 节点 {req.Tail} 不在这个任务里");
        if (head.GroupId != groupId || tail.GroupId != groupId)
            return ApiResult.Fail(400, "loop-node-not-in-group", $"head/tail 必须都是这个组的成员（组「{title}」）");

        var existing = ReadCycleByGroup(c, groupId);
        if (existing is not null)
            return ApiResult.Fail(409, "cycle-exists", $"节点组「{title}」已经是循环区（{existing.Id}）；上限要改走 /api/cycles/{existing.Id}/raise");

        var limit = req.Limit ?? 3;
        if (limit < 1) return ApiResult.Fail(400, Reasons.BadRequest, "上限至少 1");
        var limitKind = string.IsNullOrWhiteSpace(req.LimitKind) ? "bounded" : req.LimitKind!.Trim();
        var cycleId = "cyc_" + Guid.NewGuid().ToString("N")[..10];

        using (var tx = c.BeginTransaction())
        {
            Exec(c, "INSERT INTO cycles(id,task_id,region_key,group_id,head_node_id,tail_node_id,limit_count,limit_kind,visited) VALUES(@id,@t,@r,@g,@h,@tl,@l,@lk,0)",
                ("@id", cycleId), ("@t", taskId), ("@r", title), ("@g", groupId), ("@h", head.Id), ("@tl", tail.Id),
                ("@l", limit), ("@lk", limitKind));
            // 镜像：节点上的 cycle_region 跟着组名走（只是显示用，判定一律看 group_id）
            Exec(c, "UPDATE nodes SET cycle_region=@r, updated_at_utc=@now WHERE group_id=@g", ("@r", title), ("@now", Now()), ("@g", groupId));
            tx.Commit();
        }
        Event(c, taskId, head.Id, "cycle-create", by, $"节点组「{title}」声明为循环区：{head.Id} → {tail.Id}，上限 {limit}");

        // 组＋回边＋检查点：回边顺手建上（复用建线那一套校验）
        var edge = AddEdge(taskId, new EdgeSpec(null, tail.Id, head.Id, "loop", null, null, null, null), by);
        return ApiResult.Created(new
        {
            id = cycleId, groupId, regionKey = title,
            headNodeId = head.Id, tailNodeId = tail.Id, limit, limitKind,
            edge = edge.Body, edgeStatus = edge.Status
        });
    }

    /// <summary>撤销循环区：删掉这条回边与上限，组本身留着（还能当普通组用）。</summary>
    public static ApiResult UndoLoop(string groupId, string by)
    {
        using var c = ProtoDb.Open();
        var cycle = ReadCycleByGroup(c, groupId);
        if (cycle is null) return ApiResult.Fail(404, Reasons.CycleNotFound, $"节点组 {groupId} 不是循环区");

        var loopEdges = ReadEdges(c, cycle.TaskId).Where(e => e.Kind == "loop"
            && e.FromNodeId == cycle.TailNodeId && e.ToNodeId == cycle.HeadNodeId).ToList();
        foreach (var e in loopEdges)
        {
            if (Convert.ToInt32(Scalar(c, "SELECT COUNT(*) FROM releases WHERE edge_id=@id", ("@id", e.Id))) > 0)
                return ApiResult.Fail(409, "edge-already-released", "这条回边已经放行过（已进过下一轮），先处理它再撤循环");
        }

        using (var tx = c.BeginTransaction())
        {
            foreach (var e in loopEdges) Exec(c, "DELETE FROM edges WHERE id=@id", ("@id", e.Id));
            Exec(c, "DELETE FROM cycles WHERE id=@id", ("@id", cycle.Id));
            Exec(c, "UPDATE nodes SET cycle_region=NULL WHERE group_id=@g", ("@g", groupId));
            tx.Commit();
        }
        Event(c, cycle.TaskId, cycle.HeadNodeId, "cycle-delete", by,
            $"节点组「{cycle.RegionKey}」不再是循环区（回边 {loopEdges.Count} 条一并删掉）");
        return ApiResult.Ok(new { deleted = cycle.Id, edgesDeleted = loopEdges.Count });
    }

    /// <summary>老口径入口（按 regionKey 声明循环）：内部转成「先把它圈成组，再声明循环」。</summary>
    public static ApiResult AddCycle(string taskId, CycleSpec req, string by)
    {
        using var c = ProtoDb.Open();
        if (Scalar(c, "SELECT id FROM tasks WHERE id=@id", ("@id", taskId)) is null)
            return ApiResult.Fail(404, Reasons.TaskNotFound, $"任务 {taskId} 不存在");
        if (string.IsNullOrWhiteSpace(req.RegionKey) || string.IsNullOrWhiteSpace(req.Head) || string.IsNullOrWhiteSpace(req.Tail))
            return ApiResult.Fail(400, Reasons.BadRequest, "regionKey / head / tail 三项必填");

        var head = ReadNode(c, req.Head!);
        var tail = ReadNode(c, req.Tail!);
        if (head is null || head.TaskId != taskId) return ApiResult.Fail(400, Reasons.UnknownNode, $"head 节点 {req.Head} 不在这个任务里");
        if (tail is null || tail.TaskId != taskId) return ApiResult.Fail(400, Reasons.UnknownNode, $"tail 节点 {req.Tail} 不在这个任务里");

        // 循环区现在由节点组承载：先确保这个区里的节点已经是一个组
        var groupId = EnsureRegionGroup(c, taskId, req.RegionKey);
        foreach (var n in ReadNodes(c, taskId).Where(n => n.CycleRegion == req.RegionKey && (n.GroupId is null || n.GroupId != groupId)))
            Exec(c, "UPDATE nodes SET group_id=@g WHERE id=@id", ("@g", groupId), ("@id", n.Id));
        Exec(c, "UPDATE nodes SET group_id=@g WHERE id=@id", ("@g", groupId), ("@id", head.Id));
        Exec(c, "UPDATE nodes SET group_id=@g WHERE id=@id", ("@g", groupId), ("@id", tail.Id));

        return DeclareLoop(groupId, new LoopSpecRequest(req.Head, req.Tail, req.Limit, req.LimitKind), by);
    }

    /// <summary>按区名找一个组（没有就建）——老口径的 cycleRegion 就是「加入同名组」的糖。</summary>
    private static string EnsureRegionGroup(SqliteConnection c, string taskId, string regionKey)
    {
        var gid = Scalar(c, "SELECT id FROM node_groups WHERE task_id=@t AND title=@r", ("@t", taskId), ("@r", regionKey)) as string;
        if (!string.IsNullOrWhiteSpace(gid)) return gid!;
        var id = "grp_" + Guid.NewGuid().ToString("N")[..10];
        Exec(c, "INSERT INTO node_groups(id,task_id,title,created_at_utc) VALUES(@id,@t,@r,@now)",
            ("@id", id), ("@t", taskId), ("@r", regionKey), ("@now", Now()));
        return id;
    }

    private static string? GroupTitle(SqliteConnection c, string groupId)
        => Scalar(c, "SELECT title FROM node_groups WHERE id=@id", ("@id", groupId)) as string;

    // ---------- 预设（模板库，跨任务复用） ----------

    private sealed record NodeTemplateRow(string Id, string Name, string Title, string GoalLine, string Kind, int InPorts, int OutPorts);
    private sealed record TemplateNode(string Key, string Title, string GoalLine, string Kind, int InPorts, int OutPorts, int Dx, int Dy);
    private sealed record TemplateEdge(string FromKey, string ToKey, string Kind, string Gate, string GateNote);
    private sealed record GroupTemplatePayload(string GroupTitle, List<TemplateNode> Nodes, List<TemplateEdge> Edges);

    private static NodeTemplateRow? ReadNodeTemplate(SqliteConnection c, string id)
    {
        using var cmd = Q(c, "SELECT id,name,title,goal_line,kind,in_ports,out_ports FROM node_templates WHERE id=@id", ("@id", id));
        using var r = cmd.ExecuteReader();
        if (!r.Read()) return null;
        return new NodeTemplateRow(r.GetString(0), r.GetString(1), r.GetString(2), r.GetString(3), r.GetString(4), r.GetInt32(5), r.GetInt32(6));
    }

    public static ApiResult ListTemplates()
    {
        using var c = ProtoDb.Open();
        var nodes = new List<object>();
        using (var cmd = Q(c, "SELECT id,name,title,goal_line,kind,in_ports,out_ports FROM node_templates ORDER BY created_at_utc"))
        using (var r = cmd.ExecuteReader())
            while (r.Read())
                nodes.Add(new
                {
                    id = r.GetString(0), name = r.GetString(1), title = r.GetString(2), goalLine = r.GetString(3),
                    kind = r.GetString(4), inPorts = r.GetInt32(5), outPorts = r.GetInt32(6)
                });

        var groups = new List<object>();
        using (var cmd = Q(c, "SELECT id,name,payload_json FROM group_templates ORDER BY created_at_utc"))
        using (var r = cmd.ExecuteReader())
            while (r.Read())
            {
                var payload = JsonSerializer.Deserialize<GroupTemplatePayload>(r.GetString(2));
                groups.Add(new
                {
                    id = r.GetString(0), name = r.GetString(1),
                    groupTitle = payload?.GroupTitle ?? r.GetString(1),
                    nodeCount = payload?.Nodes.Count ?? 0,
                    edgeCount = payload?.Edges.Count ?? 0
                });
            }
        return ApiResult.Ok(new { nodeTemplates = nodes, groupTemplates = groups });
    }

    /// <summary>建节点预设：给 nodeId 就照那个节点快照一份；也可以直接给字段。</summary>
    public static ApiResult CreateNodeTemplate(NodeTemplateSpec req, string by)
    {
        using var c = ProtoDb.Open();
        NodeRow? src = null;
        if (!string.IsNullOrWhiteSpace(req.NodeId))
        {
            src = ReadNode(c, req.NodeId!.Trim());
            if (src is null) return ApiResult.Fail(404, Reasons.NodeNotFound, $"节点 {req.NodeId} 不存在");
        }

        var title = (req.Title ?? src?.Title ?? "").Trim();
        if (title.Length == 0) return ApiResult.Fail(400, Reasons.TitleRequired, "预设节点的标题必填");
        if (title.Length > 120) return ApiResult.Fail(400, Reasons.TitleTooLong, $"标题最长 120 字，当前 {title.Length} 字");
        var kind = (req.Kind ?? src?.Kind ?? "work").Trim();
        if (!NodeKinds.Contains(kind))
            return ApiResult.Fail(400, Reasons.KindInvalid, $"kind 只能是 work / review_auto / review_human，收到 {kind}");
        var inPorts = req.InPorts ?? src?.InPorts ?? 1;
        var outPorts = req.OutPorts ?? src?.OutPorts ?? 1;
        if (inPorts < 1 || inPorts > MaxPorts || outPorts < 1 || outPorts > MaxPorts)
            return ApiResult.Fail(400, Reasons.PortOutOfRange, $"进出端口数只能是 1–{MaxPorts}");
        var name = (req.Name ?? "").Trim();
        if (name.Length == 0) name = title;
        if (name.Length > 60) return ApiResult.Fail(400, Reasons.TitleTooLong, $"预设名最长 60 字，当前 {name.Length} 字");

        var id = "tpl_" + Guid.NewGuid().ToString("N")[..10];
        Exec(c, "INSERT INTO node_templates(id,name,title,goal_line,kind,in_ports,out_ports,created_at_utc) VALUES(@id,@n,@t,@g,@k,@ip,@op,@now)",
            ("@id", id), ("@n", name), ("@t", title), ("@g", (req.GoalLine ?? src?.GoalLine ?? "").Trim()),
            ("@k", kind), ("@ip", inPorts), ("@op", outPorts), ("@now", Now()));
        Event(c, null, null, "template-node-create", by, $"新建节点预设「{name}」（{title} / {kind}）");
        return ApiResult.Created(new { id, name, title, goalLine = (req.GoalLine ?? src?.GoalLine ?? "").Trim(), kind, inPorts, outPorts });
    }

    public static ApiResult DeleteNodeTemplate(string id, string by)
    {
        using var c = ProtoDb.Open();
        var t = ReadNodeTemplate(c, id);
        if (t is null) return ApiResult.Fail(404, "template-not-found", $"预设 {id} 不存在");
        Exec(c, "DELETE FROM node_templates WHERE id=@id", ("@id", id));
        Event(c, null, null, "template-node-delete", by, $"删掉节点预设「{t.Name}」");
        return ApiResult.Ok(new { deleted = id });
    }

    /// <summary>建组预设：从一个节点组（或指定几个节点）快照节点、组名与组内 transfer 边。</summary>
    public static ApiResult CreateGroupTemplate(GroupTemplateSpec req, string by)
    {
        using var c = ProtoDb.Open();
        List<NodeRow> members;
        string defaultName;
        if (!string.IsNullOrWhiteSpace(req.GroupId))
        {
            var title = Scalar(c, "SELECT title FROM node_groups WHERE id=@id", ("@id", req.GroupId)) as string;
            if (title is null) return ApiResult.Fail(404, Reasons.NodeGroupNotFound, $"节点组 {req.GroupId} 不存在");
            var taskId = Scalar(c, "SELECT task_id FROM node_groups WHERE id=@id", ("@id", req.GroupId)) as string;
            members = ReadNodes(c, taskId!).Where(n => n.GroupId == req.GroupId).ToList();
            defaultName = title;
        }
        else
        {
            var ids = (req.NodeIds ?? []).Where(i => !string.IsNullOrWhiteSpace(i)).Select(i => i!.Trim()).Distinct().ToList();
            members = [];
            foreach (var nodeId in ids)
            {
                var n = ReadNode(c, nodeId);
                if (n is null) return ApiResult.Fail(404, Reasons.NodeNotFound, $"节点 {nodeId} 不存在");
                members.Add(n);
            }
            defaultName = "组预设";
        }
        if (members.Count < 2)
            return ApiResult.Fail(400, Reasons.NodeGroupNeedsTwo, $"组预设至少两个节点，收到 {members.Count} 个");

        var taskIdForEdges = members[0].TaskId;
        if (members.Any(m => m.TaskId != taskIdForEdges))
            return ApiResult.Fail(400, Reasons.BadRequest, "组预设里的节点必须属于同一个任务");

        var baseX = members.Min(m => m.PosX ?? 0);
        var baseY = members.Min(m => m.PosY ?? 0);
        var keyOf = members.Select((m, i) => (m.Id, Key: "n" + (i + 1))).ToDictionary(x => x.Id, x => x.Key);

        var payload = new GroupTemplatePayload(
            defaultName,
            members.Select(m => new TemplateNode(keyOf[m.Id], m.Title, m.GoalLine, m.Kind, m.InPorts, m.OutPorts,
                (m.PosX ?? baseX) - baseX, (m.PosY ?? baseY) - baseY)).ToList(),
            ReadEdges(c, taskIdForEdges)
                .Where(e => e.Kind == "transfer" && keyOf.ContainsKey(e.FromNodeId) && keyOf.ContainsKey(e.ToNodeId))
                .Select(e => new TemplateEdge(keyOf[e.FromNodeId], keyOf[e.ToNodeId], e.Kind, e.Gate, e.GateNote))
                .ToList());

        var name = (req.Name ?? "").Trim();
        if (name.Length == 0) name = defaultName;
        if (name.Length > 60) return ApiResult.Fail(400, Reasons.TitleTooLong, $"预设名最长 60 字，当前 {name.Length} 字");

        var id = "gtpl_" + Guid.NewGuid().ToString("N")[..10];
        Exec(c, "INSERT INTO group_templates(id,name,payload_json,created_at_utc) VALUES(@id,@n,@p,@now)",
            ("@id", id), ("@n", name), ("@p", JsonSerializer.Serialize(payload)), ("@now", Now()));
        Event(c, taskIdForEdges, null, "template-group-create", by,
            $"新建组预设「{name}」：{payload.Nodes.Count} 个节点、{payload.Edges.Count} 条组内线");
        return ApiResult.Created(new { id, name, groupTitle = payload.GroupTitle, nodeCount = payload.Nodes.Count, edgeCount = payload.Edges.Count });
    }

    /// <summary>删组预设。</summary>
    public static ApiResult DeleteGroupTemplate(string id, string by)
    {
        using var c = ProtoDb.Open();
        var name = Scalar(c, "SELECT name FROM group_templates WHERE id=@id", ("@id", id)) as string;
        if (name is null) return ApiResult.Fail(404, "template-not-found", $"组预设 {id} 不存在");
        Exec(c, "DELETE FROM group_templates WHERE id=@id", ("@id", id));
        Event(c, null, null, "template-group-delete", by, $"删掉组预设「{name}」");
        return ApiResult.Ok(new { deleted = id });
    }

    /// <summary>套用一个节点预设：在 (x,y) 落一个节点（标题/目标/类型/口数照预设）。</summary>
    public static ApiResult ApplyNodeTemplate(string taskId, ApplyTemplateRequest req, string by)
    {
        if (string.IsNullOrWhiteSpace(req.TemplateId))
            return ApiResult.Fail(400, Reasons.BadRequest, "templateId 必填");
        using var c = ProtoDb.Open();
        if (Scalar(c, "SELECT id FROM tasks WHERE id=@id", ("@id", taskId)) is null)
            return ApiResult.Fail(404, Reasons.TaskNotFound, $"任务 {taskId} 不存在");
        var t = ReadNodeTemplate(c, req.TemplateId!);
        if (t is null) return ApiResult.Fail(404, "template-not-found", $"预设 {req.TemplateId} 不存在");

        var seq = ReadNodes(c, taskId).Select(n => n.Seq).DefaultIfEmpty(0).Max() + 1;
        var nodeId = "nd_" + Guid.NewGuid().ToString("N")[..10];
        Exec(c, "INSERT INTO nodes(id,task_id,title,goal_line,kind,status,seq,attempt,cycle_region,cycle_epoch,artifact_state,pos_x,pos_y,in_ports,out_ports,updated_at_utc) " +
                "VALUES(@id,@t,@title,@g,@k,'pending',@s,0,NULL,1,'none',@x,@y,@ip,@op,@now)",
            ("@id", nodeId), ("@t", taskId), ("@title", t.Title), ("@g", t.GoalLine), ("@k", t.Kind), ("@s", seq),
            ("@x", req.X), ("@y", req.Y), ("@ip", t.InPorts), ("@op", t.OutPorts), ("@now", Now()));
        Event(c, taskId, nodeId, "node-from-template", by, $"套用节点预设「{t.Name}」→ 第 {seq} 个节点");
        return ApiResult.Created(new { node = NodeDto(ReadNode(c, nodeId)!), templateId = t.Id });
    }

    /// <summary>
    /// 套用一个组预设：按预设里的相对位置把节点整块落下来，再补组内连线，最后圈成一个节点组。
    /// 回边不收进预设（需要循环区行），所以这里最多只出现 transfer 线。
    /// </summary>
    public static ApiResult ApplyGroupTemplate(string taskId, ApplyTemplateRequest req, string by)
    {
        if (string.IsNullOrWhiteSpace(req.TemplateId))
            return ApiResult.Fail(400, Reasons.BadRequest, "templateId 必填");
        using var c = ProtoDb.Open();
        if (Scalar(c, "SELECT id FROM tasks WHERE id=@id", ("@id", taskId)) is null)
            return ApiResult.Fail(404, Reasons.TaskNotFound, $"任务 {taskId} 不存在");
        var name = Scalar(c, "SELECT name FROM group_templates WHERE id=@id", ("@id", req.TemplateId!)) as string;
        var payloadJson = Scalar(c, "SELECT payload_json FROM group_templates WHERE id=@id", ("@id", req.TemplateId!)) as string;
        if (name is null || payloadJson is null) return ApiResult.Fail(404, "template-not-found", $"组预设 {req.TemplateId} 不存在");
        var payload = JsonSerializer.Deserialize<GroupTemplatePayload>(payloadJson)!;

        var baseX = req.X ?? 80;
        var baseY = req.Y ?? 80;
        var keyToId = new Dictionary<string, string>();
        var createdIds = new List<string>();

        using (var tx = c.BeginTransaction())
        {
            var seq = ReadNodes(c, taskId).Select(n => n.Seq).DefaultIfEmpty(0).Max();
            foreach (var n in payload.Nodes)
            {
                seq++;
                var nodeId = "nd_" + Guid.NewGuid().ToString("N")[..10];
                keyToId[n.Key] = nodeId;
                createdIds.Add(nodeId);
                Exec(c, "INSERT INTO nodes(id,task_id,title,goal_line,kind,status,seq,attempt,cycle_region,cycle_epoch,artifact_state,pos_x,pos_y,in_ports,out_ports,updated_at_utc) " +
                        "VALUES(@id,@t,@title,@g,@k,'pending',@s,0,NULL,1,'none',@x,@y,@ip,@op,@now)",
                    ("@id", nodeId), ("@t", taskId), ("@title", n.Title), ("@g", n.GoalLine), ("@k", n.Kind), ("@s", seq),
                    ("@x", baseX + n.Dx), ("@y", baseY + n.Dy),
                    ("@ip", n.InPorts), ("@op", n.OutPorts), ("@now", Now()));
            }
            tx.Commit();
        }
        Event(c, taskId, null, "group-from-template", by,
            $"套用组预设「{name}」：{createdIds.Count} 个节点");

        // 组内连线复用建线那一套规则（判重/端口/规则组/放行都在里面）
        var edgeReport = new List<object>();
        foreach (var e in payload.Edges)
        {
            if (!keyToId.ContainsKey(e.FromKey) || !keyToId.ContainsKey(e.ToKey)) continue;
            var r = AddEdge(taskId, new EdgeSpec(null, keyToId[e.FromKey], keyToId[e.ToKey], e.Kind, null, null, e.Gate, e.GateNote), by);
            edgeReport.Add(new { from = e.FromKey, to = e.ToKey, ok = r.Status < 400 });
        }

        string? groupId = null;
        if (createdIds.Count >= 2)
        {
            var g = CreateNodeGroup(taskId, new NodeGroupSpec(null, payload.GroupTitle, createdIds.ToArray()), by);
            groupId = g.Body is null ? null : ReadGroupId(g);
        }

        return ApiResult.Created(new
        {
            templateId = req.TemplateId, groupId,
            nodes = createdIds, edges = edgeReport,
            hint = createdIds.Count < 2 ? "预设里不足两个节点，没建组" : null
        });
    }

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
