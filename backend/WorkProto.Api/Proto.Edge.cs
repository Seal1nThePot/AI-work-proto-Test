// ────────── Proto.Edge.cs ──────────「连线」
// 用途: 连线：建 / 读 / 改 / 删，人工门确认
// 暴露: AddEdge ReadEdge EdgeDto GetEdge UpdateEdge ConfirmEdgeGate DeleteEdge
// 依赖: Proto.Infra.cs Proto.Gate.cs Proto.Propagate.cs Proto.Group.cs
// 被依赖: Program.cs
using System.Text.Json;
using Microsoft.Data.Sqlite;

namespace WorkProto.Api;

public static partial class Proto
{
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
}
