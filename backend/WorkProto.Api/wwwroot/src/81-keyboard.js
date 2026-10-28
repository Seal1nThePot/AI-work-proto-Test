// ────────── 81-keyboard.js ──────────「键盘」
// 用途: 键盘：判断是否在输入框、Delete 删除选中（节点/连线/组/链）
// 暴露: isTypingTarget deleteSelected deleteNodes
// 依赖: 01-state.js 02-dom.js 03-api.js 21-render-diff.js
// 被依赖: 90-bind.js（document keydown）

// ---------------- 键盘删除 ----------------

/** 输入框里按 Delete 是删字，不是删节点。 */
function isTypingTarget(t) {
  if (!t) return false;
  const tag = (t.tagName || "").toString().toLowerCase();
  if (tag === "input" || tag === "textarea" || tag === "select") return true;
  return !!(t.isContentEditable);
}

async function deleteSelected() {
  if (state.selectedEdge) return removeEdge(state.selectedEdge);
  if (state.selectedChain) return collapseChain(state.selectedChain, false);
  if (state.selectedGroup) return deleteNodeGroup(state.selectedGroup, false);   // 默认只解散，连节点删要走面板/菜单
  const ids = [...state.selectedIds];
  if (ids.length > 1) return deleteNodes(ids);
  if (state.selected) return deleteNode(state.selected);
  if (ids.length === 1) return deleteNode(ids[0]);
  showToast("先点一下要删的节点/连线/组（或按 Shift 多选）", false);
  return { ok: false, status: 0, body: { error: "no-selection" } };
}

/** 一次删多个节点：能删的删掉，删不掉的点名报出来（不静默丢）。 */

async function deleteNodes(ids) {
  const okIds = [];
  const failed = [];
  for (const id of ids) {
    const n = state.nodesById.get(id);
    const r = await api(`/api/nodes/${encodeURIComponent(id)}`, { method: "DELETE" });
    if (r.ok) okIds.push(n ? n.title : id);
    else failed.push(`${n ? n.title : id}（${r.body?.error || r.status}）`);
  }
  setSelection([]);
  await refresh();
  if (failed.length) {
    showToast(`删掉 ${okIds.length} 个；删不掉 ${failed.length} 个：${failed.join("、")}`, false);
  } else {
    showToast(`删掉 ${okIds.length} 个节点`, true);
  }
  return { ok: failed.length === 0, status: 200, body: { deleted: okIds, failed } };
}
