// ────────── 14-view.js ──────────「视图状态与整理」
// 用途: 视图快照/图层/撤销/开关：原视图与图层的切换、脏标记、保存提醒、组视角/紧凑视图/允许覆盖开关
// 暴露: viewFlag viewCompactLevel viewAllGroupsCollapsed viewGroupView viewCompactView viewReadOnly groupContentOrigin deriveGroupRel initGroupLayouts ensureView resetViewState pushViewHistory undoViewOperation toggleGroupView toggleCompactView toggleAllowOverlap loadViewLayers saveViewLayer switchViewLayer deleteViewLayerById guardViewDirty
// 依赖: 00-const.js 01-state.js 02-dom.js 03-api.js 10-geo.js 11-layout.js 13-group.js
// 被依赖: 20-render.js 30-select.js 46-panel-view.js 60-write.js 71-pointer.js 99-boot.js

function viewFlag(name) {
  return !!(state.viewState && state.viewState[name]);
}

/** 视图里所有节点都按小卡画：紧凑/堆叠视图。 */
function viewCompactLevel(n) {
  return viewFlag("compactView") ? 1 : ((n && n.compact) || 0);
}

function viewAllGroupsCollapsed() {
  return viewFlag("groupView");
}

function viewGroupView() { return viewFlag("groupView"); }
function viewCompactView() { return viewFlag("compactView"); }

/** 组视角/紧凑视图里只允许看和选：拖动、连线都先退出视图，避免「看到的坐标」和库里打架。 */
function viewReadOnly() {
  return viewGroupView() || viewCompactView();
}

function groupContentOrigin(groupId, positions) {
  const map = positions || state.positions;
  const ps = groupMembers(groupId).map((n) => map.get ? map.get(n.id) : map[n.id]).filter(Boolean);
  if (!ps.length) return { x: 60, y: 160 };
  return { x: Math.min(...ps.map((p) => p.x)), y: Math.min(...ps.map((p) => p.y)) };
}

/** 从当前绝对位置反推组内相对坐标（原点＝成员内容左上角）。 */
function deriveGroupRel(groupId) {
  const origin = groupContentOrigin(groupId);
  const rel = [];
  for (const n of groupMembers(groupId)) {
    const p = state.positions.get(n.id);
    if (!p) continue;
    rel.push({ id: n.id, dx: Math.round(p.x - origin.x), dy: Math.round(p.y - origin.y) });
  }
  return rel;
}

function initGroupLayouts() {
  const map = {};
  for (const grp of state.graph?.nodeGroups || []) {
    const stored = grp.layout;
    if (Array.isArray(stored)) {
      const valid = stored
        .filter((it) => it && typeof it.id === "string" && Number.isFinite(it.dx) && Number.isFinite(it.dy))
        .map((it) => ({ id: it.id, dx: Math.round(it.dx), dy: Math.round(it.dy) }));
      if (valid.length) { map[grp.id] = valid; continue; }
    }
    map[grp.id] = deriveGroupRel(grp.id);
  }
  return map;
}

/** 第一次做视图操作时，把当前这张图（含自动排出来的坐标）冻成一份工作视图；原视图不动。 */
function ensureView() {
  if (state.viewState) return state.viewState;
  const positions = {};
  for (const [id, p] of state.positions) positions[id] = { x: Math.round(p.x), y: Math.round(p.y) };
  state.viewState = {
    positions,
    groupLayouts: initGroupLayouts(),
    groupView: false, compactView: false, allowOverlap: true,
    viewport: { ...state.viewport }
  };
  state.viewDirty = false;
  return state.viewState;
}

function markViewDirty() {
  state.viewDirty = true;
  if (typeof updateViewBadge === "function") updateViewBadge();
}

function updateViewBadge() {
  if (typeof window === "undefined") return;
  const btn = $("viewMenuBtn");
  if (btn) btn.textContent = state.viewDirty ? "视图 •" : "视图 ▾";
}

function pushViewHistory() {
  state.viewHistory.push(JSON.stringify({ view: state.viewState, layerId: state.viewLayerId, dirty: state.viewDirty }));
  while (state.viewHistory.length > 40) state.viewHistory.shift();
}

function resetViewState() {
  state.viewState = null;
  state.viewLayerId = null;
  state.viewDirty = false;
  state.viewHistory = [];
  state.viewLayers = [];
  state.overview = false;
  if (typeof updateViewBadge === "function") updateViewBadge();
  if (typeof renderViewPanel === "function") renderViewPanel();
}

function undoViewOperation() {
  if (!state.viewHistory.length) { showToast("没有可撤销的视图操作", false); return false; }
  const prev = JSON.parse(state.viewHistory.pop());
  state.viewState = prev.view;
  state.viewLayerId = prev.layerId;
  state.viewDirty = !!prev.dirty;
  if (state.viewState?.viewport) state.viewport = { ...state.viewState.viewport };
  render();
  applyViewport();
  if (typeof renderViewPanel === "function") renderViewPanel();
  updateViewBadge();
  showToast("已撤销一步视图操作", true);
  return true;
}

// ---------------- 视图开关（全部可撤销、可保存图层） ----------------

function toggleGroupView() {
  const on = !viewGroupView();
  pushViewHistory();
  const v = ensureView();
  v.groupView = on;
  if (on) v.compactView = false;
  state.overview = false;
  markViewDirty();
  render();
  fitView();
  if (typeof renderViewPanel === "function") renderViewPanel();
  showToast(on ? "组视角：组收成牌，只画组间关系" : "已回到节点视图", true);
  return v.groupView;
}

function toggleCompactView() {
  const on = !viewCompactView();
  pushViewHistory();
  const v = ensureView();
  v.compactView = on;
  if (on) v.groupView = false;
  markViewDirty();
  render();
  fitView();
  if (typeof renderViewPanel === "function") renderViewPanel();
  showToast(on ? "紧凑/堆叠视图：组内紧凑排，再点一次退出" : "已退出紧凑视图", true);
  return v.compactView;
}

/** 紧凑/堆叠视图默认允许卡片覆盖；关闭时按碰撞结果展开成不重叠。 */
function toggleAllowOverlap() {
  pushViewHistory();
  const v = ensureView();
  v.compactView = true;
  v.groupView = false;
  v.allowOverlap = v.allowOverlap === false;
  markViewDirty();
  render();
  fitView();
  if (typeof renderViewPanel === "function") renderViewPanel();
  showToast(v.allowOverlap ? "已允许覆盖：卡片可以互相压住" : "已禁止覆盖：碰撞检测后全部展开", true);
  return v.allowOverlap;
}

// ---------------- 视图图层 ----------------

function viewPayload() {
  const v = ensureView();
  return JSON.stringify({
    version: 1,
    positions: v.positions,
    groupLayouts: v.groupLayouts,
    groupView: !!v.groupView,
    compactView: !!v.compactView,
    allowOverlap: !!v.compactView && v.allowOverlap !== false,
    viewport: { ...state.viewport }
  });
}

function normalizeViewPayload(p) {
  p = p || {};
  return {
    positions: p.positions && typeof p.positions === "object" ? p.positions : {},
    groupLayouts: p.groupLayouts && typeof p.groupLayouts === "object" ? p.groupLayouts : {},
    groupView: !!p.groupView || !!p.stackGroups,
    compactView: !!p.compactView || !!p.stackNodes,
    allowOverlap: p.allowOverlap !== false && p.nodeStack !== false,
    viewport: p.viewport && Number.isFinite(p.viewport.scale) ? p.viewport : null
  };
}

async function loadViewLayers() {
  if (!state.taskId) { state.viewLayers = []; if (typeof renderViewPanel === "function") renderViewPanel(); return []; }
  const r = await api(`/api/tasks/${encodeURIComponent(state.taskId)}/view-layers`);
  state.viewLayers = r.ok ? (r.body.layers || []) : [];
  if (typeof renderViewPanel === "function") renderViewPanel();
  return state.viewLayers;
}

async function saveViewLayer(name, opts = {}) {
  if (!state.taskId) return { ok: false, status: 0, body: { error: "no-task" } };
  const nm = (name || "").trim();
  const current = (state.viewLayers || []).find((l) => l.id === state.viewLayerId) || null;

  // 只改名：不碰 payload，也不新建图层
  if (opts.renameOnly) {
    if (!current) { showToast("先选中一个图层再改名", false); return { ok: false, status: 0, body: { error: "no-layer" } }; }
    if (!nm) { showToast("图层名不能为空", false); return { ok: false, status: 0, body: { error: "name-required" } }; }
    if (nm === current.name) { showToast("图层名没变", false); return { ok: true, status: 200, body: { layer: current } }; }
    if ((state.viewLayers || []).some((l) => l.id !== current.id && l.name === nm)) {
      showToast(`图层名「${nm}」已存在，换一个`, false);
      return { ok: false, status: 0, body: { error: "layer-name-exists" } };
    }
    const rr = await api(`/api/view-layers/${encodeURIComponent(current.id)}`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: nm })
    });
    if (rr.ok) {
      await loadViewLayers();
      updateViewBadge();
      showToast(`已改名为「${nm}」`, true);
    } else {
      showToast(`改名没成功：${rr.body?.error || rr.status}`, false);
    }
    return rr;
  }

  // 同名（或名字留空）＝更新当前快照；改成另一个名字＝另存一个新图层。
  const update = !opts.asNew && !!current && (!nm || nm === current.name);
  if (!update && nm && (state.viewLayers || []).some((l) => l.name === nm)) {
    showToast(`图层名「${nm}」已存在：同名会更新当前，想另存请换个名字`, false);
    return { ok: false, status: 0, body: { error: "layer-name-exists" } };
  }

  const payload = viewPayload();
  const r = update
    ? await api(`/api/view-layers/${encodeURIComponent(current.id)}`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: nm || null, payload })
      })
    : await api(`/api/tasks/${encodeURIComponent(state.taskId)}/view-layers`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: nm, payload })
      });
  if (r.ok) {
    const layer = r.body.layer || r.body;
    state.viewLayerId = layer.id || (update ? current.id : state.viewLayerId);
    state.viewDirty = false;
    await loadViewLayers();
    updateViewBadge();
    showToast(update ? `已更新图层「${layer.name || current.name}」` : `已另存为图层「${layer.name || nm}」`, true);
  } else {
    showToast(`图层没存上：${r.body?.error || r.status}`, false);
  }
  return r;
}

async function switchViewLayer(id) {
  if (!state.taskId) return { ok: false };
  if ((id || null) === state.viewLayerId && !state.viewDirty) return { ok: true };
  const ok = await guardViewDirty();
  if (!ok) return { ok: false, status: 0, body: { error: "cancelled" } };
  pushViewHistory();
  if (!id) {
    state.viewState = null;
    state.viewLayerId = null;
    state.viewDirty = false;
    render();
    fitView();
    if (typeof renderViewPanel === "function") renderViewPanel();
    updateViewBadge();
    showToast("已回到原视图", true);
    return { ok: true };
  }
  const r = await api(`/api/view-layers/${encodeURIComponent(id)}`);
  if (!r.ok) { showToast(`图层读不出来：${r.body?.error || r.status}`, false); return r; }
  const p = r.body.payload || {};
  state.viewState = normalizeViewPayload(p);
  state.viewLayerId = id;
  state.viewDirty = false;
  state.overview = false;
  if (state.viewState.viewport) state.viewport = { ...state.viewState.viewport };
  render();
  applyViewport();
  if (typeof renderViewPanel === "function") renderViewPanel();
  updateViewBadge();
  showToast(`已切到图层「${r.body.name}」`, true);
  return r;
}

async function deleteViewLayerById(id) {
  const r = await api(`/api/view-layers/${encodeURIComponent(id)}`, { method: "DELETE" });
  if (!r.ok) { showToast(`图层删不掉：${r.body?.error || r.status}`, false); return r; }
  if (state.viewLayerId === id) {
    state.viewState = null;
    state.viewLayerId = null;
    state.viewDirty = false;
    render();
    fitView();
  }
  await loadViewLayers();
  updateViewBadge();
  showToast("图层已删除（原视图不受影响）", true);
  return r;
}

async function guardViewDirty() {
  if (!state.viewDirty) return true;
  const choice = await askViewDirtyChoice();
  if (choice === "cancel") return false;
  if (choice === "save") {
    const input = $("viewNameInput");
    const r = await saveViewLayer(input ? input.value : "");
    if (!r.ok) return false;
  }
  return true;
}
