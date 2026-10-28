// ────────── app.js ──────────「画布主逻辑（尚未切走的部分）」
// 用途: 画布剩余逻辑：右键菜单、键盘、事件绑定（下一阶段继续切）
// 暴露: （全部顶层函数与 state 的消费方）
// 依赖: src/00-const.js … src/71-pointer.js（见 index.html 顺序）
// 被依赖: index.html

/** 组的先后：按跨组的 transfer 边做拓扑排序（环就按 seq 接在后面），未分组节点当最后一列。 */

/**
 * 自动整理：一列一列按组的先后摆块，块内按依赖深度从左到右、由上到下。
 * 只算坐标（不碰任何语义），算完照常走 POST /tasks/{id}/layout 落库。
 * 目标宽度 SHELF_W：摆满就换行，免得 8 个组排成一条望不到头的长龙。
 */

/**
 * 组内布局＝按依赖分层，不是网格。
 * 三合一的汇合点自己占一列，纵向对准那三个的重心；它再长出三条时，下一列就以它为中心上下摊开
 * —— 这样「3 → 1 → 3」在图上是一个看得出来的沙漏，而不是一堆并排的方块。
 * 组内不折行：一条流从左往右走到底（画布本来就没边），折成上下几条带会把「前后」读丢。
 * BAND 只是极端兜底（真有一百多层才换带）。
 */

/**
 * 自动整理：整张图只有一条「前后」主线——组按跨组依赖排出先后，一组一块、从左往右依次挨着放；
 * 组内同样从左往右（依赖分层），一条流走到底不折行。
 * 只算坐标，不碰任何语义；算完照常走 POST /tasks/{id}/layout 落库。
 */

/** 一键按组重排：先本地生效（图与渲染缓存同写，避免回弹），再落库。 */

/** 总览：所有组收成牌、牌子按组的先后排成整齐的格子（组间线收拢成一条并标 ×N），再点一次全摊开。 */

/** 连线落在哪个区域：左进、右出、底部（回边）。count>1 时沿边等分。 */

/** 屏幕坐标 → 画布世界坐标（含缩放与平移）。 */

/** 世界坐标 → 屏幕坐标（测试与锚点计算用）。 */

/**
 * 底纹跟着视口走：格子原点＝世界原点，平移缩放时格子一起动。
 * 画布没有边缘上限，所以不能给一块固定大小的底纹——否则一平移就露馅。
 */

/** 滚轮缩放：锚在光标下的那个点，缩放前后它不动。 */

/** 把整张图塞进视口。收纳起来的组按那块牌算，别为看不见的节点缩得太小。 */

/** 只框住一组节点（从总览点开一块牌时用）：不然一屏 150 个节点谁也看不清。 */

/** 收纳后的组显示成一块「牌」：成员节点全部藏起来，用这块牌代替（位置取成员包围盒左上角）。 */
/** 一个组在画布上的占位：收成牌就是牌，摊开就是组框。束线两头都落在它上面。 */

/** 一个组的进度快照：总览/组标签上要一眼看出这个组到哪了、有没有卡住。 */

/** 总览模式：牌子按组的先后排成整齐的格子，不再各自站在成员包围盒的左上角（那样牌会散到天边）。 */

/** 藏起来的节点：属于已收纳的组、或属于已收起的同向链。 */

/** 拖动时把「这个节点牵动的框」全刷一遍：循环区 + 它所在的节点组 + 它所在的那条链块。 */

/** 链块画在链头的坐标上：比节点宽一点、同高，左右口照旧（端口号取进出边里最大的那个）。 */

/** 摊开时的虚线框：把这条链的几个节点圈起来，让人知道「这条链现在在哪」。 */

/** 收起来了没：只认内存里那个集合（链头节点 id）。 */

/** 进出边索引：算链只认 transfer 边（回边是另一回事），一次建好给整张图用。 */

/**
 * 从任意一节往回追到链头、再顺下去追到链尾。判定：当前只有一条入边、那条入边的上游只有这一条出边，
 * 就算「一路接下去」；碰到分叉、汇合、或者跨了节点组就停。
 */

/** 给一个节点，返回它所在的那条同向链（可能只有它自己）。 */

/** 全图所有同向链：每个链头出一条，成员 ≥2 才算链。 */

// ---------------- 右键菜单 ----------------

function closeContextMenu() {
  const m = $("ctxMenu");
  if (m) { m.className = "ctx hidden"; m.innerHTML = ""; }
  state.ctxItems = [];
}

/** items: [{ label, hint, danger, disabled, onClick }]，null 会被跳过。 */
function openContextMenu(clientX, clientY, items) {
  const m = $("ctxMenu");
  const rows = items.filter(Boolean);
  state.ctxItems = rows;
  if (!m) return rows;
  m.innerHTML = rows.map((it, i) =>
    `<button type="button" class="ctx-item${it.danger ? " danger" : ""}" data-ctx="${i}"${it.disabled ? " disabled" : ""}>` +
    `<span>${esc(it.label)}</span>${it.hint ? `<em>${esc(it.hint)}</em>` : ""}</button>`
  ).join("");
  m.className = "ctx";
  if (m.style) { m.style.left = `${clientX}px`; m.style.top = `${clientY}px`; }
  const buttons = m.querySelectorAll ? m.querySelectorAll("[data-ctx]") : [];
  for (const b of buttons) {
    b.onclick = () => {
      const idx = Number(b.getAttribute("data-ctx"));
      const it = state.ctxItems[idx];
      closeContextMenu();
      if (it && !it.disabled && typeof it.onClick === "function") it.onClick();
    };
  }
  return rows;
}

function openNodeMenu(nodeId, ev) {
  const n = state.nodesById.get(nodeId);
  if (!n) return [];
  const picked = state.selectedIds.has(nodeId) ? [...state.selectedIds] : [nodeId];
  return openContextMenu(ev.clientX, ev.clientY, [
    { label: "编辑属性", hint: "右栏改", onClick: () => { setSelection([nodeId]); paintSelection(); focusProps(); } },
    {
      label: n.compact === 1 ? "已收纳：仅标题" : "收纳为仅标题",
      disabled: n.compact === 1,
      onClick: () => setNodeCompact(nodeId, 1)
    },
    {
      label: n.compact === 2 ? "已收纳：仅关键字" : "收纳为仅关键字",
      disabled: n.compact === 2,
      onClick: () => setNodeCompact(nodeId, 2)
    },
    n.compact ? { label: "展开（完整卡片）", onClick: () => setNodeCompact(nodeId, 0) } : null,
    (() => {
      // 同向链：一条出边接一条入边才算「接下去」，菜单上写清会收几个
      const chain = state.chainByMember ? state.chainByMember.get(nodeId) : null;
      if (chain && chainIsCollapsed(chain)) {
        return {
          label: `摊开这条同向链（${chain.count} 合 1）`,
          hint: "成员摆回原位",
          onClick: () => collapseChain(chain.id, false)
        };
      }
      const walk = chain.length >= 2 ? chain.nodeIds : walkChainLocal(nodeId);
      return {
        label: walk.length >= 2 ? `同向链收成一块（${walk.length} 个）` : "同向链收成一块",
        hint: walk.length >= 2 ? "双击标题可摊开" : "同向上接不出第二个",
        disabled: walk.length < 2,
        onClick: () => collapseChainOfNode(nodeId)
      };
    })(),
    {
      label: `建立节点组（${picked.length} 个）`,
      hint: picked.length >= 2 ? "" : "先框选/Shift 多选",
      disabled: picked.length < 2,
      onClick: () => createNodeGroup(picked)
    },
    n.groupId ? { label: "删除分组", hint: groupTitle(n.groupId), onClick: () => deleteNodeGroup(n.groupId, false) } : null,
    { label: "存成节点预设", hint: "以后到处套", onClick: () => saveNodeTemplate(nodeId) },
    { label: `删除节点「${cut(n.title, 12)}」`, hint: "只能删未起步且无连线", danger: true, onClick: () => deleteNode(nodeId) }
  ]);
}

function openGroupMenu(groupId, ev) {
  const members = groupMembers(groupId);
  const grp = (state.graph?.nodeGroups || []).find((x) => x.id === groupId);
  const collapsed = !!(grp && grp.collapsed);
  return openContextMenu(ev.clientX, ev.clientY, [
    {
      label: collapsed ? "展开这个组" : "收纳这个组",
      hint: collapsed ? "把成员摊回来" : `收起 ${members.length} 个成员`,
      onClick: () => collapseGroup(groupId, !collapsed)
    },
    {
      label: `选中组内 ${members.length} 个节点`,
      onClick: () => { setSelection(members.map((n) => n.id)); paintSelection(); }
    },
    { label: "存成组预设", hint: "整块可复用", onClick: () => saveGroupTemplate(groupId) },
    {
      label: `删除分组「${cut(groupTitle(groupId), 12)}」`,
      hint: "节点都留着",
      danger: true,
      onClick: () => deleteNodeGroup(groupId, false)
    },
    {
      label: `删除分组与组内 ${members.length} 个节点`,
      hint: "只删得起未起步且无连线的",
      danger: true,
      disabled: members.length === 0,
      onClick: () => deleteNodeGroup(groupId, true)
    }
  ]);
}

// ---------------- 选择 ----------------

function openChainMenu(chainId, ev) {
  const ch = chainById(chainId);
  if (!ch) return [];
  const members = chainMembers(ch);
  const collapsed = chainIsCollapsed(ch);
  return openContextMenu(ev.clientX, ev.clientY, [
    {
      label: collapsed ? "摊开这条链" : `收成一块（${members.length} 合 1）`,
      hint: collapsed ? "把成员摆回原位" : "只换看法，不动图",
      onClick: () => collapseChain(chainId, !chainIsCollapsed(chainById(chainId)))
    },
    {
      label: `选中链上 ${members.length} 个节点`,
      onClick: () => { setSelection(members.map((n) => n.id)); paintSelection(); }
    }
  ]);
}

/** 当前选中状态的一句话指纹：用来判断「画布上画的是不是就是这个选中」。 */

/** 焦点节点（含它所在的收纳组）：与它相连的线亮起来，其余压暗。 */

/** 节点卡片 / 连线的 class：渲染和「只上色不重绘」共用同一套，别写两份规则。 */

/**
 * 只改选中态的高亮/压暗，不重建 DOM。
 * 节点可能上千，点一下整图重绘就是「点一下卡一下」的根源——选中这种纯视觉变化不该付构图的代价。
 */

/** 把一个节点存成预设（右键节点菜单）。 */

/** 把一个组存成预设（组面板/组菜单）。 */

/** 撤销循环：删掉回边与上限，组留着。 */

/** 调高轮次上限（只有 master/lead 能干）。 */

// ---------------- 键盘删除 ----------------

/** 输入框里按 Delete 是删字，不是删节点。 */
function isTypingTarget(t) {
  if (!t) return false;
  const tag = (t.tagName || "").toString().toLowerCase();
  if (tag === "input" || tag === "textarea" || tag === "select") return true;
  return !!(t.isContentEditable);
}

/**
 * Delete 键：删「当前选中的那个东西」。
 * 优先级＝连线 > 同向链 > 组 > 多选节点 > 单节点；每种都走它自己的守卫，删不掉就把原因说出来。
 * 容器（链/组）按 Delete 只撤掉容器本身：链摊开、组解散，里面的节点一个不动。
 */
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

/**
 * Shift 拖动的左右吸附：把被拖节点的**左缘**对齐到邻居左缘、**右缘**对齐到邻居右缘，
 * 或者贴到邻居的右侧/左侧。同宽节点下「左对左」与「右对右」等价——真正的区别在贴靠那两条，
 * 所以四种候选都算，取阈值（SNAP_PX）内最近的一条，其余远处的自然不命中。
 */
/**
 * 一个轴上的吸附：左右（x）与前后/上下（y）各四种候选——
 * 上/左缘对齐、下/右缘对齐、贴到它下方/右侧、贴到它上方/左侧。
 * 取阈值（SNAP_PX）内最近的一条；两轴各算各的，所以能同时吸成一列又一行。
 */

/** 兼容老名字：只管左右那一轴。 */

/** 吸附参考线：左右吸画竖虚线、前后吸画横虚线，各带一句「上/下/左/右对齐 · 贴到哪边」。 */

/** 拖动核心：立刻改 transform（跟手），连线交给下一帧；按住 Shift 就左右 + 前后吸附。 */

// 中键平移

// 框选

/** 落点优先取指针正下方的端口，否则取纵向最近的那个口。 */

/** 批量落坐标：框选一起拖时只发一次请求。 */

/** 把本地临时画上去的那条线撤掉（服务端说不行时）。 */

/**
 * 本地插一条线：只往现有 DOM 里加「线 + 命中带」两个元素，不整图重绘。
 * 节点上千时，建线后重取整图重绘要 0.5–1 秒，全卡在这一次重绘上。
 */

/**
 * 本地改完图（拖坐标、插线、起步状态）之后，把「上次渲染的图」也同步成现在这样。
 * 不做这一步，轮询会把「本地已经画好的变化」当成新变化，再来一次整图重绘。
 */

/** 静默校准：攒一下再拉一次图（JSON 没变就不会重绘；变了也只是补上状态差异）。 */

/** 双击空白：把落点坐标交给节点表单（中心对齐到鼠标）。负坐标照收，画布没边。 */

/** 双击空白＝直接建一个默认节点（不弹表单），建完选中它、把右栏名字框聚焦好让人改。 */

/** 选中节点后把右栏「标题」输入框聚焦（双击建节点之后就能直接改名）。 */

/** 选中节点后改属性：标题 / 一行目标 / 类型 / 循环区。 */

/** 删节点（守卫在后端：只删未起步且无连线的 pending）。 */

/** 单个节点收纳：0 完整 / 1 仅标题 / 2 仅关键字（纯看图状态）。 */

/** 把选中的几个节点圈成一个节点组（纯视觉，不影响门与执行）。 */

/** 删节点组：withNodes=false 只解散（节点全留）；true 连节点一起删（组里有一个删不起就整批不动）。 */

/** 收纳/展开一个组（纯看图状态，落库只为刷新后还是原样）。 */

/** 双击标题：组在「收成一块牌 / 摊开」之间切换。 */

/** 双击标题：节点在「完整卡片 / 仅标题」之间切换（本来停在仅关键字就摊回完整）。 */

/** 收起/摊开一条同向链：纯前端看法，改的是内存里的集合，接口一个都不调。 */

/** 右键「同向链收成一块」：给链上任意一节，收它所在的那一条。 */

// ---------------- 事件接线 ----------------

function bindSvgEvents() {
  const svg = $("graph");
  if (!svg || !svg.addEventListener) return;
  svg.addEventListener("pointerdown", onSvgPointerDown);
  svg.addEventListener("pointermove", onSvgPointerMove);
  svg.addEventListener("pointerup", onSvgPointerUp);
  svg.addEventListener("pointercancel", onSvgPointerUp);
  svg.addEventListener("contextmenu", (e) => { e.preventDefault(); });
  svg.addEventListener("wheel", (e) => {
    e.preventDefault();
    zoomAt(e.clientX, e.clientY, e.deltaY);
  }, { passive: false });
  svg.addEventListener("click", (e) => {
    if (state.suppressClick) { state.suppressClick = false; return; }
    if (e.shiftKey) return;                        // Shift 点击的加/减选在 pointerup 里已经做了
    const t = e.target;
    const el = t && t.closest ? t.closest("[data-node]") : null;
    if (el) {
      const id = el.getAttribute("data-node");
      // 按下时已经选过（startDrag 里做的），这里别再拉一遍详情
      if (state.selected !== id || state.selectedIds.size !== 1) setSelection([id]);
      // 画布画的已经是这个选中（比如刚点过同一条）就不重绘：双击要靠元素不被换掉才判得出来
      if (state.paintedKey === selectionKey()) return;
      paintSelection();
      return;
    }
    if (t && t.closest && t.closest("[data-chain]")) return;   // 链块在 pointerup 里已经选中了
    const hit = t && t.closest ? t.closest("[data-edge-hit]") : null;
    if (hit) { selectEdge(hit.getAttribute("data-edge-hit")); return; }
  });
  // 双击标题＝快收/快开：节点（完整↔仅标题）、组（收成牌↔摊开）、同向链（收成一块↔摊开）
  svg.addEventListener("dblclick", (e) => {
    const t = e.target;
    const closest = (sel) => (t && t.closest ? t.closest(sel) : null);
    const chainEl = closest("[data-chain]");
    if (chainEl) { if (e.preventDefault) e.preventDefault(); toggleChain(chainEl.getAttribute("data-chain")); return; }
    const nodeEl = closest("[data-node]");
    if (nodeEl) { if (e.preventDefault) e.preventDefault(); toggleNodeCompact(nodeEl.getAttribute("data-node")); return; }
    const chipEl = closest("[data-nodegroup-chip]");
    if (chipEl) { if (e.preventDefault) e.preventDefault(); toggleGroupCollapsed(chipEl.getAttribute("data-nodegroup-chip")); return; }
    const pillEl = closest("[data-nodegroup-pill]");
    if (pillEl) { if (e.preventDefault) e.preventDefault(); toggleGroupCollapsed(pillEl.getAttribute("data-nodegroup-pill")); return; }
    const pt = svgPoint(e);
    quickAddNode(pt.x, pt.y);          // 双击空白＝当场建一个默认节点，再去右栏改名字
  });
  if (typeof document.addEventListener === "function") {
    document.addEventListener("pointerdown", (e) => {
      const m = $("ctxMenu");
      if (!m || m.className !== "ctx") return;
      const hit = e.target && e.target.closest ? e.target : null;
      // 菜单内的点击自己管；画布内的开关由 svg 的 pointerdown 管（先关再按需开）
      if (hit && hit.closest && (hit.closest("#ctxMenu") || hit.closest("#graph"))) return;
      closeContextMenu();
    });
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape") { closeContextMenu(); return; }
      if (e.key === "Delete" || e.key === "Del") {
        if (isTypingTarget(e.target)) return;         // 输入框里 Delete 是删字
        if (!state.selected && !state.selectedEdge && !state.selectedGroup && !state.selectedChain && !state.selectedIds.size) return;
        if (e.preventDefault) e.preventDefault();
        deleteSelected();
      }
    });
  }
  if (typeof window !== "undefined" && window.addEventListener) {
    window.addEventListener("resize", () => { state.view = null; });
  }
}

async function bootstrap() {
  const h = await api("/api/health");
  if (h.ok) $("dbNote").textContent = "库：" + (h.body.databasePath || "");
  bindSvgEvents();
  await loadTasks();
  await loadGraph();
}

$("taskSelect").addEventListener("change", async (e) => {
  state.taskId = e.target.value;
  state.selected = null;
  state.selectedIds = new Set();
  state.fittedFor = null;
  $("sideBody").innerHTML = "";
  closeForm();
  await loadGraph();
});

$("addTaskBtn").addEventListener("click", openTaskForm);
$("addNodeBtn").addEventListener("click", () => { state.pendingPos = null; openNodeForm(); });
$("addEdgeBtn").addEventListener("click", () => openEdgeForm());
$("tplBtn").addEventListener("click", () => openTemplatePanel());
$("arrangeBtn").addEventListener("click", () => arrangeByGroups());
$("overviewBtn").addEventListener("click", () => toggleOverview());
$("fitBtn").addEventListener("click", fitView);
$("refreshBtn").addEventListener("click", () => refresh());

$("autoRefresh").addEventListener("change", (e) => {
  if (state.timer) clearInterval(state.timer);
  state.timer = e.target.checked ? setInterval(() => loadGraph(), 5000) : null;
});

state.timer = setInterval(() => loadGraph(), 5000);
bootstrap();
