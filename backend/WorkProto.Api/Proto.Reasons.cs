// ────────── Proto.Reasons.cs ──────────「拒因码常量表」
// 用途: 拒因码常量表（28 个），前端与验收脚本按字面值断言
// 暴露: Reasons（全部 const）
// 依赖: 无
// 被依赖: Proto.* 全部写操作、docs\api.md 的拒因表
using System.Text.Json;
using Microsoft.Data.Sqlite;

namespace WorkProto.Api;

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
