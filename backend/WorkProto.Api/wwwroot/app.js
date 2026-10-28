// ────────── app.js ──────────「画布主逻辑」
// 用途: 画布剩余逻辑：布局、渲染、手势、面板、表单、写操作、装配（P2 只切走常量/状态/DOM 工具/取数四个文件，其余原样留在这里，逐阶段继续切）
// 暴露: （全部顶层函数与 state 的消费方）
// 依赖: src/00-const.js src/01-state.js src/02-dom.js src/03-api.js
// 被依赖: index.html

// ---------------- 布局 ----------------

function autoDepths(graph) {
  const depth = new Map(graph.nodes.map((n) => [n.id, 0]));
  const byId = new Map(graph.nodes.map((n) => [n.id, n]));
  const transfer = graph.edges.filter((e) => e.kind === "transfer");
  for (let i = 0; i < graph.nodes.length + 1; i++) {
    for (const e of transfer) {
      if (!byId.has(e.fromNodeId) || !byId.has(e.toNodeId)) continue;
      if (byId.get(e.fromNodeId).status === "skipped") continue;
      depth.set(e.toNodeId, Math.max(depth.get(e.toNodeId), depth.get(e.fromNodeId) + 1));
    }
  }
  return depth;
}

function layout(graph) {
  const depth = autoDepths(graph);
  const columns = new Map();
  for (const n of graph.nodes) {
    const d = depth.get(n.id) || 0;
    if (!columns.has(d)) columns.set(d, []);
    columns.get(d).push(n);
  }
  const pos = new Map();
  for (const d of [...columns.keys()].sort((a, b) => a - b)) {
    columns.get(d).sort((a, b) => a.seq - b.seq).forEach((n, i) => {
      const hasPos = Number.isFinite(n.posX) && Number.isFinite(n.posY);
      const level = n.compact || 0;
      pos.set(n.id, {
        x: hasPos ? n.posX : 40 + d * (NODE_W + NODE_GAP_X),
        y: hasPos ? n.posY : 60 + i * (NODE_H + NODE_GAP_Y),
        w: level ? COMPACT_W : NODE_W,
        h: level ? COMPACT_H : NODE_H,
        inPorts: Math.max(1, n.inPorts || 1),
        outPorts: Math.max(1, n.outPorts || 1)
      });
    });
  }
  return pos;
}

/** 组的先后：按跨组的 transfer 边做拓扑排序（环就按 seq 接在后面），未分组节点当最后一列。 */
function groupOrder(graph) {
  const ids = (graph.nodeGroups || []).map((g) => g.id);
  const hasLoose = graph.nodes.some((n) => !n.groupId);
  if (hasLoose) ids.push(LOOSE_KEY);
  const keyOf = (n) => n.groupId || LOOSE_KEY;
  const seqOf = new Map();
  for (const n of graph.nodes) {
    const k = keyOf(n);
    seqOf.set(k, Math.min(seqOf.get(k) ?? Number.MAX_SAFE_INTEGER, n.seq));
  }
  const succ = new Map(ids.map((i) => [i, new Set()]));
  const indeg = new Map(ids.map((i) => [i, 0]));
  const byId = new Map(graph.nodes.map((n) => [n.id, n]));
  for (const e of graph.edges) {
    if (e.kind !== "transfer") continue;
    const a = byId.get(e.fromNodeId), b = byId.get(e.toNodeId);
    if (!a || !b) continue;
    const ka = keyOf(a), kb = keyOf(b);
    if (ka === kb || !succ.has(ka) || !succ.has(kb)) continue;
    if (succ.get(ka).has(kb)) continue;
    succ.get(ka).add(kb);
    indeg.set(kb, indeg.get(kb) + 1);
  }
  const bySeq = (x, y) => (seqOf.get(x) ?? 0) - (seqOf.get(y) ?? 0);
  const ready = ids.filter((i) => indeg.get(i) === 0).sort(bySeq);
  const order = [];
  while (ready.length) {
    const cur = ready.shift();
    order.push(cur);
    for (const nx of succ.get(cur)) {
      indeg.set(nx, indeg.get(nx) - 1);
      if (indeg.get(nx) === 0) { ready.push(nx); ready.sort(bySeq); }
    }
  }
  for (const i of ids.filter((x) => !order.includes(x)).sort(bySeq)) order.push(i);   // 组间有环：剩下的按 seq 接在后面
  return order;
}

/**
 * 自动整理：一列一列按组的先后摆块，块内按依赖深度从左到右、由上到下。
 * 只算坐标（不碰任何语义），算完照常走 POST /tasks/{id}/layout 落库。
 * 目标宽度 SHELF_W：摆满就换行，免得 8 个组排成一条望不到头的长龙。
 */
const LOOSE_KEY = "__loose__";
const COL_PITCH = NODE_W + 64;    // 层与层的水平间距：一束线要有地方散开
const ROW_GAP = 34;

/**
 * 组内布局＝按依赖分层，不是网格。
 * 三合一的汇合点自己占一列，纵向对准那三个的重心；它再长出三条时，下一列就以它为中心上下摊开
 * —— 这样「3 → 1 → 3」在图上是一个看得出来的沙漏，而不是一堆并排的方块。
 * 组内不折行：一条流从左往右走到底（画布本来就没边），折成上下几条带会把「前后」读丢。
 * BAND 只是极端兜底（真有一百多层才换带）。
 */
const BAND = 64;
function groupLayered(list, edges) {
  const ids = new Set(list.map((n) => n.id));
  const preds = new Map(list.map((n) => [n.id, []]));
  for (const e of edges) {
    if (e.kind !== "transfer" || e.fromNodeId === e.toNodeId) continue;
    if (!ids.has(e.fromNodeId) || !ids.has(e.toNodeId)) continue;
    preds.get(e.toNodeId).push(e.fromNodeId);
  }
  // 最长路径分层（有环时用节点数兜底，不会转死）
  const layer = new Map(list.map((n) => [n.id, 0]));
  for (let it = 0; it < list.length; it++) {
    let changed = false;
    for (const [to, ps] of preds) {
      for (const p of ps) {
        const v = layer.get(p) + 1;
        if (v > layer.get(to) && v < list.length) { layer.set(to, v); changed = true; }
      }
    }
    if (!changed) break;
  }
  const layers = [];
  for (const n of list) {
    const L = layer.get(n.id);
    (layers[L] || (layers[L] = [])).push(n);
  }
  const pos = new Map();
  const centerY = new Map();
  let bandTopY = 0;
  let curBand = 0;
  const bandH = [];
  for (let L = 0; L < layers.length; L++) {
    const col = layers[L] || [];
    if (!col.length) continue;
    if (L > 0 && L % BAND === 0) {                 // 换横带：下一段从新的一行开始
      bandTopY += (bandH[curBand] || NODE_H) + 130;
      curBand += 1;
    }
    // ① 目标 y＝前驱重心（这就是「汇合点对准那三份材料」）
    const target = new Map();
    for (const n of col) {
      const cs = preds.get(n.id).filter((p) => centerY.has(p));
      target.set(n.id, cs.length ? cs.reduce((s, p) => s + centerY.get(p), 0) / cs.length - NODE_H / 2 : null);
    }
    const arr = col.slice().sort((a, b) => {
      const ta = target.get(a.id), tb = target.get(b.id);
      if (ta != null && tb != null && Math.abs(ta - tb) > 1) return ta - tb;
      if (ta != null && tb == null) return -1;
      if (ta == null && tb != null) return 1;
      return a.seq - b.seq;
    });
    // ② 先按目标放，再把挤在一起的往下推开（列内的 cursor 只在本列内累积）
    let cursor = -Infinity;
    const assigned = [];
    for (const n of arr) {
      const t = target.get(n.id);
      let y = t == null ? (cursor === -Infinity ? bandTopY : cursor) : Math.max(t, cursor === -Infinity ? t : cursor);
      if (y < bandTopY) y = bandTopY;
      assigned.push({ n, y, t });
      cursor = y + NODE_H + ROW_GAP;
    }
    // ③ 整列按"有目标的那些"的重心对齐：扇出的 4 条以扇出点为中心上下摊开，汇合点落在 4 条中间
    const withT = assigned.filter((a) => a.t != null);
    if (withT.length) {
      const shift = withT.reduce((s, a) => s + a.t, 0) / withT.length - withT.reduce((s, a) => s + a.y, 0) / withT.length;
      for (const a of assigned) a.y += shift;
    }
    for (const a of assigned) {
      pos.set(a.n.id, { col: L % BAND, band: curBand, y: a.y });
      centerY.set(a.n.id, a.y + NODE_H / 2);
      bandH[curBand] = Math.max(bandH[curBand] || 0, a.y + NODE_H - bandTopY);
    }
  }
  // 整块从 y=0 起（bandTopY 只是过程中的相对基准）
  const ys = [...pos.values()].map((p) => p.y);
  const minY = ys.length ? Math.min(...ys) : 0;
  for (const p of pos.values()) p.y = Math.round(p.y - minY);
  const cols = Math.min(BAND, Math.max(1, layers.filter((c) => c && c.length).length));
  return {
    pos,
    width: cols * COL_PITCH + NODE_W - COL_PITCH,
    height: Math.max(...bandH.filter((h) => h > 0), NODE_H)
  };
}

/**
 * 自动整理：整张图只有一条「前后」主线——组按跨组依赖排出先后，一组一块、从左往右依次挨着放；
 * 组内同样从左往右（依赖分层），一条流走到底不折行。
 * 只算坐标，不碰任何语义；算完照常走 POST /tasks/{id}/layout 落库。
 */
function arrangePositions(graph) {
  const order = groupOrder(graph);
  const buckets = new Map(order.map((k) => [k, []]));
  for (const n of graph.nodes) {
    const k = n.groupId || LOOSE_KEY;
    if (!buckets.has(k)) buckets.set(k, []);
    buckets.get(k).push(n);
  }
  const blocks = [];
  for (const key of order) {
    const list = buckets.get(key) || [];
    if (!list.length) continue;
    blocks.push({ key, block: groupLayered(list, graph.edges) });
  }
  const maxH = blocks.length ? Math.max(...blocks.map((b) => b.block.height)) : NODE_H;
  const pos = new Map();
  let x = 60;
  const y0 = 160;
  for (const { block } of blocks) {
    const y = y0 + Math.round((maxH - block.height) / 2);   // 组块纵向居中对齐：出口接着下一个入口，看起来才是一条直线
    for (const [id, p] of block.pos) {
      pos.set(id, { x: Math.round(x + p.col * COL_PITCH), y: Math.round(y + p.y) });
    }
    x += block.width + 240;                                 // 块间留够：组框 + 标签都要地方
  }
  return pos;
}

/** 一键按组重排：先本地生效（图与渲染缓存同写，避免回弹），再落库。 */
async function arrangeByGroups() {
  const g = state.graph;
  if (!g || !g.nodes.length) return;
  const pos = arrangePositions(g);
  for (const n of g.nodes) {
    const p = pos.get(n.id);
    if (!p) continue;
    n.posX = p.x;
    n.posY = p.y;
  }
  render();
  fitView();
  syncGraphJson();
  const payload = { nodes: g.nodes.map((n) => ({ id: n.id, x: n.posX, y: n.posY })) };
  const r = await api(`/api/tasks/${encodeURIComponent(g.task.id)}/layout`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload)
  });
  showToast(r.ok ? `已按组重排 ${payload.nodes.length} 个节点` : `整理后的坐标没存上：${r.body?.error || r.status}`, r.ok);
}

/** 总览：所有组收成牌、牌子按组的先后排成整齐的格子（组间线收拢成一条并标 ×N），再点一次全摊开。 */
async function toggleOverview() {
  const g = state.graph;
  const groups = (g && g.nodeGroups) || [];
  if (!groups.length) { showToast("这个任务还没有节点组，先圈几个节点成组", false); return; }
  const target = !state.overview;          // 进入总览＝全收起；退出＝全摊开
  let changed = 0;
  for (const grp of groups) {
    if (!!grp.collapsed === target) continue;
    const r = await api(`/api/node-groups/${encodeURIComponent(grp.id)}/collapse`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ collapsed: target })
    });
    if (r.ok) { grp.collapsed = target; changed += 1; }
  }
  state.overview = target;
  render();
  fitView();
  syncGraphJson();
  showToast(target ? `总览：${groups.length} 个组按先后排好了` : `已摊开 ${changed} 个组`, true);
}

/** 连线落在哪个区域：左进、右出、底部（回边）。count>1 时沿边等分。 */
function portPoint(kind, p, index = 0, count = 1) {
  if (kind === "bottom") return { x: p.x + p.w / 2, y: p.y + p.h };
  const ratio = count <= 1 ? 0.5 : (index + 1) / (count + 1);
  return kind === "out"
    ? { x: p.x + p.w, y: p.y + p.h * ratio }
    : { x: p.x, y: p.y + p.h * ratio };
}

function edgePath(from, to, edge) {
  if (!from || !to) return "";
  if (edge.kind === "loop") {
    const a = portPoint("bottom", from);
    const b = portPoint("bottom", to);
    const dip = Math.max(a.y, b.y) + 46;
    return `M ${a.x} ${a.y} C ${a.x} ${dip}, ${b.x} ${dip}, ${b.x} ${b.y}`;
  }
  const a = portPoint("out", from, edge.fromPort || 0, from.outPorts || 1);
  const b = portPoint("in", to, edge.toPort || 0, to.inPorts || 1);
  const dx = b.x - a.x;
  if (dx > 40) {
    const mid = (a.x + b.x) / 2;
    return `M ${a.x} ${a.y} C ${mid} ${a.y}, ${mid} ${b.y}, ${b.x} ${b.y}`;
  }
  const bulge = Math.max(60, Math.abs(dx) / 2 + 60);
  return `M ${a.x} ${a.y} C ${a.x + bulge} ${a.y}, ${b.x - bulge} ${b.y}, ${b.x} ${b.y}`;
}

// ---------------- 视口（缩放 / 平移 / 坐标） ----------------

function captureView() {
  const svg = $("graph");
  const rect = svg && svg.getBoundingClientRect ? svg.getBoundingClientRect() : { left: 0, top: 0, width: 0, height: 0 };
  state.view = { left: rect.left, top: rect.top, width: rect.width, height: rect.height, sx: 1, sy: 1 };
  return state.view;
}

/** 屏幕坐标 → 画布世界坐标（含缩放与平移）。 */
function svgPoint(ev) {
  const v = state.view || captureView();
  const vp = state.viewport;
  const ux = (ev.clientX - v.left) * v.sx;
  const uy = (ev.clientY - v.top) * v.sy;
  return { x: (ux - vp.tx) / vp.scale, y: (uy - vp.ty) / vp.scale };
}

/** 世界坐标 → 屏幕坐标（测试与锚点计算用）。 */
function worldToScreen(pt) {
  const v = state.view || captureView();
  const vp = state.viewport;
  return { x: pt.x * vp.scale + vp.tx + v.left, y: pt.y * vp.scale + vp.ty + v.top };
}

function viewportEl() {
  const svg = $("graph");
  return svg && svg.querySelector ? svg.querySelector("#viewport") : null;
}

function applyViewport() {
  const g = viewportEl();
  const vp = state.viewport;
  if (g && g.setAttribute) g.setAttribute("transform", `translate(${vp.tx},${vp.ty}) scale(${vp.scale})`);
  applyGrid();
  const note = $("zoomNote");
  if (note) note.textContent = `缩放 ${Math.round(vp.scale * 100)}%`;
}

/**
 * 底纹跟着视口走：格子原点＝世界原点，平移缩放时格子一起动。
 * 画布没有边缘上限，所以不能给一块固定大小的底纹——否则一平移就露馅。
 */
function applyGrid() {
  const svg = $("graph");
  if (!svg || !svg.style) return;
  const vp = state.viewport;
  let step = GRID_STEP;
  while (step * vp.scale < 8) step *= 4;          // 缩得太小就把格子放大，免得糊成一片
  const px = Math.round(step * vp.scale * 100) / 100;
  svg.style.backgroundSize = `${px}px ${px}px`;
  svg.style.backgroundPosition = `${vp.tx}px ${vp.ty}px`;
}

/** 滚轮缩放：锚在光标下的那个点，缩放前后它不动。 */
function zoomAt(clientX, clientY, deltaY) {
  captureView();
  const vp = state.viewport;
  const v = state.view;
  const ux = clientX - v.left;
  const uy = clientY - v.top;
  const before = { x: (ux - vp.tx) / vp.scale, y: (uy - vp.ty) / vp.scale };
  const factor = Math.exp(-deltaY * 0.0015);
  const scale = Math.min(MAX_SCALE, Math.max(MIN_SCALE, vp.scale * factor));
  vp.scale = scale;
  vp.tx = ux - before.x * scale;
  vp.ty = uy - before.y * scale;
  applyViewport();
  return { scale: vp.scale, tx: vp.tx, ty: vp.ty, anchor: before };
}

/** 把整张图塞进视口。收纳起来的组按那块牌算，别为看不见的节点缩得太小。 */
function fitView() {
  const hidden = state.hiddenIds || new Set();
  const pts = [];
  for (const [id, p] of state.positions) {
    if (hidden.has(id)) continue;
    pts.push(p);
  }
  for (const pill of (state.pills || new Map()).values()) pts.push(pill);
  for (const r of (state.chainRects || new Map()).values()) pts.push(r);
  applyFit(pts);
}

/** 只框住一组节点（从总览点开一块牌时用）：不然一屏 150 个节点谁也看不清。 */
function fitToNodes(ids) {
  const pts = ids.map((id) => state.positions.get(id)).filter(Boolean);
  applyFit(pts.length ? pts : null);
}

function applyFit(pts) {
  const svg = $("graph");
  if (!svg) return;
  captureView();
  const v = state.view;
  if (!pts || !pts.length) {
    state.viewport = { scale: 1, tx: 20, ty: 20 };
    applyViewport();
    return;
  }
  const minX = Math.min(...pts.map((p) => p.x));
  const minY = Math.min(...pts.map((p) => p.y));
  const maxX = Math.max(...pts.map((p) => p.x + p.w));
  const maxY = Math.max(...pts.map((p) => p.y + p.h));
  const w = Math.max(1, maxX - minX);
  const h = Math.max(1, maxY - minY);
  const pad = 40;
  const scale = Math.min(MAX_SCALE, Math.max(MIN_SCALE, Math.min((v.width - pad * 2) / w, (v.height - pad * 2) / h, 1)));
  state.viewport = { scale, tx: pad - minX * scale, ty: pad - minY * scale };
  applyViewport();
}

// ---------------- 渲染 ----------------

function portCircles(side, p, color) {
  const count = side === "in" ? p.inPorts || 1 : p.outPorts || 1;
  const local = { x: 0, y: 0, w: p.w, h: p.h };
  const out = [];
  for (let i = 0; i < count; i++) {
    const pt = portPoint(side, local, i, count);
    // 一个圆就够：看得见的那圈自己吃事件（以前还套一个透明大圈，节点上千时白多两千个元素）
    out.push(`<circle class="port port-${side}" data-port="${side}" data-index="${i}" cx="${pt.x}" cy="${pt.y}" r="${PORT_R}" stroke="${color}" pointer-events="all"></circle>`);
  }
  return out.join("");
}

function render() {
  const g = state.graph;
  if (!g) return;
  const t = g.task;
  $("taskSummary").innerHTML =
    `<b>${esc(t.title)}</b> · ${esc(t.goalLine || "（无任务级目标行）")}<br>` +
    `进度 ${t.progress}%（已解决 ${t.resolvedCount}/${t.nodeCount}）` +
    (t.blockedCount ? ` · <span style="color:#dc2626">阻塞 ${t.blockedCount}</span>` : "") +
    ` · 状态 ${esc(t.status)} · 节点 ${t.nodeCount} / 边 ${g.edges.length} / 循环 ${g.cycles.length}` +
    (state.selectedIds.size > 1 ? ` · <b>已选 ${state.selectedIds.size} 个</b>` : "");

  $("legend").innerHTML = Object.keys(STATUS_TEXT)
    .map((s) => `<span><i style="background:${STATUS_COLORS[s]}"></i>${STATUS_TEXT[s]}</span>`)
    .join("") +
    `<span><i style="background:#7c3aed"></i>循环区（带循环的组）</span>` +
    `<span><i style="background:#2563eb"></i>节点组</span>` +
    `<span><i style="background:#0ea5e9"></i>同向链（几节合 1）</span>` +
    `<span class="hint">拖空白＝框选（点空白＝取消选中） · 拖节点＝移动（可多选一起拖） · <b>拖组名/组边框＝整组一起挪</b> · <b>按住 Shift 拖＝左右 + 前后吸附</b> · 滚轮＝缩放 · 中键拖＝平移（画布没边） · 双击空白＝建节点 · <b>双击标题＝节点/组/链 快收快开</b> · 右键节点＝「同向链收成一块」 · <b>点节点/连线/组/链块＝选中，按 Delete＝删掉它</b> · 右键＝菜单 · 右键按住拖＝连线（Shift＝回边）</span>`;

  state.positions = layout(g);
  state.nodesById = new Map(g.nodes.map((n) => [n.id, n]));
  state.collapsedIds = collapsedGroupIds();     // 先算"哪些组收成牌了"，链框与 fit 都要用
  // 同向链：纯前端按边算出来的（后端只有节点和连线，链是看法不是数据）
  state.chainIndex = null;
  state.chains = state.noChains ? [] : graphChains();
  state.chainByMember = new Map();
  for (const ch of state.chains) for (const id of ch.nodeIds) state.chainByMember.set(id, ch);
  state.hiddenIds = hiddenNodeIds();
  state.chainRects = new Map();
  for (const ch of state.chains) {
    const head = state.nodesById.get(ch.headNodeId);
    if (head && head.groupId && state.collapsedIds.has(head.groupId)) continue;   // 组已收成牌：链框不画，也不参与 fit
    const r = chainRect(ch);
    if (r) state.chainRects.set(ch.id, r);
  }
  // 循环区＝带循环的组：组 id → cycles 行
  state.cycleByGroup = new Map((g.cycles || []).filter((c) => c.groupId).map((c) => [c.groupId, c]));
  state.overviewOrder = state.overview ? groupOrder(g) : [];   // 总览时牌子按组的先后排格子
  state.pills = new Map();
  for (const gid of state.collapsedIds) {
    const pill = pillRect(gid);
    if (pill) state.pills.set(gid, pill);
  }
  state.alignLineEls = [];     // 整图重绘会把参考线元素一起换掉，缓存要跟着失效
  state.alignTipEls = [];

  const svg = $("graph");
  const vp = state.viewport;
  const parts = [];
  parts.push(`<defs>
    <marker id="arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
      <path d="M 0 0 L 10 5 L 0 10 z" fill="#94a3b8"></path>
    </marker>
    <marker id="arrowLoop" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
      <path d="M 0 0 L 10 5 L 0 10 z" fill="#7c3aed"></path>
    </marker>
  </defs>`);

  // 节点组画在最底层：只包一层框，框上留个标签当抓手（框本身不吃事件，框里照样双击建节点/框选）
  // 组＋回边＋检查点＝循环区：带循环的组用紫框，标签里写上限与已跑轮次
  for (const grp of g.nodeGroups || []) {
    if (state.collapsedIds.has(grp.id)) continue;      // 收纳的组画成牌，不画框
    const b = groupBounds(grp.id);
    if (!b) continue;
    const cy = state.cycleByGroup.get(grp.id);
    const label = cy
      ? `组 · ${grp.title} · 循环 上限 ${cy.limit}${cy.limitKind === "perpetual" ? "（不限）" : ""} · 已跑 ${cy.visited} 轮${cy.pausedReason ? " · " + cy.pausedReason : ""}`
      : `组 · ${grp.title}`;
    const st = groupStats(grp.id);
    const chipTail = cy ? "" : `${st.done}/${st.count} 完成${st.blocked ? ` · 阻塞 ${st.blocked}` : st.doing ? ` · 进行 ${st.doing}` : ""} · 拖我`;
    const cw = Math.max(72, 34 + cut(label, 40).length * 11 + (chipTail ? 88 : 0));
    const gsel = state.selectedGroup === grp.id;
    // 组的边＝抓手：一条透明的宽描边，只有「边这一圈」吃事件——框里的空白照样框选、照样双击建节点
    parts.push(`<rect class="node-group-edge${gsel ? " picked" : ""}" data-nodegroup-edge="${esc(grp.id)}" x="${b.x1}" y="${b.y1}" width="${b.x2 - b.x1}" height="${b.y2 - b.y1}" rx="16"></rect>`);
    parts.push(`<rect class="node-group${gsel ? " picked" : ""}${cy ? " is-loop" : ""}" data-nodegroup="${esc(grp.id)}" x="${b.x1}" y="${b.y1}" width="${b.x2 - b.x1}" height="${b.y2 - b.y1}" rx="16"></rect>`);
    parts.push(`<g class="node-group-chip${cy ? " loop" : ""}" data-nodegroup-chip="${esc(grp.id)}" transform="translate(${b.x1 + 10},${b.y1 - 12})">
      <rect x="0" y="0" width="${cw}" height="20" rx="10" fill="${st.blocked ? "#fee2e2" : "none"}"${st.blocked ? ' stroke="#dc2626"' : ""}></rect>
      <text x="9" y="14">${esc(cut(label, 40))}</text>
      ${chipTail ? `<text x="${cw - 8}" y="14" text-anchor="end" class="chip-count" fill="${st.color}">${esc(chipTail)}</text>` : ""}
    </g>`);
  }


  // 大图（节点多）默认把「组间」的线收成一束：一条线 + ×N，组内的线照旧一条条画。
  // 不然十个组各摊一片，跨组线横穿整张画布，叠起来就是一坨。
  state.bundleCross = g.nodes.length > 60;
  const bundles = new Map();
  for (const e of g.edges) {
    if (!state.bundleCross) break;
    const fg = state.nodesById.get(e.fromNodeId)?.groupId;
    const tg = state.nodesById.get(e.toNodeId)?.groupId;
    if (!fg || !tg || fg === tg) continue;
    const key = `${fg}->${tg}:${e.kind}`;
    if (!bundles.has(key)) bundles.set(key, { fg, tg, kind: e.kind, count: 0, gated: 0, e });
    const b = bundles.get(key);
    b.count += 1;
    if (e.gate === "human" && !e.gateConfirmedBy) b.gated += 1;
  }
  // 组间束线：一对组只画一条，标 ×N（门控没点头的另加标记）。组内部照旧逐条画。
  for (const b of bundles.values()) {
    const from = groupBoxOf(b.fg), to = groupBoxOf(b.tg);
    if (!from || !to) continue;
    const rightward = to.x1 >= from.x2 - 4;
    const a = { x: rightward ? from.x2 : from.x1, y: (from.y1 + from.y2) / 2 };
    const z = { x: rightward ? to.x1 : to.x2, y: (to.y1 + to.y2) / 2 };
    const mx = (a.x + z.x) / 2;
    const d = `M ${a.x} ${a.y} C ${mx} ${a.y}, ${mx} ${z.y}, ${z.x} ${z.y}`;
    const isLoop = b.kind === "loop";
    parts.push(`<path class="edge-bundle" d="${d}" fill="none" stroke="${isLoop ? "#7c3aed" : "#94a3b8"}"
      stroke-width="${isLoop ? 2 : 1.6}" ${isLoop ? 'stroke-dasharray="7 5"' : ""} marker-end="url(#${isLoop ? "arrowLoop" : "arrow"})"></path>`);
    if (b.count > 1 || b.gated) parts.push(`<text class="edge-label" x="${mx}" y="${(a.y + z.y) / 2 - 8}" text-anchor="middle">${b.count > 1 ? "×" + b.count : ""}${b.gated ? " · 门控待确认" : ""}</text>`);
  }

  // 连线：被收纳的成员节点不画，跨边界的线收拢到那块牌上（同一对只画一条，标 ×N）
  const anchorOf = (nodeId) => {
    const ch = state.chainByMember.get(nodeId);
    if (ch && chainIsCollapsed(ch) && state.hiddenIds.has(nodeId)) {
      const r = state.chainRects.get(ch.id);
      if (r) return r;
    }
    if (!state.hiddenIds.has(nodeId)) return state.positions.get(nodeId);
    const n = state.nodesById.get(nodeId);
    return n && n.groupId ? state.pills.get(n.groupId) || null : null;
  };
  const anchorKey = (nodeId) => {
    const ch = state.chainByMember.get(nodeId);
    if (ch && chainIsCollapsed(ch) && state.hiddenIds.has(nodeId)) return `c:${ch.id}`;
    if (!state.hiddenIds.has(nodeId)) return `n:${nodeId}`;
    const n = state.nodesById.get(nodeId);
    return n && n.groupId ? `g:${n.groupId}` : `n:${nodeId}`;
  };
  const drawn = new Map();
  for (const e of g.edges) {
    if (state.bundleCross) {                       // 组间的线交给上面那束线，这里只画组内与未分组的
      const fg = state.nodesById.get(e.fromNodeId)?.groupId;
      const tg = state.nodesById.get(e.toNodeId)?.groupId;
      if (fg && tg && fg !== tg) continue;
    }
    const fk = anchorKey(e.fromNodeId);
    const tk = anchorKey(e.toNodeId);
    if (fk === tk && (fk.startsWith("g:") || fk.startsWith("c:"))) continue;   // 块内/组内的线收起来后不画
    const from = anchorOf(e.fromNodeId);
    const to = anchorOf(e.toNodeId);
    if (!from || !to) continue;
    const key = `${fk}->${tk}:${e.kind}`;
    if (drawn.has(key)) { drawn.get(key).count += 1; continue; }
    const item = { from, to, e, count: 1, fromId: e.fromNodeId, toId: e.toNodeId };
    drawn.set(key, item);
  }

  // 点中的那个节点：与它相连的线亮起来，其余压暗（一眼看清它接到谁）——这一步交给 paintSelection，
  // 选中就不用整图重绘了（节点上千时重绘一次几十毫秒，点一下卡一下）。

  for (const item of drawn.values()) {
    const { from, to, e, count } = item;
    const isLoop = e.kind === "loop";
    const gated = e.gate === "human" && !e.gateConfirmedBy;
    const dash = isLoop ? 'stroke-dasharray="7 5"' : gated ? 'stroke-dasharray="3 4"' : "";
    const stroke = gated ? "#f97316" : isLoop ? "#7c3aed" : "#94a3b8";
    const d = edgePath(from, to, e);
    parts.push(`<path class="${edgeClass(e)}" data-edge="${esc(e.id)}" d="${d}" fill="none" stroke="${stroke}"
      stroke-width="${isLoop ? 2 : 1.5}" ${dash}
      marker-end="url(#${isLoop ? "arrowLoop" : "arrow"})"></path>`);
    // 线太细点不中：给它一条透明的宽命中带（点它＝选中这条线）
    parts.push(`<path class="edge-hit" data-edge-hit="${esc(e.id)}" d="${d}" fill="none" stroke="transparent" stroke-width="16" pointer-events="stroke"></path>`);
    if (e.gate === "human") {
      const mx = (from.x + from.w / 2 + to.x + to.w / 2) / 2;
      const my = Math.min(from.y, to.y) - 8;
      parts.push(`<text class="edge-gate-label" x="${mx}" y="${my}" text-anchor="middle">门控${e.gateConfirmedBy ? "✓" : "待确认"}</text>`);
    }
    if (count > 1) {
      const mx = (from.x + to.x) / 2;
      const my = (from.y + to.y) / 2 - 6;
      parts.push(`<text class="edge-label" x="${mx}" y="${my}" text-anchor="middle">×${count}</text>`);
    }
    if (isLoop) {
      const mx = (from.x + from.w / 2 + to.x + to.w / 2) / 2;
      const my = Math.max(from.y + from.h, to.y + to.h) + 34;
      parts.push(`<text class="edge-label" x="${mx}" y="${my}" text-anchor="middle" fill="#7c3aed">回边 · 下一轮</text>`);
    }
  }

  // 收纳牌：成员都藏起来了，这块牌就是它们的替身（点它出菜单、拖它整组走）
  for (const [gid, pill] of state.pills) {
    const grp = (g.nodeGroups || []).find((x) => x.id === gid);
    const st = groupStats(gid);
    const cy = state.cycleByGroup.get(gid);
    const step = pill.step ? `${pill.step}` : "";
    const title = `${step ? step + " · " : ""}${cy ? "循环 · " : "组 · "}${cut(grp ? grp.title : gid, state.overview ? 18 : 15)}`;
    parts.push(`<g class="group-pill" data-nodegroup-pill="${esc(gid)}" transform="translate(${pill.x},${pill.y})">
      <rect x="0" y="0" width="${pill.w}" height="${pill.h}" rx="10" fill="#eff6ff" stroke="${st.color}" stroke-width="2"></rect>
      <rect x="0" y="0" width="6" height="${pill.h}" rx="3" fill="${st.color}"></rect>
      <text class="pill-title" x="14" y="25">${esc(title)}</text>
      <text class="pill-sub" x="14" y="47">${st.count} 个节点 · 完成 ${st.done}${st.doing ? ` · 进行 ${st.doing}` : ""}${st.blocked ? ` · 阻塞 ${st.blocked}` : ""}</text>
      <text class="pill-sub" x="14" y="67">${cy ? `循环 已跑 ${cy.visited}/${cy.limit} 轮 · ` : ""}已收纳 · 双击展开</text>
    </g>`);
  }

  // 同向链：收起时是一块宽卡（「5 个合 1」），摊开时画一圈虚线标出这条链在哪。
  // 纯看图：节点、连线、门都没动，双击它的标题就摊开/收起。
  for (const ch of state.chains) {
    const r = state.chainRects.get(ch.id);
    if (!r) continue;
    const members = chainMembers(ch);
    if (members.length < 2) continue;
    // 组已经收成牌了：链块别再叠一层（成员跟着组一起藏，线收到牌上）
    const headNode = state.nodesById.get(ch.headNodeId);
    if (headNode && headNode.groupId && state.collapsedIds.has(headNode.groupId)) continue;
    const seld = state.selectedChain === ch.id;
    if (!chainIsCollapsed(ch)) {
      // 两节的链不画框（太吵）；选中的那条一定画，好让人看清「我选的是哪一串」
      if (members.length < CHAIN_FRAME_MIN && state.selectedChain !== ch.id) continue;
      const box = chainFrameRect(ch);
      if (!box) continue;
      parts.push(`<rect class="chain-frame" data-chain-frame="${esc(ch.id)}" x="${box.x}" y="${box.y}" width="${box.w}" height="${box.h}" rx="16"></rect>`);
      parts.push(`<text class="chain-frame-label" data-chain-frame-label="${esc(ch.id)}" x="${box.x + 10}" y="${box.y - 6}">同向链 · ${members.length} 个 · 双击标题可收成一块</text>`);
      continue;
    }
    const head = members[0];
    const tail = members[members.length - 1];
    const color = STATUS_COLORS[head.status] || "#6b7280";
    parts.push(`<g class="chain-box" data-chain="${esc(ch.id)}" transform="translate(${r.x},${r.y})">
      <title>${esc(chainTitleText(ch))} · ${members.length} 个节点合 1（纯看图：节点与连线没动）</title>
      <rect class="chain-body" x="0" y="0" width="${r.w}" height="${r.h}" rx="10" fill="#f8fafc"
        stroke="#0ea5e9" stroke-width="2" stroke-dasharray="9 4"></rect>
      <rect x="0" y="0" width="6" height="${r.h}" rx="3" fill="#0ea5e9"></rect>
      <text class="chain-title" x="16" y="24">${esc(cut(chainTitleText(ch), 18))}</text>
      <text class="chain-sub" x="16" y="46">同向链 · ${members.length} 个合 1 · 双击标题摊开</text>
      <text class="chain-status" x="16" y="70" fill="${color}">${esc(STATUS_TEXT[head.status] || head.status)} → ${esc(STATUS_TEXT[tail.status] || tail.status)}</text>
      <text class="chain-count" x="${r.w - 14}" y="70" text-anchor="end">×${members.length}</text>
    </g>`);
  }

  for (const n of g.nodes) {
    if (state.hiddenIds.has(n.id)) continue;
    const p = state.positions.get(n.id);
    if (!p) continue;
    const color = STATUS_COLORS[n.status] || "#6b7280";
    const dash = n.status === "skipped" ? 'stroke-dasharray="5 4"' : "";

    if (n.compact) {
      // 收纳后只剩一行：1＝标题，2＝关键字（一行目标）
      const label = n.compact === 2 ? cut(n.goalLine || "（无关键字）", 11) : cut(n.title, 11);
      parts.push(`<g class="${nodeClass(n)}" data-node="${esc(n.id)}" transform="translate(${p.x},${p.y})">
        <title>${esc(n.title)} · ${esc(STATUS_TEXT[n.status] || n.status)}${n.goalLine ? " · " + esc(n.goalLine) : ""}</title>
        <rect class="node-body" x="0" y="0" width="${p.w}" height="${p.h}" rx="8" fill="#ffffff" stroke="${color}" stroke-width="2" ${dash}></rect>
        <rect x="0" y="0" width="5" height="${p.h}" rx="2.5" fill="${color}"></rect>
        <text class="compact-title" x="12" y="${p.h / 2 + 4}">${esc(label)}</text>
        ${portCircles("in", p, color)}${portCircles("out", p, color)}
      </g>`);
      continue;
    }

    parts.push(`<g class="${nodeClass(n)}" data-node="${esc(n.id)}" transform="translate(${p.x},${p.y})">
      <rect class="node-body" x="0" y="0" width="${p.w}" height="${p.h}" rx="10" fill="#ffffff" stroke="${color}" stroke-width="2" ${dash}></rect>
      <rect x="0" y="0" width="6" height="${p.h}" rx="3" fill="${color}"></rect>
      <text class="node-title" x="16" y="24">${esc(cut(n.title, 18))}</text>
      <text class="node-goal" x="16" y="46">${esc(cut(n.goalLine || "（无一行目标）", 24))}</text>
      <text class="node-status" x="16" y="70" fill="${color}">${esc(STATUS_TEXT[n.status] || n.status)}${n.blockedReason ? " · " + esc(n.blockedReason) : ""}</text>
      <text class="node-goal" x="${p.w - 12}" y="70" text-anchor="end">${esc(n.kind)}${n.cycleEpoch > 1 ? " · 第" + n.cycleEpoch + "轮" : ""}</text>
      ${portCircles("in", p, color)}${portCircles("out", p, color)}
    </g>`);
  }

  svg.innerHTML = `<g id="viewport" transform="translate(${vp.tx},${vp.ty}) scale(${vp.scale})">${parts.join("")}</g>`;

  // 建索引：拖动时按索引直接改，不再 querySelector 逐条找
  state.edgeEls = new Map();
  state.edgesById = new Map(g.edges.map((e) => [e.id, e]));
  state.incident = new Map();
  for (const e of g.edges) {
    for (const nodeId of [e.fromNodeId, e.toNodeId]) {
      if (!state.incident.has(nodeId)) state.incident.set(nodeId, new Set());
      state.incident.get(nodeId).add(e.id);
    }
  }
  state.nodeEls = new Map();
  state.cycleEls = new Map();
  state.cycleLabelEls = new Map();
  state.groupEls = new Map();
  state.groupEdgeEls = new Map();
  state.groupChipEls = new Map();
  state.pillEls = new Map();
  state.chainBoxEls = new Map();
  state.chainFrameEls = new Map();
  state.chainFrameLabelEls = new Map();
  if (svg.querySelectorAll) {
    for (const el of svg.querySelectorAll("[data-node]")) state.nodeEls.set(el.getAttribute("data-node"), el);
    for (const el of svg.querySelectorAll("[data-edge]")) state.edgeEls.set(el.getAttribute("data-edge"), el);
    for (const el of svg.querySelectorAll("[data-cycle]")) state.cycleEls.set(el.getAttribute("data-cycle"), el);
    for (const el of svg.querySelectorAll("[data-cycle-label]")) state.cycleLabelEls.set(el.getAttribute("data-cycle-label"), el);
    for (const el of svg.querySelectorAll("[data-nodegroup]")) state.groupEls.set(el.getAttribute("data-nodegroup"), el);
    for (const el of svg.querySelectorAll("[data-nodegroup-edge]")) state.groupEdgeEls.set(el.getAttribute("data-nodegroup-edge"), el);
    for (const el of svg.querySelectorAll("[data-nodegroup-chip]")) state.groupChipEls.set(el.getAttribute("data-nodegroup-chip"), el);
    for (const el of svg.querySelectorAll("[data-nodegroup-pill]")) state.pillEls.set(el.getAttribute("data-nodegroup-pill"), el);
    for (const el of svg.querySelectorAll("[data-chain]")) state.chainBoxEls.set(el.getAttribute("data-chain"), el);
    for (const el of svg.querySelectorAll("[data-chain-frame]")) state.chainFrameEls.set(el.getAttribute("data-chain-frame"), el);
    for (const el of svg.querySelectorAll("[data-chain-frame-label]")) state.chainFrameLabelEls.set(el.getAttribute("data-chain-frame-label"), el);
  }
  paintSelection();                      // 选中态单独上色：以后点选只走这一步，不重建 DOM
  applyViewport();
}

// ---------------- 节点组（纯视觉分组） ----------------

/** 组的框＝成员包围盒再放宽一圈，框上方留一条给标签。 */
function groupBounds(groupId) {
  const g = state.graph;
  if (!g) return null;
  const members = (g.nodes || [])
    .filter((n) => n.groupId === groupId)
    .map((n) => state.positions.get(n.id))
    .filter(Boolean);
  if (!members.length) return null;
  return {
    x1: Math.min(...members.map((p) => p.x)) - 22,
    y1: Math.min(...members.map((p) => p.y)) - 40,
    x2: Math.max(...members.map((p) => p.x + p.w)) + 22,
    y2: Math.max(...members.map((p) => p.y + p.h)) + 22
  };
}

function groupTitle(groupId) {
  const grp = (state.graph?.nodeGroups || []).find((x) => x.id === groupId);
  return grp ? grp.title : groupId;
}

function collapsedGroupIds() {
  return new Set((state.graph?.nodeGroups || []).filter((g) => g.collapsed).map((g) => g.id));
}

function groupMembers(groupId) {
  return (state.graph?.nodes || []).filter((n) => n.groupId === groupId);
}

/** 收纳后的组显示成一块「牌」：成员节点全部藏起来，用这块牌代替（位置取成员包围盒左上角）。 */
/** 一个组在画布上的占位：收成牌就是牌，摊开就是组框。束线两头都落在它上面。 */
function groupBoxOf(gid) {
  const pill = state.pills?.get(gid);
  if (pill) return { x1: pill.x, y1: pill.y, x2: pill.x + pill.w, y2: pill.y + pill.h };
  const b = groupBounds(gid);
  return b ? { x1: b.x1, y1: b.y1, x2: b.x2, y2: b.y2 } : null;
}

/** 一个组的进度快照：总览/组标签上要一眼看出这个组到哪了、有没有卡住。 */
function groupStats(groupId) {
  const members = groupMembers(groupId);
  let done = 0, doing = 0, blocked = 0;
  for (const n of members) {
    if (n.status === "approved" || n.status === "skipped") done += 1;
    else if (n.status === "active" || n.status === "review") doing += 1;
    else if (n.status === "blocked") blocked += 1;
  }
  const color = blocked ? "#dc2626" : doing ? "#2563eb" : done === members.length && members.length ? "#16a34a" : "#94a3b8";
  return { count: members.length, done, doing, blocked, color };
}

/** 总览模式：牌子按组的先后排成整齐的格子，不再各自站在成员包围盒的左上角（那样牌会散到天边）。 */
const OV = { cols: 8, w: 268, h: 78, gx: 66, gy: 62, x0: 90, y0: 180 };   // 总览也是一条前后线：一行放得下就一行
function overviewPillRect(gid) {
  const order = state.overviewOrder || [];
  const i = Math.max(0, order.indexOf(gid));
  const cols = Math.min(OV.cols, Math.max(1, order.length));
  return {
    x: OV.x0 + (i % cols) * (OV.w + OV.gx),
    y: OV.y0 + Math.floor(i / cols) * (OV.h + OV.gy),
    w: OV.w,
    h: OV.h,
    inPorts: 1,
    outPorts: 1,
    pill: true,
    step: i + 1
  };
}

function pillRect(groupId) {
  if (state.overview) {
    const r = overviewPillRect(groupId);
    const outs = new Set(), ins = new Set();
    for (const e of state.graph?.edges || []) {
      const fg = state.nodesById?.get(e.fromNodeId)?.groupId;
      const tg = state.nodesById?.get(e.toNodeId)?.groupId;
      if (fg === groupId && tg !== groupId) outs.add(tg || e.toNodeId);
      if (tg === groupId && fg !== groupId) ins.add(fg || e.fromNodeId);
    }
    r.inPorts = Math.min(4, Math.max(1, ins.size));
    r.outPorts = Math.min(4, Math.max(1, outs.size));
    return r;
  }
  const members = groupMembers(groupId).map((n) => state.positions.get(n.id)).filter(Boolean);
  if (!members.length) return null;
  // 出/进线口按"接到几个别的组"分：总览时 8 块牌之间的线才不会全糊在一个点上
  const outs = new Set(), ins = new Set();
  const g = state.graph;
  if (g) {
    for (const e of g.edges) {
      const fg = state.nodesById?.get(e.fromNodeId)?.groupId;
      const tg = state.nodesById?.get(e.toNodeId)?.groupId;
      if (fg === groupId && tg !== groupId) outs.add(tg || e.toNodeId);
      if (tg === groupId && fg !== groupId) ins.add(fg || e.fromNodeId);
    }
  }
  return {
    x: Math.min(...members.map((p) => p.x)),
    y: Math.min(...members.map((p) => p.y)),
    w: NODE_W,
    h: 78,
    inPorts: Math.min(6, Math.max(1, ins.size)),
    outPorts: Math.min(6, Math.max(1, outs.size)),
    pill: true
  };
}

/** 藏起来的节点：属于已收纳的组、或属于已收起的同向链。 */
function hiddenNodeIds() {
  const out = new Set();
  const collapsed = collapsedGroupIds();
  if (collapsed.size) {
    for (const n of state.graph?.nodes || []) if (n.groupId && collapsed.has(n.groupId)) out.add(n.id);
  }
  // 同向链收起：整条都换成一块。组已经收成牌的话跟着组走，别再叠一层。
  for (const ch of state.chains || []) {
    if (!chainIsCollapsed(ch)) continue;
    const head = state.nodesById ? state.nodesById.get(ch.headNodeId) : null;
    if (head && head.groupId && collapsed.has(head.groupId)) continue;
    for (const id of ch.nodeIds || []) out.add(id);
  }
  return out;
}

function groupChipWidth(title) {
  return Math.max(72, 34 + cut(title, 14).length * 12);
}

function redrawGroupBox(groupId) {
  const chip = state.groupChipEls.get(groupId);
  if (state.collapsedIds && state.collapsedIds.has(groupId)) {
    const pill = pillRect(groupId);
    const g = state.pillEls ? state.pillEls.get(groupId) : null;
    if (pill && g && g.setAttribute) g.setAttribute("transform", `translate(${pill.x},${pill.y})`);
    return;
  }
  const b = groupBounds(groupId);
  const rect = state.groupEls.get(groupId);
  const band = state.groupEdgeEls ? state.groupEdgeEls.get(groupId) : null;
  if (!b) return;
  for (const el of [rect, band]) {
    if (!el || !el.setAttribute) continue;
    el.setAttribute("x", b.x1);
    el.setAttribute("y", b.y1);
    el.setAttribute("width", b.x2 - b.x1);
    el.setAttribute("height", b.y2 - b.y1);
  }
  if (chip && chip.setAttribute) chip.setAttribute("transform", `translate(${b.x1 + 10},${b.y1 - 12})`);
}

/** 拖动时把「这个节点牵动的框」全刷一遍：循环区 + 它所在的节点组 + 它所在的那条链块。 */
function redrawBoxesFor(ids) {
  const groupIds = new Set();
  const chainIds = new Set();
  for (const id of ids) {
    redrawCycleFor(id);
    const n = state.nodesById.get(id);
    if (n && n.groupId) groupIds.add(n.groupId);
    const ch = state.chainByMember ? state.chainByMember.get(id) : null;
    if (ch) chainIds.add(ch.id);
  }
  for (const gid of groupIds) redrawGroupBox(gid);
  for (const cid of chainIds) redrawChainFor(cid);
}

// ---------------- 同向链（一根筋接下去的几节，收成一块看） ----------------
// 纯前端：链是从「连线」里读出来的看法，不是数据——后端只有节点和边，一个字段都没加。
// 收没收起也只记在内存里，刷新页面就摊开（要长期记住再说）。

function chainMembers(chain) {
  return ((chain && chain.nodeIds) || []).map((id) => state.nodesById.get(id)).filter(Boolean);
}

/** 链块画在链头的坐标上：比节点宽一点、同高，左右口照旧（端口号取进出边里最大的那个）。 */
function chainRect(chain) {
  const head = state.positions.get(chain.headNodeId);
  if (!head) return null;
  const ids = new Set(chain.nodeIds || []);
  let inPorts = 1;
  let outPorts = 1;
  for (const e of state.graph?.edges || []) {
    const fromIn = ids.has(e.fromNodeId);
    const toIn = ids.has(e.toNodeId);
    if (fromIn === toIn) continue;                       // 链内部的线不算口
    if (toIn) inPorts = Math.max(inPorts, (e.toPort || 0) + 1);
    else outPorts = Math.max(outPorts, (e.fromPort || 0) + 1);
  }
  return { x: head.x, y: head.y, w: CHAIN_W, h: CHAIN_H, inPorts, outPorts };
}

/** 摊开时的虚线框：把这条链的几个节点圈起来，让人知道「这条链现在在哪」。 */
function chainFrameRect(chain) {
  const members = chainMembers(chain).map((n) => state.positions.get(n.id)).filter(Boolean);
  if (!members.length) return null;
  return {
    x: Math.min(...members.map((p) => p.x)) - 18,
    y: Math.min(...members.map((p) => p.y)) - 26,
    w: Math.max(...members.map((p) => p.x + p.w)) + 18 - (Math.min(...members.map((p) => p.x)) - 18),
    h: Math.max(...members.map((p) => p.y + p.h)) + 16 - (Math.min(...members.map((p) => p.y)) - 26)
  };
}

function chainTitleText(chain) {
  const members = chainMembers(chain);
  if (members.length < 2) return "同向链";
  return `${members[0].title} › … › ${members[members.length - 1].title}`;
}

function chainIdOf(headNodeId) {
  return `ch:${headNodeId}`;
}

/** 收起来了没：只认内存里那个集合（链头节点 id）。 */
function chainIsCollapsed(chain) {
  return !!chain && state.collapsedChains.has(chain.headNodeId);
}

function chainById(chainId) {
  return (state.chains || []).find((x) => x.id === chainId) || null;
}

/** 进出边索引：算链只认 transfer 边（回边是另一回事），一次建好给整张图用。 */
function chainIndex() {
  if (state.chainIndex) return state.chainIndex;
  const ins = new Map();
  const outs = new Map();
  for (const n of state.graph?.nodes || []) { ins.set(n.id, []); outs.set(n.id, []); }
  for (const e of state.graph?.edges || []) {
    if (e.kind !== "transfer") continue;
    if (!outs.has(e.fromNodeId) || !ins.has(e.toNodeId)) continue;
    if (!outs.get(e.fromNodeId).includes(e.toNodeId)) outs.get(e.fromNodeId).push(e.toNodeId);
    if (!ins.get(e.toNodeId).includes(e.fromNodeId)) ins.get(e.toNodeId).push(e.fromNodeId);
  }
  state.chainIndex = { ins, outs };
  return state.chainIndex;
}

/**
 * 从任意一节往回追到链头、再顺下去追到链尾。判定：当前只有一条入边、那条入边的上游只有这一条出边，
 * 就算「一路接下去」；碰到分叉、汇合、或者跨了节点组就停。
 */
function walkChainFrom(nodeId, ins, outs) {
  const groupOf = (id) => (state.nodesById.get(id) || {}).groupId || "";
  const group = groupOf(nodeId);
  const seen = new Set([nodeId]);
  const chain = [nodeId];
  let cur = nodeId;
  while (chain.length < 60) {
    const list = ins.get(cur) || [];
    if (list.length !== 1) break;
    const prev = list[0];
    if ((outs.get(prev) || []).length !== 1 || groupOf(prev) !== group || seen.has(prev)) break;
    seen.add(prev);
    chain.unshift(prev);
    cur = prev;
  }
  cur = nodeId;
  while (chain.length < 60) {
    const list = outs.get(cur) || [];
    if (list.length !== 1) break;
    const next = list[0];
    if ((ins.get(next) || []).length !== 1 || groupOf(next) !== group || seen.has(next)) break;
    seen.add(next);
    chain.push(next);
    cur = next;
  }
  return chain;
}

/** 给一个节点，返回它所在的那条同向链（可能只有它自己）。 */
function walkChainLocal(nodeId) {
  if (!state.nodesById.has(nodeId)) return [];
  const { ins, outs } = chainIndex();
  return walkChainFrom(nodeId, ins, outs);
}

/** 全图所有同向链：每个链头出一条，成员 ≥2 才算链。 */
function graphChains() {
  const { ins, outs } = chainIndex();
  const seen = new Set();
  const list = [];
  for (const n of state.graph?.nodes || []) {
    const chain = walkChainFrom(n.id, ins, outs);
    if (chain.length < 2 || seen.has(chain[0])) continue;
    for (const id of chain) seen.add(id);
    list.push({ id: chainIdOf(chain[0]), headNodeId: chain[0], tailNodeId: chain[chain.length - 1], nodeIds: chain, count: chain.length });
  }
  return list;
}

function redrawChainFor(chainId) {
  const ch = chainById(chainId);
  if (!ch) return;
  const r = chainRect(ch);
  if (!r) return;
  state.chainRects.set(chainId, r);
  if (chainIsCollapsed(ch)) {
    const el = state.chainBoxEls ? state.chainBoxEls.get(chainId) : null;
    if (el && el.setAttribute) el.setAttribute("transform", `translate(${r.x},${r.y})`);
    return;
  }
  const box = chainFrameRect(ch);
  if (!box) return;
  const frame = state.chainFrameEls ? state.chainFrameEls.get(chainId) : null;
  if (frame && frame.setAttribute) {
    frame.setAttribute("x", box.x);
    frame.setAttribute("y", box.y);
    frame.setAttribute("width", box.w);
    frame.setAttribute("height", box.h);
  }
  const label = state.chainFrameLabelEls ? state.chainFrameLabelEls.get(chainId) : null;
  if (label && label.setAttribute) {
    label.setAttribute("x", box.x + 10);
    label.setAttribute("y", box.y - 6);
  }
}

// ---------------- 右键菜单 ----------------

function closeContextMenu() {
  const m = $("ctxMenu");
  if (m) { m.className = "ctx hidden"; m.innerHTML = ""; }
  state.ctxItems = [];
}

/** items: [{ label, hint, danger, disabled, onClick }]，null 会被跳过。 */
function openContextMenu(clientX, clientY, items) {
  const m = $("ctxMenu");
  const rows = items.filter(Boolean);
  state.ctxItems = rows;
  if (!m) return rows;
  m.innerHTML = rows.map((it, i) =>
    `<button type="button" class="ctx-item${it.danger ? " danger" : ""}" data-ctx="${i}"${it.disabled ? " disabled" : ""}>` +
    `<span>${esc(it.label)}</span>${it.hint ? `<em>${esc(it.hint)}</em>` : ""}</button>`
  ).join("");
  m.className = "ctx";
  if (m.style) { m.style.left = `${clientX}px`; m.style.top = `${clientY}px`; }
  const buttons = m.querySelectorAll ? m.querySelectorAll("[data-ctx]") : [];
  for (const b of buttons) {
    b.onclick = () => {
      const idx = Number(b.getAttribute("data-ctx"));
      const it = state.ctxItems[idx];
      closeContextMenu();
      if (it && !it.disabled && typeof it.onClick === "function") it.onClick();
    };
  }
  return rows;
}

function openNodeMenu(nodeId, ev) {
  const n = state.nodesById.get(nodeId);
  if (!n) return [];
  const picked = state.selectedIds.has(nodeId) ? [...state.selectedIds] : [nodeId];
  return openContextMenu(ev.clientX, ev.clientY, [
    { label: "编辑属性", hint: "右栏改", onClick: () => { setSelection([nodeId]); paintSelection(); focusProps(); } },
    {
      label: n.compact === 1 ? "已收纳：仅标题" : "收纳为仅标题",
      disabled: n.compact === 1,
      onClick: () => setNodeCompact(nodeId, 1)
    },
    {
      label: n.compact === 2 ? "已收纳：仅关键字" : "收纳为仅关键字",
      disabled: n.compact === 2,
      onClick: () => setNodeCompact(nodeId, 2)
    },
    n.compact ? { label: "展开（完整卡片）", onClick: () => setNodeCompact(nodeId, 0) } : null,
    (() => {
      // 同向链：一条出边接一条入边才算「接下去」，菜单上写清会收几个
      const chain = state.chainByMember ? state.chainByMember.get(nodeId) : null;
      if (chain && chainIsCollapsed(chain)) {
        return {
          label: `摊开这条同向链（${chain.count} 合 1）`,
          hint: "成员摆回原位",
          onClick: () => collapseChain(chain.id, false)
        };
      }
      const walk = chain.length >= 2 ? chain.nodeIds : walkChainLocal(nodeId);
      return {
        label: walk.length >= 2 ? `同向链收成一块（${walk.length} 个）` : "同向链收成一块",
        hint: walk.length >= 2 ? "双击标题可摊开" : "同向上接不出第二个",
        disabled: walk.length < 2,
        onClick: () => collapseChainOfNode(nodeId)
      };
    })(),
    {
      label: `建立节点组（${picked.length} 个）`,
      hint: picked.length >= 2 ? "" : "先框选/Shift 多选",
      disabled: picked.length < 2,
      onClick: () => createNodeGroup(picked)
    },
    n.groupId ? { label: "删除分组", hint: groupTitle(n.groupId), onClick: () => deleteNodeGroup(n.groupId, false) } : null,
    { label: "存成节点预设", hint: "以后到处套", onClick: () => saveNodeTemplate(nodeId) },
    { label: `删除节点「${cut(n.title, 12)}」`, hint: "只能删未起步且无连线", danger: true, onClick: () => deleteNode(nodeId) }
  ]);
}

function openGroupMenu(groupId, ev) {
  const members = groupMembers(groupId);
  const grp = (state.graph?.nodeGroups || []).find((x) => x.id === groupId);
  const collapsed = !!(grp && grp.collapsed);
  return openContextMenu(ev.clientX, ev.clientY, [
    {
      label: collapsed ? "展开这个组" : "收纳这个组",
      hint: collapsed ? "把成员摊回来" : `收起 ${members.length} 个成员`,
      onClick: () => collapseGroup(groupId, !collapsed)
    },
    {
      label: `选中组内 ${members.length} 个节点`,
      onClick: () => { setSelection(members.map((n) => n.id)); paintSelection(); }
    },
    { label: "存成组预设", hint: "整块可复用", onClick: () => saveGroupTemplate(groupId) },
    {
      label: `删除分组「${cut(groupTitle(groupId), 12)}」`,
      hint: "节点都留着",
      danger: true,
      onClick: () => deleteNodeGroup(groupId, false)
    },
    {
      label: `删除分组与组内 ${members.length} 个节点`,
      hint: "只删得起未起步且无连线的",
      danger: true,
      disabled: members.length === 0,
      onClick: () => deleteNodeGroup(groupId, true)
    }
  ]);
}

// ---------------- 选择 ----------------

function openChainMenu(chainId, ev) {
  const ch = chainById(chainId);
  if (!ch) return [];
  const members = chainMembers(ch);
  const collapsed = chainIsCollapsed(ch);
  return openContextMenu(ev.clientX, ev.clientY, [
    {
      label: collapsed ? "摊开这条链" : `收成一块（${members.length} 合 1）`,
      hint: collapsed ? "把成员摆回原位" : "只换看法，不动图",
      onClick: () => collapseChain(chainId, !chainIsCollapsed(chainById(chainId)))
    },
    {
      label: `选中链上 ${members.length} 个节点`,
      onClick: () => { setSelection(members.map((n) => n.id)); paintSelection(); }
    }
  ]);
}

/** 当前选中状态的一句话指纹：用来判断「画布上画的是不是就是这个选中」。 */
function selectionKey() {
  const ids = [...state.selectedIds].sort().join(",");
  return [state.selected || "", state.selectedEdge || "", state.selectedGroup || "", state.selectedChain || "", ids].join("|");
}

/** 焦点节点（含它所在的收纳组）：与它相连的线亮起来，其余压暗。 */
function touchesFocus(id) {
  const focus = state.selected;
  if (!focus) return false;
  if (id === focus) return true;
  const g = (state.nodesById.get(focus) || {}).groupId;
  if (!g || !state.collapsedIds || !state.collapsedIds.has(g)) return false;
  return ((state.nodesById.get(id) || {}).groupId || null) === g;
}

/** 节点卡片 / 连线的 class：渲染和「只上色不重绘」共用同一套，别写两份规则。 */
function nodeClass(n) {
  return "node-box" + (n.compact ? " compact" : "") +
    (state.selectedIds.has(n.id) ? " picked" : "") + (state.selected === n.id ? " focus" : "");
}

function edgeClass(e) {
  const gated = e && e.gate === "human" && !e.gateConfirmedBy;
  let cls = "edge" + (gated ? " edge-gated" : "");
  if (state.selectedEdge) cls += e && e.id === state.selectedEdge ? " edge-focus edge-selected" : " edge-dim";
  else if (state.selected && e) cls += (touchesFocus(e.fromNodeId) || touchesFocus(e.toNodeId)) ? " edge-focus" : " edge-dim";
  return cls;
}

/**
 * 只改选中态的高亮/压暗，不重建 DOM。
 * 节点可能上千，点一下整图重绘就是「点一下卡一下」的根源——选中这种纯视觉变化不该付构图的代价。
 */
function paintSelection() {
  for (const [id, el] of state.nodeEls || []) {
    const n = state.nodesById.get(id);
    if (!el || !el.setAttribute || !n) continue;
    el.setAttribute("class", nodeClass(n));
  }
  for (const [id, el] of state.edgeEls || []) {
    const e = state.edgesById.get(id);
    if (!el || !el.setAttribute || !e) continue;
    el.setAttribute("class", edgeClass(e));
  }
  const unmarkAll = (map) => {
    for (const el of (map ? map.values() : [])) {
      if (el && el.setAttribute) el.setAttribute("class", (el.getAttribute("class") || "").replace(/\s*picked/g, ""));
    }
  };
  const mark = (map, id) => {
    const el = map && map.get(id);
    if (el && el.setAttribute) el.setAttribute("class", (el.getAttribute("class") || "").replace(/\s*picked/g, "") + " picked");
  };
  unmarkAll(state.groupEls); unmarkAll(state.groupEdgeEls); unmarkAll(state.pillEls);
  unmarkAll(state.chainBoxEls); unmarkAll(state.chainFrameEls); unmarkAll(state.chainFrameLabelEls);
  if (state.selectedGroup) { mark(state.groupEls, state.selectedGroup); mark(state.groupEdgeEls, state.selectedGroup); mark(state.pillEls, state.selectedGroup); }
  if (state.selectedChain) { mark(state.chainBoxEls, state.selectedChain); mark(state.chainFrameEls, state.selectedChain); mark(state.chainFrameLabelEls, state.selectedChain); }
  state.paintedKey = selectionKey();
}

function setSelection(ids) {
  state.selectedIds = new Set(ids);
  state.selectedEdge = null;
  state.selectedGroup = null;
  state.selectedChain = null;
  if (ids.length === 1) selectNode(ids[0]);
  else if (ids.length === 0) { state.selected = null; $("sideBody").innerHTML = ""; }
}

// ---------------- 预设（模板库） ----------------

/** 落点取当前视图中心附近（世界坐标），套用的东西不会跑到视野外。 */
function centerWorld(dy = 0) {
  const v = state.view || captureView();
  const vp = state.viewport;
  return {
    x: Math.round((v.width / 2 - vp.tx) / vp.scale - NODE_W / 2),
    y: Math.round((v.height / 2 - vp.ty) / vp.scale - 140 + dy)
  };
}

async function openTemplatePanel() {
  const r = await api("/api/templates");
  if (!r.ok) { showToast(`${r.body?.error || r.status}：读模板库失败`, false); return r; }
  const nodeTemplates = r.body.nodeTemplates || [];
  const groupTemplates = r.body.groupTemplates || [];
  state.templates = r.body;
  const host = $("formHost");
  if (!host) return r;
  host.innerHTML = `
  <div class="form">
    <div class="formhead"><b>模板库（跨任务复用）</b><button type="button" id="closeTpl">关闭</button></div>
    <div class="muted">套用会把预设放到当前视野中间。组预预设连组内连线一起落下来。</div>
    <h3>节点预设（${nodeTemplates.length}）</h3>
    ${nodeTemplates.length
      ? nodeTemplates.map((t) => `<div class="tplRow">
          <span>${esc(t.name)}<em>${esc(t.title)} · ${esc(t.kind)} · 进${t.inPorts}/出${t.outPorts}</em></span>
          <button type="button" data-tpl-apply="node" data-tpl-id="${esc(t.id)}">套用</button>
          <button type="button" class="danger-btn" data-tpl-del="node" data-tpl-id="${esc(t.id)}">删</button>
        </div>`).join("")
      : `<div class="muted">还没有节点预设：右键节点 →「存成节点预设」。</div>`}
    <h3>组预设（${groupTemplates.length}）</h3>
    ${groupTemplates.length
      ? groupTemplates.map((t) => `<div class="tplRow">
          <span>${esc(t.name)}<em>${t.nodeCount} 个节点 · ${t.edgeCount} 条组内线</em></span>
          <button type="button" data-tpl-apply="group" data-tpl-id="${esc(t.id)}">套用</button>
          <button type="button" class="danger-btn" data-tpl-del="group" data-tpl-id="${esc(t.id)}">删</button>
        </div>`).join("")
      : `<div class="muted">还没有组预设：点一个组 → 右栏「存成组预设」。</div>`}
    <div id="tplResult" class="formResult"></div>
  </div>`;

  const closeBtn = $("closeTpl");
  if (closeBtn) closeBtn.onclick = closeForm;
  for (const b of host.querySelectorAll ? host.querySelectorAll("[data-tpl-apply]") : []) {
    b.onclick = () => (b.getAttribute("data-tpl-apply") === "node" ? applyNodeTemplate : applyGroupTemplate)(b.getAttribute("data-tpl-id"));
  }
  for (const b of host.querySelectorAll ? host.querySelectorAll("[data-tpl-del]") : []) {
    b.onclick = () => (b.getAttribute("data-tpl-del") === "node" ? deleteNodeTemplate : deleteGroupTemplate)(b.getAttribute("data-tpl-id"));
  }
  return r;
}

async function applyNodeTemplate(templateId) {
  if (!state.taskId) { showToast("先选一个任务，再套用预设", false); return { ok: false, status: 0, body: { error: "no-task" } }; }
  const at = centerWorld();
  const r = await api(`/api/tasks/${encodeURIComponent(state.taskId)}/apply-node-template`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ templateId, x: at.x, y: at.y })
  });
  if (r.ok) {
    showToast(`已套用节点预设：「${r.body.node.title}」`, true);
    await refresh();
    await selectNode(r.body.node.id);
    paintSelection();
  } else {
    showToast(`${r.body?.error || r.status}：${r.body?.message || "套用失败"}`, false);
  }
  return r;
}

async function applyGroupTemplate(templateId) {
  if (!state.taskId) { showToast("先选一个任务，再套用预设", false); return { ok: false, status: 0, body: { error: "no-task" } }; }
  const at = centerWorld();
  const r = await api(`/api/tasks/${encodeURIComponent(state.taskId)}/apply-group-template`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ templateId, x: at.x, y: at.y })
  });
  if (r.ok) {
    const n = (r.body.nodes || []).length;
    showToast(`已套用组预设：${n} 个节点${r.body.groupId ? "，并圈成一个组" : ""}`, true);
    await refresh();
    if (r.body.groupId) selectGroup(r.body.groupId);
    else render();
  } else {
    showToast(`${r.body?.error || r.status}：${r.body?.message || "套用失败"}`, false);
  }
  return r;
}

/** 把一个节点存成预设（右键节点菜单）。 */
async function saveNodeTemplate(nodeId, name) {
  const n = state.nodesById.get(nodeId);
  const r = await api("/api/templates/nodes", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ nodeId, name: name || "" })
  });
  if (r.ok) showToast(`已存成节点预设「${r.body.name}」（${n ? n.title : nodeId}）`, true);
  else showToast(`${r.body?.error || r.status}：${r.body?.message || "存预设失败"}`, false);
  return r;
}

/** 把一个组存成预设（组面板/组菜单）。 */
async function saveGroupTemplate(groupId, name) {
  const r = await api("/api/templates/groups", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ groupId, name: name || "" })
  });
  if (r.ok) showToast(`已存成组预设「${r.body.name}」：${r.body.nodeCount} 个节点、${r.body.edgeCount} 条组内线`, true);
  else showToast(`${r.body?.error || r.status}：${r.body?.message || "存组预设失败"}`, false);
  return r;
}

async function deleteNodeTemplate(templateId) {
  const r = await api(`/api/templates/nodes/${encodeURIComponent(templateId)}`, { method: "DELETE" });
  if (r.ok) { showToast("节点预设已删", true); await openTemplatePanel(); }
  else showToast(`${r.body?.error || r.status}：删不掉`, false);
  return r;
}

async function deleteGroupTemplate(templateId) {
  const r = await api(`/api/templates/groups/${encodeURIComponent(templateId)}`, { method: "DELETE" });
  if (r.ok) { showToast("组预设已删", true); await openTemplatePanel(); }
  else showToast(`${r.body?.error || r.status}：删不掉`, false);
  return r;
}

// ---------------- 循环区（组＋回边＋检查点） ----------------

/** 把一个组声明成循环区：自动连上「尾 → 头」的回边。 */
async function declareLoop(groupId) {
  const head = $("grpLoopHead") ? $("grpLoopHead").value : "";
  const tail = $("grpLoopTail") ? $("grpLoopTail").value : "";
  const limit = $("grpLoopLimit") ? Number($("grpLoopLimit").value || 3) : 3;
  const r = await api(`/api/node-groups/${encodeURIComponent(groupId)}/loop`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ head, tail, limit })
  });
  const box = $("grpLoopResult");
  if (r.ok) {
    showToast(`已把这个组声明为循环区（上限 ${r.body.limit}），回边已连好`, true);
    await refresh();
    selectGroup(groupId);
  } else if (box) {
    box.className = "formResult err";
    box.innerHTML = `<b>${esc(r.body?.error || r.status)}</b>：${esc(r.body?.message || "声明失败")}`;
  } else {
    showToast(`${r.body?.error || r.status}：${r.body?.message || "声明失败"}`, false);
  }
  return r;
}

/** 撤销循环：删掉回边与上限，组留着。 */
async function undoLoop(groupId) {
  const r = await api(`/api/node-groups/${encodeURIComponent(groupId)}/loop`, { method: "DELETE" });
  if (r.ok) {
    showToast(`已撤销循环（删了 ${r.body.edgesDeleted} 条回边），组还在`, true);
    await refresh();
    selectGroup(groupId);
  } else {
    showToast(`${r.body?.error || r.status}：${r.body?.message || "撤销失败"}`, false);
  }
  return r;
}

/** 调高轮次上限（只有 master/lead 能干）。 */
async function raiseLoopLimit(groupId) {
  const cy = state.cycleByGroup.get(groupId);
  if (!cy) { showToast("这个组不是循环区", false); return { ok: false, status: 0, body: { error: "no-cycle" } }; }
  const limit = $("grpLimitInput") ? Number($("grpLimitInput").value || cy.limit) : cy.limit;
  const r = await api(`/api/cycles/${encodeURIComponent(cy.id)}/raise`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ by: "master", limit, reason: "画布上调高上限" })
  });
  if (r.ok) { showToast(`上限已调到 ${r.body.limit}`, true); await refresh(); selectGroup(groupId); }
  else showToast(`${r.body?.error || r.status}：${r.body?.message || "调高失败"}`, false);
  return r;
}

// ---------------- 节点组面板 ----------------

function selectGroup(groupId) {
  state.selected = null;
  state.selectedIds = new Set();
  state.selectedEdge = null;
  state.selectedChain = null;
  state.selectedGroup = groupId;
  renderGroupPanel(groupId);
  paintSelection();
  return groupId;
}

function renderGroupPanel(groupId) {
  const grp = (state.graph?.nodeGroups || []).find((x) => x.id === groupId);
  if (!grp) { state.selectedGroup = null; $("sideBody").innerHTML = ""; return; }
  const members = groupMembers(groupId);
  const cy = state.cycleByGroup.get(groupId);
  $("sideBody").innerHTML = `
  <div class="node-head">
    <h2>节点组：${esc(grp.title)}</h2>
    <div class="goal">${members.length} 个节点${grp.collapsed ? " · 已收纳（成员在画布上隐藏）" : ""}${cy ? ` · <b>循环区</b>（上限 ${cy.limit}，已跑 ${cy.visited} 轮${cy.pausedReason ? " · " + esc(cy.pausedReason) : ""}）` : ""}</div>
    <div style="margin-top:6px"><span class="chip" style="background:${cy ? "#7c3aed" : "#2563eb"}">${cy ? "循环区（组＋回边＋检查点）" : "分组"}</span>
      <span class="muted">${cy ? "轮次到上限先出检查点" : "不进门、不参与执行"}</span></div>
  </div>

  <div class="section"><h3>循环区</h3>
    ${cy
      ? `<div class="portsRow">
           <span class="muted">头 ${esc(cy.headNodeId)} → 尾 ${esc(cy.tailNodeId)} · 上限 ${cy.limit}${cy.limitKind === "perpetual" ? "（不限）" : ""}</span>
         </div>
         <div class="portsRow">
           <label class="muted">调高上限 <input id="grpLimitInput" type="number" min="1" value="${cy.limit}" style="width:70px" /></label>
           <button type="button" id="grpRaiseBtn">调高（master/lead）</button>
           <button type="button" id="grpUndoLoopBtn" class="danger-btn">撤销循环（组留着）</button>
         </div>
         <div id="grpLoopResult" class="formResult"></div>`
      : `<div class="propsForm">
           <label>头（每轮从这里重新开始）<select id="grpLoopHead">${members.map((n) => `<option value="${esc(n.id)}">${esc(n.title)}</option>`).join("")}</select></label>
           <label>尾（它做完就算跑完一轮）<select id="grpLoopTail">${members.map((n) => `<option value="${esc(n.id)}"${members.length > 1 ? "" : " selected"}>${esc(n.title)}</option>`).join("")}</select></label>
           <label>轮次上限（到上限先出检查点）<input id="grpLoopLimit" type="number" min="1" value="3" /></label>
           <div class="portsRow"><button type="button" id="grpDeclareLoopBtn" class="primary">声明为循环区（自动建回边）</button></div>
           <div class="muted">组＋回边＋检查点＝循环区：声明时会自动把「尾 → 头」的回边连上。</div>
           <div id="grpLoopResult" class="formResult"></div>
         </div>`}
  </div>

  <div class="section"><h3>组内节点</h3>
    ${members.length ? `<ul>${members.map((n) => `<li>${esc(n.title)} <span class="muted">${esc(STATUS_TEXT[n.status] || n.status)}</span></li>`).join("")}</ul>` : `<div class="muted">组里没有节点了。</div>`}
  </div>

  <div class="section"><h3>看</h3>
    <div class="portsRow">
      <button type="button" id="grpCollapseBtn">${grp.collapsed ? "展开这个组" : "收纳这个组"}</button>
      <button type="button" id="grpSelectBtn">选中组内 ${members.length} 个节点</button>
      <button type="button" id="grpSaveTplBtn">存成组预设</button>
    </div>
  </div>

  <div class="section"><h3>删除</h3>
    <div class="portsRow">
      <button type="button" id="grpDissolveBtn" class="danger-btn">删除分组（节点都留着）</button>
    </div>
    <div class="portsRow">
      <button type="button" id="grpDeleteAllBtn" class="danger-btn">删除分组与组内 ${members.length} 个节点</button>
    </div>
    <div class="muted">连节点一起删是整批口径：组里有一个删不起（已起步或还挂着线），整批都不动。</div>
    <div id="grpResult" class="formResult"></div>
  </div>`;

  const cBtn = $("grpCollapseBtn");
  if (cBtn) cBtn.onclick = () => collapseGroup(groupId, !grp.collapsed);
  const sBtn = $("grpSelectBtn");
  if (sBtn) sBtn.onclick = () => { setSelection(members.map((n) => n.id)); paintSelection(); };
  const tBtn = $("grpSaveTplBtn");
  if (tBtn) tBtn.onclick = () => saveGroupTemplate(groupId);
  const declBtn = $("grpDeclareLoopBtn");
  if (declBtn) declBtn.onclick = () => declareLoop(groupId);
  const undoBtn = $("grpUndoLoopBtn");
  if (undoBtn) undoBtn.onclick = () => undoLoop(groupId);
  const raiseBtn = $("grpRaiseBtn");
  if (raiseBtn) raiseBtn.onclick = () => raiseLoopLimit(groupId);
  const dBtn = $("grpDissolveBtn");
  if (dBtn) dBtn.onclick = () => deleteNodeGroup(groupId, false);
  const aBtn = $("grpDeleteAllBtn");
  if (aBtn) aBtn.onclick = () => deleteNodeGroup(groupId, true);
}

// ---------------- 键盘删除 ----------------

/** 输入框里按 Delete 是删字，不是删节点。 */
function isTypingTarget(t) {
  if (!t) return false;
  const tag = (t.tagName || "").toString().toLowerCase();
  if (tag === "input" || tag === "textarea" || tag === "select") return true;
  return !!(t.isContentEditable);
}

/**
 * Delete 键：删「当前选中的那个东西」。
 * 优先级＝连线 > 同向链 > 组 > 多选节点 > 单节点；每种都走它自己的守卫，删不掉就把原因说出来。
 * 容器（链/组）按 Delete 只撤掉容器本身：链摊开、组解散，里面的节点一个不动。
 */
async function deleteSelected() {
  if (state.selectedEdge) return removeEdge(state.selectedEdge);
  if (state.selectedChain) return collapseChain(state.selectedChain, false);
  if (state.selectedGroup) return deleteNodeGroup(state.selectedGroup, false);   // 默认只解散，连节点删要走面板/菜单
  const ids = [...state.selectedIds];
  if (ids.length > 1) return deleteNodes(ids);
  if (state.selected) return deleteNode(state.selected);
  if (ids.length === 1) return deleteNode(ids[0]);
  showToast("先点一下要删的节点/连线/组（或按 Shift 多选）", false);
  return { ok: false, status: 0, body: { error: "no-selection" } };
}

/** 一次删多个节点：能删的删掉，删不掉的点名报出来（不静默丢）。 */
async function deleteNodes(ids) {
  const okIds = [];
  const failed = [];
  for (const id of ids) {
    const n = state.nodesById.get(id);
    const r = await api(`/api/nodes/${encodeURIComponent(id)}`, { method: "DELETE" });
    if (r.ok) okIds.push(n ? n.title : id);
    else failed.push(`${n ? n.title : id}（${r.body?.error || r.status}）`);
  }
  setSelection([]);
  await refresh();
  if (failed.length) {
    showToast(`删掉 ${okIds.length} 个；删不掉 ${failed.length} 个：${failed.join("、")}`, false);
  } else {
    showToast(`删掉 ${okIds.length} 个节点`, true);
  }
  return { ok: failed.length === 0, status: 200, body: { deleted: okIds, failed } };
}

// ---------------- 连线面板（点线看它的走向与门控） ----------------

function portOptions(count, current) {
  let out = "";
  for (let i = 0; i < Math.max(1, count); i++) {
    out += `<option value="${i}"${i === current ? " selected" : ""}>第 ${i + 1} 个</option>`;
  }
  return out;
}

async function selectEdge(edgeId) {
  state.selected = null;
  state.selectedIds = new Set();
  state.selectedGroup = null;
  state.selectedChain = null;
  state.selectedEdge = edgeId;
  const r = await api(`/api/edges/${encodeURIComponent(edgeId)}`);
  if (!r.ok) {
    state.selectedEdge = null;
    showToast(`${r.body?.error || r.status}：${r.body?.message || "读连线失败"}`, false);
    paintSelection();
    return r;
  }
  renderEdgePanel(r.body.edge);
  paintSelection();
  return r;
}

function renderEdgePanel(e) {
  const gateText = e.gate === "human"
    ? (e.gateConfirmedBy ? `人工门控 · 已由 ${esc(e.gateConfirmedBy)} 确认` : "人工门控 · 还没确认（下游会被它挡住）")
    : "自动门控 · 上游做完就放行";
  const nodeOpts = (state.graph?.nodes || [])
    .map((n) => `<option value="${esc(n.id)}"${n.id === e.fromNodeId ? " selected" : ""}>${esc(n.title)}</option>`)
    .join("");
  const nodeOptsTo = (state.graph?.nodes || [])
    .map((n) => `<option value="${esc(n.id)}"${n.id === e.toNodeId ? " selected" : ""}>${esc(n.title)}</option>`)
    .join("");

  $("sideBody").innerHTML = `
  <div class="node-head">
    <h2>连线：${esc(e.fromTitle || e.fromNodeId)} → ${esc(e.toTitle || e.toNodeId)}</h2>
    <div class="goal">${esc(gateText)}</div>
    <div style="margin-top:6px">
      <span class="chip" style="background:${e.gate === "human" ? (e.gateConfirmedBy ? "#16a34a" : "#f97316") : "#64748b"}">${e.kind}</span>
      <span class="muted">端口 出 ${e.fromPort + 1} / 进 ${e.toPort + 1}${e.released ? " · 这条线已经放过行" : ""}</span>
    </div>
    ${e.released ? `<div class="muted">已经放过行的线只能改门控与备注；改走向/类型要删掉重连。</div>` : ""}
  </div>

  <div class="section"><h3>连线关系</h3>
    <div class="propsForm">
      <label>起点<input disabled value="${esc(e.fromTitle || e.fromNodeId)}" /></label>
      <label>终点 <select id="eToSel"${e.released ? " disabled" : ""}>${nodeOptsTo}</select></label>
      <label>类型
        <select id="eKindSel"${e.released ? " disabled" : ""}>
          <option value="transfer"${e.kind === "transfer" ? " selected" : ""}>transfer · 传递（要等上游做完）</option>
          <option value="loop"${e.kind === "loop" ? " selected" : ""}>loop · 回边（进下一轮）</option>
        </select>
      </label>
      <label>挂哪个出线口 / 进线口
        <span class="portsRow">
          <select id="eFromPortSel"${e.released ? " disabled" : ""}>${portOptions(e.fromOutPorts, e.fromPort)}</select>
          <select id="eToPortSel"${e.released ? " disabled" : ""}>${portOptions(e.toInPorts, e.toPort)}</select>
        </span>
      </label>
      <div class="muted">起点改不了（要从别处出发就删掉这条、重新画）</div>
    </div>
  </div>

  <div class="section"><h3>门控</h3>
    <div class="propsForm">
      <label>这条线怎么放行
        <select id="eGateSel">
          <option value="auto"${e.gate === "auto" ? " selected" : ""}>auto · 上游做完就放行</option>
          <option value="human"${e.gate === "human" ? " selected" : ""}>human · 还要人在这条线上点头</option>
        </select>
      </label>
      <label>门控说明（给人看的条件，一句话）<input id="eGateNote" value="${esc(e.gateNote || "")}" placeholder="例如：核对过数字口径才放行" /></label>
      <div class="portsRow">
        <button type="button" id="saveEdgeBtn">保存</button>
        ${e.gate === "human" && !e.gateConfirmedBy ? `<button type="button" id="confirmGateBtn" class="primary">确认门控（点头放行）</button>` : ""}
      </div>
      <div id="edgeResult" class="formResult"></div>
    </div>
  </div>

  <div class="section"><h3>删除</h3>
    <div class="portsRow">
      <button type="button" id="delEdgeBtn" class="danger-btn">删除这条连线</button>
      <span class="muted">${e.released ? "已放过行的线删不了" : "删完下游的规则组会跟着重算"}</span>
    </div>
    <div id="edgeDelResult" class="formResult"></div>
  </div>`;

  const saveBtn = $("saveEdgeBtn");
  if (saveBtn) saveBtn.onclick = () => saveEdge(e.id);
  const cBtn = $("confirmGateBtn");
  if (cBtn) cBtn.onclick = () => confirmEdgeGate(e.id);
  const dBtn = $("delEdgeBtn");
  if (dBtn) dBtn.onclick = () => removeEdge(e.id);
}

async function saveEdge(edgeId) {
  const body = {
    to: $("eToSel") ? $("eToSel").value : undefined,
    kind: $("eKindSel") ? $("eKindSel").value : undefined,
    fromPort: $("eFromPortSel") ? Number($("eFromPortSel").value) : undefined,
    toPort: $("eToPortSel") ? Number($("eToPortSel").value) : undefined,
    gate: $("eGateSel") ? $("eGateSel").value : undefined,
    gateNote: $("eGateNote") ? $("eGateNote").value : undefined
  };
  const r = await api(`/api/edges/${encodeURIComponent(edgeId)}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });
  const box = $("edgeResult");
  if (r.ok) {
    if (box) { box.className = "formResult ok"; box.innerHTML = (r.body.changed || []).length ? `已保存：${esc(r.body.changed.join("；"))}` : "没有改动"; }
    await refresh();
    await selectEdge(edgeId);
    showToast((r.body.activated || []).length ? `已更新，并起步：${r.body.activated.map(nodeTitle).join("、")}` : "连线已更新", true);
  } else {
    if (box) { box.className = "formResult err"; box.innerHTML = `<b>${esc(r.body?.error || r.status)}</b>：${esc(r.body?.message || "改连线失败")}`; }
    showToast(`${r.body?.error || r.status}：${r.body?.message || "改连线失败"}`, false);
  }
  return r;
}

async function confirmEdgeGate(edgeId) {
  const r = await api(`/api/edges/${encodeURIComponent(edgeId)}/confirm`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ by: "ui" })
  });
  if (r.ok) {
    const act = r.body.activated || [];
    showToast(act.length ? `门控已确认，已起步：${act.map(nodeTitle).join("、")}` : "门控已确认（上游还没做完，先记着）", true);
    await refresh();
    await selectEdge(edgeId);
  } else {
    showToast(`${r.body?.error || r.status}：${r.body?.message || "确认门控失败"}`, false);
  }
  return r;
}

async function removeEdge(edgeId) {
  const r = await api(`/api/edges/${encodeURIComponent(edgeId)}`, { method: "DELETE" });
  const box = $("edgeDelResult");
  if (r.ok) {
    state.selectedEdge = null;
    showToast("连线已删除（下游规则组已重算）", true);
    await refresh();
    $("sideBody").innerHTML = "";
  } else {
    if (box) { box.className = "formResult err"; box.innerHTML = `<b>${esc(r.body?.error || r.status)}</b>：${esc(r.body?.message || "删不掉")}`; }
    showToast(`${r.body?.error || r.status}：${r.body?.message || "删不掉"}`, false);
  }
  return r;
}

function toggleSelection(nodeId) {
  const next = new Set(state.selectedIds);
  if (next.has(nodeId)) next.delete(nodeId); else next.add(nodeId);
  setSelection([...next]);
  paintSelection();
}

function nodesInRect(rect) {
  const out = [];
  for (const n of state.graph?.nodes || []) {
    if (state.hiddenIds && state.hiddenIds.has(n.id)) continue;   // 收纳起来的成员不参与框选
    const p = state.positions.get(n.id);
    if (!p) continue;
    if (p.x < rect.x + rect.w && p.x + p.w > rect.x && p.y < rect.y + rect.h && p.y + p.h > rect.y) out.push(n.id);
  }
  return out;
}

// ---------------- 拖动 / 连线 / 框选 / 平移 ----------------

function moveNodeTo(nodeId, x, y) {
  const p = state.positions.get(nodeId);
  if (!p) return false;
  if (p.x === x && p.y === y) return false;
  p.x = x;
  p.y = y;
  // 图里的坐标也跟着改：render() 是按 nodes[].posX/posY 重算布局的，
  // 只改 positions 会留下「库里还是旧坐标」的状态，任何一次重绘都把节点摆回去（拖动回弹的真凶）。
  const n = state.nodesById.get(nodeId);
  if (n) { n.posX = Math.round(x); n.posY = Math.round(y); }
  const el = state.nodeEls.get(nodeId);
  if (el && el.setAttribute) el.setAttribute("transform", `translate(${x},${y})`);
  const ids = state.incident.get(nodeId);
  if (ids) for (const edgeId of ids) state.dirtyEdges.add(edgeId);
  return true;
}

/**
 * Shift 拖动的左右吸附：把被拖节点的**左缘**对齐到邻居左缘、**右缘**对齐到邻居右缘，
 * 或者贴到邻居的右侧/左侧。同宽节点下「左对左」与「右对右」等价——真正的区别在贴靠那两条，
 * 所以四种候选都算，取阈值（SNAP_PX）内最近的一条，其余远处的自然不命中。
 */
/**
 * 一个轴上的吸附：左右（x）与前后/上下（y）各四种候选——
 * 上/左缘对齐、下/右缘对齐、贴到它下方/右侧、贴到它上方/左侧。
 * 取阈值（SNAP_PX）内最近的一条；两轴各算各的，所以能同时吸成一列又一行。
 */
function snapAxis(raw, axis, excludeIds = []) {
  const skip = new Set(excludeIds);
  const horizontal = axis === "x";
  const mine = horizontal ? NODE_W : NODE_H;
  let best = null;
  let lo = Infinity;
  let hi = -Infinity;
  for (const n of state.graph?.nodes || []) {
    const p = state.positions.get(n.id);
    if (!p) continue;
    if (horizontal) { lo = Math.min(lo, p.y); hi = Math.max(hi, p.y + p.h); }
    else { lo = Math.min(lo, p.x); hi = Math.max(hi, p.x + p.w); }
    if (skip.has(n.id)) continue;
    const cands = horizontal
      ? [
          { v: p.x, at: p.x, tip: "左对齐" },
          { v: p.x + p.w - mine, at: p.x + p.w, tip: "右对齐" },
          { v: p.x + p.w, at: p.x + p.w, tip: "贴到右侧" },
          { v: p.x - mine, at: p.x, tip: "贴到左侧" }
        ]
      : [
          { v: p.y, at: p.y, tip: "上对齐" },
          { v: p.y + p.h - mine, at: p.y + p.h, tip: "下对齐" },
          { v: p.y + p.h, at: p.y + p.h, tip: "贴到下方" },
          { v: p.y - mine, at: p.y, tip: "贴到上方" }
        ];
    for (const c of cands) {
      const dist = Math.abs(c.v - raw);
      if (dist > SNAP_PX) continue;
      if (!best || dist < best.dist) best = { v: c.v, dist, tip: c.tip, at: c.at };
    }
  }
  if (!best) return null;
  return { value: best.v, guide: { axis, at: best.at, from: lo - 28, to: hi + 28, tip: best.tip } };
}

/** 兼容老名字：只管左右那一轴。 */
function snapX(rawX, excludeIds = []) {
  const hit = snapAxis(rawX, "x", excludeIds);
  return hit ? { x: hit.value, guide: hit.guide } : null;
}

function ensureGuideEls(n) {
  const g = viewportEl();
  if (!g || typeof document.createElementNS !== "function") return;
  if (!state.alignLineEls) { state.alignLineEls = []; state.alignTipEls = []; }
  while (state.alignLineEls.length < n) {
    const line = document.createElementNS(SVG_NS, "path");
    if (line.setAttribute) { line.setAttribute("class", "align-line"); line.setAttribute("fill", "none"); }
    if (g.appendChild) g.appendChild(line);
    const tip = document.createElementNS(SVG_NS, "text");
    if (tip.setAttribute) tip.setAttribute("class", "align-tip");
    if (g.appendChild) g.appendChild(tip);
    state.alignLineEls.push(line);
    state.alignTipEls.push(tip);
  }
}

/** 吸附参考线：左右吸画竖虚线、前后吸画横虚线，各带一句「上/下/左/右对齐 · 贴到哪边」。 */
function drawAlignGuide(guides) {
  const list = (Array.isArray(guides) ? guides : (guides ? [guides] : [])).filter(Boolean);
  const g = viewportEl();
  if (!g || typeof document.createElementNS !== "function") return;
  if (!list.length && !(state.alignLineEls && state.alignLineEls.length)) return;
  ensureGuideEls(2);
  if (!state.alignLineEls) return;
  state.alignLineEls.forEach((line, i) => {
    const gd = list[i];
    const tip = state.alignTipEls[i];
    if (!gd) {
      if (line.setAttribute) line.setAttribute("d", "");
      if (tip && tip.textContent !== undefined) tip.textContent = "";
      return;
    }
    const d = gd.axis === "y"
      ? `M ${gd.from} ${gd.at} L ${gd.to} ${gd.at}`
      : `M ${gd.at} ${gd.from} L ${gd.at} ${gd.to}`;
    if (line.setAttribute) line.setAttribute("d", d);
    if (tip && tip.setAttribute) {
      tip.setAttribute("x", gd.axis === "y" ? gd.from : gd.at + 6);
      tip.setAttribute("y", gd.axis === "y" ? gd.at - 6 : gd.from + 12);
    }
    if (tip && tip.textContent !== undefined) tip.textContent = gd.tip;
  });
}

/** 拖动核心：立刻改 transform（跟手），连线交给下一帧；按住 Shift 就左右 + 前后吸附。 */
function applyDragFrame() {
  const d = state.drag;
  if (!d || !d.pending) return;
  // 画布没有边缘：世界坐标可以是负数，往左上也照样拖（不再夹到 0）
  const movingIds = d.startPositions ? [...d.startPositions.keys()] : [d.id];
  let nx = d.pending.x - d.offsetX;
  let ny = d.pending.y - d.offsetY;
  if (d.align) {
    const hx = snapAxis(nx, "x", movingIds);
    const hy = snapAxis(ny, "y", movingIds);
    if (hx) nx = hx.value;
    if (hy) ny = hy.value;
    state.aligns = [hx && hx.guide, hy && hy.guide].filter(Boolean);
    state.align = state.aligns[0] || null;
  } else {
    state.aligns = [];
    state.align = null;
  }

  if (d.startPositions && d.startPrimary) {
    const dx = nx - d.startPrimary.x;
    const dy = ny - d.startPrimary.y;
    // 手抖 1–2 px 不算拖：否则「点一下」会被判成拖动，click 被吞、节点还挪了半格
    if (!d.moved && Math.abs(dx) < DRAG_START && Math.abs(dy) < DRAG_START) {
      drawAlignGuide(state.aligns);
      return;
    }
    if (dx !== 0 || dy !== 0 || d.moved) {
      d.moved = true;
      for (const [id, start] of d.startPositions) moveNodeTo(id, start.x + dx, start.y + dy);
      if (d.startPositions.size) redrawBoxesFor([...d.startPositions.keys()]);
    }
  } else if (nx !== d.x || ny !== d.y) {
    d.x = nx;
    d.y = ny;
    d.moved = true;
    moveNodeTo(d.id, nx, ny);
    redrawBoxesFor([d.id]);
  }
  drawAlignGuide(state.aligns);
}

function scheduleDragFrame() {
  if (state.frame) return;
  const raf = typeof globalThis.requestAnimationFrame === "function"
    ? globalThis.requestAnimationFrame
    : (cb) => setTimeout(cb, 16);
  state.frame = raf(() => {
    state.frame = null;
    redrawDirtyEdges();
  });
}

function redrawDirtyEdges() {
  if (!state.dirtyEdges.size) return;
  for (const edgeId of state.dirtyEdges) {
    const el = state.edgeEls.get(edgeId);
    const e = state.edgesById.get(edgeId);
    if (!el || !e || !el.setAttribute) continue;
    // 一头藏在链块/组牌里的线：拖动中途不重画（松手会整图重排），免得线飞出去
    if (state.hiddenIds && (state.hiddenIds.has(e.fromNodeId) || state.hiddenIds.has(e.toNodeId))) continue;
    const from = state.positions.get(e.fromNodeId);
    const to = state.positions.get(e.toNodeId);
    if (!from || !to) continue;
    el.setAttribute("d", edgePath(from, to, e));
  }
  state.dirtyEdges.clear();
}

function redrawIncident(nodeId) {
  const ids = state.incident ? state.incident.get(nodeId) : null;
  if (ids) for (const id of ids) state.dirtyEdges.add(id);
}

function redrawCycleFor(nodeId) {
  return;   // 循环区已经由组承载：拖动时重绘组框就够了
  /* eslint-disable no-unreachable */
  const g = state.graph;
  const node = (g?.nodes || []).find((n) => n.id === nodeId);
  if (!node || !node.cycleRegion) return;
  for (const cy of g.cycles) {
    if (cy.regionKey !== node.cycleRegion) continue;
    const region = g.nodes.filter((n) => n.cycleRegion === cy.regionKey).map((n) => state.positions.get(n.id)).filter(Boolean);
    if (!region.length) continue;
    const rect = state.cycleEls.get(cy.id);
    const label = state.cycleLabelEls.get(cy.id);
    const x1 = Math.min(...region.map((p) => p.x)) - 16;
    const y1 = Math.min(...region.map((p) => p.y)) - 32;
    const x2 = Math.max(...region.map((p) => p.x + p.w)) + 16;
    const y2 = Math.max(...region.map((p) => p.y + p.h)) + 42;
    if (rect && rect.setAttribute) {
      rect.setAttribute("x", x1);
      rect.setAttribute("y", y1);
      rect.setAttribute("width", x2 - x1);
      rect.setAttribute("height", y2 - y1);
    }
    if (label && label.setAttribute) {
      label.setAttribute("x", x1 + 8);
      label.setAttribute("y", y1 + 16);
    }
  }
}

function onSvgPointerDown(ev) {
  const target = ev.target;
  const nodeEl = target && target.closest ? target.closest("[data-node]") : null;
  state.suppressClick = false;
  closeContextMenu();
  captureView();

  if (ev.button === 1) { startPan(ev); return; }                 // 中键平移

  // 组的名字（标签）与组的边（那一圈描边）＝抓手：
  // 按住拖＝整组一起挪；按下没拖动＝选中这个组（右栏出组面板）；右键＝组菜单
  const chipEl = target && target.closest ? target.closest("[data-nodegroup-chip]") : null;
  const edgeEl = target && target.closest ? target.closest("[data-nodegroup-edge]") : null;
  const groupHit = chipEl || edgeEl;
  if (groupHit) {
    const groupId = chipEl ? chipEl.getAttribute("data-nodegroup-chip") : edgeEl.getAttribute("data-nodegroup-edge");
    if (ev.button === 2) {
      openGroupMenu(groupId, ev);
      if (ev.preventDefault) ev.preventDefault();
      return;
    }
    if (ev.button !== 0) return;
    const members = groupMembers(groupId).map((x) => x.id).filter((id) => state.positions.has(id));
    if (!members.length) { selectGroup(groupId); return; }
    setSelection(members);
    startDrag(members[0], ev);
    if (state.drag) state.drag.groupId = groupId;
    if (ev.preventDefault) ev.preventDefault();
    return;
  }

  // 收纳后的组：这是一块替身牌，按住拖＝整组一起挪，点一下（没拖动）＝组菜单
  const pillEl = target && target.closest ? target.closest("[data-nodegroup-pill]") : null;
  if (pillEl) {
    const groupId = pillEl.getAttribute("data-nodegroup-pill");
    if (ev.button !== 0 && ev.button !== 2) return;
    const members = groupMembers(groupId).map((x) => x.id);
    if (!members.length) return;
    setSelection(members);
    startDrag(members[0], ev);
    if (state.drag) state.drag.groupId = groupId;
    return;
  }

  // 同向链块：按住拖＝整条链一起挪（链块位置由链头决定），点一下＝选中这条链，右键＝链菜单
  const chainEl = target && target.closest ? target.closest("[data-chain]") : null;
  if (chainEl) {
    const chainId = chainEl.getAttribute("data-chain");
    const ch = (state.chains || []).find((x) => x.id === chainId);
    if (!ch) return;
    if (ev.button === 2) { openChainMenu(chainId, ev); if (ev.preventDefault) ev.preventDefault(); return; }
    if (ev.button !== 0) return;
    const ids = (ch.nodeIds || []).filter((id) => state.positions.has(id));
    if (!ids.length) return;
    setSelection(ids);
    startDrag(ch.headNodeId, ev);
    if (state.drag) state.drag.chainId = chainId;
    return;
  }

  const nodeId = nodeEl ? nodeEl.getAttribute("data-node") : null;
  if (!nodeId) {
    if (ev.button === 0) startMarquee(ev);                       // 空白左键＝框选
    return;
  }

  const portEl = target.closest ? target.closest("[data-port]") : null;
  const portKind = portEl ? portEl.getAttribute("data-port") : null;
  const portIndex = portEl ? Number(portEl.getAttribute("data-index") || 0) : 0;

  if (ev.button === 2) { startConnect(nodeId, ev, portIndex); return; }
  if (ev.button !== 0) return;
  if (portKind === "out") { startConnect(nodeId, ev, portIndex); return; }
  // Shift 按住也走拖动：拖起来是「左右吸附对齐」，没拖动就是 Shift 点击加/减选（在 pointerup 里判）
  startDrag(nodeId, ev);
}

function startDrag(nodeId, ev) {
  const shift = !!ev.shiftKey;
  // Shift 按住时不动选区：挪完没拖动才算「Shift 点击＝加/减选」
  if (!shift && !state.selectedIds.has(nodeId)) setSelection([nodeId]);
  const p0 = state.positions.get(nodeId);
  if (!p0) return;
  const pt = svgPoint(ev);
  const ids = shift && !state.selectedIds.has(nodeId)
    ? [nodeId]
    : [...state.selectedIds].filter((id) => state.positions.has(id));
  const startPositions = new Map(ids.map((id) => [id, { x: state.positions.get(id).x, y: state.positions.get(id).y }]));
  const cycleIds = ids.filter((id) => (state.graph?.nodes || []).find((n) => n.id === id)?.cycleRegion);
  state.drag = {
    id: nodeId, ids, startPositions, startPrimary: { x: p0.x, y: p0.y }, cycleIds,
    offsetX: pt.x - p0.x, offsetY: pt.y - p0.y, moved: false, pending: null,
    align: shift, shiftArm: shift
  };
  ev.preventDefault();
}

function onSvgPointerMove(ev) {
  if (state.pan) {
    const p = state.pan;
    state.viewport.tx = p.tx + (ev.clientX - p.x);
    state.viewport.ty = p.ty + (ev.clientY - p.y);
    applyViewport();
    return;
  }
  if (state.marquee) { updateMarquee(ev); return; }
  if (state.drag) {
    state.drag.align = !!ev.shiftKey;      // 拖动中按下/松开 Shift 立刻生效
    state.drag.pending = svgPoint(ev);
    applyDragFrame();            // 跟手：位置立刻生效，不等下一帧
    scheduleDragFrame();         // 只合并连线重绘
    return;
  }
  if (state.connect) {
    const c = state.connect;
    // 右键按下先不算连线：得真的拖出去（>4px）才算，否则松手就是出菜单
    if (c.needMove && !c.moved) {
      const dist = Math.hypot((ev.clientX ?? 0) - (c.startX ?? 0), (ev.clientY ?? 0) - (c.startY ?? 0));
      if (dist <= 4) return;
      c.moved = true;
    }
    drawTempLink(svgPoint(ev));
  }
}

async function onSvgPointerUp(ev) {
  if (state.pan) { state.pan = null; return; }
  if (state.marquee) { endMarquee(); return; }
  if (state.drag) {
    const d = state.drag;
    applyDragFrame();
    if (state.frame) { state.frame = null; }
    state.drag = null;
    state.view = null;
    state.suppressClick = d.moved;          // 真拖过就别让 click 再整图重绘一遍（回弹的另一半原因）
    drawAlignGuide(null);
    state.align = null;
    state.aligns = [];
    redrawDirtyEdges();
    if (!d.moved) {
      if (d.chainId) { selectChain(d.chainId); return; }          // 点一下链块＝选中这条链
      if (d.groupId) { selectGroup(d.groupId); return; }         // 点一下收纳牌＝选中这个组
      if (d.shiftArm) toggleSelection(d.id);   // Shift 点一下＝加/减选
      return;
    }
    await saveLayout(d.ids && d.ids.length ? d.ids : [d.id]);
    // 收纳态下连线收拢过，拖完整图重排一遍（组收成牌 / 链收成块都算）
    if ((state.collapsedIds && state.collapsedIds.size) || (state.collapsedChains && state.collapsedChains.size)) render();
    else paintSelection();          // 拖完也要把选中态画上（拖过一次 click 会被吞，别再等下一次刷新）
    return;
  }
  if (state.connect) {
    const { from, kind, port, moved } = state.connect;
    state.connect = null;
    state.view = null;
    removeTempLink();
    if (!moved) { openNodeMenu(from, ev); return; }        // 右键点一下＝出菜单
    const el = document.elementFromPoint ? document.elementFromPoint(ev.clientX, ev.clientY) : null;
    const nodeEl = el && el.closest ? el.closest("[data-node]") : null;
    const to = nodeEl ? nodeEl.getAttribute("data-node") : null;
    if (!to || to === from) { showToast("连线取消：要落在另一个节点上", false); return; }
    await connectNodes(from, to, kind, port, nearestPortIndex(to, "in", ev));
  }
}

// 中键平移
function startPan(ev) {
  state.pan = { x: ev.clientX, y: ev.clientY, tx: state.viewport.tx, ty: state.viewport.ty };
  if (ev.preventDefault) ev.preventDefault();
}

// 框选
function startMarquee(ev) {
  const pt = svgPoint(ev);
  state.marquee = { start: pt, current: pt, additive: !!ev.shiftKey, el: null, moved: false };
  const g = viewportEl();
  if (g && typeof document.createElementNS === "function") {
    const rect = document.createElementNS(SVG_NS, "rect");
    rect.setAttribute("class", "marquee");
    rect.setAttribute("x", pt.x);
    rect.setAttribute("y", pt.y);
    rect.setAttribute("width", 0);
    rect.setAttribute("height", 0);
    if (g.appendChild) g.appendChild(rect);
    state.marquee.el = rect;
  }
  if (ev.preventDefault) ev.preventDefault();
}

function updateMarquee(ev) {
  const m = state.marquee;
  if (!m) return;
  m.current = svgPoint(ev);
  const r = normRect(m.start, m.current);
  m.moved = r.w > 3 || r.h > 3;
  if (m.el && m.el.setAttribute) {
    m.el.setAttribute("x", r.x);
    m.el.setAttribute("y", r.y);
    m.el.setAttribute("width", r.w);
    m.el.setAttribute("height", r.h);
  }
}

function normRect(a, b) {
  return {
    x: Math.min(a.x, b.x),
    y: Math.min(a.y, b.y),
    w: Math.abs(a.x - b.x),
    h: Math.abs(a.y - b.y)
  };
}

function endMarquee() {
  const m = state.marquee;
  state.marquee = null;
  if (m && m.el && m.el.remove) m.el.remove();
  if (!m) return;
  if (!m.moved) { if (!m.additive) setSelection([]); paintSelection(); return; }
  const hits = nodesInRect(normRect(m.start, m.current));
  const next = m.additive ? [...new Set([...state.selectedIds, ...hits])] : hits;
  setSelection(next);
  paintSelection();
  showToast(hits.length ? `框选了 ${hits.length} 个节点，可以一起拖` : "框里没有节点", hits.length > 0);
}

/** 落点优先取指针正下方的端口，否则取纵向最近的那个口。 */
function nearestPortIndex(nodeId, side, ev) {
  const p = state.positions.get(nodeId);
  if (!p) return 0;
  const el = document.elementFromPoint && ev ? document.elementFromPoint(ev.clientX, ev.clientY) : null;
  const hitPort = el && el.closest ? el.closest("[data-port]") : null;
  if (hitPort && hitPort.getAttribute("data-port") === side) {
    const owner = hitPort.closest("[data-node]");
    if (!owner || owner.getAttribute("data-node") === nodeId) return Number(hitPort.getAttribute("data-index") || 0);
  }
  const count = side === "in" ? p.inPorts || 1 : p.outPorts || 1;
  const pt = ev ? svgPoint(ev) : { x: p.x, y: p.y + p.h / 2 };
  let best = 0;
  let bestD = Infinity;
  for (let i = 0; i < count; i++) {
    const q = portPoint(side, p, i, count);
    const d = Math.abs(q.y - pt.y);
    if (d < bestD) { bestD = d; best = i; }
  }
  return best;
}

function startConnect(nodeId, ev, portIndex = 0) {
  const kind = ev && ev.shiftKey ? "loop" : "transfer";
  const p = state.positions.get(nodeId);
  const origin = p ? portPoint(kind === "loop" ? "bottom" : "out", p, portIndex, kind === "loop" ? 1 : p.outPorts || 1) : null;
  // 右键：先挂着，拖出去才算连线，松手没动就是出菜单；左键从出线口拖：当场就是连线
  const needMove = ev && ev.button === 2;
  state.connect = {
    from: nodeId, kind, port: portIndex, origin,
    needMove, moved: !needMove,
    startX: ev ? ev.clientX : 0, startY: ev ? ev.clientY : 0
  };
  if (origin && !needMove) drawTempLink(origin);
  if (ev && ev.preventDefault) ev.preventDefault();
}

function drawTempLink(pt) {
  const svg = $("graph");
  const p = state.positions.get(state.connect?.from);
  if (!svg || !p) return;
  const origin = state.connect.origin || portPoint("out", p);
  let line = svg.querySelector ? svg.querySelector("#tempLink") : null;
  if (!line) {
    if (!svg.appendChild || typeof document.createElement !== "function") return;
    line = document.createElementNS ? document.createElementNS(SVG_NS, "path") : document.createElement("path");
    if (line.setAttribute) line.setAttribute("id", "tempLink");
    const g = viewportEl();
    (g || svg).appendChild(line);
  }
  if (line.setAttribute) {
    line.setAttribute("d", `M ${origin.x} ${origin.y} L ${pt.x} ${pt.y}`);
    line.setAttribute("fill", "none");
    line.setAttribute("stroke", "#2563eb");
    line.setAttribute("stroke-width", "2");
    line.setAttribute("stroke-dasharray", "6 4");
  }
}

function removeTempLink() {
  const svg = $("graph");
  const line = svg && svg.querySelector ? svg.querySelector("#tempLink") : null;
  if (line && line.remove) line.remove();
}

// ---------------- 写操作 ----------------

async function saveNodePosition(nodeId, x, y) {
  const rx = Math.round(x);
  const ry = Math.round(y);
  const r = await api(`/api/nodes/${encodeURIComponent(nodeId)}/move`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ x: rx, y: ry })
  });
  if (r.ok) {
    const n = (state.graph?.nodes || []).find((x) => x.id === nodeId);
    if (n) { n.posX = r.body.posX; n.posY = r.body.posY; }
  } else {
    showToast(`位置没存下：${r.body?.error || r.status}`, false);
  }
  return r;
}

/** 批量落坐标：框选一起拖时只发一次请求。 */
async function saveLayout(ids) {
  if (!state.taskId || !ids.length) return { ok: true, body: null };
  const nodes = ids
    .map((id) => {
      const p = state.positions.get(id);
      return p ? { id, x: Math.round(p.x), y: Math.round(p.y) } : null;
    })
    .filter(Boolean);
  if (!nodes.length) return { ok: true, body: null };
  const r = await api(`/api/tasks/${encodeURIComponent(state.taskId)}/layout`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ nodes })
  });
  if (r.ok) {
    for (const it of nodes) {
      const n = (state.graph?.nodes || []).find((x) => x.id === it.id);
      if (n) { n.posX = it.x; n.posY = it.y; }
    }
    // 本地已经和库里一致了：把「上次渲染的图」同步一下，否则轮询会以为图变了，
    // 拖完 5 秒内必来一次整图重绘（节点上千就是 150ms 的卡顿）
    syncGraphJson();
  } else {
    showToast(`位置没存下：${r.body?.error || r.status}`, false);
  }
  return r;
}

async function connectNodes(fromId, toId, kind, fromPort = 0, toPort = 0) {
  if (!state.taskId) return { ok: false, body: { error: "no-task" } };
  // 先把线画上再等服务端：等 POST 回来才画的话，节点一多就要等三四百毫秒
  const k = kind || "transfer";
  const tmpId = `tmp:${fromId}->${toId}:${Date.now()}`;
  insertEdgeLocally({ id: tmpId, fromNodeId: fromId, toNodeId: toId, kind: k, fromPort, toPort, gate: "auto" });
  const r = await api(`/api/tasks/${encodeURIComponent(state.taskId)}/edges`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ from: fromId, to: toId, kind: k, fromPort, toPort })
  });
  if (r.ok) {
    removeEdgeLocally(tmpId);
    const parts = [`已连线 ${nodeTitle(fromId)} → ${nodeTitle(toId)}（${k}）`];
    if (k === "transfer") {
      parts.push(r.body.groupCreated ? `新建输入规则组（all，${r.body.groupItems.length} 条入边）` : `并入已有规则组（${r.body.groupItems.length} 条入边）`);
      if ((r.body.activated || []).length) parts.push(`已起步：${r.body.activated.map((id) => nodeTitle(id)).join("、")}`);
    } else if (r.body.cycle) {
      parts.push(`接入循环区 ${r.body.cycle.regionKey}（上限 ${r.body.cycle.limit}）`);
    }
    showToast(parts.join("；"), true);
    insertEdgeLocally(r.body.edge, r.body.activated || []);
    scheduleSilentSync();
  } else {
    removeEdgeLocally(tmpId);
    showToast(`${r.body?.error || r.status}：${r.body?.message || "连线失败"}`, false);
  }
  return r;
}

/** 把本地临时画上去的那条线撤掉（服务端说不行时）。 */
function removeEdgeLocally(edgeId) {
  if (!state.graph) return;
  state.graph.edges = state.graph.edges.filter((e) => e.id !== edgeId);
  if (state.edgesById) state.edgesById.delete(edgeId);
  if (state.edgeEls) state.edgeEls.delete(edgeId);
  const vp = viewportEl();
  if (vp && vp.querySelector) {
    for (const sel of [`[data-edge="${edgeId}"]`, `[data-edge-hit="${edgeId}"]`]) {
      const el = vp.querySelector(sel);
      if (el && el.remove) el.remove();
    }
  }
}

/**
 * 本地插一条线：只往现有 DOM 里加「线 + 命中带」两个元素，不整图重绘。
 * 节点上千时，建线后重取整图重绘要 0.5–1 秒，全卡在这一次重绘上。
 */
function insertEdgeLocally(edge, activated = []) {
  if (!edge || !state.graph) return;
  const g = state.graph;
  if (g.edges.some((e) => e.id === edge.id)) return;
  g.edges.push(edge);
  if (state.edgesById) state.edgesById.set(edge.id, edge);
  for (const nodeId of [edge.fromNodeId, edge.toNodeId]) {
    if (!state.incident) state.incident = new Map();
    if (!state.incident.has(nodeId)) state.incident.set(nodeId, new Set());
    state.incident.get(nodeId).add(edge.id);
  }
  // 起步的节点在本地也要变「进行中」，否则下一次轮询会因为对不上而整图重绘
  for (const id of activated) {
    const n = state.nodesById && state.nodesById.get(id);
    if (n) n.status = "active";
  }
  const from = state.positions.get(edge.fromNodeId);
  const to = state.positions.get(edge.toNodeId);
  const vp = viewportEl();
  if (!from || !to || !vp || !vp.insertAdjacentHTML) return;
  const isLoop = edge.kind === "loop";
  const gated = edge.gate === "human" && !edge.gateConfirmedBy;
  const d = edgePath(from, to, edge);
  const stroke = gated ? "#f97316" : isLoop ? "#7c3aed" : "#94a3b8";
  const dash = isLoop ? 'stroke-dasharray="7 5"' : gated ? 'stroke-dasharray="3 4"' : "";
  vp.insertAdjacentHTML("beforeend",
    `<path class="edge" data-edge="${esc(edge.id)}" d="${d}" fill="none" stroke="${stroke}" stroke-width="${isLoop ? 2 : 1.5}" ${dash} marker-end="url(#${isLoop ? "arrowLoop" : "arrow"})"></path>` +
    `<path class="edge-hit" data-edge-hit="${esc(edge.id)}" d="${d}" fill="none" stroke="transparent" stroke-width="16" pointer-events="stroke"></path>`);
  const added = vp.querySelector ? vp.querySelector(`[data-edge="${edge.id}"]`) : null;
  if (added && state.edgeEls) state.edgeEls.set(edge.id, added);
  paintSelection();
  syncGraphJson();
}

/**
 * 本地改完图（拖坐标、插线、起步状态）之后，把「上次渲染的图」也同步成现在这样。
 * 不做这一步，轮询会把「本地已经画好的变化」当成新变化，再来一次整图重绘。
 */
function syncGraphJson() {
  state.graphJson = state.graph ? JSON.stringify(state.graph) : null;
}

/** 静默校准：攒一下再拉一次图（JSON 没变就不会重绘；变了也只是补上状态差异）。 */
function scheduleSilentSync(delay = 700) {
  if (state.silentTimer) clearTimeout(state.silentTimer);
  state.silentTimer = setTimeout(() => { state.silentTimer = null; loadGraph(); }, delay);
}

async function createTask(title, goalLine) {
  const r = await api("/api/tasks", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ title, goalLine, nodes: [], edges: [], groups: [], cycles: [] })
  });
  if (r.ok) {
    state.taskId = r.body.id;
    state.selected = null;
    state.selectedIds = new Set();
    state.fittedFor = null;
    await refresh();
    showToast(`已建任务「${title}」（${r.body.id}）：双击空白处开始加节点`, true);
  } else {
    showToast(`${r.body?.error || r.status}：${r.body?.message || "建任务失败"}`, false);
  }
  return r;
}

function nodeTitle(id) {
  const n = (state.graph?.nodes || []).find((x) => x.id === id);
  return n ? n.title : id;
}

function nodeOptions(selected) {
  const nodes = (state.graph?.nodes || []).slice().sort((a, b) => a.seq - b.seq);
  if (!nodes.length) return `<option value="">（这个任务还没有节点）</option>`;
  return nodes
    .map((n) => `<option value="${esc(n.id)}"${n.id === selected ? " selected" : ""}>${esc(n.title)}（${esc(n.id)}）</option>`)
    .join("");
}

// ---------------- 表单 ----------------

function closeForm() {
  $("formHost").innerHTML = "";
  state.pendingPos = null;
}

function showFormResult(ok, html) {
  const box = $("formResult");
  if (!box) return;
  box.className = "formResult " + (ok ? "ok" : "err");
  box.innerHTML = html;
}

function openTaskForm() {
  $("formHost").innerHTML = `
  <div class="form">
    <div class="formhead"><b>新建任务</b><button type="button" id="closeForm">关闭</button></div>
    <label>标题（必填）<input id="tTitle" maxlength="120" placeholder="例如：把周报写出来" /></label>
    <label>一行目标<input id="tGoal" placeholder="例如：给出可复核的三条结论" /></label>
    <div class="actions"><button type="button" class="primary" id="submitTask">建任务</button></div>
    <div id="formResult" class="formResult"></div>
  </div>`;
  $("closeForm").onclick = closeForm;
  $("submitTask").onclick = submitTask;
  $("tTitle").focus();
}

async function submitTask() {
  const title = $("tTitle").value.trim();
  if (!title) { showFormResult(false, "标题必填"); return; }
  $("submitTask").disabled = true;
  const r = await createTask(title, $("tGoal").value.trim());
  $("submitTask").disabled = false;
  if (r.ok) { $("tTitle").value = ""; $("tGoal").value = ""; showFormResult(true, `已建任务「${esc(title)}」，双击空白处加第一个节点`); }
  else showFormResult(false, `<b>${esc(r.body?.error || r.status)}</b>：${esc(r.body?.message || "")}`);
}

function openNodeForm() {
  if (!state.taskId) { $("formHost").innerHTML = `<div class="form"><div class="formResult err">先新建或选一个任务</div></div>`; return; }
  const at = state.pendingPos;
  $("formHost").innerHTML = `
  <div class="form">
    <div class="formhead"><b>新建节点</b><button type="button" id="closeForm">关闭</button></div>
    ${at ? `<div class="muted">画布位置：(${at.x}, ${at.y})</div>` : `<div class="muted">位置：建好后拖到想要的地方</div>`}
    <label>标题（必填，≤120 字）<input id="fTitle" maxlength="120" placeholder="例如：素材收集" /></label>
    <label>一行目标<input id="fGoal" placeholder="例如：收齐三份可用材料" /></label>
    <label>类型
      <select id="fKind">
        <option value="work">work · 干活</option>
        <option value="review_auto">review_auto · 程序/审核者按规则判</option>
        <option value="review_human">review_human · 人点头</option>
      </select>
    </label>
    <label>循环区（可选，要连回边才需要）<input id="fRegion" placeholder="例如：R1" /></label>
    <label>接线口（1–12，默认各 1 个）
      <span class="portsRow">进 <input id="fInPorts" type="number" min="1" max="12" value="1" /> 出 <input id="fOutPorts" type="number" min="1" max="12" value="1" /></span>
    </label>
    <div class="actions"><button type="button" class="primary" id="submitNode">建节点</button></div>
    <div id="formResult" class="formResult"></div>
  </div>`;
  $("closeForm").onclick = closeForm;
  $("submitNode").onclick = submitNode;
  $("fTitle").focus();
}

/** 双击空白：把落点坐标交给节点表单（中心对齐到鼠标）。负坐标照收，画布没边。 */
function requestNodeAt(x, y) {
  state.pendingPos = { x: Math.round(x - NODE_W / 2), y: Math.round(y - NODE_H / 2) };
  openNodeForm();
  return state.pendingPos;
}

/** 双击空白＝直接建一个默认节点（不弹表单），建完选中它、把右栏名字框聚焦好让人改。 */
async function quickAddNode(worldX, worldY, title) {
  if (!state.taskId) {
    showToast("先新建或选一个任务，再双击空白建节点", false);
    return { ok: false, status: 0, body: { error: "no-task" } };
  }
  const seq = (state.graph?.nodes?.length || 0) + 1;
  const body = {
    title: (title || `新节点 ${seq}`).trim(),
    goalLine: "",
    kind: "work",
    x: Math.round(worldX - NODE_W / 2),
    y: Math.round(worldY - NODE_H / 2)
  };
  const r = await api(`/api/tasks/${encodeURIComponent(state.taskId)}/nodes`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });
  if (!r.ok) {
    showToast(`${r.body?.error || r.status}：${r.body?.message || "建节点失败"}`, false);
    return r;
  }
  const n = r.body.node;
  state.pendingPos = null;
  await refresh();
  await selectNode(n.id);
  paintSelection();
  focusProps();
  showToast(`已建节点「${n.title}」——在右栏改名字和目标`, true);
  return r;
}

/** 选中节点后把右栏「标题」输入框聚焦（双击建节点之后就能直接改名）。 */
function focusProps() {
  const el = $("nTitle");
  if (el && el.focus) el.focus();
  return el;
}

/** 选中节点后改属性：标题 / 一行目标 / 类型 / 循环区。 */
async function saveNodeProps(nodeId) {
  const payload = {
    title: $("nTitle") ? $("nTitle").value : undefined,
    goalLine: $("nGoal") ? $("nGoal").value : undefined,
    kind: $("nKind") ? $("nKind").value : undefined
  };
  const r = await api(`/api/nodes/${encodeURIComponent(nodeId)}/props`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload)
  });
  const box = $("propsResult");
  if (r.ok) {
    const changed = r.body.changed || [];
    if (box) {
      box.className = "formResult ok";
      box.innerHTML = changed.length ? `已保存：${esc(changed.join("；"))}` : "没有改动";
    }
    await refresh();
    await selectNode(nodeId);
    paintSelection();
    showToast(changed.length ? `节点已更新（${changed.length} 项）` : "没有改动", true);
  } else {
    if (box) {
      box.className = "formResult err";
      box.innerHTML = `<b>${esc(r.body?.error || r.status)}</b>：${esc(r.body?.message || "改属性失败")}`;
    }
    showToast(`${r.body?.error || r.status}：${r.body?.message || "改属性失败"}`, false);
  }
  return r;
}

/** 删节点（守卫在后端：只删未起步且无连线的 pending）。 */
async function deleteNode(nodeId) {
  const n = state.nodesById.get(nodeId);
  const r = await api(`/api/nodes/${encodeURIComponent(nodeId)}`, { method: "DELETE" });
  if (r.ok) {
    showToast(`已删节点「${n ? n.title : nodeId}」`, true);
    setSelection([]);
    await refresh();
  } else {
    showToast(`${r.body?.error || r.status}：${r.body?.message || "删不掉"}`, false);
  }
  return r;
}

/** 单个节点收纳：0 完整 / 1 仅标题 / 2 仅关键字（纯看图状态）。 */
async function setNodeCompact(nodeId, level) {
  const r = await api(`/api/nodes/${encodeURIComponent(nodeId)}/compact`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ level })
  });
  if (r.ok) {
    showToast(level ? `「${r.body.title}」已收纳为${level === 2 ? "仅关键字" : "仅标题"}` : `「${r.body.title}」已展开`, true);
    await refresh();
  } else {
    showToast(`${r.body?.error || r.status}：${r.body?.message || "收纳失败"}`, false);
  }
  return r;
}

/** 把选中的几个节点圈成一个节点组（纯视觉，不影响门与执行）。 */
async function createNodeGroup(ids, title) {
  if (!state.taskId) return { ok: false, status: 0, body: { error: "no-task" } };
  const r = await api(`/api/tasks/${encodeURIComponent(state.taskId)}/node-groups`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ title: title || "", nodeIds: ids })
  });
  if (r.ok) {
    showToast(`已建节点组「${r.body.title}」：${r.body.nodeIds.length} 个节点（只是画布分组，不影响执行）`, true);
    setSelection([]);
    await refresh();
  } else {
    showToast(`${r.body?.error || r.status}：${r.body?.message || "建组失败"}`, false);
  }
  return r;
}

/** 删节点组：withNodes=false 只解散（节点全留）；true 连节点一起删（组里有一个删不起就整批不动）。 */
async function deleteNodeGroup(groupId, withNodes) {
  const title = groupTitle(groupId);
  const url = `/api/node-groups/${encodeURIComponent(groupId)}${withNodes ? "?withNodes=true" : ""}`;
  const r = await api(url, { method: "DELETE" });
  if (r.ok) {
    showToast(withNodes
      ? `已删除节点组「${title}」连同 ${r.body.nodesDeleted} 个节点`
      : `已解散节点组「${title}」，${r.body.released} 个节点留着`, true);
    setSelection([]);
    await refresh();
  } else {
    showToast(`${r.body?.error || r.status}：${r.body?.message || "删组失败"}`, false);
  }
  return r;
}

/** 收纳/展开一个组（纯看图状态，落库只为刷新后还是原样）。 */
async function collapseGroup(groupId, collapsed) {
  const fromOverview = state.overview;
  const r = await api(`/api/node-groups/${encodeURIComponent(groupId)}/collapse`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ collapsed })
  });
  if (r.ok) {
    if (!collapsed && state.overview) state.overview = false;   // 从总览里展开一个组＝退出总览，回真实布局
    showToast(collapsed ? `已收纳「${r.body.title}」` : `已展开「${r.body.title}」`, true);
    await refresh();
    // 从总览点开一块牌＝聚焦到这一组（其余组还是牌），不然一屏 150 个节点谁也看不清
    if (fromOverview && !collapsed) fitToNodes(groupMembers(groupId).map((n) => n.id));
  } else {
    showToast(`${r.body?.error || r.status}：${r.body?.message || "收纳失败"}`, false);
  }
  return r;
}

/** 双击标题：组在「收成一块牌 / 摊开」之间切换。 */
function toggleGroupCollapsed(groupId) {
  const grp = (state.graph?.nodeGroups || []).find((x) => x.id === groupId);
  return collapseGroup(groupId, !(grp && grp.collapsed));
}

/** 双击标题：节点在「完整卡片 / 仅标题」之间切换（本来停在仅关键字就摊回完整）。 */
async function toggleNodeCompact(nodeId, node) {
  const n = node || state.nodesById.get(nodeId);
  const level = n && n.compact ? 0 : 1;
  const r = await setNodeCompact(nodeId, level);
  if (r.ok && state.selected === nodeId) await selectNode(nodeId);      // 右栏跟着刷
  return r;
}

// ---------------- 同向链：收成一块 / 摊开 / 解散 ----------------

function selectChain(chainId) {
  const ch = (state.chains || []).find((x) => x.id === chainId);
  state.selectedEdge = null;
  state.selectedGroup = null;
  state.selectedChain = ch ? chainId : null;
  if (!ch) { state.selected = null; state.selectedIds = new Set(); paintSelection(); return chainId; }
  state.selected = null;
  state.selectedIds = new Set(ch.nodeIds || []);
  renderChainPanel(chainId);
  paintSelection();
  return chainId;
}

function renderChainPanel(chainId) {
  const ch = chainById(chainId);
  if (!ch) { state.selectedChain = null; $("sideBody").innerHTML = ""; return; }
  const members = chainMembers(ch);
  const collapsed = chainIsCollapsed(ch);
  $("sideBody").innerHTML = `
  <div class="node-head">
    <h2>同向链：${esc(cut(chainTitleText(ch), 30))}</h2>
    <div class="goal">${members.length} 个节点合成一块${collapsed ? " · 已收起（成员在画布上隐藏）" : " · 已摊开"}</div>
    <div style="margin-top:6px"><span class="chip" style="background:#0ea5e9">同向链 · ${members.length} 合 1</span>
      <span class="muted">只是看图：节点、连线、门一个都没动</span></div>
  </div>

  <div class="section"><h3>链上节点（按方向）</h3>
    <ul>${members.map((n) => `<li>${esc(n.title)} <span class="muted">${esc(STATUS_TEXT[n.status] || n.status)}</span></li>`).join("")}</ul>
  </div>

  <div class="section"><h3>看</h3>
    <div class="portsRow">
      <button type="button" id="chainCollapseBtn">${collapsed ? "摊开这条链" : "收成一块"}</button>
      <button type="button" id="chainSelectBtn">选中链上 ${members.length} 个节点</button>
    </div>
    <div class="muted">双击链块的标题也能收/开；拖动链块＝整条一起挪。</div>
  </div>

  <div class="section"><h3>链是怎么算出来的</h3>
    <div class="muted">一个节点只有一条出边、且对面只有这一条入边，就算「接下去」；碰到分叉、汇合、跨组或断线就停。
      所以改连线时链会自己缩短或消失，不用手动维护。收起状态只在这次页面里，刷新就摊开。</div>
  </div>`;

  const cBtn = $("chainCollapseBtn");
  if (cBtn) cBtn.onclick = () => collapseChain(chainId, !chainIsCollapsed(chainById(chainId)));
  const sBtn = $("chainSelectBtn");
  if (sBtn) sBtn.onclick = () => { setSelection(members.map((n) => n.id)); paintSelection(); };
}

/** 收起/摊开一条同向链：纯前端看法，改的是内存里的集合，接口一个都不调。 */
function collapseChain(chainId, collapsed) {
  const ch = chainById(chainId);
  if (!ch) return { ok: false, status: 0, body: { error: "chain-not-found" } };
  if (collapsed) state.collapsedChains.add(ch.headNodeId);
  else state.collapsedChains.delete(ch.headNodeId);
  render();
  if (state.selectedChain === chainId) renderChainPanel(chainId);
  showToast(collapsed ? `已收成一块：${ch.count} 个合 1（双击标题摊开）` : `已摊开：${ch.count} 个节点回来`, true);
  return { ok: true, status: 200, body: { id: chainId, collapsed } };
}

function toggleChain(chainId) {
  const ch = chainById(chainId);
  return collapseChain(chainId, !(ch && chainIsCollapsed(ch)));
}

/** 右键「同向链收成一块」：给链上任意一节，收它所在的那一条。 */
function collapseChainOfNode(nodeId) {
  const walk = walkChainLocal(nodeId);
  if (walk.length < 2) {
    showToast("这个节点在同向上接不出第二个（线头/线尾，或下一步就分叉了）", false);
    return { ok: false, status: 400, body: { error: "chain-needs-two" } };
  }
  return collapseChain(chainIdOf(walk[0]), true);
}

async function submitNode() {
  const title = $("fTitle").value.trim();
  if (!title) { showFormResult(false, "标题必填（一句白话，别写代号）"); return; }
  const body = { title, goalLine: $("fGoal").value.trim(), kind: $("fKind").value };
  const region = $("fRegion").value.trim();
  if (region) body.cycleRegion = region;
  const inPorts = Number($("fInPorts").value || 1);
  const outPorts = Number($("fOutPorts").value || 1);
  if (inPorts !== 1 || outPorts !== 1) { body.inPorts = inPorts; body.outPorts = outPorts; }
  if (state.pendingPos) { body.x = state.pendingPos.x; body.y = state.pendingPos.y; }

  $("submitNode").disabled = true;
  const r = await api(`/api/tasks/${encodeURIComponent(state.taskId)}/nodes`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });
  $("submitNode").disabled = false;

  if (r.ok) {
    const n = r.body.node;
    showFormResult(true, `已建节点「${esc(n.title)}」，排在第 ${n.seq} 个（${esc(n.id)}）` +
      (r.body.hint ? `<div class="muted">提示：${esc(r.body.hint)}</div>` : ""));
    $("fTitle").value = "";
    $("fGoal").value = "";
    $("fInPorts").value = "1";
    $("fOutPorts").value = "1";
    state.pendingPos = null;
    state.selected = n.id;
    await refresh();
  } else {
    showFormResult(false, `<b>${esc(r.body?.error || r.status)}</b>：${esc(r.body?.message || "提交失败")}`);
  }
  return r;
}

function openEdgeForm(prefillFrom) {
  if (!state.taskId) { $("formHost").innerHTML = `<div class="form"><div class="formResult err">先新建或选一个任务</div></div>`; return; }
  const nodes = state.graph?.nodes || [];
  $("formHost").innerHTML = `
  <div class="form">
    <div class="formhead"><b>新建连线</b><button type="button" id="closeForm">关闭</button></div>
    <label>起点（材料从哪来）<select id="eFrom">${nodeOptions(prefillFrom || state.selected)}</select></label>
    <label>起点出线口<select id="eFromPort"></select></label>
    <label>终点（材料给谁）<select id="eTo">${nodeOptions(null)}</select></label>
    <label>终点进线口<select id="eToPort"></select></label>
    <label>类型
      <select id="eKind">
        <option value="transfer">transfer · 传递（接材料 / 等上游做完）</option>
        <option value="loop">loop · 回边（进下一轮）</option>
      </select>
    </label>
    <div class="muted">也可以直接在图上右键按住起点拖到终点，或从出线口拖出来。按住 Shift 是回边。</div>
    <div class="actions" style="margin-top:8px"><button type="button" class="primary" id="submitEdge">连线</button></div>
    <div id="formResult" class="formResult"></div>
  </div>`;
  $("closeForm").onclick = closeForm;
  $("submitEdge").onclick = submitEdge;
  fillPortSelect("eFromPort", $("eFrom").value, "out");
  fillPortSelect("eToPort", $("eTo").value, "in");
  $("eFrom").onchange = () => fillPortSelect("eFromPort", $("eFrom").value, "out");
  $("eTo").onchange = () => fillPortSelect("eToPort", $("eTo").value, "in");
  if (!nodes.length) showFormResult(false, "这个任务还没有节点，先建节点再连线");
}

function fillPortSelect(selectId, nodeId, side) {
  const box = $(selectId);
  if (!box) return;
  const p = state.positions.get(nodeId);
  const count = p ? (side === "in" ? p.inPorts || 1 : p.outPorts || 1) : 1;
  const items = [];
  for (let i = 0; i < count; i++) items.push(`<option value="${i}">第 ${i + 1} 个${count === 1 ? "（唯一）" : ""}</option>`);
  box.innerHTML = items.join("");
}

async function submitEdge() {
  const from = $("eFrom").value;
  const to = $("eTo").value;
  const kind = $("eKind").value;
  if (!from || !to) { showFormResult(false, "起点和终点都要选"); return; }
  const fromPort = Number($("eFromPort")?.value || 0);
  const toPort = Number($("eToPort")?.value || 0);
  $("submitEdge").disabled = true;
  const r = await connectNodes(from, to, kind, fromPort, toPort);
  $("submitEdge").disabled = false;
  if (r.ok) {
    await openEdgeForm(from);
    showFormResult(true, "已连线（规则组与起步情况见上方提示）");
  } else {
    const waiting = r.body?.details?.waitingOn || [];
    showFormResult(false, `<b>${esc(r.body?.error || r.status)}</b>：${esc(r.body?.message || "提交失败")}` +
      (waiting.length ? `<ul>${waiting.map((w) => `<li>${esc(w.edgeId || "-")} · ${esc(w.reason)}</li>`).join("")}</ul>` : ""));
  }
  return r;
}

// ---------------- 节点详情 ----------------

async function selectNode(nodeId) {
  state.selected = nodeId;
  state.selectedEdge = null;
  state.selectedGroup = null;
  state.selectedChain = null;
  const r = await api(`/api/nodes/${encodeURIComponent(nodeId)}`);
  if (!r.ok) {
    $("sideBody").innerHTML = `<div class="reject">读取节点失败：${esc(r.body?.error || r.status)}</div>`;
    return;
  }
  const d = r.body;
  const n = d.node;
  const color = STATUS_COLORS[n.status] || "#6b7280";
  const out = [];
  out.push(`<div class="node-head">
    <h2>${esc(n.title)}</h2>
    <div class="goal">${esc(n.goalLine || "（无一行目标）")}</div>
    <div style="margin-top:6px">
      <span class="chip" style="background:${color}">${esc(STATUS_TEXT[n.status] || n.status)}</span>
      <span class="muted">${esc(n.kind)} · 第 ${n.seq} 个 · attempt ${n.attempt} · epoch ${n.cycleEpoch}${n.cycleRegion ? " · 循环 " + esc(n.cycleRegion) : ""}</span>
    </div>
    ${n.blockedReason ? `<div class="muted">阻塞原因：<code>${esc(n.blockedReason)}</code> · 可解除：master 或 lead</div>` : ""}
  </div>`);

  out.push(`<div class="section"><h3>属性（点节点就能改）</h3>
    <div class="propsForm">
      <label>标题（必填，≤120 字）<input id="nTitle" maxlength="120" value="${esc(n.title)}" /></label>
      <label>一行目标<input id="nGoal" value="${esc(n.goalLine || "")}" /></label>
      <label>类型
        <select id="nKind">
          <option value="work">work · 干活</option>
          <option value="review_auto">review_auto · 程序/审核者按规则判</option>
          <option value="review_human">review_human · 人点头</option>
        </select>
      </label>
      <label>循环区 <input disabled value="${esc(n.cycleRegion ? "属于循环组「" + n.cycleRegion + "」" : "（不在循环区里）")}" /></label>
      <div class="muted">循环区不再挂在节点上：把节点圈进一个组，再给那个组声明循环。</div>
      <div class="portsRow"><button type="button" id="saveProps">保存属性</button>
        <span class="muted">换循环区要先断线，否则回边语义会乱</span></div>
      <div id="propsResult" class="formResult"></div>
    </div>
  </div>`);

  const gate = d.input;
  out.push(`<div class="section"><h3>输入条件（${MODE_TEXT[gate.mode] || gate.mode || "无规则组"}${gate.needCount ? " · 需要 " + gate.needCount : ""}）</h3>`);
  if (!gate.items.length) {
    out.push(`<div class="muted">没有入边，可以独立起步。</div>`);
  } else {
    out.push(`<ul>${gate.items.map((i) => `<li>${i.released ? "✅" : "⛔"} ${esc(i.fromTitle)} <span class="muted">（${esc(i.fromStatus)}${i.released ? "" : " · " + esc(i.reason)}）</span></li>`).join("")}</ul>`);
    if (!gate.satisfied) out.push(`<div class="muted">还没满足：缺 ${gate.missing.length} 条</div>`);
  }
  out.push(`</div>`);

  out.push(`<div class="section"><h3>最近三次检查点</h3>`);
  if (!d.checkpoints.length) {
    out.push(`<div class="muted">还没有检查点。</div>`);
  } else {
    for (const c of d.checkpoints) {
      out.push(`<div class="ckp">
        <div class="kv"><span>我在做什么：</span>${esc(c.doing)}</div>
        <div class="kv"><span>接下来：</span>${esc(c.nextStep)}</div>
        <div class="kv"><span>最终目标：</span>${esc(c.goal)}</div>
        <div class="kv"><span>判定：</span><span class="verdict ${esc(c.verdict)}">${c.verdict === "progress" ? "有进展" : "无进展"}</span>
          <span class="muted"> · 第 ${c.cycleVisit} 轮 · ${esc(fmt(c.startedAtUtc))} → ${esc(fmt(c.endedAtUtc))}</span></div>
      </div>`);
    }
  }
  out.push(`</div>`);

  out.push(`<div class="section"><h3>上次被拒原因</h3>`);
  out.push(d.lastRejection ? `<div class="reject">${esc(d.lastRejection)}</div>` : `<div class="muted">没有被拒绝过。</div>`);
  out.push(`</div>`);

  out.push(`<div class="section"><h3>接线口</h3>
    <div class="portsRow">进 <input id="pIn" type="number" min="1" max="12" value="${n.inPorts}" /> 出 <input id="pOut" type="number" min="1" max="12" value="${n.outPorts}" />
      <button type="button" id="savePorts">保存</button></div>
    <div class="muted">改小时不能少于已挂线的口。</div>
    <div id="portsResult" class="formResult"></div>
  </div>`);

  if (d.cycle) {
    out.push(`<div class="section"><h3>所属循环</h3>
      <ul>
        <li>区域 ${esc(d.cycle.regionKey)} · 上限 ${d.cycle.limit}${d.cycle.limitKind === "perpetual" ? "（不限）" : ""} · 已跑 ${d.cycle.visited} 轮</li>
        <li>状态：${d.cycle.pausedReason ? esc(d.cycle.pausedReason) : "运行中"}</li>
      </ul></div>`);
  }

  $("sideBody").innerHTML = out.join("");
  const kindSel = $("nKind");
  if (kindSel) kindSel.value = n.kind;
  const propsBtn = $("saveProps");
  if (propsBtn) propsBtn.onclick = () => saveNodeProps(n.id);
  const saveBtn = $("savePorts");
  if (saveBtn) saveBtn.onclick = () => saveNodePorts(n.id);
}

async function saveNodePorts(nodeId) {
  const inPorts = Number($("pIn")?.value || 1);
  const outPorts = Number($("pOut")?.value || 1);
  const r = await api(`/api/nodes/${encodeURIComponent(nodeId)}/ports`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ inPorts, outPorts })
  });
  if (r.ok) {
    showToast(`接线口已更新：进 ${r.body.inPorts} / 出 ${r.body.outPorts}`, true);
    await refresh();
    await selectNode(nodeId);
  } else {
    const box = $("portsResult");
    if (box) {
      box.className = "formResult err";
      box.innerHTML = `<b>${esc(r.body?.error || r.status)}</b>：${esc(r.body?.message || "")}`;
    }
    showToast(`${r.body?.error || r.status}：${r.body?.message || "改端口失败"}`, false);
  }
  return r;
}

// ---------------- 事件接线 ----------------

function bindSvgEvents() {
  const svg = $("graph");
  if (!svg || !svg.addEventListener) return;
  svg.addEventListener("pointerdown", onSvgPointerDown);
  svg.addEventListener("pointermove", onSvgPointerMove);
  svg.addEventListener("pointerup", onSvgPointerUp);
  svg.addEventListener("pointercancel", onSvgPointerUp);
  svg.addEventListener("contextmenu", (e) => { e.preventDefault(); });
  svg.addEventListener("wheel", (e) => {
    e.preventDefault();
    zoomAt(e.clientX, e.clientY, e.deltaY);
  }, { passive: false });
  svg.addEventListener("click", (e) => {
    if (state.suppressClick) { state.suppressClick = false; return; }
    if (e.shiftKey) return;                        // Shift 点击的加/减选在 pointerup 里已经做了
    const t = e.target;
    const el = t && t.closest ? t.closest("[data-node]") : null;
    if (el) {
      const id = el.getAttribute("data-node");
      // 按下时已经选过（startDrag 里做的），这里别再拉一遍详情
      if (state.selected !== id || state.selectedIds.size !== 1) setSelection([id]);
      // 画布画的已经是这个选中（比如刚点过同一条）就不重绘：双击要靠元素不被换掉才判得出来
      if (state.paintedKey === selectionKey()) return;
      paintSelection();
      return;
    }
    if (t && t.closest && t.closest("[data-chain]")) return;   // 链块在 pointerup 里已经选中了
    const hit = t && t.closest ? t.closest("[data-edge-hit]") : null;
    if (hit) { selectEdge(hit.getAttribute("data-edge-hit")); return; }
  });
  // 双击标题＝快收/快开：节点（完整↔仅标题）、组（收成牌↔摊开）、同向链（收成一块↔摊开）
  svg.addEventListener("dblclick", (e) => {
    const t = e.target;
    const closest = (sel) => (t && t.closest ? t.closest(sel) : null);
    const chainEl = closest("[data-chain]");
    if (chainEl) { if (e.preventDefault) e.preventDefault(); toggleChain(chainEl.getAttribute("data-chain")); return; }
    const nodeEl = closest("[data-node]");
    if (nodeEl) { if (e.preventDefault) e.preventDefault(); toggleNodeCompact(nodeEl.getAttribute("data-node")); return; }
    const chipEl = closest("[data-nodegroup-chip]");
    if (chipEl) { if (e.preventDefault) e.preventDefault(); toggleGroupCollapsed(chipEl.getAttribute("data-nodegroup-chip")); return; }
    const pillEl = closest("[data-nodegroup-pill]");
    if (pillEl) { if (e.preventDefault) e.preventDefault(); toggleGroupCollapsed(pillEl.getAttribute("data-nodegroup-pill")); return; }
    const pt = svgPoint(e);
    quickAddNode(pt.x, pt.y);          // 双击空白＝当场建一个默认节点，再去右栏改名字
  });
  if (typeof document.addEventListener === "function") {
    document.addEventListener("pointerdown", (e) => {
      const m = $("ctxMenu");
      if (!m || m.className !== "ctx") return;
      const hit = e.target && e.target.closest ? e.target : null;
      // 菜单内的点击自己管；画布内的开关由 svg 的 pointerdown 管（先关再按需开）
      if (hit && hit.closest && (hit.closest("#ctxMenu") || hit.closest("#graph"))) return;
      closeContextMenu();
    });
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape") { closeContextMenu(); return; }
      if (e.key === "Delete" || e.key === "Del") {
        if (isTypingTarget(e.target)) return;         // 输入框里 Delete 是删字
        if (!state.selected && !state.selectedEdge && !state.selectedGroup && !state.selectedChain && !state.selectedIds.size) return;
        if (e.preventDefault) e.preventDefault();
        deleteSelected();
      }
    });
  }
  if (typeof window !== "undefined" && window.addEventListener) {
    window.addEventListener("resize", () => { state.view = null; });
  }
}

async function bootstrap() {
  const h = await api("/api/health");
  if (h.ok) $("dbNote").textContent = "库：" + (h.body.databasePath || "");
  bindSvgEvents();
  await loadTasks();
  await loadGraph();
}

$("taskSelect").addEventListener("change", async (e) => {
  state.taskId = e.target.value;
  state.selected = null;
  state.selectedIds = new Set();
  state.fittedFor = null;
  $("sideBody").innerHTML = "";
  closeForm();
  await loadGraph();
});

$("addTaskBtn").addEventListener("click", openTaskForm);
$("addNodeBtn").addEventListener("click", () => { state.pendingPos = null; openNodeForm(); });
$("addEdgeBtn").addEventListener("click", () => openEdgeForm());
$("tplBtn").addEventListener("click", () => openTemplatePanel());
$("arrangeBtn").addEventListener("click", () => arrangeByGroups());
$("overviewBtn").addEventListener("click", () => toggleOverview());
$("fitBtn").addEventListener("click", fitView);
$("refreshBtn").addEventListener("click", () => refresh());

$("autoRefresh").addEventListener("change", (e) => {
  if (state.timer) clearInterval(state.timer);
  state.timer = e.target.checked ? setInterval(() => loadGraph(), 5000) : null;
});

state.timer = setInterval(() => loadGraph(), 5000);
bootstrap();
