// ────────── Proto.Contracts.cs ──────────「请求体 record」
// 用途: 请求体 record 全集：建任务 / 认领 / 检查点 / 择一 / 移动 / 端口 / 组 / 循环 / 模板
// 暴露: NodeSpec EdgeSpec EdgePatchRequest GroupSpec CycleSpec CreateTaskRequest ClaimRequest ByRequest CheckpointRequest PickRequest RaiseRequest MoveRequest MoveBatchRequest PortsRequest NodeGroupSpec CollapseRequest CompactRequest NodePatchRequest LoopSpecRequest NodeTemplateSpec GroupTemplateSpec ApplyTemplateRequest
// 依赖: 无
// 被依赖: Program.cs（请求体绑定）、Proto.Task / Edge / NodeWrite / Group / Template / Lifecycle
using System.Text.Json;
using Microsoft.Data.Sqlite;

namespace WorkProto.Api;

public sealed record NodeSpec(string? Id, string Title, string? GoalLine, string? Kind, int? Seq, string? CycleRegion, int? X = null, int? Y = null, int? InPorts = null, int? OutPorts = null);

public sealed record EdgeSpec(string? Id, string From, string To, string? Kind, int? FromPort = null, int? ToPort = null, string? Gate = null, string? GateNote = null);

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

public sealed record GroupLayoutItem(string? Id, int? Dx, int? Dy);

public sealed record GroupLayoutRequest(GroupLayoutItem[]? Nodes);

public sealed record ViewLayerSpec(string? Name, string? Payload);

public sealed record MoveBatchRequest(MoveNodeItem[]? Nodes);

public sealed record PortsRequest(int? InPorts, int? OutPorts);

public sealed record NodeGroupSpec(string? Id, string? Title, string[]? NodeIds);

public sealed record CollapseRequest(bool? Collapsed);

public sealed record CompactRequest(int? Level, bool? Collapsed);

public sealed record NodePatchRequest(string? Title, string? GoalLine, string? Kind, string? CycleRegion);

public sealed record LoopSpecRequest(string? Head, string? Tail, int? Limit, string? LimitKind);

public sealed record NodeTemplateSpec(string? NodeId, string? Name, string? Title, string? GoalLine, string? Kind, int? InPorts, int? OutPorts);

public sealed record GroupTemplateSpec(string? GroupId, string? Name, string[]? NodeIds);

public sealed record ApplyTemplateRequest(string? TemplateId, int? X, int? Y);
