// ────────── 21-render-diff.js ──────────「增量重绘」
// 用途: 增量重绘：只改脏边与邻接边、重画循环区标签（拖动时避免整图重绘）
// 暴露: redrawDirtyEdges redrawIncident redrawCycleFor
// 依赖: 01-state.js(dirtyEdges/incident/positions) 10-geo.js(edgePath)
// 被依赖: app.js 70-drag.js 71-pointer.js

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
