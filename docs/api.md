# 接口契约：动作、门、拒因码、钉死的口径

入口：[README](../README.md) ｜ 架构：[architecture.md](architecture.md) ｜ 画布功能：[features.md](features.md) ｜ 验收：[acceptance.md](acceptance.md)

端点表在 `Program.cs`（48 个端点），业务按域分在 16 个 `Proto.*.cs`（`partial class Proto`，导航见 `backend\WorkProto.Api\索引.md`）；本文件是"调什么、什么情况下拒绝、拒绝码叫什么"的唯一正文。

## 一、动作与端点

| 动作 | 端点 | 要点 |
| --- | --- | --- |
| 建图 | `POST /api/tasks`、`DELETE /api/tasks/{id}` | 一次贴齐节点 / 边 / 规则组 / 循环；原型清理用删除 |
| 导入 bundle | `POST /api/import` | 新建任务并重映射节点/边/组/循环/视图 ID；恢复工作流结构与当前视图，不恢复执行状态；格式为 `workproto.bundle`（version 1） |
| 认领与排队 | `POST /api/tasks/{id}/claim`、`POST /api/tasks/{id}/release` | 同一 agent 可持多个任务，**同时只跑一个**，其余 `queued`；释放后按 `seq` 自动接上 |
| 放行 | `POST /api/nodes/{id}/start`、`/complete`、`/rework`、`POST /api/tasks/{id}/pick` | 门判 `all / any / k_of_n / pick_one`；放行写 `releases`，幂等靠唯一键；不满足返回 409 + 缺哪条入边 |
| 检查点 | `POST /api/tasks/{id}/checkpoint`、`POST /api/cycles/{id}/raise`、`POST /api/nodes/{id}/unblock` | 三句话 + 起止时间 + verdict 落库；轮次满先出检查点，判无进展才 `blocked` |
| 读 | `GET /api/tasks`、`/api/tasks/{id}/graph`、`/api/nodes/{id}` | 页面只用这三个，不新增第二套语义 |
| 图增量 | `POST /api/tasks/{id}/nodes`、`/edges`、`/cycles`、`DELETE /api/nodes/{id}` | 往已有图里加节点 / 加线 / 声明循环 / 删掉未起步的节点；**校验与建图同一套**（见第二节） |
| 画布 | `POST /api/nodes/{id}/move`、`POST /api/tasks/{id}/layout`、`POST /api/nodes/{id}/ports` | 单个/批量落坐标（框选一起拖只发一次请求）；改接线口数量（1–12）；位置与口数是展示/接线状态，不写 events 业务语义 |
| 节点属性 | `POST /api/nodes/{id}/props` | 改标题 / 一行目标 / 类型；只改给了的项，写一条 `node-update` 事件。循环区不在这里改（见 [features.md](features.md) 第八节·循环区并进节点组） |
| 节点组 | `POST /api/tasks/{id}/node-groups`、`POST /api/node-groups/{id}/nodes/{nodeId}`、`POST /api/node-groups/{id}/collapse`、`POST/DELETE /api/node-groups/{id}/loop`、`DELETE /api/node-groups/{id}[?withNodes=true]` | 分组（`node_groups` + `nodes.group_id` + `collapsed`）**同时就是循环区的载体**：`/nodes/{nodeId}` 把未分组单节点并入已有组（同组重复调用幂等）；`/loop` 声明 head/tail/上限并自动连回边，`DELETE /loop` 撤销；删组默认只解散，`withNodes=true` 才连节点一起删且要求整组都删得起；循环组要先撤循环才能删 |
| 节点收纳 | `POST /api/nodes/{id}/compact` | `level` 三档：0 完整 / 1 仅标题 / 2 仅关键字（一行目标）；纯看图状态，不写 events；也收 `collapsed=true` 当 1 用 |
| 连线 | `GET/POST/DELETE /api/edges/{id}`、`POST /api/edges/{id}/confirm` | 点连线可改走向/类型/端口/门控；门控 `auto`（上游做完就放行）或 `human`（还要人点头）；人工门控未确认 → 不写放行记录，拒因 `gate-needs-confirm`；已放行过的线只允许放宽门控与改备注 |
| 组布局缓存 | `POST /api/node-groups/{id}/layout` | 存组内**相对坐标**（dx/dy，原点为成员内容左上角）；只收本组成员，最多 500 个；纯看图状态，不写 events |
| 视图图层 | `GET/POST /api/tasks/{id}/view-layers`、`GET/POST/DELETE /api/view-layers/{id}` | 命名快照：紧凑/组视角/是否允许覆盖、展开收起、坐标、组内缓存、视口；列表回带 `modes` 标签（`group-view` / `compact` / `stack`）；同一任务可保存任意多个；payload 必须合法 JSON（≤4MB）；默认名 `图层1/图层2…`；**只存视图，不复制节点结构** |
| 预设 | `GET /api/templates`、`POST/DELETE /api/templates/nodes|groups`、`POST /api/tasks/{id}/apply-node-template|apply-group-template` | 模板库跨任务：节点预设（标题/目标/类型/口数）与组预设（节点 + 组名 + 组内 transfer 线，按相对坐标）。套用组预设＝整块落节点＋补组内连线＋圈成一个组 |
| 体检 | `GET /api/health` | 脚本起来前探活用 |

## 二、图增量：与建图同一套规则（别另立一套）

1. **方向必填**：`from`/`to` 都要在同一个任务里存在，否则 `400 unknown-node`；不从画布位置猜顺序。
2. **判重用签名**：`(task, from, to, kind, target_step_id, graph_version)` 命中即 `409 edge-duplicate`；同一条线不因为「再画一次」变成两份输入。**端口不参与判重**——多口不能让同一条线变成两份输入。
3. **kind 两值**：`transfer`（传递）/`loop`（回边）。普通线自环 → `409 loop-needs-cycle`；回边两端必须同一个组、且那个组已声明循环，否则同样是 `loop-needs-cycle`（文案写清缺哪一半）。
4. **画线即生成门**（09 表二的约定）：目标节点原来没有规则组 → 建 `all` 组，且把**已有入边一并纳入**（不能只放新线，否则旧边被悄悄忽略）；已有组 → 并入，`pick_one` 下作为新候选。
5. **加线会重算门**：上游已 `approved` 时新线立刻写放行记录并尝试起步下游（材料本来就在手，不该白等）；已经 `active/approved` 的节点不会被打回。
6. **回边不触发执行**：连上只改结构，真正进下一轮仍由尾节点完成时的循环逻辑决定。

## 三、门与放行

- `input_groups.mode`：`all`（全等）/`any`（任一）/`k_of_n`（够 `need_count` 条）/`pick_one`（择一，选过就不再改）。
- `edges.gate`：`auto`＝上游做完就放行；`human`＝上游做完还得有人在这条线上点头（`POST /api/edges/{id}/confirm`）。未点头时 `TryRelease` 根本不写放行记录，下游保持 `pending`，`GET /api/nodes/{id}` 的拒因直接写 `gate-needs-confirm`。
- 点头幂等：只更新盖章字段再补一次放行，重复调用返回 `activated: []`；放行本身的幂等靠 `releases` 唯一键。
- 已放行过的线是**冻结的**：不许改走向/类型、不许删、不许**事后**加人工门控（那是假账）；只允许放宽成 `auto` 与改备注，三种情况同一个原因码 `edge-already-released`，文案分别说清。

## 四、拒因码

| 码 | 什么时候 | 状态码 |
| --- | --- | --- |
| `no-nodes` | 任务里没有节点就认领 | 409 |
| `nothing-to-do:waiting` | 全在等上游，不是死锁；任务保持 `open` | 409 |
| `nothing-to-do:blocked` | 有节点 `blocked`，得先解除 | 409 |
| `gate-unsatisfied` | 门没满足，details 里给缺哪条入边与原因 | 409 |
| `gate-needs-confirm` | 人工门控还没点头 | 409（作为节点拒因出现） |
| `node-not-active` | 对不在 `active` 的节点做完成/返工 | 409 |
| `pick-already-decided` | 择一组已经选过还再选 | 409 |
| `blocked-release-forbidden` | 想用 release 解除阻塞 | 409 |
| `task-not-found` / `node-not-found` / `edge-not-found` / `node-group-not-found` / `template-not-found` | 对象不存在 | 404 |
| `edge-duplicate` | 判重签名命中，或 `id` 已存在 | 409 |
| `edge-already-released` | 改走向/删/事后加闸门 | 409 |
| `loop-needs-cycle` | 自环走了普通线，或回边不在已声明的循环组里 | 409 |
| `cycle-exists` / `group-is-loop` | 同一个组重复声明循环；直接删循环组 | 409 |
| `node-has-edges` / `node-not-pending` | 删节点时挂着线 / 已经起步 | 409 |
| `node-group-needs-two` / `node-group-not-deletable` | 建组不足两个成员；`withNodes=true` 时组里有删不起的（整批不动） | 400 / 409 |
| `node-already-grouped` | 把已在别的组里的节点再加入另一组 | 409 |
| `port-out-of-range` / `port-in-use` | 取不存在的接线口 / 把口缩到还有线挂着的口以下 | 400 / 409 |
| `title-required` / `kind-invalid` / `bad-request` | 参数不合规（含图层 payload 非 JSON、超过 4MB、图层名为空） | 400 |
| `view-layer-not-found` | 视图图层不存在 | 404 |
| `unknown-node` | 端点不在这个任务里 | 400 |

## 五、文档没定死、这里替你钉住的五处

1. **轮次号 = 节点 `cycle_epoch`**，不是计数器「已跑几轮 +1」。判据：`completed < limit` 才允许进入下一轮；`completed == limit` 时**不执行第 N+1 轮**，先要检查点。默认上限 3（口径 4），`limit_kind=perpetual` 可关掉上限。
2. **检查点判「有进展」不自动续跑**：循环停在轮次上限（`paused_reason=limit-reached`），要 master/lead 调高上限才继续，调高写 `cycles.raised_by/raised_reason/raised_at_utc` + 一条 `cycle-raise` 事件。理由是「只有人能调高上限」这条口径不能靠模型自觉。
3. **择一未选分支落 `skipped` 的条件**：该节点已 `approved`、且它在这条边之外的出边要么没有、要么都指向已决的择一组。别的分支还有去处就不动它。
4. **`nothing-to-do` 分两种**：有 `blocked` → `nothing-to-do:blocked`；只是全在等上游 → `nothing-to-do:waiting`，任务保持 `open`，不产生僵尸租约。
5. **放行幂等与循环不被误去重**按签字实现：`UNIQUE(edge_id,to_node_id,node_attempt,cycle_epoch)` + `INSERT OR IGNORE`；`node_attempt = 目标节点 attempt+1`，循环每轮 `cycle_epoch+1`。`target_step_id TEXT NOT NULL DEFAULT ''` 已按②预留，一期恒空。

## 六、视图图层与组缓存（0.4.11）

- **组缓存是相对坐标**：`node_groups.layout_json` 存 `[{id,dx,dy}]`，`dx/dy` 相对组内容左上角；组移动时相对关系不变。前端按成员 id 取用，缺失成员直接忽略。
- **整理分两种**：选中组只整理该组；全局整理按依赖排组、组内一律用各自缓存（没有缓存才现算一份并写回）。整理是视图操作，原视图的节点绝对坐标不写库；`Ctrl+Z` 可撤销。
- **图层是看法不是数据**：`view_layers.payload_json` 只放显示坐标、组内缓存、模式开关与视口；节点、连线、组的结构仍只有一份。切图层不改节点表。
- **未保存提醒**：当前视图有改动时，切图层/切任务会弹「保存为图层 / 不保存 / 取消」；不保存则丢弃这次视图操作，已保存图层留在右栏。
- **不做的**：方案分支的结构化探索、连线直接接节点组——按主人要求顺延到 0.4.12。
