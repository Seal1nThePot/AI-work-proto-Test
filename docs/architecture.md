# 架构：单进程 · 一个库 · 手写 SVG

入口：[README](../README.md) ｜ 接口契约：[api.md](api.md) ｜ 画布功能：[features.md](features.md) ｜ 验收：[acceptance.md](acceptance.md)

## 一、进程与端口

一个 `dotnet WorkProto.Api.dll` 进程同时干两件事：`/api/*` 的 REST 与 `wwwroot` 里的静态页。没有前端构建链、没有第二个进程、没有依赖另一个服务。

| 项 | 值 |
| --- | --- |
| 页面 | `http://127.0.0.1:5081/`（`run-proto.cmd` 起） |
| 环境变量 | `PROTO_PORT`（端口）、`PROTO_DB`（库路径）、`PROTO_AGENT`（默认操作者名）、`PROTO_SYNC`（`NORMAL`/`FULL`，见第五节） |
| 库 | `data\proto.db`（可删，删了重启即空库；`verify` 脚本各自用临时库） |
| 构建 | `dotnet build backend\WorkProto.Api\WorkProto.Api.csproj`（net10.0 + Microsoft.Data.Sqlite） |
| 静态资源 | 直接 `dotnet xxx.dll` 起服务时 ContentRoot 要指到 `AppContext.BaseDirectory`，且 csproj 里 `wwwroot\**\*` 设 `CopyToOutputDirectory=PreserveNewest`，否则页面 404 |

## 二、代码地图

```
backend\WorkProto.Api\
  ProtoDb.cs       库路径解析、连接与 PRAGMA、整份 DDL（要核对表结构就看这个文件）、老库补列与搬家
  Program.cs       端点表（一一对上 api.md 的表）
  Proto.ApiResult.cs   统一返回体（Ok/Created/Fail）
  Proto.Reasons.cs     拒因码常量表
  Proto.Contracts.cs   请求体 record 全集
  Proto.Rows.cs        四张表的行模型（NodeRow/EdgeRow/GroupRow/CycleRow）
  Proto.Infra.cs       事务(AsyncLocal)/Q·Exec·Event/行映射/读节点读边读组
  Proto.Gate.cs        门判定：缺哪条边、拒因、放行（写 released_at）
  Proto.Propagate.cs   传播：激活后继 / 跳过未选 / 循环迭代
  Proto.Lease.cs       认领与租约回收
  Proto.Lifecycle.cs   开始/完成/返工/择一/跳过/检查点/提上限/解阻塞
  Proto.Read.cs        读端点：列表、摘要、整图、单节点
  Proto.NodeWrite.cs   建节点/改端口/改属性/移动 + 端口与类型白名单
  Proto.Group.cs       节点组与循环区：建/收纳/展开/删、声明与撤销循环
  Proto.Edge.cs        连线：建/读/改/删、人工门确认
  Proto.Template.cs    模板库：节点/组模板增删查与应用
  Proto.Task.cs        任务级：建图 / 删任务 / 删节点
  wwwroot\
    index.html     工具栏 + 画布容器 + 右栏面板的骨架
    src\           已按层切出 4 个文件（P2）：00-const（常量）/ 01-state（状态）/ 02-dom（$ esc cut fmt showToast）/ 03-api（api + 取数）
      ↑ 顺序即依赖，index.html 里的 <script src> 是唯一真相源
    app.js         还没切走的部分：渲染、手势、选区、拖动、连线、面板、抽屉式收纳（逐阶段继续切）
    style.css      所有视觉与选择态（`.picked` / `.focus` / `.edge-focus` / `.edge-dim` 都在 CSS 里）
```

分层原则：**业务判定只在后端 `Proto.*.cs`**（15 个 `partial class Proto`，编译器眼里仍是一个类），页面不复制一份语义；页面只负责「看得见」与「发请求」。每个文件前四行写着 `用途/暴露/依赖/被依赖`，`索引.md` 由 `tools/gen-index.mjs` 生成。

## 三、数据层

### 表

六张业务表加辅助表，DDL 在 `ProtoDb.cs` 的 `Schema` 常量里（可直接对）：

| 表 | 干什么 |
| --- | --- |
| `tasks` | 任务（`open/running/done`） |
| `nodes` | 节点：`seq`、`status`、`attempt`、`cycle_region`(镜像)、`cycle_epoch`、`blocked_reason`、`pos_x/pos_y`、`in_ports/out_ports`、`group_id`、`compact` |
| `edges` | 连线：`kind`(transfer/loop)、`target_step_id`、`graph_version`、`from_port/to_port`、`gate/gate_note`、`gate_confirmed_by/at_utc` |
| `input_groups` | 每个目标节点一份输入规则组：`mode`、`need_count`、`items_json`、`chosen_edge_id` |
| `releases` | 放行记录，幂等靠 `UNIQUE(edge_id,to_node_id,node_attempt,cycle_epoch)` |
| `cycles` | 循环区：`group_id`（真身，挂在节点组上）、`region_key`（组名的显示镜像）、`limit_count`、`raised_*` |
| `checkpoints` | 检查点：三句话、起止时间、verdict、轮次号 |
| `node_groups` | 节点组：`title`、`collapsed` |
| `node_templates` / `group_templates` | 跨任务预设 |
| `leases` / `events` | 租约、只追加留痕 |

老库升级不删库：`CREATE TABLE IF NOT EXISTS` 补不出新列，所以有一步 `AddColumnIfMissing`（先查 `pragma_table_info` 再 `ALTER TABLE ADD COLUMN`）；循环区从「节点上的字符串」搬到「节点组」的那次迁移是 `MigrateLoopsIntoGroups`，每次启动可重复执行。

### 连接与提交

```csharp
// ProtoDb.cs
ConnectionString => $"Data Source={DbPath};Pooling=True";
每条连接：PRAGMA foreign_keys=ON; busy_timeout=5000; synchronous=NORMAL;
首次连接：PRAGMA journal_mode=WAL;   // 库级持久设置，只切一次
```

- **为什么这么配**：`synchronous=FULL` 下每条自提交语句都要等一次 fsync（本机 33.6 ms），`POST /edges` 一句要落 8 行就是 266 ms——这才是「画一条线要等 0.3 秒」的真身，跟图多大无关。数字与对照见第六节。
- **耐久性**：`NORMAL` 下进程崩了已提交的还在；整机掉电可能丢最后几笔。要严格耐久 `PROTO_SYNC=FULL`，同一份代码跑回每笔等磁盘。
- **不设 `Cache=Shared`**：单进程 + WAL 没收益，和连接池叠着容易吃表锁。

### 一次写请求的路径

以 `POST /api/tasks/{id}/edges` 为例（`AddEdge`）：

1. 开连接 → `WriteBatch`（一个事务）；
2. 任务/端点存在性 → 判重签名 → 环规则 → 端口范围 → 门控取值，任一不过 `ApiResult.Fail` 早退（**事务随 `using` 回滚，半写的图不会留下**）；
3. 写 `edges` 一行；
4. 目标节点没有规则组 → 建 `all` 组（**把已有入边一并纳入**）；有则并入（`pick_one` 下当新候选）；
5. 上游已 `approved` → `TryRelease` 写 `releases` 并起步下游；
6. `Settle` 把下游能起步的起步；
7. 两条 `events`（`group-create`/`group-append` + `edge-create`）→ `Commit`。

事务怎么挂上去的：`SqliteConnection.Transaction` 是 internal，取不到，所以用 `AsyncLocal<SqliteTransaction?>` 存「环境事务」，`Q()` 建每条命令时自动 `cmd.Transaction = 环境事务`（并校验连接是同一个）。写方法只要 `using var batch = new WriteBatch(c);` … `batch.Commit();` 就是一段原子操作。

守卫顺序有讲究：**先命中的原因码会掩盖后面的分支**。删节点先判 `pending` 再判有没有连线，所以"起步过的节点"永远先吃 `node-has-edges`，`node-not-pending` 在原型里事实上到不了——别为不可达分支写断言。

## 四、前端架构（零构建，手写 SVG + 原生 JS）

### 图层

```
<svg>
  <g id="graph">          ← 画布内容，尺寸随内容长（不设固定宽高）
    <g id="viewport">     ← 平移/缩放只改这个 g 的 transform
      底纹 / 循环框 / 组框 / 连线层 / 节点层 / 覆盖层（吸附参考线、临时连线、选框）
```

平移缩放只改 `viewport` 的 `transform`，坐标换算是 `world = (屏幕 - rect 原点 - 平移) / 缩放`；底纹的 `backgroundPosition/backgroundSize` 跟着平移与缩放走，所以看起来是"一张无限大的纸"。世界坐标**可以为负**，`±1e6` 只是防垃圾兜底。

### 状态

`state` 里几块互不干扰的：

| 字段 | 是什么 | 落不落库 |
| --- | --- | --- |
| `graph` | 最近一次 `GET graph` 的结果（**渲染的真值**） | 库的镜像 |
| `selected` / `selectedIds` / `selectedGroup` / `selectedEdge` | 选区 | 否 |
| `viewport` | 平移与缩放 | 否（刷新复位） |
| `drag` / `snap` | 拖动过程、吸附参考线 | 否 |
| `collapsedChains` | 同向链收没收起（存链头节点 id） | **否，刻意只在内存** |
| `paintedKey` | 上次画的选择态指纹 | 否 |

### 渲染

- `render()` 按 `graph.nodes[].posX/posY` 重算布局 → 生成整棵 SVG（节点、线、组框、链块）；`layout()` 里算出 `p.w/p.h`，所以**端口均分、连线端点、框选命中、组框包围盒、fit 全部自动跟着卡片尺寸走**，不需要各自特判。
- 渲染末尾调 `paintSelection()`，把选中态以类名补上（`.picked` / `.focus` / `.edge-focus` / `.edge-dim`）。
- **选中不改数据、只改类名**：点一下的成本是 0.4 ms 而不是整图重绘 56–89 ms。类型与样式全在 `style.css`，`nodeClass(n)` / `edgeClass(e)` 由渲染与重绘共用，不会两处漂移。
- 渲染后建索引（连线元素表、边表、出入邻接表），拖动只重算**与该节点相连的线**和**它所在的组框/循环框**。
- `loadGraph()` 比对 JSON 指纹：内容没变就不重绘（5 秒轮询绝大多数是空转）；本地已改过的结构（拖动落库、乐观插线）会先 `syncGraphJson()` 同步指纹。

### 手势

`pointerdown` 只做判定（点了什么、是不是抓手）→ `pointermove` 写坐标 / 记候选 → `pointerup` 落库。**拖动阈值 `DRAG_START = 3px`**：1–2 px 的抖动不算拖动，否则点击会被吞掉。真拖动过就置 `suppressClick`，吃掉浏览器补的那颗 `click`（那颗 click 会拿旧坐标重绘，表现为"松手弹回原位"）。

## 五、性能设计

### 拖动（前端三处）

1. **视口只量一次**：`getBoundingClientRect()` 强制重排，原来每次 `pointermove` 都调；现在按下时量一次存进 `state.view`。
2. **一帧一次**：`pointermove` 只记坐标，重绘交给 `requestAnimationFrame` 合并。
3. **只算相关的**：建索引，只重算相关连线与所在的组框/循环框，不再遍历整图、不再 `querySelector` 逐条找。
4. 仍只改被拖节点的 `transform` 与相关 path 的 `d`，**不整图重绘**——整图重绘会换掉正在拖的 DOM 节点，手势当场断。但**位置要同步写进 DOM**（跟手性），只有连线重绘走 rAF。

### 写操作（后端：提交等磁盘）

`synchronous=FULL` 下每条自提交语句等一次 fsync，实测 33.6 ms/次。判重早退那条路不写库，只要 6 ms —— 两条路径差 40 倍，正好对上「0.3 秒且与数据量无关」。

| 接口（demo，9 节点） | 改前 `PROTO_SYNC=FULL` | 现在 `NORMAL` | 倍数 |
| --- | --- | --- | --- |
| `POST /nodes/{id}/move`（1 次提交） | 42.2 ms | **5.4 ms** | 7.8× |
| `POST /edges`（新建，8 次提交） | 60.7 ms | **14.6 ms** | 4.2× |
| `POST /edges`（判重早退，不写库） | 6.3 ms | 5.8 ms | 1.1× |
| `GET graph` | 7.4 ms | 7.0 ms | 1.1× |
| 16 条并发画线（墙钟） | 1025 ms | **100 ms** | 10× |

第三行是**对照组**（不写库，数字不动），用来证明提速来自提交，不是连接、不是查询。客户端壳约 4–5 ms 算在里面。复核：`pwsh -File verify\run-perf.ps1`（自起 5090 + 临时库，两种口径各跑一遍出这张表，跑完自清）。

一处**记错的账**（留在这儿防复发）：`ReadNodes()` 原来是「1 条查 id + N 条逐个读」，改成一条查询后 1000 节点只快 3 ms（4.7 → 1.8 ms）；`GET graph` 的 34/78 ms 里大头是 473 KB 的序列化与传输，不是查询。改得更简单可以，别指望它提速。

### 渲染（150 节点样板，无头 Chrome 实测）

`node verify\run-canvas-bench.mjs`（造图脚本 `verify\seed-complex.mjs`）：

| 项 | 值 |
| --- | --- |
| 图 | 150 节点 / 233 连线 / 8 组（其中 1 个循环区、1 个收纳成牌） |
| 真画的 DOM | 142 张节点卡（H 组 8 个被收纳）× 226 条线 × 452 个端口圈，`#graph` 内共 1977 个元素 |
| `render()` | **6.9–7.6 ms**（全量重建） |
| `fitView()` | 8.6 ms（46% 缩放塞进视口） |
| payload | 101.7 KB，`JSON.parse` 不到 1 ms |
| 控制台报错 | 无 |

同一条路径放大到 1000 节点是 56–89 ms——所以"点一下卡一下"从来不是命中判定，是整图重建；这也是 `paintSelection()`（只改类名，0.4 ms）存在的理由。

### 自动整理（按组布局）

`arrangeByGroups()` 只算坐标，不碰语义，算完走一次 `POST /tasks/{id}/layout` 落库：

1. **组序**＝跨组 `transfer` 边的拓扑序（环按 seq 垫后，未分组节点当最后一列）；
2. **一组一块，横向依次挨着放**（前后排列，不折行），块间 240；组块按最高的一块纵向居中对齐——出口接到下一个入口时看起来是一条直线；
3. **组内**按依赖分层（最长路径），层内先按**前驱重心**定目标 y，再自上而下排开避免重叠，最后**整列按目标重心对齐**——扇出点居中、汇合点落在几个分支的中间，于是「1 → 3~4 → 1」是看得出来的沙漏。整条主线会很长（150 节点约 29000 px），全局看靠总览、细节靠平移，这是刻意分工。

`fitView()` 只按**画出来的东西**算包围盒（可见节点 + 牌 + 链框）；曾经把「已收进牌里的组」的链框也算进去，包围盒虚高十倍，缩放一路掉到下限——这类"看不见的东西撑大 bbox"的 bug 只会在多组图上冒头。

### 没做的

`GET graph` 的 ETag / `If-None-Match`：1000 节点 473 KB、78 ms 主要是序列化 + 传输，但前端 `JSON.parse` 只要 0.4 ms，5 秒一次的轮询收益太小，不值得引入缓存失效。

## 六、并发与幂等

- SQLite 写者串行 + `busy_timeout=5000`：16 条新线同时画，两轮共 32 条全部 201，无 `SQLITE_BUSY`。
- 放行幂等靠库而不是靠代码记忆：`UNIQUE(edge_id,to_node_id,node_attempt,cycle_epoch)` + `INSERT OR IGNORE`，`node_attempt = 目标 attempt+1`，循环每轮 `cycle_epoch+1`（所以循环不会被误去重）。
- 一个 agent 可持多个任务但**同时只跑一个**（口径 2，仅原型生效），释放后按 `seq` 自动接上。
- 批量操作（批量删坐标、删组连节点）**要么全成要么全不动**并点名谁挡住的，不做"删了一半"。
