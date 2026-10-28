// ────────── 90-bind.js ──────────「事件绑定」
// 用途: 把 SVG 上的 pointerdown/move/up、contextmenu、wheel、click、dblclick 与 document 上的 pointerdown/keydown 全部接起来
// 暴露: bindSvgEvents
// 依赖: 10-geo.js 70-drag.js 71-pointer.js 80-menu.js 81-keyboard.js
// 被依赖: 99-boot.js（bootstrap 里调用）

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
