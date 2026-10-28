// ────────── 01-state.js ──────────「全局状态」
// 用途: 全局状态单例：图与任务、选区、视口、同向链、节点组、脏边、右键项、模板快照（19 字段 + 8 个 Map/Set）
// 暴露: state
// 依赖: 无
// 被依赖: 全部脚本

const state = {
  tasks: [],
  taskId: null,
  graph: null,
  overview: false,           // 总览模式：组收成牌、牌子按组的先后排成格子（纯前端看法）
  overviewOrder: [],
  selected: null,            // 当前看详情的那个节点
  selectedEdge: null,        // 当前选中的那条连线（点线看门控）
  selectedGroup: null,       // 当前选中的节点组（点组标签/收纳牌）
  selectedChain: null,       // 当前选中的同向链块（点链块）
  selectedIds: new Set(),    // 框选/多选集合
  // 同向链＝纯前端看法：成员每次按边现算，收没收起只记在内存里（后端一点不动）
  chains: [],
  chainByMember: new Map(),  // 节点 id → 它所在的那条链
  collapsedChains: new Set(),// 收起来的链（存链头节点 id）
  chainRects: new Map(),
  chainBoxEls: new Map(),
  chainFrameEls: new Map(),
  chainFrameLabelEls: new Map(),
  chainIndex: null,          // 当前图的进出边索引（算链用，每次重绘重建）
  positions: new Map(),
  timer: null,
  drag: null,
  connect: null,
  pendingPos: null,
  marquee: null,
  pan: null,
  // 视口：rect 缓存给坐标换算，viewport 给 scale/平移
  view: null,
  viewport: { scale: 1, tx: 0, ty: 0 },
  fittedFor: null,
  frame: null,
  dirtyEdges: new Set(),
  align: null,              // 当前吸附参考线（第一条，兼容老断言）
  aligns: [],               // 全部吸附参考线（左右一条 + 前后一条）
  suppressClick: false,     // 刚拖过就别再让 click 触发整图重绘
  nodesById: new Map(),
  groupEls: new Map(),      // 节点组的框
  groupChipEls: new Map(),  // 节点组的标签（唯一可点/可右键的地方）
  ctxItems: [],             // 右键菜单项
  templates: null,          // 模板库快照（面板用）
  cycleByGroup: new Map(),  // 组 id → 它的 cycles 行（组＋回边＋检查点＝循环区）
  edgeEls: new Map(),
  edgesById: new Map(),
  incident: new Map(),
  nodeEls: new Map(),
  cycleEls: new Map(),
  cycleLabelEls: new Map()
};
