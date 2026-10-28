// ────────── Proto.Gate.cs ──────────「门与放行」
// 用途: 门判定：算缺哪条边、给拒因、满足则放行（写 released_at）
// 暴露: ReleasedEdges IsResolved Gate GateItem EvaluateGate ReasonFor GateDto TryRelease
// 依赖: Proto.Infra.cs
// 被依赖: Proto.Propagate.cs Proto.Lifecycle.cs Proto.NodeWrite.cs Proto.Edge.cs
using System.Text.Json;
using Microsoft.Data.Sqlite;

namespace WorkProto.Api;

public static partial class Proto
{
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
}
