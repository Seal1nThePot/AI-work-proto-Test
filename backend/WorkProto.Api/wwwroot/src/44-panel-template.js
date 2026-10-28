// ────────── 44-panel-template.js ──────────「模板面板」
// 用途: 模板库面板：打开面板、应用节点/组模板、存节点/组模板、删模板；centerWorld 负责把新贴的图居中
// 暴露: centerWorld openTemplatePanel applyNodeTemplate applyGroupTemplate saveNodeTemplate saveGroupTemplate deleteNodeTemplate deleteGroupTemplate
// 依赖: 01-state.js 02-dom.js 03-api.js 10-geo.js
// 被依赖: 20-render.js 与 app.js

// ---------------- 预设（模板库） ----------------

/** 落点取当前视图中心附近（世界坐标），套用的东西不会跑到视野外。 */
function centerWorld(dy = 0) {
  const v = state.view || captureView();
  const vp = state.viewport;
  return {
    x: Math.round((v.width / 2 - vp.tx) / vp.scale - NODE_W / 2),
    y: Math.round((v.height / 2 - vp.ty) / vp.scale - 140 + dy)
  };
}

async function openTemplatePanel() {
  const r = await api("/api/templates");
  if (!r.ok) { showToast(`${r.body?.error || r.status}：读模板库失败`, false); return r; }
  const nodeTemplates = r.body.nodeTemplates || [];
  const groupTemplates = r.body.groupTemplates || [];
  state.templates = r.body;
  const host = $("formHost");
  if (!host) return r;
  host.innerHTML = `
  <div class="form">
    <div class="formhead"><b>模板库（跨任务复用）</b><button type="button" id="closeTpl">关闭</button></div>
    <div class="muted">套用会把预设放到当前视野中间。组预预设连组内连线一起落下来。</div>
    <h3>节点预设（${nodeTemplates.length}）</h3>
    ${nodeTemplates.length
      ? nodeTemplates.map((t) => `<div class="tplRow">
          <span>${esc(t.name)}<em>${esc(t.title)} · ${esc(t.kind)} · 进${t.inPorts}/出${t.outPorts}</em></span>
          <button type="button" data-tpl-apply="node" data-tpl-id="${esc(t.id)}">套用</button>
          <button type="button" class="danger-btn" data-tpl-del="node" data-tpl-id="${esc(t.id)}">删</button>
        </div>`).join("")
      : `<div class="muted">还没有节点预设：右键节点 →「存成节点预设」。</div>`}
    <h3>组预设（${groupTemplates.length}）</h3>
    ${groupTemplates.length
      ? groupTemplates.map((t) => `<div class="tplRow">
          <span>${esc(t.name)}<em>${t.nodeCount} 个节点 · ${t.edgeCount} 条组内线</em></span>
          <button type="button" data-tpl-apply="group" data-tpl-id="${esc(t.id)}">套用</button>
          <button type="button" class="danger-btn" data-tpl-del="group" data-tpl-id="${esc(t.id)}">删</button>
        </div>`).join("")
      : `<div class="muted">还没有组预设：点一个组 → 右栏「存成组预设」。</div>`}
    <div id="tplResult" class="formResult"></div>
  </div>`;

  const closeBtn = $("closeTpl");
  if (closeBtn) closeBtn.onclick = closeForm;
  for (const b of host.querySelectorAll ? host.querySelectorAll("[data-tpl-apply]") : []) {
    b.onclick = () => (b.getAttribute("data-tpl-apply") === "node" ? applyNodeTemplate : applyGroupTemplate)(b.getAttribute("data-tpl-id"));
  }
  for (const b of host.querySelectorAll ? host.querySelectorAll("[data-tpl-del]") : []) {
    b.onclick = () => (b.getAttribute("data-tpl-del") === "node" ? deleteNodeTemplate : deleteGroupTemplate)(b.getAttribute("data-tpl-id"));
  }
  return r;
}

async function applyNodeTemplate(templateId) {
  if (!state.taskId) { showToast("先选一个任务，再套用预设", false); return { ok: false, status: 0, body: { error: "no-task" } }; }
  const at = centerWorld();
  const r = await api(`/api/tasks/${encodeURIComponent(state.taskId)}/apply-node-template`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ templateId, x: at.x, y: at.y })
  });
  if (r.ok) {
    showToast(`已套用节点预设：「${r.body.node.title}」`, true);
    await refresh();
    await selectNode(r.body.node.id);
    paintSelection();
  } else {
    showToast(`${r.body?.error || r.status}：${r.body?.message || "套用失败"}`, false);
  }
  return r;
}

async function applyGroupTemplate(templateId) {
  if (!state.taskId) { showToast("先选一个任务，再套用预设", false); return { ok: false, status: 0, body: { error: "no-task" } }; }
  const at = centerWorld();
  const r = await api(`/api/tasks/${encodeURIComponent(state.taskId)}/apply-group-template`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ templateId, x: at.x, y: at.y })
  });
  if (r.ok) {
    const n = (r.body.nodes || []).length;
    showToast(`已套用组预设：${n} 个节点${r.body.groupId ? "，并圈成一个组" : ""}`, true);
    await refresh();
    if (r.body.groupId) selectGroup(r.body.groupId);
    else render();
  } else {
    showToast(`${r.body?.error || r.status}：${r.body?.message || "套用失败"}`, false);
  }
  return r;
}

async function saveNodeTemplate(nodeId, name) {
  const n = state.nodesById.get(nodeId);
  const r = await api("/api/templates/nodes", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ nodeId, name: name || "" })
  });
  if (r.ok) showToast(`已存成节点预设「${r.body.name}」（${n ? n.title : nodeId}）`, true);
  else showToast(`${r.body?.error || r.status}：${r.body?.message || "存预设失败"}`, false);
  return r;
}

async function saveGroupTemplate(groupId, name) {
  const r = await api("/api/templates/groups", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ groupId, name: name || "" })
  });
  if (r.ok) showToast(`已存成组预设「${r.body.name}」：${r.body.nodeCount} 个节点、${r.body.edgeCount} 条组内线`, true);
  else showToast(`${r.body?.error || r.status}：${r.body?.message || "存组预设失败"}`, false);
  return r;
}

async function deleteNodeTemplate(templateId) {
  const r = await api(`/api/templates/nodes/${encodeURIComponent(templateId)}`, { method: "DELETE" });
  if (r.ok) { showToast("节点预设已删", true); await openTemplatePanel(); }
  else showToast(`${r.body?.error || r.status}：删不掉`, false);
  return r;
}

async function deleteGroupTemplate(templateId) {
  const r = await api(`/api/templates/groups/${encodeURIComponent(templateId)}`, { method: "DELETE" });
  if (r.ok) { showToast("组预设已删", true); await openTemplatePanel(); }
  else showToast(`${r.body?.error || r.status}：删不掉`, false);
  return r;
}
