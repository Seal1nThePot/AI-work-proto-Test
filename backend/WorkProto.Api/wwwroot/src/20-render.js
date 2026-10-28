// ────────── 20-render.js ──────────「整图渲染」
// 用途: 整图重绘：从 state.graph 一次性生成节点卡片/连线/端口圆/组框/链块的 DOM（不做增量，增量在 21）
// 暴露: render portCircles
// 依赖: 00-const.js 01-state.js 02-dom.js 10-geo.js 12-chain.js 13-group.js 30-select.js
// 被依赖: 03-api.js(loadGraph) 21-render-diff.js 60-write 70-drag 71-pointer 与 app.js

// ---------------- 渲染 ----------------

/** 世界坐标参考系：轴和刻度随节点/组一起平移缩放，不固定在屏幕上。 */
function coordAxesSvg() {
  let max = 0;
  for (const p of state.positions.values()) {
    max = Math.max(max, Math.abs(p.x), Math.abs(p.y), Math.abs(p.x + p.w), Math.abs(p.y + p.h));
  }
  const R = Math.max(4000, Math.ceil((max + 1600) / 800) * 800);
  const step = 800;
  let grid = "";
  let labels = "";
  for (let v = -R; v <= R; v += step) {
    if (v === 0) continue;
    grid += `<line class="axis-grid" x1="${v}" y1="${-R}" x2="${v}" y2="${R}"></line>` +
      `<line class="axis-grid" x1="${-R}" y1="${v}" x2="${R}" y2="${v}"></line>`;
    labels += `<text class="axis-tick-label" x="${v}" y="20" text-anchor="middle">${v}</text>` +
      `<text class="axis-tick-label" x="12" y="${v - 4}">${v}</text>`;
  }
  return `<g class="coord-axes" pointer-events="none">
    ${grid}
    <line class="axis" x1="${-R}" y1="0" x2="${R}" y2="0"></line>
    <line class="axis" x1="0" y1="${-R}" x2="0" y2="${R}"></line>
    ${labels}
    <circle class="axis-origin" cx="0" cy="0" r="4"></circle>
    <text class="axis-label" x="${R - 80}" y="-16" text-anchor="end">x</text>
    <text class="axis-label" x="16" y="${-R + 80}">y</text>
    <text class="axis-origin-label" x="12" y="20">0</text>
  </g>`;
}

/** 拉远时只画组名：组标签用 1/scale 反缩放，屏幕字号保持 13px。 */
function renderGroupLod(g) {
  state.lodActive = true;
  state.hiddenIds = new Set((g.nodes || []).map((n) => n.id));
  state.chains = [];
  state.chainByMember = new Map();
  state.chainRects = new Map();
  state.pills = new Map();
  state.overviewOrder = [];
  state.cycleByGroup = new Map();
  state.nodeEls = new Map();
  state.edgeEls = new Map();
  state.groupEls = new Map();
  state.groupChipEls = new Map();
  state.pillEls = new Map();
  state.cycleEls = new Map();
  state.cycleLabelEls = new Map();
  state.alignLineEls = [];
  state.alignTipEls = [];
  const inv = 1 / Math.max(MIN_SCALE, state.viewport.scale);
  const parts = [];
  for (const grp of g.nodeGroups || []) {
    const b = groupBounds(grp.id);
    if (!b) continue;
    const label = cut(grp.title, 18);
    const w = Math.max(128, label.length * 20 + 34);
    const picked = state.selectedGroup === grp.id;
    parts.push(`<g class="lod-group${picked ? " picked" : ""}" data-nodegroup-chip="${esc(grp.id)}"
      transform="translate(${(b.x1 + b.x2) / 2},${(b.y1 + b.y2) / 2}) scale(${inv})">
      <title>双击进入组，拖拽移动组</title>
      <rect x="${-w / 2}" y="-22" width="${w}" height="44" rx="22"></rect>
      <text x="0" y="7" text-anchor="middle">${esc(label)}</text>
    </g>`);
  }
  $("graph").innerHTML = `<g id="viewport" transform="translate(${state.viewport.tx},${state.viewport.ty}) scale(${state.viewport.scale})">${coordAxesSvg()}${parts.join("")}</g>`;
  applyViewport();
}

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
    `<span class="hint">拖空白＝框选（点空白＝取消选中） · 拖节点＝移动（可多选一起拖） · <b>拖组名/组边框＝整组一起挪</b> · <b>按住 Shift 拖＝左右 + 前后吸附</b> · 滚轮＝缩放 · 中键拖＝平移（画布没边） · 双击空白＝建节点 · <b>双击标题＝节点/组/链 快收快开</b> · 右键节点＝「同向链收成一块」 · <b>点节点/连线/组/链块＝选中，按 Delete＝删掉它</b> · 右键＝菜单 · 右键按住拖＝连线（Shift＝回边） · 空格＝复位到工作流</span>`;

  state.positions = layout(g);
  state.nodesById = new Map(g.nodes.map((n) => [n.id, n]));
  state.lodActive = false;
  if (state.viewport.scale < LOD_GROUP_SCALE && !viewCompactView() && !viewGroupView() && (g.nodeGroups || []).length) {
    renderGroupLod(g);
    return;
  }
  state.collapsedIds = collapsedGroupIds();     // 先算"哪些组收成牌了"，链框与 fit 都要用
  // 同向链：纯前端按边算出来的（后端只有节点和连线，链是看法不是数据）
  state.chainIndex = null;
  state.noChains = (typeof viewCompactView === "function" && viewCompactView())
    || (typeof viewGroupView === "function" && viewGroupView());
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
  state.overviewOrder = (state.overview || (typeof viewGroupView === "function" && viewGroupView()))
    ? groupOrder(g) : [];   // 总览/组视角时牌子按组的先后排格子
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
  state.bundleCross = g.nodes.length > 60 || (typeof viewGroupView === "function" && viewGroupView());
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
    const title = `${step ? step + " · " : ""}${cy ? "循环 · " : "组 · "}${cut(grp ? grp.title : gid, (state.overview || (typeof viewGroupView === "function" && viewGroupView())) ? 18 : 15)}`;
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

    const compactLevel = typeof viewCompactLevel === "function" ? viewCompactLevel(n) : (n.compact || 0);
    if (compactLevel) {
      // 收纳后只剩一行：1＝标题，2＝关键字（一行目标）
      const label = compactLevel === 2 ? cut(n.goalLine || "（无关键字）", 11) : cut(n.title, 11);
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

  svg.innerHTML = `<g id="viewport" transform="translate(${vp.tx},${vp.ty}) scale(${vp.scale})">${coordAxesSvg()}${parts.join("")}</g>`;

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
