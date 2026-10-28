// ────────── Proto.Rows.cs ──────────「表行模型」
// 用途: 四张表的行模型：NodeRow / EdgeRow / GroupRow / CycleRow（required 字段对齐 DDL）
// 暴露: NodeRow EdgeRow GroupRow CycleRow
// 依赖: 无
// 被依赖: Proto.Infra / Read / NodeWrite / Edge / Group
using System.Text.Json;
using Microsoft.Data.Sqlite;

namespace WorkProto.Api;

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
