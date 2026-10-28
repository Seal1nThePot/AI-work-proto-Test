// ────────── Proto.NodeWrite.cs ──────────「节点写操作」
// 用途: 节点写操作：建节点 / 改端口 / 改属性 / 移动 / 批量移动，以及端口与类型白名单常量
// 暴露: NodeKinds EdgeKinds EdgeGates MaxPorts PosGuard FreePos AddNode UpdatePorts UpdateNode MoveNode MoveNodes
// 依赖: Proto.Infra.cs Proto.Gate.cs
// 被依赖: Program.cs、Proto.Edge.cs
using System.Text.Json;
using Microsoft.Data.Sqlite;

namespace WorkProto.Api;

public static partial class Proto
{
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
}
