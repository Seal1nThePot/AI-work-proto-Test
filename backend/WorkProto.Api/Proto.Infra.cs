// ────────── Proto.Infra.cs ──────────「事务与查询基建」
// 用途: 基建：AsyncLocal 事务、Q/Exec/ExecCount/Scalar、事件写、行映射与读节点/读边/读组
// 暴露: Now LeaseMinutes Resolvers WriteBatch Q Exec ExecCount Scalar Event NodeColumns MapNode ReadNode ReadNodes ReadEdges ReadNodeGroups NodeDto NodeGroupRow
// 依赖: Proto.Rows.cs
// 被依赖: 其余全部 Proto.*.cs
using System.Text.Json;
using Microsoft.Data.Sqlite;

namespace WorkProto.Api;

public static partial class Proto
{
    private const int LeaseMinutes = 30;

    private static readonly string[] Resolvers = ["master", "lead"];

    public static string Now() => DateTime.UtcNow.ToString("O");

    /// <summary>
    /// 一次写操作要落多行（连线 + 规则组 + 放行 + 留痕）时，整段包进一个事务：
    /// 要么全成要么全不动，顺便把「每行一次提交」变成一次提交。
    /// 事务挂在 AsyncLocal 上，由 Q 自动接到每条命令（SqliteConnection.Transaction 是 internal，取不到）。
    /// </summary>
    private static readonly AsyncLocal<SqliteTransaction?> AmbientTx = new();

    private sealed class WriteBatch : IDisposable
    {
        private readonly SqliteTransaction _tx;
        private bool _done;
        public WriteBatch(SqliteConnection c)
        {
            _tx = c.BeginTransaction();
            AmbientTx.Value = _tx;
        }
        public void Commit()
        {
            _tx.Commit();
            _done = true;
        }
        public void Dispose()
        {
            if (!_done) _tx.Rollback();
            _tx.Dispose();
            AmbientTx.Value = null;
        }
    }

    private static SqliteCommand Q(SqliteConnection c, string sql, params (string Name, object? Value)[] args)
    {
        var cmd = c.CreateCommand();
        cmd.CommandText = sql;
        // 连接上已经开着事务时命令必须挂同一个事务（Microsoft.Data.Sqlite 会校验）
        var tx = AmbientTx.Value;
        if (tx is not null && ReferenceEquals(tx.Connection, c)) cmd.Transaction = tx;
        foreach (var (name, value) in args) cmd.Parameters.AddWithValue(name, value ?? DBNull.Value);
        return cmd;
    }

    private static void Exec(SqliteConnection c, string sql, params (string, object?)[] args)
    {
        using var cmd = Q(c, sql, args);
        cmd.ExecuteNonQuery();
    }

    private static int ExecCount(SqliteConnection c, string sql, params (string, object?)[] args)
    {
        using var cmd = Q(c, sql, args);
        return cmd.ExecuteNonQuery();
    }

    private static object? Scalar(SqliteConnection c, string sql, params (string, object?)[] args)
    {
        using var cmd = Q(c, sql, args);
        return cmd.ExecuteScalar();
    }

    private static void Event(SqliteConnection c, string? taskId, string? nodeId, string kind, string by, string body = "")
        => Exec(c, "INSERT INTO events(task_id,node_id,kind,by,body,at_utc) VALUES(@t,@n,@k,@b,@body,@at)",
            ("@t", taskId), ("@n", nodeId), ("@k", kind), ("@b", by), ("@body", body), ("@at", Now()));

    // ---------- 读 ----------

    private const string NodeColumns = "id,task_id,title,goal_line,kind,status,seq,attempt,cycle_region,cycle_epoch,blocked_reason,artifact_state,active_since_utc,pos_x,pos_y,in_ports,out_ports,group_id,compact";

    private static NodeRow MapNode(SqliteDataReader r) => new()
    {
        Id = r.GetString(0), TaskId = r.GetString(1), Title = r.GetString(2), GoalLine = r.GetString(3),
        Kind = r.GetString(4), Status = r.GetString(5), Seq = r.GetInt32(6), Attempt = r.GetInt32(7),
        CycleRegion = r.IsDBNull(8) ? null : r.GetString(8), CycleEpoch = r.GetInt32(9),
        BlockedReason = r.IsDBNull(10) ? null : r.GetString(10), ArtifactState = r.GetString(11),
        ActiveSinceUtc = r.IsDBNull(12) ? null : r.GetString(12),
        PosX = r.IsDBNull(13) ? null : r.GetInt32(13),
        PosY = r.IsDBNull(14) ? null : r.GetInt32(14),
        InPorts = r.GetInt32(15), OutPorts = r.GetInt32(16),
        GroupId = r.IsDBNull(17) ? null : r.GetString(17),
        Compact = r.GetInt32(18)
    };

    private static NodeRow? ReadNode(SqliteConnection c, string id)
    {
        using var cmd = Q(c, $"SELECT {NodeColumns} FROM nodes WHERE id=@id", ("@id", id));
        using var r = cmd.ExecuteReader();
        return r.Read() ? MapNode(r) : null;
    }

    private sealed record NodeGroupRow(string Id, string TaskId, string Title, bool Collapsed);

    private static List<NodeGroupRow> ReadNodeGroups(SqliteConnection c, string taskId)
    {
        var list = new List<NodeGroupRow>();
        using var cmd = Q(c, "SELECT id,task_id,title,collapsed FROM node_groups WHERE task_id=@t ORDER BY created_at_utc", ("@t", taskId));
        using var r = cmd.ExecuteReader();
        while (r.Read()) list.Add(new NodeGroupRow(r.GetString(0), r.GetString(1), r.GetString(2), r.GetInt32(3) != 0));
        return list;
    }

    private static object NodeDto(NodeRow n) => new
    {
        id = n.Id, taskId = n.TaskId, seq = n.Seq, title = n.Title, goalLine = n.GoalLine, kind = n.Kind,
        status = n.Status, attempt = n.Attempt, cycleRegion = n.CycleRegion, cycleEpoch = n.CycleEpoch,
        blockedReason = n.BlockedReason, artifactState = n.ArtifactState, posX = n.PosX, posY = n.PosY,
        inPorts = n.InPorts, outPorts = n.OutPorts, groupId = n.GroupId, compact = n.Compact
    };

    private static List<NodeRow> ReadNodes(SqliteConnection c, string taskId)
    {
        // 一条查询拿全部节点（以前是 1 条查 id + N 条逐个读，1000 个节点白花 34 ms）
        var list = new List<NodeRow>();
        using var cmd = Q(c, $"SELECT {NodeColumns} FROM nodes WHERE task_id=@t ORDER BY seq", ("@t", taskId));
        using var r = cmd.ExecuteReader();
        while (r.Read()) list.Add(MapNode(r));
        return list;
    }

    private static List<EdgeRow> ReadEdges(SqliteConnection c, string taskId)
    {
        var list = new List<EdgeRow>();
        using var cmd = Q(c, "SELECT id,task_id,from_node_id,to_node_id,kind,transfer_condition,target_step_id,graph_version,from_port,to_port,gate,gate_note,gate_confirmed_by,gate_confirmed_at_utc FROM edges WHERE task_id=@t", ("@t", taskId));
        using var r = cmd.ExecuteReader();
        while (r.Read())
        {
            list.Add(new EdgeRow
            {
                Id = r.GetString(0), TaskId = r.GetString(1), FromNodeId = r.GetString(2), ToNodeId = r.GetString(3),
                Kind = r.GetString(4), TransferCondition = r.GetString(5), TargetStepId = r.GetString(6), GraphVersion = r.GetInt32(7),
                FromPort = r.GetInt32(8), ToPort = r.GetInt32(9),
                Gate = r.GetString(10), GateNote = r.GetString(11),
                GateConfirmedBy = r.IsDBNull(12) ? null : r.GetString(12),
                GateConfirmedAt = r.IsDBNull(13) ? null : r.GetString(13)
            });
        }
        return list;
    }
}
