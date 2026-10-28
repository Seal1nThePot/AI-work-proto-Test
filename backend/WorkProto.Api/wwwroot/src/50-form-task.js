// ────────── 50-form-task.js ──────────「任务与节点表单」
// 用途: 表单入口：关闭表单、显示提交结果、开「新建任务」「新建节点」、提交任务、双击空白快速建节点、按坐标要一个可用位置
// 暴露: closeForm showFormResult openTaskForm submitTask createTask openNodeForm requestNodeAt quickAddNode
// 依赖: 01-state.js 02-dom.js 03-api.js 10-geo.js
// 被依赖: 20-render.js 与 app.js（顶栏按钮接线）

async function createTask(title, goalLine) {
  const r = await api("/api/tasks", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ title, goalLine, nodes: [], edges: [], groups: [], cycles: [] })
  });
  if (r.ok) {
    state.taskId = r.body.id;
    state.selected = null;
    state.selectedIds = new Set();
    state.fittedFor = null;
    await refresh();
    showToast(`已建任务「${title}」（${r.body.id}）：双击空白处开始加节点`, true);
  } else {
    showToast(`${r.body?.error || r.status}：${r.body?.message || "建任务失败"}`, false);
  }
  return r;
}

// ---------------- 表单 ----------------

function closeForm() {
  $("formHost").innerHTML = "";
  state.pendingPos = null;
}

function showFormResult(ok, html) {
  const box = $("formResult");
  if (!box) return;
  box.className = "formResult " + (ok ? "ok" : "err");
  box.innerHTML = html;
}

function openTaskForm() {
  $("formHost").innerHTML = `
  <div class="form">
    <div class="formhead"><b>新建任务</b><button type="button" id="closeForm">关闭</button></div>
    <label>标题（必填）<input id="tTitle" maxlength="120" placeholder="例如：把周报写出来" /></label>
    <label>一行目标<input id="tGoal" placeholder="例如：给出可复核的三条结论" /></label>
    <div class="actions"><button type="button" class="primary" id="submitTask">建任务</button></div>
    <div id="formResult" class="formResult"></div>
  </div>`;
  $("closeForm").onclick = closeForm;
  $("submitTask").onclick = submitTask;
  $("tTitle").focus();
}

async function submitTask() {
  const title = $("tTitle").value.trim();
  if (!title) { showFormResult(false, "标题必填"); return; }
  $("submitTask").disabled = true;
  const r = await createTask(title, $("tGoal").value.trim());
  $("submitTask").disabled = false;
  if (r.ok) { $("tTitle").value = ""; $("tGoal").value = ""; showFormResult(true, `已建任务「${esc(title)}」，双击空白处加第一个节点`); }
  else showFormResult(false, `<b>${esc(r.body?.error || r.status)}</b>：${esc(r.body?.message || "")}`);
}

function openNodeForm() {
  if (!state.taskId) { $("formHost").innerHTML = `<div class="form"><div class="formResult err">先新建或选一个任务</div></div>`; return; }
  const at = state.pendingPos;
  $("formHost").innerHTML = `
  <div class="form">
    <div class="formhead"><b>新建节点</b><button type="button" id="closeForm">关闭</button></div>
    ${at ? `<div class="muted">画布位置：(${at.x}, ${at.y})</div>` : `<div class="muted">位置：建好后拖到想要的地方</div>`}
    <label>标题（必填，≤120 字）<input id="fTitle" maxlength="120" placeholder="例如：素材收集" /></label>
    <label>一行目标<input id="fGoal" placeholder="例如：收齐三份可用材料" /></label>
    <label>类型
      <select id="fKind">
        <option value="work">work · 干活</option>
        <option value="review_auto">review_auto · 程序/审核者按规则判</option>
        <option value="review_human">review_human · 人点头</option>
      </select>
    </label>
    <label>循环区（可选，要连回边才需要）<input id="fRegion" placeholder="例如：R1" /></label>
    <label>接线口（1–12，默认各 1 个）
      <span class="portsRow">进 <input id="fInPorts" type="number" min="1" max="12" value="1" /> 出 <input id="fOutPorts" type="number" min="1" max="12" value="1" /></span>
    </label>
    <div class="actions"><button type="button" class="primary" id="submitNode">建节点</button></div>
    <div id="formResult" class="formResult"></div>
  </div>`;
  $("closeForm").onclick = closeForm;
  $("submitNode").onclick = submitNode;
  $("fTitle").focus();
}

function requestNodeAt(x, y) {
  state.pendingPos = { x: Math.round(x - NODE_W / 2), y: Math.round(y - NODE_H / 2) };
  openNodeForm();
  return state.pendingPos;
}

async function quickAddNode(worldX, worldY, title) {
  if (!state.taskId) {
    showToast("先新建或选一个任务，再双击空白建节点", false);
    return { ok: false, status: 0, body: { error: "no-task" } };
  }
  const seq = (state.graph?.nodes?.length || 0) + 1;
  const body = {
    title: (title || `新节点 ${seq}`).trim(),
    goalLine: "",
    kind: "work",
    x: Math.round(worldX - NODE_W / 2),
    y: Math.round(worldY - NODE_H / 2)
  };
  const r = await api(`/api/tasks/${encodeURIComponent(state.taskId)}/nodes`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });
  if (!r.ok) {
    showToast(`${r.body?.error || r.status}：${r.body?.message || "建节点失败"}`, false);
    return r;
  }
  const n = r.body.node;
  state.pendingPos = null;
  await refresh();
  await selectNode(n.id);
  paintSelection();
  focusProps();
  showToast(`已建节点「${n.title}」——在右栏改名字和目标`, true);
  return r;
}
