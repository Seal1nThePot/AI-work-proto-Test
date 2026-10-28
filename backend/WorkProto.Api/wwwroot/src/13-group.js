// ────────── 13-group.js ──────────「节点组几何与牌面」
// 用途: 节点组：包围盒/成员/统计/被组隐藏的节点、组标签宽度、收纳牌与总览格子、组框重绘
// 暴露: groupBounds groupTitle collapsedGroupIds groupMembers groupBoxOf groupStats OV overviewPillRect pillRect hiddenNodeIds groupChipWidth redrawGroupBox redrawBoxesFor
// 依赖: 00-const.js 01-state.js 02-dom.js(esc/cut)
// 被依赖: 12-chain.js 20-render.js 30-select.js 与 app.js

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
