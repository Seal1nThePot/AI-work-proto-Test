// ────────── Proto.Template.cs ──────────「模板库」
// 用途: 模板库：节点 / 组模板的增删查与应用（跨任务复用）
// 暴露: ListTemplates CreateNodeTemplate DeleteNodeTemplate CreateGroupTemplate DeleteGroupTemplate ApplyNodeTemplate ApplyGroupTemplate
// 依赖: Proto.Infra.cs
// 被依赖: Program.cs
using System.Text.Json;
using Microsoft.Data.Sqlite;

namespace WorkProto.Api;

public static partial class Proto
{
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
}
