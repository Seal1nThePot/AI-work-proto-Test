// ────────── Proto.Task.cs ──────────「任务级写操作」
// 用途: 任务级：建图（一次贴整张图）/ 删任务 / 删节点 / 从返回体取 id
// 暴露: ReadGroupId DeleteNode DeleteTask CreateTask
// 依赖: Proto.Infra.cs Proto.Group.cs
// 被依赖: Program.cs
using System.Text.Json;
using System.Text.Json.Nodes;
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

    /// <summary>
    /// 导入「工作流 + 一个视图」JSON：新建任务并重映射所有 id，不覆盖现有任务。
    /// 只恢复结构与视图坐标；执行进度/租约/检查点按新任务从 pending 开始。
    /// </summary>
    public static ApiResult ImportBundle(JsonElement req)
    {
        if (req.ValueKind != JsonValueKind.Object)
            return ApiResult.Fail(400, Reasons.BadRequest, "导入文件必须是 JSON 对象");
        if (req.GetRawText().Length > 8_000_000)
            return ApiResult.Fail(400, Reasons.BadRequest, "导入文件超过 8 MB");

        static string? Str(JsonElement e, string name) =>
            e.ValueKind == JsonValueKind.Object && e.TryGetProperty(name, out var v) && v.ValueKind == JsonValueKind.String
                ? v.GetString() : null;
        static int Int(JsonElement e, string name, int def) =>
            e.ValueKind == JsonValueKind.Object && e.TryGetProperty(name, out var v) && v.TryGetInt32(out var n) ? n : def;
        static int? IntOrNull(JsonElement e, string name) =>
            e.ValueKind == JsonValueKind.Object && e.TryGetProperty(name, out var v) && v.TryGetInt32(out var n) ? n : null;
        static bool Bool(JsonElement e, string name) =>
            e.ValueKind == JsonValueKind.Object && e.TryGetProperty(name, out var v) && v.ValueKind == JsonValueKind.True;
        static JsonElement[] Arr(JsonElement e, string name) =>
            e.ValueKind == JsonValueKind.Object && e.TryGetProperty(name, out var v) && v.ValueKind == JsonValueKind.Array
                ? v.EnumerateArray().ToArray() : [];

        if (Str(req, "format") != "workproto.bundle")
            return ApiResult.Fail(400, Reasons.BadRequest, "不是 WorkProto bundle 文件");
        if (Int(req, "version", 0) != 1)
            return ApiResult.Fail(400, Reasons.BadRequest, "只支持 version=1 的 bundle");

        if (!req.TryGetProperty("task", out var taskEl) || taskEl.ValueKind != JsonValueKind.Object)
            return ApiResult.Fail(400, Reasons.BadRequest, "bundle 缺少 task");
        var title = (Str(taskEl, "title") ?? "").Trim();
        if (title.Length == 0) title = "导入的工作流";
        var goal = Str(taskEl, "goalLine") ?? "";

        var prefix = "im_" + Guid.NewGuid().ToString("N")[..8] + "_";
        var taskId = "tsk_" + Guid.NewGuid().ToString("N")[..12];
        var nodesEl = Arr(req, "nodes");
        var edgesEl = Arr(req, "edges");
        var inputGroupsEl = Arr(req, "inputGroups");
        var cyclesEl = Arr(req, "cycles");
        var nodeGroupsEl = Arr(req, "nodeGroups");

        var nodeMap = new Dictionary<string, string>();
        for (var i = 0; i < nodesEl.Length; i++)
        {
            var oldId = Str(nodesEl[i], "id");
            if (string.IsNullOrWhiteSpace(oldId) || nodeMap.ContainsKey(oldId!))
                return ApiResult.Fail(400, Reasons.BadRequest, $"nodes[{i}] 的 id 为空或重复");
            nodeMap[oldId!] = $"{prefix}n{i + 1}";
        }
        var edgeMap = new Dictionary<string, string>();
        for (var i = 0; i < edgesEl.Length; i++)
        {
            var oldId = Str(edgesEl[i], "id");
            if (string.IsNullOrWhiteSpace(oldId) || edgeMap.ContainsKey(oldId!))
                return ApiResult.Fail(400, Reasons.BadRequest, $"edges[{i}] 的 id 为空或重复");
            edgeMap[oldId!] = $"{prefix}e{i + 1}";
        }

        var groupMap = new Dictionary<string, string>();
        for (var i = 0; i < nodeGroupsEl.Length; i++)
        {
            var oldId = Str(nodeGroupsEl[i], "id");
            if (string.IsNullOrWhiteSpace(oldId) || groupMap.ContainsKey(oldId!))
                return ApiResult.Fail(400, Reasons.BadRequest, $"nodeGroups[{i}] 的 id 为空或重复");
            groupMap[oldId!] = $"{prefix}g{i + 1}";
        }

        var nodeToGroup = new Dictionary<string, string>();
        foreach (var grp in nodeGroupsEl)
        {
            var oldGid = Str(grp, "id");
            if (oldGid is null || !groupMap.TryGetValue(oldGid, out var newGid)) continue;
            foreach (var member in Arr(grp, "nodeIds"))
            {
                var oldNid = member.ValueKind == JsonValueKind.String ? member.GetString() : null;
                if (oldNid is not null && nodeMap.TryGetValue(oldNid, out var newNid)) nodeToGroup[newNid] = newGid;
            }
        }
        foreach (var n in nodesEl)
        {
            var oldNid = Str(n, "id");
            var oldGid = Str(n, "groupId");
            if (oldNid is not null && oldGid is not null &&
                nodeMap.TryGetValue(oldNid, out var newNid) &&
                groupMap.TryGetValue(oldGid, out var newGid) &&
                !nodeToGroup.ContainsKey(newNid))
                nodeToGroup[newNid] = newGid;
        }

        foreach (var e in edgesEl)
        {
            if (!nodeMap.ContainsKey(Str(e, "from") ?? "") || !nodeMap.ContainsKey(Str(e, "to") ?? ""))
                return ApiResult.Fail(400, Reasons.BadRequest, $"边「{Str(e, "id")}」引用了不存在的节点");
        }
        foreach (var g in inputGroupsEl)
        {
            if (!nodeMap.ContainsKey(Str(g, "nodeId") ?? ""))
                return ApiResult.Fail(400, Reasons.BadRequest, "规则组引用了不存在的节点");
            foreach (var item in Arr(g, "items"))
            {
                var oldEid = item.ValueKind == JsonValueKind.String ? item.GetString() : null;
                if (oldEid is not null && !edgeMap.ContainsKey(oldEid))
                    return ApiResult.Fail(400, Reasons.BadRequest, "规则组引用了不存在的边");
            }
        }
        foreach (var cy in cyclesEl)
        {
            if (!nodeMap.ContainsKey(Str(cy, "headNodeId") ?? "") || !nodeMap.ContainsKey(Str(cy, "tailNodeId") ?? ""))
                return ApiResult.Fail(400, Reasons.BadRequest, "循环引用了不存在的头/尾节点");
        }

        string? RemapLayout(JsonElement layout)
        {
            if (layout.ValueKind != JsonValueKind.Array) return null;
            var arr = new JsonArray();
            foreach (var it in layout.EnumerateArray())
            {
                if (it.ValueKind != JsonValueKind.Object) continue;
                var oldNid = Str(it, "id");
                if (oldNid is null || !nodeMap.TryGetValue(oldNid, out var newNid)) continue;
                if (JsonNode.Parse(it.GetRawText()) is not JsonObject obj) continue;
                obj["id"] = newNid;
                arr.Add(obj);
            }
            return arr.Count == 0 ? null : arr.ToJsonString();
        }

        string? viewName = null;
        string? viewPayload = null;
        if (req.TryGetProperty("view", out var viewEl) && viewEl.ValueKind == JsonValueKind.Object)
        {
            viewName = (Str(viewEl, "name") ?? "导入视图").Trim();
            if (viewName.Length == 0) viewName = "导入视图";
            if (viewName.Length > 60)
                return ApiResult.Fail(400, Reasons.TitleTooLong, "视图名最长 60 字");
            if (!viewEl.TryGetProperty("payload", out var payloadEl) || payloadEl.ValueKind != JsonValueKind.Object)
                return ApiResult.Fail(400, Reasons.BadRequest, "view.payload 必须是对象");
            if (payloadEl.GetRawText().Length > 4_000_000)
                return ApiResult.Fail(400, Reasons.BadRequest, "视图快照超过 4 MB");
            if (JsonNode.Parse(payloadEl.GetRawText()) is not JsonObject viewObj)
                return ApiResult.Fail(400, Reasons.BadRequest, "view.payload 解析失败");

            if (viewObj["positions"] is JsonObject positions)
            {
                var mapped = new JsonObject();
                foreach (var (oldNid, pos) in positions)
                    if (nodeMap.TryGetValue(oldNid, out var newNid)) mapped[newNid] = pos?.DeepClone();
                viewObj["positions"] = mapped;
            }
            if (viewObj["groupLayouts"] is JsonObject layouts)
            {
                var mapped = new JsonObject();
                foreach (var (oldGid, layout) in layouts)
                {
                    if (!groupMap.TryGetValue(oldGid, out var newGid) || layout is not JsonArray items) continue;
                    var arr = new JsonArray();
                    foreach (var item in items)
                    {
                        if (item is not JsonObject obj) continue;
                        if (obj["id"] is not JsonValue idVal || !idVal.TryGetValue<string>(out var oldNid)) continue;
                        if (!nodeMap.TryGetValue(oldNid!, out var newNid)) continue;
                        var clone = (JsonObject)obj.DeepClone();
                        clone["id"] = newNid;
                        arr.Add(clone);
                    }
                    mapped[newGid] = arr;
                }
                viewObj["groupLayouts"] = mapped;
            }
            viewPayload = viewObj.ToJsonString();
        }

        var now = Now();
        var layerId = viewPayload is null ? null : "vl_" + Guid.NewGuid().ToString("N")[..10];
        try
        {
            using var c = ProtoDb.Open();
            using var tx = c.BeginTransaction();
            Exec(c, "INSERT INTO tasks(id,title,goal_line,status,created_at_utc) VALUES(@id,@t,@g,'open',@now)",
                ("@id", taskId), ("@t", title), ("@g", goal), ("@now", now));

            for (var i = 0; i < nodeGroupsEl.Length; i++)
            {
                var grp = nodeGroupsEl[i];
                var oldGid = Str(grp, "id")!;
                var newGid = groupMap[oldGid];
                var layoutJson = grp.TryGetProperty("layout", out var layoutEl) ? RemapLayout(layoutEl) : null;
                Exec(c, "INSERT INTO node_groups(id,task_id,title,collapsed,layout_json,created_at_utc) VALUES(@id,@t,@title,@collapsed,@layout,@now)",
                    ("@id", newGid), ("@t", taskId), ("@title", (Str(grp, "title") ?? $"组 {i + 1}").Trim()),
                    ("@collapsed", Bool(grp, "collapsed") ? 1 : 0), ("@layout", layoutJson), ("@now", now));
            }

            for (var i = 0; i < nodesEl.Length; i++)
            {
                var n = nodesEl[i];
                var oldId = Str(n, "id")!;
                var newId = nodeMap[oldId];
                var kind = Str(n, "kind") ?? "work";
                if (!NodeKinds.Contains(kind)) kind = "work";
                var cycleRegion = Str(n, "cycleRegion");
                var inPorts = Math.Clamp(Int(n, "inPorts", 1), 1, MaxPorts);
                var outPorts = Math.Clamp(Int(n, "outPorts", 1), 1, MaxPorts);
                var compact = Math.Clamp(Int(n, "compact", 0), 0, 2);
                Exec(c, "INSERT INTO nodes(id,task_id,title,goal_line,kind,status,seq,attempt,cycle_region,cycle_epoch,artifact_state,pos_x,pos_y,in_ports,out_ports,compact,group_id,updated_at_utc) " +
                        "VALUES(@id,@t,@title,@g,@k,'pending',@s,0,@r,1,'none',@x,@y,@ip,@op,@compact,@grp,@now)",
                    ("@id", newId), ("@t", taskId), ("@title", (Str(n, "title") ?? $"节点 {i + 1}").Trim()),
                    ("@g", Str(n, "goalLine") ?? ""), ("@k", kind), ("@s", i + 1), ("@r", cycleRegion),
                    ("@x", IntOrNull(n, "x")), ("@y", IntOrNull(n, "y")), ("@ip", inPorts), ("@op", outPorts),
                    ("@compact", compact), ("@grp", nodeToGroup.GetValueOrDefault(newId)), ("@now", now));
            }

            for (var i = 0; i < edgesEl.Length; i++)
            {
                var e = edgesEl[i];
                var oldId = Str(e, "id")!;
                var gate = Str(e, "gate") ?? "auto";
                if (!EdgeGates.Contains(gate)) gate = "auto";
                var kind = Str(e, "kind") == "loop" ? "loop" : "transfer";
                Exec(c, "INSERT INTO edges(id,task_id,from_node_id,to_node_id,kind,transfer_condition,target_step_id,from_port,to_port,gate,gate_note,graph_version) " +
                        "VALUES(@id,@t,@f,@to,@k,'auto','',@fp,@tp,@gate,@note,1)",
                    ("@id", edgeMap[oldId]), ("@t", taskId), ("@f", nodeMap[Str(e, "from")!]),
                    ("@to", nodeMap[Str(e, "to")!]), ("@k", kind),
                    ("@fp", Math.Max(0, Int(e, "fromPort", 0))), ("@tp", Math.Max(0, Int(e, "toPort", 0))),
                    ("@gate", gate), ("@note", Str(e, "gateNote") ?? ""));
            }

            for (var i = 0; i < inputGroupsEl.Length; i++)
            {
                var g = inputGroupsEl[i];
                var mode = Str(g, "mode") ?? "all";
                if (mode is not ("all" or "any" or "k_of_n" or "pick_one")) mode = "all";
                var items = Arr(g, "items")
                    .Select(x => x.ValueKind == JsonValueKind.String ? x.GetString() : null)
                    .Where(x => x is not null && edgeMap.ContainsKey(x))
                    .Select(x => edgeMap[x!]).ToArray();
                Exec(c, "INSERT INTO input_groups(id,task_id,node_id,mode,need_count,items_json) VALUES(@id,@t,@n,@m,@k,@items)",
                    ("@id", $"{prefix}ig{i + 1}"), ("@t", taskId), ("@n", nodeMap[Str(g, "nodeId")!]),
                    ("@m", mode), ("@k", Math.Max(0, Int(g, "needCount", 0))), ("@items", JsonSerializer.Serialize(items)));
            }

            for (var i = 0; i < cyclesEl.Length; i++)
            {
                var cy = cyclesEl[i];
                var oldHead = Str(cy, "headNodeId")!;
                var oldTail = Str(cy, "tailNodeId")!;
                var oldGid = Str(cy, "groupId");
                string? newGid = oldGid is not null && groupMap.TryGetValue(oldGid, out var mappedGid) ? mappedGid : null;
                var limitKind = Str(cy, "limitKind") == "perpetual" ? "perpetual" : "bounded";
                Exec(c, "INSERT INTO cycles(id,task_id,region_key,group_id,head_node_id,tail_node_id,limit_count,limit_kind,visited) " +
                        "VALUES(@id,@t,@r,@g,@h,@tl,@l,@lk,0)",
                    ("@id", $"{prefix}cy{i + 1}"), ("@t", taskId), ("@r", Str(cy, "regionKey") ?? $"R{i + 1}"),
                    ("@g", newGid), ("@h", nodeMap[oldHead]), ("@tl", nodeMap[oldTail]),
                    ("@l", Math.Max(1, Int(cy, "limit", 3))), ("@lk", limitKind));
            }

            if (viewPayload is not null && layerId is not null)
            {
                Exec(c, "INSERT INTO view_layers(id,task_id,name,payload_json,created_at_utc,updated_at_utc) VALUES(@id,@t,@n,@p,@now,@now)",
                    ("@id", layerId), ("@t", taskId), ("@n", viewName ?? "导入视图"), ("@p", viewPayload), ("@now", now));
            }

            tx.Commit();
            Event(c, taskId, null, "import", "import",
                $"导入工作流「{title}」：{nodesEl.Length} 节点 / {edgesEl.Length} 边 / {nodeGroupsEl.Length} 组 / {cyclesEl.Length} 循环");
        }
        catch (Exception ex)
        {
            return ApiResult.Fail(400, "import-invalid", $"导入失败：{ex.Message}");
        }

        return ApiResult.Created(new
        {
            taskId, layerId, title,
            nodes = nodesEl.Length, edges = edgesEl.Length,
            groups = nodeGroupsEl.Length, cycles = cyclesEl.Length
        });
    }
}
