// ────────── 46-panel-view.js ──────────「视图菜单与图层面板」
// 用途: 顶部「视图」下拉菜单、右栏视图图层面板、未保存视图的保存/丢弃提醒
// 暴露: renderViewPanel updateViewBadge askViewDirtyChoice openViewMenu focusViewPanel exportBundle importBundleData importBundleFile
// 依赖: 01-state.js 02-dom.js 14-view.js 42-panel-group.js 80-menu.js
// 被依赖: 99-boot.js 14-view.js（回调）

function updateViewBadge() {
  const btn = $("viewMenuBtn");
  if (btn) btn.textContent = state.viewDirty ? "视图 •" : "视图 ▾";
}

function renderViewPanel() {
  const host = $("viewPanel");
  if (!host) return;
  updateViewBadge();
  if (!state.taskId) {
    host.innerHTML = `<div class="view-head"><b>视图图层</b></div><div class="muted">先选一个任务</div>`;
    return;
  }
  const modeLabels = { "group-view": "组视角", compact: "紧凑", stack: "重叠" };
  const modeText = (layer) => ((layer && layer.modes) || []).map((m) => modeLabels[m] || m).join(" · ") || "原布局";
  const active = state.viewLayerId;
  const current = active ? (state.viewLayers || []).find((l) => l.id === active) : null;
  const rows = [`<div class="view-row"><button type="button" class="view-item${!active && !state.viewDirty ? " active" : ""}" data-view-layer="">
    <span class="view-name">原视图</span><span class="view-tags">库中坐标</span>
  </button></div>`];
  for (const layer of state.viewLayers || []) {
    rows.push(`<div class="view-row">
      <button type="button" class="view-item${layer.id === active ? " active" : ""}" data-view-layer="${esc(layer.id)}">
        <span class="view-name">${esc(layer.name)}</span><span class="view-tags">${esc(modeText(layer))}</span>
      </button>
      <button type="button" class="view-del" data-view-del="${esc(layer.id)}" title="删除图层">×</button>
    </div>`);
  }
  const name = current ? current.name : "";
  const stateText = state.viewDirty ? "未保存" : active ? `已保存 · ${current ? modeText(current) : "读取中"}` : "原视图";
  host.innerHTML = `
    <div class="view-head"><b>视图图层</b><span class="view-state">${esc(stateText)}</span></div>
    <div class="view-list">${rows.join("")}</div>
    <div class="view-save">
      <input id="viewNameInput" placeholder="图层名（留空＝图层1、图层2…自动排）" value="${esc(name)}" />
      <button type="button" id="viewSaveBtn" title="同名或留空＝更新当前；新名字＝另存新图层">保存</button>
      ${current ? `<button type="button" id="viewRenameBtn" class="ghost" title="只改当前图层名字，不覆盖快照">改名</button>` : ""}
    </div>
    <div class="view-hint">图层可保存多个：同名/留空更新当前，改成新名字＝另存；显示模式随图层一起存。</div>
    <div class="view-hint">只存视图，不改节点/连线；Ctrl+Z 可撤销视图操作</div>`;
  host.onclick = (ev) => {
    const t = ev && ev.target;
    const del = t && t.closest ? t.closest("[data-view-del]") : null;
    if (del) { deleteViewLayerById(del.getAttribute("data-view-del")); return; }
    const item = t && t.closest ? t.closest("[data-view-layer]") : null;
    if (item) {
      const id = item.getAttribute("data-view-layer");
      switchViewLayer(id || null);
    }
  };
  const saveBtn = $("viewSaveBtn");
  if (saveBtn) saveBtn.onclick = () => {
    const input = $("viewNameInput");
    saveViewLayer(input ? input.value : "");
  };
  const renameBtn = $("viewRenameBtn");
  if (renameBtn) renameBtn.onclick = () => {
    const input = $("viewNameInput");
    saveViewLayer(input ? input.value : "", { renameOnly: true });
  };
  const input = $("viewNameInput");
  if (input) input.onkeydown = (e) => {
    if (e && e.key === "Enter") saveViewLayer(input.value);
  };
}

function focusViewPanel() {
  const input = $("viewNameInput");
  if (input && input.focus) input.focus();
}

/** 当前工作流 + 当前视图打包成可下载 JSON（不包含执行进度/租约/检查点）。 */
function exportBundle() {
  const g = state.graph;
  if (!g || !g.task) { showToast("先选一个任务再导出", false); return null; }
  const view = state.viewState
    ? JSON.parse(viewPayload())
    : {
        version: 1,
        positions: Object.fromEntries([...state.positions].map(([id, p]) => [id, { x: Math.round(p.x), y: Math.round(p.y) }])),
        groupLayouts: initGroupLayouts(),
        groupView: false, compactView: false, allowOverlap: true,
        viewport: { ...state.viewport }
      };
  const layer = (state.viewLayers || []).find((l) => l.id === state.viewLayerId);
  const bundle = {
    format: "workproto.bundle",
    version: 1,
    exportedAtUtc: new Date().toISOString(),
    task: { title: g.task.title, goalLine: g.task.goalLine || "" },
    nodes: g.nodes.map((n) => ({
      id: n.id, title: n.title, goalLine: n.goalLine, kind: n.kind, seq: n.seq,
      cycleRegion: n.cycleRegion, x: n.posX, y: n.posY,
      inPorts: n.inPorts, outPorts: n.outPorts, compact: n.compact, groupId: n.groupId
    })),
    edges: g.edges.map((e) => ({
      id: e.id, from: e.fromNodeId, to: e.toNodeId, kind: e.kind,
      fromPort: e.fromPort, toPort: e.toPort, gate: e.gate, gateNote: e.gateNote
    })),
    inputGroups: g.groups || [],
    cycles: (g.cycles || []).map((c) => ({
      id: c.id, groupId: c.groupId, regionKey: c.regionKey,
      headNodeId: c.headNodeId, tailNodeId: c.tailNodeId, limit: c.limit, limitKind: c.limitKind
    })),
    nodeGroups: (g.nodeGroups || []).map((grp) => ({
      id: grp.id, title: grp.title, collapsed: !!grp.collapsed,
      layout: grp.layout || null, nodeIds: grp.nodeIds || []
    })),
    view: { name: layer ? layer.name : "当前视图", payload: view }
  };
  const text = JSON.stringify(bundle, null, 2);
  if (typeof Blob !== "undefined" && typeof URL !== "undefined" && URL.createObjectURL && document.createElement) {
    try {
      const url = URL.createObjectURL(new Blob([text], { type: "application/json" }));
      const a = document.createElement("a");
      const safe = (g.task.title || "workflow").replace(/[\\/:*?"<>|]+/g, "_").slice(0, 60);
      a.href = url;
      a.download = `${safe}.workproto.json`;
      if (a.click) a.click();
      if (URL.revokeObjectURL) URL.revokeObjectURL(url);
    } catch { /* 下载失败也不影响返回 bundle */ }
  }
  showToast(`已导出「${g.task.title}」的工作流 + ${layer ? "视图「" + layer.name + "」" : "当前视图"}`, true);
  return bundle;
}

async function importBundleData(bundle) {
  if (!bundle || typeof bundle !== "object") {
    showToast("导入失败：不是有效的 JSON 对象", false);
    return { ok: false, status: 0, body: { error: "bad-bundle" } };
  }
  const r = await api("/api/import", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(bundle)
  });
  if (r.ok) {
    state.taskId = r.body.taskId;
    state.fittedFor = null;
    state.selected = null;
    state.selectedIds = new Set();
    state.selectedEdge = null;
    state.selectedGroup = null;
    state.selectedChain = null;
    state.viewState = null;
    state.viewLayerId = null;
    state.viewDirty = false;
    state.viewLayers = [];
    state.viewHistory = [];
    state.overview = false;
    await refresh();
    await loadViewLayers();
    if (r.body.layerId) await switchViewLayer(r.body.layerId);
    showToast(`已导入「${r.body.title}」：${r.body.nodes} 节点 / ${r.body.edges} 边`, true);
  } else {
    showToast(`导入失败：${r.body?.error || r.status} ${r.body?.message || ""}`, false);
  }
  return r;
}

async function importBundleFile(file) {
  try {
    const text = await file.text();
    return await importBundleData(JSON.parse(text));
  } catch (e) {
    showToast(`导入失败：${e.message || "JSON 读不出来"}`, false);
    return { ok: false, status: 0, body: { error: "bad-json" } };
  }
}

function askViewDirtyChoice() {
  if (state.viewPromptChoice) {
    const forced = state.viewPromptChoice;
    state.viewPromptChoice = null;
    return Promise.resolve(forced);
  }
  return new Promise((resolve) => {
    const dlg = $("viewDialog");
    const save = $("viewDialogSave");
    const discard = $("viewDialogDiscard");
    const cancel = $("viewDialogCancel");
    if (!dlg || !save || !discard || !cancel) { resolve("discard"); return; }
    const done = (choice) => {
      dlg.className = "view-dialog hidden";
      state.viewPromptClick = null;
      resolve(choice);
    };
    dlg.className = "view-dialog";
    save.onclick = () => done("save");
    discard.onclick = () => done("discard");
    cancel.onclick = () => done("cancel");
  });
}

function openViewMenu(ev) {
  const btn = $("viewMenuBtn");
  const rect = btn && btn.getBoundingClientRect ? btn.getBoundingClientRect() : { left: 0, top: 0, width: 0, height: 0 };
  const x = ev && Number.isFinite(ev.clientX) ? ev.clientX : rect.left;
  const y = ev && Number.isFinite(ev.clientY) && ev.clientY > 0 ? ev.clientY : rect.top + rect.height + 4;
  const groupHint = state.selectedGroup ? groupTitle(state.selectedGroup) : "先点一个组";
  const currentLayer = (state.viewLayers || []).find((l) => l.id === state.viewLayerId) || null;
  const items = [
    { label: "按组整理（选中组）", hint: groupHint, disabled: !state.selectedGroup, onClick: () => arrangeGroup(state.selectedGroup) },
    { label: "全局组整理", hint: "组内用各自缓存，不重排组内", onClick: () => arrangeAllGroups() },
    { label: "──────── 视图 ────────", disabled: true },
    { label: `组视角${viewGroupView() ? " ✓" : ""}`, hint: "组收成牌，只看组间关系", onClick: () => toggleGroupView() },
    { label: `紧凑/堆叠视图${viewCompactView() ? " ✓" : ""}`, hint: "全部小卡，组内按缓存紧排", onClick: () => toggleCompactView() },
    { label: `允许覆盖${viewFlag("allowOverlap") ? " ✓" : ""}`, hint: "默认允许；关闭立即碰撞检测并整体展开", onClick: () => toggleAllowOverlap() },
    { label: "──────── 图层 ────────", disabled: true },
    { label: "保存当前视图为图层", hint: "总是另存；留空自动 图层N", onClick: () => saveViewLayer("", { asNew: true }) },
    currentLayer ? { label: `更新当前图层「${currentLayer.name}」`, hint: "覆盖当前快照", onClick: () => saveViewLayer(currentLayer.name) } : null,
    { label: "到右栏命名/管理图层…", hint: "改名 / 切换 / 删除", onClick: focusViewPanel },
    { label: "撤销视图操作（Ctrl+Z）", hint: state.viewHistory.length ? `${state.viewHistory.length} 步` : "没有可撤销的视图操作", disabled: !state.viewHistory.length, onClick: () => undoViewOperation() },
    state.viewState ? { label: "回到原视图", hint: "保留已保存图层", onClick: () => switchViewLayer(null) } : null,
    { label: "──────── 文件 ────────", disabled: true },
    { label: "导出工作流 + 当前视图…", hint: "下载 JSON", onClick: () => exportBundle() },
    { label: "导入 JSON（工作流 + 视图）…", hint: "会新建任务", onClick: () => {
      const input = $("bundleFile");
      if (input && input.click) input.click();
      else showToast("当前页面没有文件选择框", false);
    } }
  ];
  return openContextMenu(x, y, items);
}
