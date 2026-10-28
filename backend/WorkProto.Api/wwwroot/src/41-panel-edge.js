// ────────── 41-panel-edge.js ──────────「连线面板」
// 用途: 右栏连线面板：端口下拉、选中连线、渲染门控面板、保存改动、人工门确认、删除连线
// 暴露: portOptions selectEdge renderEdgePanel saveEdge confirmEdgeGate removeEdge
// 依赖: 01-state.js 02-dom.js 03-api.js
// 被依赖: 20-render.js 与 app.js

// ---------------- 连线面板（点线看它的走向与门控） ----------------

function portOptions(count, current) {
  let out = "";
  for (let i = 0; i < Math.max(1, count); i++) {
    out += `<option value="${i}"${i === current ? " selected" : ""}>第 ${i + 1} 个</option>`;
  }
  return out;
}

async function selectEdge(edgeId) {
  state.selected = null;
  state.selectedIds = new Set();
  state.selectedGroup = null;
  state.selectedChain = null;
  state.selectedEdge = edgeId;
  const r = await api(`/api/edges/${encodeURIComponent(edgeId)}`);
  if (!r.ok) {
    state.selectedEdge = null;
    showToast(`${r.body?.error || r.status}：${r.body?.message || "读连线失败"}`, false);
    paintSelection();
    return r;
  }
  renderEdgePanel(r.body.edge);
  paintSelection();
  return r;
}

function renderEdgePanel(e) {
  const gateText = e.gate === "human"
    ? (e.gateConfirmedBy ? `人工门控 · 已由 ${esc(e.gateConfirmedBy)} 确认` : "人工门控 · 还没确认（下游会被它挡住）")
    : "自动门控 · 上游做完就放行";
  const nodeOpts = (state.graph?.nodes || [])
    .map((n) => `<option value="${esc(n.id)}"${n.id === e.fromNodeId ? " selected" : ""}>${esc(n.title)}</option>`)
    .join("");
  const nodeOptsTo = (state.graph?.nodes || [])
    .map((n) => `<option value="${esc(n.id)}"${n.id === e.toNodeId ? " selected" : ""}>${esc(n.title)}</option>`)
    .join("");

  $("sideBody").innerHTML = `
  <div class="node-head">
    <h2>连线：${esc(e.fromTitle || e.fromNodeId)} → ${esc(e.toTitle || e.toNodeId)}</h2>
    <div class="goal">${esc(gateText)}</div>
    <div style="margin-top:6px">
      <span class="chip" style="background:${e.gate === "human" ? (e.gateConfirmedBy ? "#16a34a" : "#f97316") : "#64748b"}">${e.kind}</span>
      <span class="muted">端口 出 ${e.fromPort + 1} / 进 ${e.toPort + 1}${e.released ? " · 这条线已经放过行" : ""}</span>
    </div>
    ${e.released ? `<div class="muted">已经放过行的线只能改门控与备注；改走向/类型要删掉重连。</div>` : ""}
  </div>

  <div class="section"><h3>连线关系</h3>
    <div class="propsForm">
      <label>起点<input disabled value="${esc(e.fromTitle || e.fromNodeId)}" /></label>
      <label>终点 <select id="eToSel"${e.released ? " disabled" : ""}>${nodeOptsTo}</select></label>
      <label>类型
        <select id="eKindSel"${e.released ? " disabled" : ""}>
          <option value="transfer"${e.kind === "transfer" ? " selected" : ""}>transfer · 传递（要等上游做完）</option>
          <option value="loop"${e.kind === "loop" ? " selected" : ""}>loop · 回边（进下一轮）</option>
        </select>
      </label>
      <label>挂哪个出线口 / 进线口
        <span class="portsRow">
          <select id="eFromPortSel"${e.released ? " disabled" : ""}>${portOptions(e.fromOutPorts, e.fromPort)}</select>
          <select id="eToPortSel"${e.released ? " disabled" : ""}>${portOptions(e.toInPorts, e.toPort)}</select>
        </span>
      </label>
      <div class="muted">起点改不了（要从别处出发就删掉这条、重新画）</div>
    </div>
  </div>

  <div class="section"><h3>门控</h3>
    <div class="propsForm">
      <label>这条线怎么放行
        <select id="eGateSel">
          <option value="auto"${e.gate === "auto" ? " selected" : ""}>auto · 上游做完就放行</option>
          <option value="human"${e.gate === "human" ? " selected" : ""}>human · 还要人在这条线上点头</option>
        </select>
      </label>
      <label>门控说明（给人看的条件，一句话）<input id="eGateNote" value="${esc(e.gateNote || "")}" placeholder="例如：核对过数字口径才放行" /></label>
      <div class="portsRow">
        <button type="button" id="saveEdgeBtn">保存</button>
        ${e.gate === "human" && !e.gateConfirmedBy ? `<button type="button" id="confirmGateBtn" class="primary">确认门控（点头放行）</button>` : ""}
      </div>
      <div id="edgeResult" class="formResult"></div>
    </div>
  </div>

  <div class="section"><h3>删除</h3>
    <div class="portsRow">
      <button type="button" id="delEdgeBtn" class="danger-btn">删除这条连线</button>
      <span class="muted">${e.released ? "已放过行的线删不了" : "删完下游的规则组会跟着重算"}</span>
    </div>
    <div id="edgeDelResult" class="formResult"></div>
  </div>`;

  const saveBtn = $("saveEdgeBtn");
  if (saveBtn) saveBtn.onclick = () => saveEdge(e.id);
  const cBtn = $("confirmGateBtn");
  if (cBtn) cBtn.onclick = () => confirmEdgeGate(e.id);
  const dBtn = $("delEdgeBtn");
  if (dBtn) dBtn.onclick = () => removeEdge(e.id);
}

async function saveEdge(edgeId) {
  const body = {
    to: $("eToSel") ? $("eToSel").value : undefined,
    kind: $("eKindSel") ? $("eKindSel").value : undefined,
    fromPort: $("eFromPortSel") ? Number($("eFromPortSel").value) : undefined,
    toPort: $("eToPortSel") ? Number($("eToPortSel").value) : undefined,
    gate: $("eGateSel") ? $("eGateSel").value : undefined,
    gateNote: $("eGateNote") ? $("eGateNote").value : undefined
  };
  const r = await api(`/api/edges/${encodeURIComponent(edgeId)}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });
  const box = $("edgeResult");
  if (r.ok) {
    if (box) { box.className = "formResult ok"; box.innerHTML = (r.body.changed || []).length ? `已保存：${esc(r.body.changed.join("；"))}` : "没有改动"; }
    await refresh();
    await selectEdge(edgeId);
    showToast((r.body.activated || []).length ? `已更新，并起步：${r.body.activated.map(nodeTitle).join("、")}` : "连线已更新", true);
  } else {
    if (box) { box.className = "formResult err"; box.innerHTML = `<b>${esc(r.body?.error || r.status)}</b>：${esc(r.body?.message || "改连线失败")}`; }
    showToast(`${r.body?.error || r.status}：${r.body?.message || "改连线失败"}`, false);
  }
  return r;
}

async function confirmEdgeGate(edgeId) {
  const r = await api(`/api/edges/${encodeURIComponent(edgeId)}/confirm`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ by: "ui" })
  });
  if (r.ok) {
    const act = r.body.activated || [];
    showToast(act.length ? `门控已确认，已起步：${act.map(nodeTitle).join("、")}` : "门控已确认（上游还没做完，先记着）", true);
    await refresh();
    await selectEdge(edgeId);
  } else {
    showToast(`${r.body?.error || r.status}：${r.body?.message || "确认门控失败"}`, false);
  }
  return r;
}

async function removeEdge(edgeId) {
  const r = await api(`/api/edges/${encodeURIComponent(edgeId)}`, { method: "DELETE" });
  const box = $("edgeDelResult");
  if (r.ok) {
    state.selectedEdge = null;
    showToast("连线已删除（下游规则组已重算）", true);
    await refresh();
    $("sideBody").innerHTML = "";
  } else {
    if (box) { box.className = "formResult err"; box.innerHTML = `<b>${esc(r.body?.error || r.status)}</b>：${esc(r.body?.message || "删不掉")}`; }
    showToast(`${r.body?.error || r.status}：${r.body?.message || "删不掉"}`, false);
  }
  return r;
}
