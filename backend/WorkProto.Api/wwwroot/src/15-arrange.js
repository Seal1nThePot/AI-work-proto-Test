// ────────── 15-arrange.js ──────────「整理与紧凑布局」
// 用途: 组内相对布局缓存、按组/全局整理、紧凑/堆叠视图（组内网格 + 组块靠近）；只算坐标，不碰执行语义
// 暴露: persistGroupLayout syncGroupCachesFor computeRelForList computeGroupRel relBlockSize arrangeGroup arrangeAllGroups compactLayout
// 依赖: 00-const.js 01-state.js 02-dom.js 03-api.js 10-geo.js 11-layout.js 13-group.js 14-view.js
// 被依赖: 20-render.js（紧凑布局）、60-write.js（拖动后同步组缓存）、46-panel-view.js（整理菜单）
// ---------------- 组内相对布局缓存 ----------------

async function persistGroupLayout(groupId, rel) {
  const grp = (state.graph?.nodeGroups || []).find((g) => g.id === groupId);
  if (grp) grp.layout = rel;
  if (!state.taskId) return { ok: true, body: null };
  return api(`/api/node-groups/${encodeURIComponent(groupId)}/layout`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ nodes: rel })
  });
}

/** 手动拖完：组内相对坐标跟着更新；原视图还要把缓存落库，视图图层里只改当前快照。 */
function syncGroupCachesFor(ids, persist = true) {
  const gids = new Set();
  for (const id of ids) {
    const n = state.nodesById.get(id);
    if (n && n.groupId) gids.add(n.groupId);
  }
  for (const gid of gids) {
    const rel = deriveGroupRel(gid);
    const grp = (state.graph?.nodeGroups || []).find((g) => g.id === gid);
    if (grp) grp.layout = rel;
    if (state.viewState) state.viewState.groupLayouts[gid] = rel;
    else if (persist) persistGroupLayout(gid, rel);
  }
}

function computeRelForList(list, edges) {
  if (!list.length) return [];
  const block = groupLayered(list, edges);
  // groupLayered 的 pos 是 { col, band, y }：x 要按 col * 列距换算（不是 p.x）
  const raw = [...block.pos.entries()].map(([id, p]) => ({
    id,
    x: Number.isFinite(p.x) ? p.x : (p.col || 0) * COL_PITCH,
    y: Number.isFinite(p.y) ? p.y : 0
  }));
  let minX = Infinity, minY = Infinity;
  for (const p of raw) {
    minX = Math.min(minX, p.x);
    minY = Math.min(minY, p.y);
  }
  return raw.map((p) => ({ id: p.id, dx: Math.round(p.x - minX), dy: Math.round(p.y - minY) }));
}

function computeGroupRel(groupId) {
  const members = groupMembers(groupId);
  const ids = new Set(members.map((n) => n.id));
  const edges = (state.graph?.edges || []).filter((e) =>
    e.kind === "transfer" && ids.has(e.fromNodeId) && ids.has(e.toNodeId));
  return computeRelForList(members, edges);
}

function relBlockSize(list, rel) {
  const byId = new Map((rel || []).map((it) => [it.id, it]));
  let w = NODE_W, h = NODE_H;
  for (const n of list) {
    const it = byId.get(n.id);
    if (!it) continue;
    w = Math.max(w, it.dx + NODE_W);
    h = Math.max(h, it.dy + NODE_H);
  }
  return { w, h };
}

/** 只整理选中组：位置留在原地，组内按依赖分层；结果写进组缓存，原视图不被改。 */
function arrangeGroup(groupId) {
  const grp = (state.graph?.nodeGroups || []).find((g) => g.id === groupId);
  if (!grp) { showToast("先选中一个节点组", false); return { ok: false }; }
  pushViewHistory();
  const v = ensureView();
  v.groupView = false;
  v.compactView = false;
  const rel = computeGroupRel(groupId);
  const origin = groupContentOrigin(groupId, v.positions);
  for (const it of rel) v.positions[it.id] = { x: origin.x + it.dx, y: origin.y + it.dy };
  v.groupLayouts[groupId] = rel;
  markViewDirty();
  persistGroupLayout(groupId, rel);
  render();
  fitToNodes(groupMembers(groupId).map((n) => n.id));
  if (typeof renderViewPanel === "function") renderViewPanel();
  showToast(`已整理组「${grp.title}」的 ${rel.length} 个节点；Ctrl+Z 可撤销`, true);
  return { ok: true, rel };
}

/** 全局整理：组按依赖排先后，组内一律用各自缓存；没缓存的先算一份并写回。 */
function arrangeAllGroups() {
  const g = state.graph;
  if (!g || !g.nodes.length) { showToast("这个任务还没有节点", false); return { ok: false }; }
  pushViewHistory();
  const v = ensureView();
  v.groupView = false;
  v.compactView = false;
  const order = groupOrder(g);
  const buckets = new Map(order.map((k) => [k, []]));
  for (const n of g.nodes) {
    const k = n.groupId || LOOSE_KEY;
    if (!buckets.has(k)) buckets.set(k, []);
    buckets.get(k).push(n);
  }
  const blocks = [];
  for (const key of order) {
    const list = buckets.get(key) || [];
    if (!list.length) continue;
    let rel = v.groupLayouts[key];
    if (!rel || !rel.length) rel = key === LOOSE_KEY ? computeRelForList(list, []) : computeGroupRel(key);
    v.groupLayouts[key] = rel;
    if (key !== LOOSE_KEY) persistGroupLayout(key, rel);
    const size = relBlockSize(list, rel);
    blocks.push({ key, list, rel, w: size.w, h: size.h });
  }
  const maxH = blocks.length ? Math.max(...blocks.map((b) => b.h)) : NODE_H;
  let x = 60;
  const y0 = 160;
  for (const b of blocks) {
    const y = y0 + Math.round((maxH - b.h) / 2);
    for (const it of b.rel) v.positions[it.id] = { x: x + it.dx, y: y + it.dy };
    x += b.w + 240;
  }
  markViewDirty();
  render();
  fitView();
  if (typeof renderViewPanel === "function") renderViewPanel();
  showToast(`已按组整理 ${blocks.length} 块（组内用缓存，不重排组内）；Ctrl+Z 可撤销`, true);
  return { ok: true, blocks: blocks.length };
}

// ---------------- 紧凑/堆叠视图 ----------------

/** 把一组相对坐标压到紧凑网格：保留前后/左右顺序，但把大间距收成固定小缝。 */
function compactSlots(values, gap) {
  const sorted = [...new Set(values.map((v) => Math.round(v)))].sort((a, b) => a - b);
  const slot = new Map();
  let last = null;
  let index = -1;
  for (const v of sorted) {
    if (last === null || v - last > gap) { index += 1; last = v; }
    slot.set(v, index);
  }
  return slot;
}

/** 组内紧凑相对坐标：优先用组缓存/整理结果，缺的节点按依赖补；再按顺序压成小网格。 */
function compactGroupRel(key, list) {
  const cached = key === LOOSE_KEY ? null : state.viewState?.groupLayouts?.[key];
  const fallback = key === LOOSE_KEY ? null : computeGroupRel(key);
  const byId = new Map();
  for (const rel of [cached, fallback]) {
    if (!Array.isArray(rel)) continue;
    for (const it of rel) {
      if (it && !byId.has(it.id) && Number.isFinite(it.dx) && Number.isFinite(it.dy)) byId.set(it.id, it);
    }
  }
  const raw = list.map((n, i) => {
    const it = byId.get(n.id);
    if (it) return { id: n.id, x: it.dx, y: it.dy };
    const p = state.viewState?.positions?.[n.id];
    return { id: n.id, x: p ? p.x : i * 240, y: p ? p.y : 0 };
  });
  const minX = Math.min(...raw.map((p) => p.x));
  const minY = Math.min(...raw.map((p) => p.y));
  for (const p of raw) { p.x -= minX; p.y -= minY; }
  const xs = compactSlots(raw.map((p) => p.x), 48);
  const ys = compactSlots(raw.map((p) => p.y), 24);
  const pitchX = COMPACT_W + 24;
  const allowOverlap = state.viewState?.allowOverlap !== false;
  const pitchY = allowOverlap ? COMPACT_H - 14 : COMPACT_H + 12;
  const used = new Set();
  return raw.map((p) => {
    const col = xs.get(Math.round(p.x));
    let row = ys.get(Math.round(p.y));
    if (!allowOverlap) {
      while (used.has(`${col}:${row}`)) row += 1;
      used.add(`${col}:${row}`);
    }
    return { id: p.id, dx: col * pitchX, dy: row * pitchY };
  });
}

/** 紧凑/堆叠视图：组内按缓存压成紧凑块，组块按依赖顺序靠近排；组与组始终分开。 */
function compactLayout(graph) {
  const out = new Map();
  const order = groupOrder(graph);
  const buckets = new Map(order.map((k) => [k, []]));
  for (const n of graph.nodes) {
    const k = n.groupId || LOOSE_KEY;
    if (!buckets.has(k)) buckets.set(k, []);
    buckets.get(k).push(n);
  }
  const blocks = [];
  for (const key of order) {
    const list = (buckets.get(key) || []).slice().sort((a, b) => a.seq - b.seq);
    if (!list.length) continue;
    const rel = compactGroupRel(key, list);
    const byId = new Map(rel.map((it) => [it.id, it]));
    let w = COMPACT_W;
    let h = COMPACT_H;
    for (const it of rel) {
      w = Math.max(w, it.dx + COMPACT_W);
      h = Math.max(h, it.dy + COMPACT_H);
    }
    blocks.push({ key, list, byId, w, h });
  }
  const rows = [];
  let row = { items: [], w: 0, h: 0 };
  const MAX_ROW_W = 2600;
  for (const b of blocks) {
    const add = row.items.length ? 64 : 0;
    if (row.items.length && row.w + add + b.w > MAX_ROW_W) {
      rows.push(row);
      row = { items: [], w: 0, h: 0 };
    }
    row.items.push(b);
    row.w += (row.items.length > 1 ? 64 : 0) + b.w;
    row.h = Math.max(row.h, b.h);
  }
  if (row.items.length) rows.push(row);
  let y = 200;
  for (const r of rows) {
    let x = 60;
    for (const b of r.items) {
      const by = y + Math.round((r.h - b.h) / 2);
      for (const n of b.list) {
        const it = b.byId.get(n.id);
        if (!it) continue;
        out.set(n.id, {
          x: x + it.dx, y: by + it.dy, w: COMPACT_W, h: COMPACT_H,
          inPorts: Math.max(1, n.inPorts || 1), outPorts: Math.max(1, n.outPorts || 1)
        });
      }
      x += b.w + 64;
    }
    y += r.h + 90;
  }
  return out;
}

