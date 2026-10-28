// ────────── 45-cycle.js ──────────「循环区操作」
// 用途: 循环区三个动作：给节点组声明循环（自动带回边）、撤销循环、提高循环上限
// 暴露: declareLoop undoLoop raiseLoopLimit
// 依赖: 01-state.js 02-dom.js 03-api.js
// 被依赖: 42-panel-group.js 与 app.js

// ---------------- 循环区（组＋回边＋检查点） ----------------

/** 把一个组声明成循环区：自动连上「尾 → 头」的回边。 */
async function declareLoop(groupId) {
  const head = $("grpLoopHead") ? $("grpLoopHead").value : "";
  const tail = $("grpLoopTail") ? $("grpLoopTail").value : "";
  const limit = $("grpLoopLimit") ? Number($("grpLoopLimit").value || 3) : 3;
  const r = await api(`/api/node-groups/${encodeURIComponent(groupId)}/loop`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ head, tail, limit })
  });
  const box = $("grpLoopResult");
  if (r.ok) {
    showToast(`已把这个组声明为循环区（上限 ${r.body.limit}），回边已连好`, true);
    await refresh();
    selectGroup(groupId);
  } else if (box) {
    box.className = "formResult err";
    box.innerHTML = `<b>${esc(r.body?.error || r.status)}</b>：${esc(r.body?.message || "声明失败")}`;
  } else {
    showToast(`${r.body?.error || r.status}：${r.body?.message || "声明失败"}`, false);
  }
  return r;
}

/** 撤销循环：删掉回边与上限，组留着。 */

async function undoLoop(groupId) {
  const r = await api(`/api/node-groups/${encodeURIComponent(groupId)}/loop`, { method: "DELETE" });
  if (r.ok) {
    showToast(`已撤销循环（删了 ${r.body.edgesDeleted} 条回边），组还在`, true);
    await refresh();
    selectGroup(groupId);
  } else {
    showToast(`${r.body?.error || r.status}：${r.body?.message || "撤销失败"}`, false);
  }
  return r;
}

/** 调高轮次上限（只有 master/lead 能干）。 */

async function raiseLoopLimit(groupId) {
  const cy = state.cycleByGroup.get(groupId);
  if (!cy) { showToast("这个组不是循环区", false); return { ok: false, status: 0, body: { error: "no-cycle" } }; }
  const limit = $("grpLimitInput") ? Number($("grpLimitInput").value || cy.limit) : cy.limit;
  const r = await api(`/api/cycles/${encodeURIComponent(cy.id)}/raise`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ by: "master", limit, reason: "画布上调高上限" })
  });
  if (r.ok) { showToast(`上限已调到 ${r.body.limit}`, true); await refresh(); selectGroup(groupId); }
  else showToast(`${r.body?.error || r.status}：${r.body?.message || "调高失败"}`, false);
  return r;
}
