// ────────── 71-pointer.js ──────────「指针状态机」
// 用途: 指针状态机：按下/移动/抬起分发、平移、框选、右键长按连线与临时线、最近端口计算（一个状态机留在一处，不再往下切）
// 暴露: onSvgPointerDown onSvgPointerMove onSvgPointerUp startPan startMarquee updateMarquee endMarquee nearestPortIndex startConnect drawTempLink removeTempLink
// 依赖: 00-const.js 01-state.js 02-dom.js 10-geo.js 21-render-diff.js 60-write.js 70-drag.js
// 被依赖: 90-bind.js（bindSvgEvents）

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
    if (viewReadOnly()) {
      if (ev.button === 0) selectGroup(groupId);
      else showToast("视图模式下只读：先退出组视角/紧凑视图再改分组", false);
      return;
    }
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
    if (viewReadOnly()) {
      if (ev.button === 0) selectGroup(groupId);
      else showToast("视图模式下只读：先退出组视角/紧凑视图再拖组", false);
      return;
    }
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

  if (viewReadOnly()) {
    if (ev.button === 0) setSelection([nodeId]);
    else showToast("视图模式下只读：先退出组视角/紧凑视图再连线", false);
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
  if (viewReadOnly()) { showToast("视图模式下只读：先退出组视角/紧凑视图再连线", false); return; }
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
