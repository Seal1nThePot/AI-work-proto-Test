// ────────── 42-panel-group.js ──────────「组面板」
// 用途: 右栏节点组面板：选中组、渲染组信息、收纳/展开组、切换节点收纳级别
// 暴露: selectGroup renderGroupPanel collapseGroup toggleGroupCollapsed toggleNodeCompact
// 依赖: 01-state.js 02-dom.js 03-api.js 13-group.js
// 被依赖: 20-render.js 与 app.js

// ---------------- 节点组面板 ----------------

function selectGroup(groupId) {
  state.selected = null;
  state.selectedIds = new Set();
  state.selectedEdge = null;
  state.selectedChain = null;
  state.selectedGroup = groupId;
  renderGroupPanel(groupId);
  paintSelection();
  return groupId;
}

function renderGroupPanel(groupId) {
  const grp = (state.graph?.nodeGroups || []).find((x) => x.id === groupId);
  if (!grp) { state.selectedGroup = null; $("sideBody").innerHTML = ""; return; }
  const members = groupMembers(groupId);
  const cy = state.cycleByGroup.get(groupId);
  $("sideBody").innerHTML = `
  <div class="node-head">
    <h2>节点组：${esc(grp.title)}</h2>
    <div class="goal">${members.length} 个节点${grp.collapsed ? " · 已收纳（成员在画布上隐藏）" : ""}${cy ? ` · <b>循环区</b>（上限 ${cy.limit}，已跑 ${cy.visited} 轮${cy.pausedReason ? " · " + esc(cy.pausedReason) : ""}）` : ""}</div>
    <div style="margin-top:6px"><span class="chip" style="background:${cy ? "#7c3aed" : "#2563eb"}">${cy ? "循环区（组＋回边＋检查点）" : "分组"}</span>
      <span class="muted">${cy ? "轮次到上限先出检查点" : "不进门、不参与执行"}</span></div>
  </div>

  <div class="section"><h3>循环区</h3>
    ${cy
      ? `<div class="portsRow">
           <span class="muted">头 ${esc(cy.headNodeId)} → 尾 ${esc(cy.tailNodeId)} · 上限 ${cy.limit}${cy.limitKind === "perpetual" ? "（不限）" : ""}</span>
         </div>
         <div class="portsRow">
           <label class="muted">调高上限 <input id="grpLimitInput" type="number" min="1" value="${cy.limit}" style="width:70px" /></label>
           <button type="button" id="grpRaiseBtn">调高（master/lead）</button>
           <button type="button" id="grpUndoLoopBtn" class="danger-btn">撤销循环（组留着）</button>
         </div>
         <div id="grpLoopResult" class="formResult"></div>`
      : `<div class="propsForm">
           <label>头（每轮从这里重新开始）<select id="grpLoopHead">${members.map((n) => `<option value="${esc(n.id)}">${esc(n.title)}</option>`).join("")}</select></label>
           <label>尾（它做完就算跑完一轮）<select id="grpLoopTail">${members.map((n) => `<option value="${esc(n.id)}"${members.length > 1 ? "" : " selected"}>${esc(n.title)}</option>`).join("")}</select></label>
           <label>轮次上限（到上限先出检查点）<input id="grpLoopLimit" type="number" min="1" value="3" /></label>
           <div class="portsRow"><button type="button" id="grpDeclareLoopBtn" class="primary">声明为循环区（自动建回边）</button></div>
           <div class="muted">组＋回边＋检查点＝循环区：声明时会自动把「尾 → 头」的回边连上。</div>
           <div id="grpLoopResult" class="formResult"></div>
         </div>`}
  </div>

  <div class="section"><h3>组内节点</h3>
    ${members.length ? `<ul>${members.map((n) => `<li>${esc(n.title)} <span class="muted">${esc(STATUS_TEXT[n.status] || n.status)}</span></li>`).join("")}</ul>` : `<div class="muted">组里没有节点了。</div>`}
  </div>

  <div class="section"><h3>看</h3>
    <div class="portsRow">
      <button type="button" id="grpCollapseBtn">${grp.collapsed ? "展开这个组" : "收纳这个组"}</button>
      <button type="button" id="grpSelectBtn">选中组内 ${members.length} 个节点</button>
      <button type="button" id="grpSaveTplBtn">存成组预设</button>
    </div>
  </div>

  <div class="section"><h3>删除</h3>
    <div class="portsRow">
      <button type="button" id="grpDissolveBtn" class="danger-btn">删除分组（节点都留着）</button>
    </div>
    <div class="portsRow">
      <button type="button" id="grpDeleteAllBtn" class="danger-btn">删除分组与组内 ${members.length} 个节点</button>
    </div>
    <div class="muted">连节点一起删是整批口径：组里有一个删不起（已起步或还挂着线），整批都不动。</div>
    <div id="grpResult" class="formResult"></div>
  </div>`;

  const cBtn = $("grpCollapseBtn");
  if (cBtn) cBtn.onclick = () => collapseGroup(groupId, !grp.collapsed);
  const sBtn = $("grpSelectBtn");
  if (sBtn) sBtn.onclick = () => { setSelection(members.map((n) => n.id)); paintSelection(); };
  const tBtn = $("grpSaveTplBtn");
  if (tBtn) tBtn.onclick = () => saveGroupTemplate(groupId);
  const declBtn = $("grpDeclareLoopBtn");
  if (declBtn) declBtn.onclick = () => declareLoop(groupId);
  const undoBtn = $("grpUndoLoopBtn");
  if (undoBtn) undoBtn.onclick = () => undoLoop(groupId);
  const raiseBtn = $("grpRaiseBtn");
  if (raiseBtn) raiseBtn.onclick = () => raiseLoopLimit(groupId);
  const dBtn = $("grpDissolveBtn");
  if (dBtn) dBtn.onclick = () => deleteNodeGroup(groupId, false);
  const aBtn = $("grpDeleteAllBtn");
  if (aBtn) aBtn.onclick = () => deleteNodeGroup(groupId, true);
}

/** 收纳/展开一个组（纯看图状态，落库只为刷新后还是原样）。 */

async function collapseGroup(groupId, collapsed) {
  const fromOverview = state.overview;
  const r = await api(`/api/node-groups/${encodeURIComponent(groupId)}/collapse`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ collapsed })
  });
  if (r.ok) {
    if (!collapsed && state.overview) state.overview = false;   // 从总览里展开一个组＝退出总览，回真实布局
    showToast(collapsed ? `已收纳「${r.body.title}」` : `已展开「${r.body.title}」`, true);
    await refresh();
    // 从总览点开一块牌＝聚焦到这一组（其余组还是牌），不然一屏 150 个节点谁也看不清
    if (fromOverview && !collapsed) fitToNodes(groupMembers(groupId).map((n) => n.id));
  } else {
    showToast(`${r.body?.error || r.status}：${r.body?.message || "收纳失败"}`, false);
  }
  return r;
}

/** 双击标题：组在「收成一块牌 / 摊开」之间切换。 */

function toggleGroupCollapsed(groupId) {
  const grp = (state.graph?.nodeGroups || []).find((x) => x.id === groupId);
  return collapseGroup(groupId, !(grp && grp.collapsed));
}

/** 双击标题：节点在「完整卡片 / 仅标题」之间切换（本来停在仅关键字就摊回完整）。 */

async function toggleNodeCompact(nodeId, node) {
  const n = node || state.nodesById.get(nodeId);
  const level = n && n.compact ? 0 : 1;
  const r = await setNodeCompact(nodeId, level);
  if (r.ok && state.selected === nodeId) await selectNode(nodeId);      // 右栏跟着刷
  return r;
}
