// ────────── Proto.Group.cs ──────────「节点组与循环区」
// 用途: 节点组与循环区：读组/读循环、建组 / 收纳 / 展开 / 删组 / 重建组内条目、声明与撤销循环
// 暴露: ReadGroup ReadCycle ReadCycleByHead ReadCycleByGroup MapCycle CreateNodeGroup SetNodeCompact SetGroupCollapsed DeleteNodeGroup RebuildGroupItems DeclareLoop UndoLoop AddCycle EnsureRegionGroup GroupTitle
// 依赖: Proto.Infra.cs
// 被依赖: Proto.Lifecycle.cs（择一）、Proto.Edge.cs、Proto.Task.cs
using System.Text.Json;
using Microsoft.Data.Sqlite;

namespace WorkProto.Api;

public static partial class Proto
{
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

    /// <summary>把单个未分组节点加进已有组：右键菜单/快捷键都走这里，不改执行语义。</summary>
    public static ApiResult JoinNodeGroup(string nodeId, string groupId, string by)
    {
        using var c = ProtoDb.Open();
        var node = ReadNode(c, nodeId);
        if (node is null) return ApiResult.Fail(404, Reasons.NodeNotFound, $"节点 {nodeId} 不存在");

        var title = GroupTitle(c, groupId);
        if (title is null) return ApiResult.Fail(404, Reasons.NodeGroupNotFound, $"节点组 {groupId} 不存在");
        var groupTask = Scalar(c, "SELECT task_id FROM node_groups WHERE id=@g", ("@g", groupId)) as string;
        if (groupTask != node.TaskId)
            return ApiResult.Fail(400, Reasons.UnknownNode, $"节点 {nodeId} 和组 {groupId} 不在同一个任务里");

        if (node.GroupId == groupId)
            return ApiResult.Ok(new { nodeId, groupId, title, changed = false });
        if (node.GroupId is not null)
            return ApiResult.Fail(409, Reasons.NodeAlreadyGrouped,
                $"节点「{node.Title}」已在组「{GroupTitle(c, node.GroupId)}」里；先移出原组再加");

        Exec(c, "UPDATE nodes SET group_id=@g, updated_at_utc=@now WHERE id=@id",
            ("@g", groupId), ("@now", Now()), ("@id", nodeId));
        Event(c, node.TaskId, nodeId, "node-group-append", by, $"节点「{node.Title}」加入组「{title}」");
        return ApiResult.Ok(new { nodeId, groupId, title, changed = true });
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
}
