// ────────── Proto.View.cs ──────────「视图与组布局缓存」
// 用途: 组内相对布局缓存 + 视图图层 CRUD（纯看图状态，不参与执行、不写 events）
// 暴露: SetGroupLayout ListViewLayers GetViewLayer CreateViewLayer UpdateViewLayer DeleteViewLayer
// 依赖: Proto.Infra.cs
// 被依赖: Program.cs
using System.Text.Json;
using Microsoft.Data.Sqlite;

namespace WorkProto.Api;

public static partial class Proto
{
    private const int ViewPayloadMax = 4_000_000;

    /// <summary>
    /// 保存一个组的相对布局缓存：dx/dy 相对组内容左上角（成员最小 x/y）。
    /// 只存坐标，不碰节点绝对位置；组内结构变了，旧缓存由前端按成员 id 忽略缺失项。
    /// </summary>
    public static ApiResult SetGroupLayout(string groupId, GroupLayoutRequest req)
    {
        using var c = ProtoDb.Open();
        var taskId = Scalar(c, "SELECT task_id FROM node_groups WHERE id=@id", ("@id", groupId)) as string;
        if (taskId is null)
            return ApiResult.Fail(404, Reasons.NodeGroupNotFound, $"节点组 {groupId} 不存在");

        var items = req.Nodes ?? [];
        if (items.Length > 500)
            return ApiResult.Fail(400, Reasons.BadRequest, "一次最多保存 500 个节点的组内相对坐标");

        var members = ReadNodes(c, taskId).Where(n => n.GroupId == groupId).Select(n => n.Id).ToHashSet();
        var clean = new List<object>();
        foreach (var it in items)
        {
            if (string.IsNullOrWhiteSpace(it.Id))
                return ApiResult.Fail(400, Reasons.BadRequest, "每项都要有节点 id");
            if (!members.Contains(it.Id!))
                return ApiResult.Fail(400, Reasons.UnknownNode, $"节点 {it.Id} 不是组 {groupId} 的成员");
            if (it.Dx is null || it.Dy is null)
                return ApiResult.Fail(400, Reasons.BadRequest, $"节点 {it.Id} 缺 dx/dy");
            clean.Add(new { id = it.Id, dx = it.Dx.Value, dy = it.Dy.Value });
        }

        var json = clean.Count == 0 ? null : JsonSerializer.Serialize(clean);
        Exec(c, "UPDATE node_groups SET layout_json=@j WHERE id=@id", ("@j", json), ("@id", groupId));
        return ApiResult.Ok(new { groupId, nodes = clean });
    }

    /// <summary>列表只回模式标签，不回整份 payload——多个图层各自可能接近 4 MB。</summary>
    private static string[] LayerModes(string? payload)
    {
        if (string.IsNullOrWhiteSpace(payload)) return [];
        try
        {
            using var doc = JsonDocument.Parse(payload);
            var root = doc.RootElement;
            if (root.ValueKind != JsonValueKind.Object) return [];
            var modes = new List<string>();
            bool On(string key) =>
                root.TryGetProperty(key, out var v) && v.ValueKind == JsonValueKind.True;
            if (On("groupView") || On("stackGroups")) modes.Add("group-view");
            var compact = On("compactView") || On("stackNodes");
            if (compact) modes.Add("compact");
            var allowOverlap = true;
            if (root.TryGetProperty("allowOverlap", out var av) && av.ValueKind == JsonValueKind.False) allowOverlap = false;
            if (root.TryGetProperty("nodeStack", out var ns) && ns.ValueKind == JsonValueKind.False) allowOverlap = false;
            if (compact && allowOverlap) modes.Add("stack");
            return modes.ToArray();
        }
        catch (JsonException) { return []; }
    }

    private static object LayerSummary(SqliteDataReader r) => new
    {
        id = r.GetString(0), taskId = r.GetString(1), name = r.GetString(2),
        createdAtUtc = r.GetString(3), updatedAtUtc = r.GetString(4),
        modes = LayerModes(r.IsDBNull(5) ? null : r.GetString(5))
    };

    /// <summary>图层默认名按阿拉伯数字排：图层1、图层2……删掉中间一个也不撞名。</summary>
    private static string NextLayerName(SqliteConnection c, string taskId)
    {
        var used = new HashSet<string>();
        using (var cmd = Q(c, "SELECT name FROM view_layers WHERE task_id=@t", ("@t", taskId)))
        using (var r = cmd.ExecuteReader())
            while (r.Read()) used.Add(r.GetString(0));
        for (var i = 1; i < 100000; i++)
        {
            var name = $"图层{i}";
            if (!used.Contains(name)) return name;
        }
        return $"图层{used.Count + 1}";
    }

    public static ApiResult ListViewLayers(string taskId)
    {
        using var c = ProtoDb.Open();
        if (Scalar(c, "SELECT id FROM tasks WHERE id=@id", ("@id", taskId)) is null)
            return ApiResult.Fail(404, Reasons.TaskNotFound, $"任务 {taskId} 不存在");

        var list = new List<object>();
        using var cmd = Q(c, "SELECT id,task_id,name,created_at_utc,updated_at_utc,payload_json FROM view_layers WHERE task_id=@t ORDER BY created_at_utc", ("@t", taskId));
        using var r = cmd.ExecuteReader();
        while (r.Read()) list.Add(LayerSummary(r));
        return ApiResult.Ok(new { layers = list });
    }

    public static ApiResult GetViewLayer(string id)
    {
        using var c = ProtoDb.Open();
        using var cmd = Q(c, "SELECT id,task_id,name,payload_json,created_at_utc,updated_at_utc FROM view_layers WHERE id=@id", ("@id", id));
        using var r = cmd.ExecuteReader();
        if (!r.Read()) return ApiResult.Fail(404, "view-layer-not-found", $"视图图层 {id} 不存在");
        var payloadJson = r.GetString(3);
        return ApiResult.Ok(new
        {
            id = r.GetString(0), taskId = r.GetString(1), name = r.GetString(2),
            payload = JsonSerializer.Deserialize<JsonElement>(payloadJson),
            modes = LayerModes(payloadJson),
            createdAtUtc = r.GetString(4), updatedAtUtc = r.GetString(5)
        });
    }

    private static ApiResult? ValidateLayerInput(string? name, string? payload, bool requirePayload)
    {
        if (name is not null && name.Trim().Length > 60)
            return ApiResult.Fail(400, Reasons.TitleTooLong, $"图层名最长 60 字，当前 {name.Trim().Length} 字");
        if (payload is null)
            return requirePayload ? ApiResult.Fail(400, Reasons.BadRequest, "payload 必填（保存当前视图快照）") : null;
        if (payload.Length > ViewPayloadMax)
            return ApiResult.Fail(400, Reasons.BadRequest, "视图快照超过 4 MB，先减少图层内容");
        try { JsonDocument.Parse(payload); }
        catch (JsonException) { return ApiResult.Fail(400, Reasons.BadRequest, "payload 必须是合法 JSON"); }
        return null;
    }

    public static ApiResult CreateViewLayer(string taskId, ViewLayerSpec req)
    {
        using var c = ProtoDb.Open();
        if (Scalar(c, "SELECT id FROM tasks WHERE id=@id", ("@id", taskId)) is null)
            return ApiResult.Fail(404, Reasons.TaskNotFound, $"任务 {taskId} 不存在");

        var bad = ValidateLayerInput(req.Name, req.Payload, true);
        if (bad is not null) return bad;

        var name = (req.Name ?? "").Trim();
        if (name.Length == 0) name = NextLayerName(c, taskId);
        var id = "vl_" + Guid.NewGuid().ToString("N")[..10];
        var now = Now();
        Exec(c, "INSERT INTO view_layers(id,task_id,name,payload_json,created_at_utc,updated_at_utc) VALUES(@id,@t,@n,@p,@now,@now)",
            ("@id", id), ("@t", taskId), ("@n", name), ("@p", req.Payload), ("@now", now));
        return ApiResult.Created(new { id, taskId, name, createdAtUtc = now, updatedAtUtc = now });
    }

    public static ApiResult UpdateViewLayer(string id, ViewLayerSpec req)
    {
        using var c = ProtoDb.Open();
        var existing = Scalar(c, "SELECT payload_json FROM view_layers WHERE id=@id", ("@id", id)) as string;
        if (existing is null) return ApiResult.Fail(404, "view-layer-not-found", $"视图图层 {id} 不存在");

        var bad = ValidateLayerInput(req.Name, req.Payload, false);
        if (bad is not null) return bad;

        var name = req.Name is null ? null : req.Name.Trim();
        if (name is { Length: 0 })
            return ApiResult.Fail(400, Reasons.BadRequest, "图层名不能为空");
        if (name is not null)
            Exec(c, "UPDATE view_layers SET name=@n, updated_at_utc=@now WHERE id=@id", ("@n", name), ("@now", Now()), ("@id", id));
        if (req.Payload is not null)
            Exec(c, "UPDATE view_layers SET payload_json=@p, updated_at_utc=@now WHERE id=@id", ("@p", req.Payload), ("@now", Now()), ("@id", id));

        using var cmd = Q(c, "SELECT id,task_id,name,created_at_utc,updated_at_utc,payload_json FROM view_layers WHERE id=@id", ("@id", id));
        using var r = cmd.ExecuteReader();
        r.Read();
        return ApiResult.Ok(new { layer = LayerSummary(r) });
    }

    public static ApiResult DeleteViewLayer(string id)
    {
        using var c = ProtoDb.Open();
        var deleted = ExecCount(c, "DELETE FROM view_layers WHERE id=@id", ("@id", id));
        if (deleted == 0) return ApiResult.Fail(404, "view-layer-not-found", $"视图图层 {id} 不存在");
        return ApiResult.Ok(new { deleted = id });
    }
}
