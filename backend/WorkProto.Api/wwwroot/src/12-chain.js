// ────────── 12-chain.js ──────────「同向链」
// 用途: 同向链＝纯前端看法：按边现算链成员、链框与标题、折叠判定、链块重绘（不落库，刷新即摊开）
// 暴露: chainMembers chainRect chainFrameRect chainTitleText chainIdOf chainIsCollapsed chainById chainIndex walkChainFrom walkChainLocal graphChains redrawChainFor
// 依赖: 00-const.js(CHAIN_W) 01-state.js(chains/collapsedChains) 02-dom.js
// 被依赖: 13-group.js 20-render.js 与 app.js

// ---------------- 同向链（一根筋接下去的几节，收成一块看） ----------------
// 纯前端：链是从「连线」里读出来的看法，不是数据——后端只有节点和边，一个字段都没加。
// 收没收起也只记在内存里，刷新页面就摊开（要长期记住再说）。

function chainMembers(chain) {
  return ((chain && chain.nodeIds) || []).map((id) => state.nodesById.get(id)).filter(Boolean);
}

function chainRect(chain) {
  const head = state.positions.get(chain.headNodeId);
  if (!head) return null;
  const ids = new Set(chain.nodeIds || []);
  let inPorts = 1;
  let outPorts = 1;
  for (const e of state.graph?.edges || []) {
    const fromIn = ids.has(e.fromNodeId);
    const toIn = ids.has(e.toNodeId);
    if (fromIn === toIn) continue;                       // 链内部的线不算口
    if (toIn) inPorts = Math.max(inPorts, (e.toPort || 0) + 1);
    else outPorts = Math.max(outPorts, (e.fromPort || 0) + 1);
  }
  return { x: head.x, y: head.y, w: CHAIN_W, h: CHAIN_H, inPorts, outPorts };
}

function chainFrameRect(chain) {
  const members = chainMembers(chain).map((n) => state.positions.get(n.id)).filter(Boolean);
  if (!members.length) return null;
  return {
    x: Math.min(...members.map((p) => p.x)) - 18,
    y: Math.min(...members.map((p) => p.y)) - 26,
    w: Math.max(...members.map((p) => p.x + p.w)) + 18 - (Math.min(...members.map((p) => p.x)) - 18),
    h: Math.max(...members.map((p) => p.y + p.h)) + 16 - (Math.min(...members.map((p) => p.y)) - 26)
  };
}

function chainTitleText(chain) {
  const members = chainMembers(chain);
  if (members.length < 2) return "同向链";
  return `${members[0].title} › … › ${members[members.length - 1].title}`;
}

function chainIdOf(headNodeId) {
  return `ch:${headNodeId}`;
}

function chainIsCollapsed(chain) {
  return !!chain && state.collapsedChains.has(chain.headNodeId);
}

function chainById(chainId) {
  return (state.chains || []).find((x) => x.id === chainId) || null;
}

function chainIndex() {
  if (state.chainIndex) return state.chainIndex;
  const ins = new Map();
  const outs = new Map();
  for (const n of state.graph?.nodes || []) { ins.set(n.id, []); outs.set(n.id, []); }
  for (const e of state.graph?.edges || []) {
    if (e.kind !== "transfer") continue;
    if (!outs.has(e.fromNodeId) || !ins.has(e.toNodeId)) continue;
    if (!outs.get(e.fromNodeId).includes(e.toNodeId)) outs.get(e.fromNodeId).push(e.toNodeId);
    if (!ins.get(e.toNodeId).includes(e.fromNodeId)) ins.get(e.toNodeId).push(e.fromNodeId);
  }
  state.chainIndex = { ins, outs };
  return state.chainIndex;
}

function walkChainFrom(nodeId, ins, outs) {
  const groupOf = (id) => (state.nodesById.get(id) || {}).groupId || "";
  const group = groupOf(nodeId);
  const seen = new Set([nodeId]);
  const chain = [nodeId];
  let cur = nodeId;
  while (chain.length < 60) {
    const list = ins.get(cur) || [];
    if (list.length !== 1) break;
    const prev = list[0];
    if ((outs.get(prev) || []).length !== 1 || groupOf(prev) !== group || seen.has(prev)) break;
    seen.add(prev);
    chain.unshift(prev);
    cur = prev;
  }
  cur = nodeId;
  while (chain.length < 60) {
    const list = outs.get(cur) || [];
    if (list.length !== 1) break;
    const next = list[0];
    if ((ins.get(next) || []).length !== 1 || groupOf(next) !== group || seen.has(next)) break;
    seen.add(next);
    chain.push(next);
    cur = next;
  }
  return chain;
}

function walkChainLocal(nodeId) {
  if (!state.nodesById.has(nodeId)) return [];
  const { ins, outs } = chainIndex();
  return walkChainFrom(nodeId, ins, outs);
}

function graphChains() {
  const { ins, outs } = chainIndex();
  const seen = new Set();
  const list = [];
  for (const n of state.graph?.nodes || []) {
    const chain = walkChainFrom(n.id, ins, outs);
    if (chain.length < 2 || seen.has(chain[0])) continue;
    for (const id of chain) seen.add(id);
    list.push({ id: chainIdOf(chain[0]), headNodeId: chain[0], tailNodeId: chain[chain.length - 1], nodeIds: chain, count: chain.length });
  }
  return list;
}

function redrawChainFor(chainId) {
  const ch = chainById(chainId);
  if (!ch) return;
  const r = chainRect(ch);
  if (!r) return;
  state.chainRects.set(chainId, r);
  if (chainIsCollapsed(ch)) {
    const el = state.chainBoxEls ? state.chainBoxEls.get(chainId) : null;
    if (el && el.setAttribute) el.setAttribute("transform", `translate(${r.x},${r.y})`);
    return;
  }
  const box = chainFrameRect(ch);
  if (!box) return;
  const frame = state.chainFrameEls ? state.chainFrameEls.get(chainId) : null;
  if (frame && frame.setAttribute) {
    frame.setAttribute("x", box.x);
    frame.setAttribute("y", box.y);
    frame.setAttribute("width", box.w);
    frame.setAttribute("height", box.h);
  }
  const label = state.chainFrameLabelEls ? state.chainFrameLabelEls.get(chainId) : null;
  if (label && label.setAttribute) {
    label.setAttribute("x", box.x + 10);
    label.setAttribute("y", box.y - 6);
  }
}
