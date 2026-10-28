// ────────── 03-api.js ──────────「取数与刷新」
// 用途: 取数与刷新：api() 统一 HTTP 封装（返回 ok/status/body，非 JSON 保留原文）、loadTasks 拉任务、loadGraph 拉图并按 JSON 去重、refresh 串起来
// 暴露: api loadTasks loadGraph refresh
// 依赖: 01-state.js(state) 02-dom.js($ esc)
// 被依赖: app.js、99-boot（5 秒轮询）

async function api(path, options) {
  const res = await fetch(path, options);
  const text = await res.text();
  let body = text;
  try { body = text ? JSON.parse(text) : null; } catch (_) { /* 保留原文 */ }
  return { ok: res.ok, status: res.status, body };
}

// ---------------- 数据 ----------------

async function loadTasks() {
  const r = await api("/api/tasks");
  state.tasks = r.ok ? r.body.tasks : [];
  const sel = $("taskSelect");
  sel.innerHTML = state.tasks.length
    ? state.tasks
        .map((t) => `<option value="${esc(t.id)}">${esc(t.title)} · ${t.progress}%${t.blockedCount ? " · 阻塞" + t.blockedCount : ""}</option>`)
        .join("")
    : `<option value="">（还没有任务，点「＋ 新建任务」）</option>`;
  if (!state.tasks.length) { state.taskId = null; return; }
  const nextId = state.tasks.some((t) => t.id === state.taskId) ? state.taskId : state.tasks[0].id;
  if (nextId !== state.taskId) state.overview = false;   // 换任务就退出总览
  state.taskId = nextId;
  sel.value = state.taskId;
}

async function loadGraph() {
  if (!state.taskId) { $("graph").innerHTML = ""; $("taskSummary").innerHTML = ""; return; }
  if (state.drag || state.marquee || state.pan || state.connect) return;   // 操作中不打断
  const r = await api(`/api/tasks/${encodeURIComponent(state.taskId)}/graph`);
  if (!r.ok) {
    $("graph").innerHTML = `<text x="20" y="40" fill="#dc2626">读取失败：${esc(r.body?.error || r.status)}</text>`;
    return;
  }
  // 图没变就别重建 DOM：每 5 秒整图重绘一次，节点一多就是「无缘无故卡一下」
  const json = JSON.stringify(r.body);
  if (state.graphJson === json) return;
  state.graphJson = json;
  state.graph = r.body;
  render();
  if (state.fittedFor !== state.taskId) { state.fittedFor = state.taskId; fitView(); }
}

async function refresh() {
  await loadTasks();
  await loadGraph();
}
