// ────────── 43-panel-chain.js ──────────「同向链面板」
// 用途: 右栏同向链面板：选中链、渲染链信息、收起/展开链（含按节点收链）
// 暴露: selectChain renderChainPanel collapseChain toggleChain collapseChainOfNode
// 依赖: 01-state.js 02-dom.js 12-chain.js
// 被依赖: 20-render.js 与 app.js

// ---------------- 同向链：收成一块 / 摊开 / 解散 ----------------

function selectChain(chainId) {
  const ch = (state.chains || []).find((x) => x.id === chainId);
  state.selectedEdge = null;
  state.selectedGroup = null;
  state.selectedChain = ch ? chainId : null;
  if (!ch) { state.selected = null; state.selectedIds = new Set(); paintSelection(); return chainId; }
  state.selected = null;
  state.selectedIds = new Set(ch.nodeIds || []);
  renderChainPanel(chainId);
  paintSelection();
  return chainId;
}

function renderChainPanel(chainId) {
  const ch = chainById(chainId);
  if (!ch) { state.selectedChain = null; $("sideBody").innerHTML = ""; return; }
  const members = chainMembers(ch);
  const collapsed = chainIsCollapsed(ch);
  $("sideBody").innerHTML = `
  <div class="node-head">
    <h2>同向链：${esc(cut(chainTitleText(ch), 30))}</h2>
    <div class="goal">${members.length} 个节点合成一块${collapsed ? " · 已收起（成员在画布上隐藏）" : " · 已摊开"}</div>
    <div style="margin-top:6px"><span class="chip" style="background:#0ea5e9">同向链 · ${members.length} 合 1</span>
      <span class="muted">只是看图：节点、连线、门一个都没动</span></div>
  </div>

  <div class="section"><h3>链上节点（按方向）</h3>
    <ul>${members.map((n) => `<li>${esc(n.title)} <span class="muted">${esc(STATUS_TEXT[n.status] || n.status)}</span></li>`).join("")}</ul>
  </div>

  <div class="section"><h3>看</h3>
    <div class="portsRow">
      <button type="button" id="chainCollapseBtn">${collapsed ? "摊开这条链" : "收成一块"}</button>
      <button type="button" id="chainSelectBtn">选中链上 ${members.length} 个节点</button>
    </div>
    <div class="muted">双击链块的标题也能收/开；拖动链块＝整条一起挪。</div>
  </div>

  <div class="section"><h3>链是怎么算出来的</h3>
    <div class="muted">一个节点只有一条出边、且对面只有这一条入边，就算「接下去」；碰到分叉、汇合、跨组或断线就停。
      所以改连线时链会自己缩短或消失，不用手动维护。收起状态只在这次页面里，刷新就摊开。</div>
  </div>`;

  const cBtn = $("chainCollapseBtn");
  if (cBtn) cBtn.onclick = () => collapseChain(chainId, !chainIsCollapsed(chainById(chainId)));
  const sBtn = $("chainSelectBtn");
  if (sBtn) sBtn.onclick = () => { setSelection(members.map((n) => n.id)); paintSelection(); };
}

/** 收起/摊开一条同向链：纯前端看法，改的是内存里的集合，接口一个都不调。 */

function collapseChain(chainId, collapsed) {
  const ch = chainById(chainId);
  if (!ch) return { ok: false, status: 0, body: { error: "chain-not-found" } };
  if (collapsed) state.collapsedChains.add(ch.headNodeId);
  else state.collapsedChains.delete(ch.headNodeId);
  render();
  if (state.selectedChain === chainId) renderChainPanel(chainId);
  showToast(collapsed ? `已收成一块：${ch.count} 个合 1（双击标题摊开）` : `已摊开：${ch.count} 个节点回来`, true);
  return { ok: true, status: 200, body: { id: chainId, collapsed } };
}

function toggleChain(chainId) {
  const ch = chainById(chainId);
  return collapseChain(chainId, !(ch && chainIsCollapsed(ch)));
}

/** 右键「同向链收成一块」：给链上任意一节，收它所在的那一条。 */

function collapseChainOfNode(nodeId) {
  const walk = walkChainLocal(nodeId);
  if (walk.length < 2) {
    showToast("这个节点在同向上接不出第二个（线头/线尾，或下一步就分叉了）", false);
    return { ok: false, status: 400, body: { error: "chain-needs-two" } };
  }
  return collapseChain(chainIdOf(walk[0]), true);
}
