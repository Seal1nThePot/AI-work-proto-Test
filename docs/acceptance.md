# 验收：176 项接口断言 + 231 项页面断言 + 16 条守恒

入口：[README](../README.md) ｜ 架构：[architecture.md](architecture.md) ｜ 接口契约：[api.md](api.md) ｜ 画布功能：[features.md](features.md)

```powershell
pwsh -File verify\run-acceptance.ps1   # 接口：自起 5082 + 临时库，跑完自清        176 项
pwsh -File verify\run-ui-smoke.ps1     # 页面：自起 5083 + 临时库，DOM 桩跑真页面脚本  231 项
pwsh -File verify\run-perf.ps1         # 服务端往返延迟对照表（FULL vs NORMAL）
pwsh -File verify\seed-demo.ps1        # 灌三个 demo 任务到 data\proto.db
node verify\seed-complex.mjs           # 造 150 节点复杂任务 tsk-150-demo（结构走 REST、进度刷库）
node verify\run-canvas-bench.mjs       # 无头 Chrome 量渲染成本 + 截图
pwsh -File verify\run-split-check.ps1  # 拆分守恒检查（拆的是文件不是函数；红了说明搬丢了东西）
```

设计任务不好靠肉眼截图验收，所以页面侧的办法是：**用极简 DOM 桩在 Node 里加载真的页面脚本**（`wwwroot\src\*.js` 按 `index.html` 的 `<script src>` 顺序拼接；0.4.8 起 `app.js` 已不存在）（`document.getElementById` 换成 Map 缓存的对象桩、`fetch` 前缀成临时库地址），直接调页面自己的函数走「按钮 → 表单 → 调接口 → 回显」整条链路。带手势的交互（拖动、双击、右键拖连）之所以可测，是因为手势层只做"取坐标 + 判定落点"，再调命名动作函数（`saveNodePosition` / `requestNodeAt` / `connectNodes` / `createTask`）——测动作函数即可，手势层只剩几行翻译代码。

## 一、接口场景（`run-acceptance.ps1`）

| # | 场景 | 断言要点 |
| --- | --- | --- |
| 1 | 0 节点任务 | 认领 409 `no-nodes`，文案写明「没有节点」 |
| 2 | 全孤立节点 | 三个节点同时 `active`，不报死锁 |
| 3 | 择一 3 选 1 | 选中走到 `approved`、未选落 `skipped`、进度 100%；二次择一 409 |
| 4 | 回边循环 | 第 1、2 轮正常进下一轮；**第 3 轮跑完先要检查点**，判无进展 → `blocked(cycle-limit)`；owner 调高上限 403、lead 调高后回到第 4 轮 |
| 5 | 检查点 | 三句话、起止时间、verdict、轮次号都查得到；循环内的检查点带 `cycleVisit=3` |
| 6 | 拒绝语义 | 每条拒绝都有原因码：`no-nodes` / `nothing-to-do:waiting` / `nothing-to-do:blocked` / `gate-unsatisfied`（含缺哪条边与原因）/ `node-not-active` / `pick-already-decided` / `blocked-release-forbidden` / `task-not-found` |
| 7 | 排队（口径 2） | 同一 agent 第二个任务 `queued`，释放第一个后自动接上并起步 |
| 8 | 新建节点 | 标题必填、`kind` 三选一、`seq` 不撞号、`id` 不重名；不传 `seq` 自动排末尾；带 `cycleRegion` 但没 `cycles` 行时给补齐提示 |
| 9 | 新建连线 | 画线自动生成输入规则组（已有组则并入，`pick_one` 作为新候选）；上游已完工就立刻放行下游；同一条线重复建 409；端点不在本任务 400；普通线不许自环 |
| 10 | 回边与循环 | 循环区＝**节点组**：回边两端必须同组、且该组已声明循环，否则 409 并说明缺什么；声明循环会自动建 tail→head 的回边；循环组不能直接删（`group-is-loop`）；撤销循环＝删回边与上限、组留着 |
| 11 | 删节点（防手滑） | 只删得起「从未起步 + 没挂线」的 `pending` 节点；挂线的 409 `node-has-edges`，已起步的 409 `node-not-pending` |
| 12 | 自定义接线口 | 建图/新建节点时可指定 `inPorts/outPorts`（1–12）；连线记住 `fromPort/toPort`；取不存在的口 400 `port-out-of-range`；缩到已占用口之下 409 `port-in-use` |
| 13 | 批量落坐标 | 框选一起拖只发一次 `POST /tasks/{id}/layout`；`nodes` 为空 400；混进不存在的节点 404 `node-not-found`，整批不落地 |
| 14 | 画布没有边缘 | 单个与批量都能落到**负坐标**且读得回来；`±1000000` 只是防垃圾兜底、不是画布边界 |
| 15 | 节点组 | `POST /tasks/{id}/node-groups` 至少两个成员；`graph` 回带 `nodeGroups` 且成员带 `groupId`；一个节点 400 `node-group-needs-two`；混入不存在节点 400 `unknown-node`；`POST /node-groups/{id}/nodes/{nodeId}` 把未分组单节点并入（重复同组幂等）；`DELETE /node-groups/{id}` **只解散不删节点**；删不存在的组 404 `node-group-not-found`；`POST /node-groups/{id}/collapse` 收纳/展开且随图回带；`DELETE ?withNodes=true` 连节点一起删、组里有删不起的**整批拒绝** `node-group-not-deletable` |
| 16 | 点节点改属性 | `POST /nodes/{id}/props` 改标题/一行目标/类型，回带 `changed`；改空标题 400 `title-required`、类型不合法 400 `kind-invalid`；没差别时 `changed` 为空且不写事件；**循环区不再挂在节点上**（传了给 400 并指路节点组） |
| 17 | 组收纳与两种删除 | `POST /node-groups/{id}/collapse` 收纳/展开且随图回带；`DELETE ?withNodes=true` 连节点一起删、组里有删不起的**整批拒绝** `node-group-not-deletable` |
| 18 | 节点收纳三档 | `POST /nodes/{id}/compact {level}` 0/1/2 且随图回带；越界 400 `bad-request`；也收 `collapsed=true` 当 1 用；不存在节点 404 |
| 19 | 连线本身与门控 | `GET/POST/DELETE /api/edges/{id}`：改走向/类型/端口/门控；**human 门控未点头时上游做完下游仍 pending，拒因 `gate-needs-confirm`**；`POST /edges/{id}/confirm` 点头后立刻放行并起步下游、重复点头幂等；已放行过的线 409 `edge-already-released`（不许改走向、不许事后加闸门、不许删），但可以放宽成 auto；删线后目标节点的规则组按现存入边重算；非法 gate 400 |
| 20 | 预设 | `POST /templates/nodes`（可挂 nodeId 快照或直接给字段）、`POST /templates/groups`（挂 groupId 快照，2 节点 1 线）；`GET /templates` 列两类；`POST /tasks/{id}/apply-node-template` 按给定坐标落节点；`POST /tasks/{id}/apply-group-template` 整块落节点 + 补组内线 + 圈成同名组、左上角落在给定坐标；套不存在预设 404 `template-not-found`；删预设 200 |
| 21 | 循环区＝组＋回边＋检查点 | 给组声明循环（201，自动带回边、成员 `cycleRegion` 镜像组名）；同一个组重复声明 409 `cycle-exists`；跨组回边 409 `loop-needs-cycle`；循环组不能删（409 `group-is-loop`）；撤销循环（200，回边一并删掉）之后组能删；节点属性里改循环区已废弃（400 指路节点组） |
| 22 | 组内相对布局缓存 | `POST /node-groups/{id}/layout` 存 `{id,dx,dy}` 并随 `GET graph` 回带；非组员 400 `unknown-node`；空数组清空缓存 |
| 23 | 视图图层 | 空表、保存/读/改名/删除；列表与单读回带 `modes`（紧凑/组视角/重叠）；可并存多个图层；默认名 `图层1/图层2…`；payload 非 JSON 400 `bad-request`；不存在 404 `view-layer-not-found`；图层只存视图、不复制节点结构 |

## 二、页面断言（`run-ui-smoke.ps1`，231 项）

拖动落坐标且刷新后仍在；双击空白按落点建节点；右键连线建组并起步下游；重复连线回显 `edge-duplicate`；普通线自环被拒；**新建任务目标允许为空**、建后切到空图；空标题前端拦下；表单路径与节点详情仍通；**节点画出进出线口、出线口起手锚在右缘、Shift 锚在底部、连线端点随坐标重算、小角度/近距离连线走直线且大角度才弯**；**无级缩放突破旧 0.2–2.5 上下限、普通视图拉远后每组只显示组名称、紧凑视图不被 LOD 误折叠、坐标轴与节点/组一起平移缩放、空格复原到工作流视图中心**；**导出 bundle 同时包含工作流与当前视图，导入后新建任务并重映射 ID、自动打开导入视图**；缩放锚点、框选多选、跟手性、负坐标与底纹跟随、**拖动不回弹**、Shift 左右/前后吸附（两轴各四候选）、**双击直接建节点、点节点改属性且改动自动同步、右键菜单、建组/删组、组框内新节点右键/按 `G` 加入最近组**、**收纳与展开、拖牌整组走、删组连节点**、**拖组名/组边框整组走、点组名选中、点空白取消选中**、**节点收纳成仅标题/仅关键字、点节点高亮相连线**、**点连线看/改走向·端口·门控，人工门控点头才放行**、**选中节点/连线/组按 Delete 直接删**、**节点/组预设存一次到处套**、**双击标题快收快开、同向链五合一收成一块（纯前端）**；**整理选中组只动该组、全局整理保留组内缓存、组视角收牌+束线、紧凑/堆叠视图按组缓存压成紧凑块且组块靠近、默认允许覆盖、关闭覆盖后碰撞检测整体展开且所有节点框不重叠、视图图层可并存多个且带模式标签、同名更新、改名另存、改名不新建、重名拒绝、切换图层恢复对应显示模式、Ctrl+Z 撤销视图操作、未保存视图切换时提醒丢弃**。

细节分别在：[features.md](features.md)（无边缘、拖动与吸附、组与收纳、连线面板、Delete、预设、链、视图与图层）。页面断言里的保存提醒用 `state.viewPromptChoice = "discard"` 直接指定选择，避免测试卡在弹窗上。

## 三、性能证据

不是靠"感觉顺了"：拖动的视口换算次数与排帧次数在桩里计数断言；服务端往返有 `run-perf.ps1` 的两种口径对照表（含不写库的阴性对照）。数字见 [architecture.md](architecture.md) 第五节·性能设计。

## 四、测不到的地方（别当成没 bug）

- `node-not-pending` 在原型里**事实上到不了**：守卫先判 `node-has-edges`（没有删边接口后，起步过的节点必然还挂着线）。别为不可达分支写断言。
- 认领 / 完成 / 检查点 / 择一 / 解除阻塞只有 REST 路径，页面没有按钮——这部分只有接口断言。
- 视图图层的「保存/不保存」弹窗在 DOM 桩里用 `state.viewPromptChoice` 指定选择；真实弹窗的点击由手工浏览器验证。
- 视图图层只覆盖看法；在图层里改节点结构仍会落到主图（结构性方案分支按 0.4.12 再做）。
- 1000 节点量级的拖动与渲染没有进自动验收，是手工用 CDP 量过的（150 节点：`render()` 6.9 ms、1977 个 DOM、`fitView()` 8.6 ms；1000 节点：渲染 56–89 ms、命中 0.4 ms、拖动帧 0.03–0.07 ms）。`run-canvas-bench.mjs` 是这套手验的脚本化版本。
