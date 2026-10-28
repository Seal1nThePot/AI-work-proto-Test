// ────────── 11-layout.js ──────────「自动布局」
// 用途: 自动整理：组按依赖排先后、组内分层摆块、总览排格子、整理/复原开关；只算坐标，落库另走 saveLayout
// 暴露: autoDepths layout groupOrder groupLayered arrangePositions arrangeByGroups toggleOverview（内部 LOOSE_KEY/COL_PITCH/ROW_GAP/BAND）
// 依赖: 00-const.js 01-state.js 10-geo.js
// 被依赖: app.js（按组整理/总览按钮）

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
