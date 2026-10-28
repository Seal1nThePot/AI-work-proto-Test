// ────────── 51-form-node.js ──────────「节点表单与节点级写操作」
// 用途: 节点属性：提交表单、存属性、删节点、切换收纳级别、建/删节点组
// 暴露: submitNode saveNodeProps deleteNode setNodeCompact createNodeGroup addNodeToGroup addNodeToNearestGroup deleteNodeGroup
// 依赖: 01-state.js 02-dom.js 03-api.js 12-chain.js 13-group.js
// 被依赖: 20-render.js 42-panel-group.js 与 app.js

/** 选中节点后改属性：标题 / 一行目标 / 类型；改动自动保存，按钮只作手动兜底。 */

async function saveNodeProps(nodeId, opts = {}) {
  const auto = !!opts.auto;
  if (state.propsTimer) { clearTimeout(state.propsTimer); state.propsTimer = null; }
  const titleValue = $("nTitle") ? $("nTitle").value : undefined;
  if (auto && titleValue !== undefined && !titleValue.trim()) {
    if (state.selected === nodeId) {
      const box = $("propsResult");
      if (box) { box.className = "formResult err"; box.innerHTML = "标题不能为空，未自动保存"; }
    }
    return { ok: false, status: 0, body: { error: "title-required", message: "标题不能为空" } };
  }
  const payload = {
    title: titleValue,
    goalLine: $("nGoal") ? $("nGoal").value : undefined,
    kind: $("nKind") ? $("nKind").value : undefined
  };
  const r = await api(`/api/nodes/${encodeURIComponent(nodeId)}/props`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload)
  });
  const box = $("propsResult");
  if (r.ok) {
    const changed = r.body.changed || [];
    const node = r.body.node;
    if (auto) {
      if (node && state.graph) {
        const idx = state.graph.nodes.findIndex((n) => n.id === nodeId);
        if (idx >= 0) Object.assign(state.graph.nodes[idx], node);
        if (!state.drag && !state.marquee && !state.pan && !state.connect) render();
        syncGraphJson();
      }
      if (state.selected === nodeId && box) {
        box.className = "formResult ok";
        box.innerHTML = changed.length ? `已自动保存：${esc(changed.join("；"))}` : "没有改动";
        if (node) {
          const h = $("nodeHeadTitle");
          const gl = $("nodeHeadGoal");
          const meta = $("nodeHeadMeta");
          if (h) h.textContent = node.title;
          if (gl) gl.textContent = node.goalLine || "（无一行目标）";
          if (meta) meta.textContent = `${node.kind} · 第 ${node.seq} 个 · attempt ${node.attempt} · epoch ${node.cycleEpoch}${node.cycleRegion ? " · 循环 " + node.cycleRegion : ""}`;
        }
      }
    } else {
      if (box) {
        box.className = "formResult ok";
        box.innerHTML = changed.length ? `已保存：${esc(changed.join("；"))}` : "没有改动";
      }
      await refresh();
      await selectNode(nodeId);
      paintSelection();
      showToast(changed.length ? `节点已更新（${changed.length} 项）` : "没有改动", true);
    }
  } else {
    if (state.selected === nodeId && box) {
      box.className = "formResult err";
      box.innerHTML = `<b>${esc(r.body?.error || r.status)}</b>：${esc(r.body?.message || "改属性失败")}`;
    }
    if (!auto) showToast(`${r.body?.error || r.status}：${r.body?.message || "改属性失败"}`, false);
  }
  return r;
}

/** 删节点（守卫在后端：只删未起步且无连线的 pending）。 */

async function deleteNode(nodeId) {
  const n = state.nodesById.get(nodeId);
  const r = await api(`/api/nodes/${encodeURIComponent(nodeId)}`, { method: "DELETE" });
  if (r.ok) {
    showToast(`已删节点「${n ? n.title : nodeId}」`, true);
    setSelection([]);
    await refresh();
  } else {
    showToast(`${r.body?.error || r.status}：${r.body?.message || "删不掉"}`, false);
  }
  return r;
}

/** 单个节点收纳：0 完整 / 1 仅标题 / 2 仅关键字（纯看图状态）。 */

async function setNodeCompact(nodeId, level) {
  const r = await api(`/api/nodes/${encodeURIComponent(nodeId)}/compact`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ level })
  });
  if (r.ok) {
    showToast(level ? `「${r.body.title}」已收纳为${level === 2 ? "仅关键字" : "仅标题"}` : `「${r.body.title}」已展开`, true);
    await refresh();
  } else {
    showToast(`${r.body?.error || r.status}：${r.body?.message || "收纳失败"}`, false);
  }
  return r;
}

/** 把选中的几个节点圈成一个节点组（纯视觉，不影响门与执行）。 */

async function createNodeGroup(ids, title) {
  if (!state.taskId) return { ok: false, status: 0, body: { error: "no-task" } };
  const r = await api(`/api/tasks/${encodeURIComponent(state.taskId)}/node-groups`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ title: title || "", nodeIds: ids })
  });
  if (r.ok) {
    showToast(`已建节点组「${r.body.title}」：${r.body.nodeIds.length} 个节点（只是画布分组，不影响执行）`, true);
    setSelection([]);
    await refresh();
  } else {
    showToast(`${r.body?.error || r.status}：${r.body?.message || "建组失败"}`, false);
  }
  return r;
}

/** 把单个未分组节点加进已有组（右键菜单 / G 快捷键）。 */

async function addNodeToGroup(nodeId, groupId) {
  const r = await api(`/api/node-groups/${encodeURIComponent(groupId)}/nodes/${encodeURIComponent(nodeId)}`, {
    method: "POST"
  });
  if (r.ok) {
    showToast(`已把节点加入组「${r.body.title}」`, true);
    await refresh();
    await selectNode(nodeId);
    paintSelection();
  } else {
    showToast(`${r.body?.error || r.status}：${r.body?.message || "加入组失败"}`, false);
  }
  return r;
}

/** 快捷键/菜单共用：找最近的组并加入；已在组内或附近没有组时给出提示。 */

function addNodeToNearestGroup(nodeId) {
  const n = state.nodesById.get(nodeId);
  if (!n) return null;
  if (n.groupId) {
    showToast(`节点已在组「${groupTitle(n.groupId)}」里`, false);
    return null;
  }
  const target = nearestGroupForNode(nodeId);
  if (!target) {
    showToast("附近没有可加入的节点组", false);
    return null;
  }
  return addNodeToGroup(nodeId, target.id);
}

/** 删节点组：withNodes=false 只解散（节点全留）；true 连节点一起删（组里有一个删不起就整批不动）。 */

async function deleteNodeGroup(groupId, withNodes) {
  const title = groupTitle(groupId);
  const url = `/api/node-groups/${encodeURIComponent(groupId)}${withNodes ? "?withNodes=true" : ""}`;
  const r = await api(url, { method: "DELETE" });
  if (r.ok) {
    showToast(withNodes
      ? `已删除节点组「${title}」连同 ${r.body.nodesDeleted} 个节点`
      : `已解散节点组「${title}」，${r.body.released} 个节点留着`, true);
    setSelection([]);
    await refresh();
  } else {
    showToast(`${r.body?.error || r.status}：${r.body?.message || "删组失败"}`, false);
  }
  return r;
}

async function submitNode() {
  const title = $("fTitle").value.trim();
  if (!title) { showFormResult(false, "标题必填（一句白话，别写代号）"); return; }
  const body = { title, goalLine: $("fGoal").value.trim(), kind: $("fKind").value };
  const region = $("fRegion").value.trim();
  if (region) body.cycleRegion = region;
  const inPorts = Number($("fInPorts").value || 1);
  const outPorts = Number($("fOutPorts").value || 1);
  if (inPorts !== 1 || outPorts !== 1) { body.inPorts = inPorts; body.outPorts = outPorts; }
  if (state.pendingPos) { body.x = state.pendingPos.x; body.y = state.pendingPos.y; }

  $("submitNode").disabled = true;
  const r = await api(`/api/tasks/${encodeURIComponent(state.taskId)}/nodes`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });
  $("submitNode").disabled = false;

  if (r.ok) {
    const n = r.body.node;
    showFormResult(true, `已建节点「${esc(n.title)}」，排在第 ${n.seq} 个（${esc(n.id)}）` +
      (r.body.hint ? `<div class="muted">提示：${esc(r.body.hint)}</div>` : ""));
    $("fTitle").value = "";
    $("fGoal").value = "";
    $("fInPorts").value = "1";
    $("fOutPorts").value = "1";
    state.pendingPos = null;
    state.selected = n.id;
    await refresh();
  } else {
    showFormResult(false, `<b>${esc(r.body?.error || r.status)}</b>：${esc(r.body?.message || "提交失败")}`);
  }
  return r;
}
