// ────────── 30-select.js ──────────「选中态」
// 用途: 选中态：选中键、是否触碰焦点、节点/连线 class 计算、重涂选中、多选集合、框选命中判定
// 暴露: selectionKey touchesFocus nodeClass edgeClass paintSelection setSelection toggleSelection nodesInRect
// 依赖: 01-state.js 02-dom.js($)
// 被依赖: 20-render.js app.js 71-pointer.js

function selectionKey() {
  const ids = [...state.selectedIds].sort().join(",");
  return [state.selected || "", state.selectedEdge || "", state.selectedGroup || "", state.selectedChain || "", ids].join("|");
}

function touchesFocus(id) {
  const focus = state.selected;
  if (!focus) return false;
  if (id === focus) return true;
  const g = (state.nodesById.get(focus) || {}).groupId;
  if (!g || !state.collapsedIds || !state.collapsedIds.has(g)) return false;
  return ((state.nodesById.get(id) || {}).groupId || null) === g;
}

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
