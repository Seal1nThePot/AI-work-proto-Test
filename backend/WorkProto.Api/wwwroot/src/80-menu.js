// ────────── 80-menu.js ──────────「右键菜单」
// 用途: 右键菜单：关闭、按空白处打开、节点菜单、组菜单、链菜单（每一项都直接调对应动作）
// 暴露: closeContextMenu openContextMenu openNodeMenu openGroupMenu openChainMenu
// 依赖: 01-state.js(ctxItems) 02-dom.js($ esc) 12-chain.js 13-group.js 42~45 面板动作
// 被依赖: 71-pointer.js（右键长按）与 app.js

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
      const walk = chain && chain.length >= 2 ? chain.nodeIds : walkChainLocal(nodeId);
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
    (() => {
      if (n.groupId) return null;
      const target = nearestGroupForNode(nodeId);
      if (!target) return null;
      return {
        label: `加入最近组「${cut(target.title, 12)}」`,
        hint: target.distance < 0.5 ? "已在组框内 · G" : `距离 ${Math.round(target.distance)}px · G`,
        onClick: () => addNodeToGroup(nodeId, target.id)
      };
    })(),
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
