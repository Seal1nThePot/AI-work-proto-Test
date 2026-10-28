// ────────── 10-geo.js ──────────「几何与视口」
// 用途: 端口坐标、连线路径、屏幕/世界坐标换算、缩放平移与适配、矩形归一化（只算坐标，不碰语义）
// 暴露: portPoint edgePath captureView svgPoint worldToScreen viewportEl applyViewport applyGrid zoomAt fitView fitToNodes applyFit normRect
// 依赖: 00-const.js(几何常量) 01-state.js(view/viewport)
// 被依赖: 11-layout 12-chain 13-group 20-render 60-write 70-drag 71-pointer 与 app.js

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
  const dy = b.y - a.y;
  // 小角度/短距离直接拉直线；只有偏得明显或两头离得远时才弯，避免每根线都像面条
  const straightAngle = 14 * Math.PI / 180;
  const straightDy = 18;
  const shortDist = 60;
  const dist = Math.hypot(dx, dy);
  const angle = Math.atan2(Math.abs(dy), Math.max(0, dx));
  if (dist <= shortDist || (dx > 0 && (Math.abs(dy) <= straightDy || angle <= straightAngle)))
    return `M ${a.x} ${a.y} L ${b.x} ${b.y}`;
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
  const wasLod = state.lodActive;
  const ux = clientX - v.left;
  const uy = clientY - v.top;
  const before = { x: (ux - vp.tx) / vp.scale, y: (uy - vp.ty) / vp.scale };
  const factor = Math.exp(-deltaY * 0.0015);
  const scale = Math.min(MAX_SCALE, Math.max(MIN_SCALE, vp.scale * factor));
  vp.scale = scale;
  vp.tx = ux - before.x * scale;
  vp.ty = uy - before.y * scale;
  applyViewport();
  const nowLod = scale < LOD_GROUP_SCALE && !viewCompactView() && !viewGroupView() && (state.graph?.nodeGroups || []).length > 0;
  if (nowLod || wasLod !== nowLod) render();   // 组名标签要按当前缩放反算字号
  return { scale: vp.scale, tx: vp.tx, ty: vp.ty, anchor: before };
}

/** 把整张图塞进视口。收纳起来的组按那块牌算，别为看不见的节点缩得太小。 */

function fitView() {
  const hidden = state.hiddenIds || new Set();
  const pts = [];
  if (state.lodActive) {
    for (const grp of state.graph?.nodeGroups || []) {
      const b = typeof groupBoxOf === "function" ? groupBoxOf(grp.id) : null;
      if (b) pts.push({ x: b.x1, y: b.y1, w: b.x2 - b.x1, h: b.y2 - b.y1 });
    }
  } else {
    for (const [id, p] of state.positions) {
      if (hidden.has(id)) continue;
      pts.push(p);
    }
    for (const pill of (state.pills || new Map()).values()) pts.push(pill);
    for (const r of (state.chainRects || new Map()).values()) pts.push(r);
  }
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
  const wasLod = state.lodActive;
  if (!pts || !pts.length) {
    state.viewport = { scale: 1, tx: 20, ty: 20 };
    applyViewport();
    if (wasLod) render();
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
  const nowLod = scale < LOD_GROUP_SCALE && !viewCompactView() && !viewGroupView() && (state.graph?.nodeGroups || []).length > 0;
  if (nowLod || wasLod !== nowLod) render();
}

function normRect(a, b) {
  return {
    x: Math.min(a.x, b.x),
    y: Math.min(a.y, b.y),
    w: Math.abs(a.x - b.x),
    h: Math.abs(a.y - b.y)
  };
}
