// ────────── 70-drag.js ──────────「拖动与吸附」
// 用途: 拖动：节点位移、横向/纵向吸附、参考线元素与绘制、拖动帧合并（一帧只更新一次）、起拖判定
// 暴露: moveNodeTo snapAxis snapX ensureGuideEls drawAlignGuide applyDragFrame scheduleDragFrame startDrag
// 依赖: 00-const.js(SNAP_PX/DRAG_START) 01-state.js 10-geo.js 60-write.js
// 被依赖: 71-pointer.js 与 app.js

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
  // 视图图层里只改显示坐标，不写图里的 posX/posY——否则切回原视图时会被这次拖动污染
  if (n && !state.viewState) { n.posX = Math.round(x); n.posY = Math.round(y); }
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

function startDrag(nodeId, ev) {
  if (typeof viewReadOnly === "function" && viewReadOnly()) { setSelection([nodeId]); return; }
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
