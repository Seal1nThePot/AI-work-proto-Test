// ────────── ProtoDb.cs ──────────「库与 DDL」
// 用途: 库路径解析、连接与 PRAGMA、整份 DDL、老库补列与搬家（核对表结构只看这个文件）
// 暴露: ProtoDb.DbPath Open Schema
// 依赖: 无
// 被依赖: Proto.Infra.cs（全部 SQL 走这里拿连接）
using Microsoft.Data.Sqlite;

namespace WorkProto.Api;

/// <summary>原型库：自带 SQLite 文件，不连 SkyOps 库。</summary>
public static class ProtoDb
{
    public static string DbPath { get; } = ResolvePath();

    // Pooling=True：连接复用，省掉每请求开库 + 关库时那趟 WAL 检查点（实测每请求 3~5 ms）。
    // 不用 Cache=Shared：单进程 + WAL 下没有收益，反而和连接池叠在一起容易吃到表锁。
    public static string ConnectionString => $"Data Source={DbPath};Pooling=True";

    private static readonly object WalGate = new();
    private static bool _walReady;

    private static string ResolvePath()
    {
        var env = Environment.GetEnvironmentVariable("PROTO_DB");
        if (!string.IsNullOrWhiteSpace(env)) return Path.GetFullPath(env);
        var dir = Path.Combine(AppContext.BaseDirectory, "data");
        Directory.CreateDirectory(dir);
        return Path.Combine(dir, "proto.db");
    }

    /// <summary>
    /// 提交成本的两个开关（2026-10-28 实测：本机一次 WAL 提交等 fsync ≈ 33 ms，8 次自提交 = 266 ms，
    /// 这就是「画一条线要等 0.3 秒」的真身，跟图有多大没关系）：
    /// ①journal_mode 是库级持久设置，只切一次，不用每条连接都 PRAGMA 一遍；
    /// ②synchronous 是连接级、不持久，每条连接都要说，WAL 下用 NORMAL——提交不再等磁盘，
    ///   进程崩了已提交的还在，只有整机掉电才可能丢最后几笔（原型可接受；
    ///   要严格耐久设 PROTO_SYNC=FULL 变回每笔等磁盘）。
    /// </summary>
    public static SqliteConnection Open()
    {
        Directory.CreateDirectory(Path.GetDirectoryName(DbPath)!);
        var conn = new SqliteConnection(ConnectionString);
        conn.Open();
        var sync = Environment.GetEnvironmentVariable("PROTO_SYNC");
        sync = string.IsNullOrWhiteSpace(sync) ? "NORMAL" : sync.Trim().ToUpperInvariant();
        using (var pragma = conn.CreateCommand())
        {
            pragma.CommandText = $"PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000; PRAGMA synchronous={sync};";
            pragma.ExecuteNonQuery();
        }
        if (!_walReady)
        {
            lock (WalGate)
            {
                if (!_walReady)
                {
                    using var wal = conn.CreateCommand();
                    wal.CommandText = "PRAGMA journal_mode=WAL;";
                    wal.ExecuteNonQuery();
                    _walReady = true;
                }
            }
        }
        return conn;
    }

    /// <summary>六张业务表 + 留痕表。node_attempt 从 1 起，cycle_epoch 非循环恒 1。</summary>
    public const string Schema = """
        CREATE TABLE IF NOT EXISTS tasks (
          id           TEXT PRIMARY KEY,
          title        TEXT NOT NULL,
          goal_line    TEXT NOT NULL DEFAULT '',
          status       TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','running','done')),
          created_at_utc TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS nodes (
          id             TEXT PRIMARY KEY,
          task_id        TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
          title          TEXT NOT NULL,
          goal_line      TEXT NOT NULL DEFAULT '',
          kind           TEXT NOT NULL DEFAULT 'work' CHECK (kind IN ('work','review_auto','review_human')),
          status         TEXT NOT NULL DEFAULT 'pending'
                         CHECK (status IN ('pending','active','review','approved','blocked','skipped')),
          seq            INTEGER NOT NULL,
          attempt        INTEGER NOT NULL DEFAULT 0,
          cycle_region   TEXT,
          cycle_epoch    INTEGER NOT NULL DEFAULT 1,
          blocked_reason TEXT,
          spec           TEXT,
          artifact_state TEXT NOT NULL DEFAULT 'none' CHECK (artifact_state IN ('none','declared','delivered')),
          artifact_desc  TEXT,
          active_since_utc TEXT,
          pos_x          INTEGER,
          pos_y          INTEGER,
          in_ports       INTEGER NOT NULL DEFAULT 1,
          out_ports      INTEGER NOT NULL DEFAULT 1,
          compact        INTEGER NOT NULL DEFAULT 0,
          updated_at_utc TEXT NOT NULL
        );
        CREATE UNIQUE INDEX IF NOT EXISTS ux_nodes_task_seq ON nodes(task_id, seq);

        CREATE TABLE IF NOT EXISTS edges (
          id            TEXT PRIMARY KEY,
          task_id       TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
          from_node_id  TEXT NOT NULL,
          to_node_id    TEXT NOT NULL,
          kind          TEXT NOT NULL DEFAULT 'transfer' CHECK (kind IN ('transfer','loop')),
          transfer_condition TEXT NOT NULL DEFAULT 'auto',
          target_step_id     TEXT NOT NULL DEFAULT '',
          from_port          INTEGER NOT NULL DEFAULT 0,
          to_port            INTEGER NOT NULL DEFAULT 0,
          gate               TEXT NOT NULL DEFAULT 'auto',
          gate_note          TEXT NOT NULL DEFAULT '',
          gate_confirmed_by  TEXT,
          gate_confirmed_at_utc TEXT,
          graph_version      INTEGER NOT NULL DEFAULT 1,
          UNIQUE(task_id, from_node_id, to_node_id, kind, target_step_id, graph_version)
        );

        CREATE TABLE IF NOT EXISTS input_groups (
          id          TEXT PRIMARY KEY,
          task_id     TEXT NOT NULL,
          node_id     TEXT NOT NULL,
          mode        TEXT NOT NULL CHECK (mode IN ('all','any','k_of_n','pick_one')),
          need_count  INTEGER NOT NULL DEFAULT 0,
          items_json  TEXT NOT NULL DEFAULT '[]',
          chosen_edge_id TEXT,
          decided_at_utc TEXT
        );
        CREATE UNIQUE INDEX IF NOT EXISTS ux_groups_node ON input_groups(node_id);

        CREATE TABLE IF NOT EXISTS releases (
          id             TEXT PRIMARY KEY,
          task_id        TEXT NOT NULL,
          edge_id        TEXT NOT NULL,
          to_node_id     TEXT NOT NULL,
          node_attempt   INTEGER NOT NULL,
          cycle_epoch    INTEGER NOT NULL,
          graph_version  INTEGER NOT NULL DEFAULT 1,
          released_at_utc TEXT NOT NULL,
          released_by    TEXT NOT NULL,
          UNIQUE(edge_id, to_node_id, node_attempt, cycle_epoch)
        );

        CREATE TABLE IF NOT EXISTS cycles (
          id            TEXT PRIMARY KEY,
          task_id       TEXT NOT NULL,
          region_key    TEXT NOT NULL,
          group_id      TEXT,
          head_node_id  TEXT NOT NULL,
          tail_node_id  TEXT NOT NULL,
          limit_count   INTEGER NOT NULL DEFAULT 3,
          limit_kind    TEXT NOT NULL DEFAULT 'bounded' CHECK (limit_kind IN ('bounded','perpetual')),
          visited       INTEGER NOT NULL DEFAULT 0,
          paused_reason TEXT,
          raised_by     TEXT,
          raised_reason TEXT,
          raised_at_utc TEXT,
          UNIQUE(task_id, region_key)
        );

        CREATE TABLE IF NOT EXISTS node_groups (
          id             TEXT PRIMARY KEY,
          task_id        TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
          title          TEXT NOT NULL,
          collapsed      INTEGER NOT NULL DEFAULT 0,
          created_at_utc TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS node_templates (
          id             TEXT PRIMARY KEY,
          name           TEXT NOT NULL,
          title          TEXT NOT NULL,
          goal_line      TEXT NOT NULL DEFAULT '',
          kind           TEXT NOT NULL DEFAULT 'work',
          in_ports       INTEGER NOT NULL DEFAULT 1,
          out_ports      INTEGER NOT NULL DEFAULT 1,
          created_at_utc TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS group_templates (
          id             TEXT PRIMARY KEY,
          name           TEXT NOT NULL,
          payload_json   TEXT NOT NULL,
          created_at_utc TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS checkpoints (
          id             TEXT PRIMARY KEY,
          task_id        TEXT NOT NULL,
          node_id        TEXT NOT NULL,
          cycle_visit    INTEGER NOT NULL DEFAULT 0,
          started_at_utc TEXT NOT NULL,
          ended_at_utc   TEXT NOT NULL,
          doing          TEXT NOT NULL,
          next_step      TEXT NOT NULL,
          goal           TEXT NOT NULL,
          verdict        TEXT NOT NULL CHECK (verdict IN ('progress','no_progress')),
          created_by     TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS leases (
          id             TEXT PRIMARY KEY,
          agent          TEXT NOT NULL,
          task_id        TEXT NOT NULL,
          seq            INTEGER NOT NULL,
          state          TEXT NOT NULL CHECK (state IN ('active','queued','released')),
          created_at_utc TEXT NOT NULL,
          expires_at_utc TEXT,
          released_at_utc TEXT
        );
        CREATE UNIQUE INDEX IF NOT EXISTS ux_lease_active ON leases(agent) WHERE state = 'active';

        CREATE TABLE IF NOT EXISTS events (
          id      INTEGER PRIMARY KEY AUTOINCREMENT,
          task_id TEXT,
          node_id TEXT,
          kind    TEXT NOT NULL,
          by      TEXT NOT NULL,
          body    TEXT NOT NULL DEFAULT '',
          at_utc  TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS ix_events_node ON events(node_id, at_utc);
        """;

    public static void EnsureSchema()
    {
        using var conn = Open();
        using (var cmd = conn.CreateCommand())
        {
            cmd.CommandText = Schema;
            cmd.ExecuteNonQuery();
        }
        // 老库补列：SQLite 的 ADD COLUMN 没有 IF NOT EXISTS，先查 pragma_table_info
        AddColumnIfMissing(conn, "nodes", "pos_x", "INTEGER");
        AddColumnIfMissing(conn, "nodes", "pos_y", "INTEGER");
        AddColumnIfMissing(conn, "nodes", "in_ports", "INTEGER NOT NULL DEFAULT 1");
        AddColumnIfMissing(conn, "nodes", "out_ports", "INTEGER NOT NULL DEFAULT 1");
        AddColumnIfMissing(conn, "edges", "from_port", "INTEGER NOT NULL DEFAULT 0");
        AddColumnIfMissing(conn, "edges", "to_port", "INTEGER NOT NULL DEFAULT 0");
        AddColumnIfMissing(conn, "edges", "gate", "TEXT NOT NULL DEFAULT 'auto'");
        AddColumnIfMissing(conn, "edges", "gate_note", "TEXT NOT NULL DEFAULT ''");
        AddColumnIfMissing(conn, "edges", "gate_confirmed_by", "TEXT");
        AddColumnIfMissing(conn, "edges", "gate_confirmed_at_utc", "TEXT");
        AddColumnIfMissing(conn, "nodes", "group_id", "TEXT");
        AddColumnIfMissing(conn, "nodes", "compact", "INTEGER NOT NULL DEFAULT 0");
        AddColumnIfMissing(conn, "node_groups", "collapsed", "INTEGER NOT NULL DEFAULT 0");
        AddColumnIfMissing(conn, "cycles", "group_id", "TEXT");
        MigrateLoopsIntoGroups(conn);
    }

    /// <summary>
    /// 老库搬家：循环区从「节点上的 cycle_region 字符串」改成「由节点组承载」。
    /// 每条还没有 group_id 的 cycles 行，按 region_key 找一个同名组（没有就建一个），
    /// 把该区里的节点归进这个组，再把 cycles.group_id 补上。可重复执行。
    /// </summary>
    private static void MigrateLoopsIntoGroups(SqliteConnection conn)
    {
        var todo = new List<(string Id, string TaskId, string RegionKey)>();
        using (var cmd = conn.CreateCommand())
        {
            cmd.CommandText = "SELECT id,task_id,region_key FROM cycles WHERE group_id IS NULL";
            using var r = cmd.ExecuteReader();
            while (r.Read()) todo.Add((r.GetString(0), r.GetString(1), r.GetString(2)));
        }
        foreach (var (id, taskId, regionKey) in todo)
        {
            string? groupId;
            using (var q = conn.CreateCommand())
            {
                q.CommandText = "SELECT id FROM node_groups WHERE task_id=@t AND title=@title LIMIT 1";
                q.Parameters.AddWithValue("@t", taskId);
                q.Parameters.AddWithValue("@title", regionKey);
                groupId = q.ExecuteScalar() as string;
            }
            if (groupId is null)
            {
                groupId = "grp_" + Guid.NewGuid().ToString("N")[..10];
                using var ins = conn.CreateCommand();
                ins.CommandText = "INSERT INTO node_groups(id,task_id,title,created_at_utc) VALUES(@id,@t,@title,@now)";
                ins.Parameters.AddWithValue("@id", groupId);
                ins.Parameters.AddWithValue("@t", taskId);
                ins.Parameters.AddWithValue("@title", regionKey);
                ins.Parameters.AddWithValue("@now", DateTime.UtcNow.ToString("O"));
                ins.ExecuteNonQuery();
            }
            using (var up = conn.CreateCommand())
            {
                up.CommandText = "UPDATE nodes SET group_id=@g WHERE task_id=@t AND cycle_region=@r AND (group_id IS NULL OR group_id='')";
                up.Parameters.AddWithValue("@g", groupId);
                up.Parameters.AddWithValue("@t", taskId);
                up.Parameters.AddWithValue("@r", regionKey);
                up.ExecuteNonQuery();
            }
            using (var up2 = conn.CreateCommand())
            {
                up2.CommandText = "UPDATE cycles SET group_id=@g WHERE id=@id";
                up2.Parameters.AddWithValue("@g", groupId);
                up2.Parameters.AddWithValue("@id", id);
                up2.ExecuteNonQuery();
            }
        }
    }

    private static void AddColumnIfMissing(SqliteConnection conn, string table, string column, string type)    {
        using (var check = conn.CreateCommand())
        {
            check.CommandText = $"SELECT COUNT(*) FROM pragma_table_info('{table}') WHERE name = '{column}'";
            if (Convert.ToInt32(check.ExecuteScalar()) > 0) return;
        }
        using var alter = conn.CreateCommand();
        alter.CommandText = $"ALTER TABLE {table} ADD COLUMN {column} {type}";
        alter.ExecuteNonQuery();
    }
}
