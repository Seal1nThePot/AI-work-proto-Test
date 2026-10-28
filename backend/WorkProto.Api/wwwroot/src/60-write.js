// ────────── 60-write.js ──────────「写操作与本地图同步」
// 用途: 写操作：存单点/批量坐标、存布局、连两节点、本地删边/插边、同步 graphJson、防抖静默刷新
// 暴露: saveNodePosition saveLayout connectNodes removeEdgeLocally insertEdgeLocally syncGraphJson scheduleSilentSync
// 依赖: 01-state.js 02-dom.js 03-api.js
// 被依赖: 70-drag.js 71-pointer.js 与 app.js

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
