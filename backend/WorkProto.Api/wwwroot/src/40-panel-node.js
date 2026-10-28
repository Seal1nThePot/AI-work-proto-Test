// ────────── 40-panel-node.js ──────────「节点面板」
// 用途: 右栏节点面板：选中节点、渲染属性表单、存端口数、聚焦属性区、标题与类型下拉项
// 暴露: selectNode saveNodePorts focusProps nodeTitle nodeOptions
// 依赖: 01-state.js 02-dom.js 03-api.js(api)
// 被依赖: 20-render.js 与 app.js

function nodeTitle(id) {
  const n = (state.graph?.nodes || []).find((x) => x.id === id);
  return n ? n.title : id;
}

function nodeOptions(selected) {
  const nodes = (state.graph?.nodes || []).slice().sort((a, b) => a.seq - b.seq);
  if (!nodes.length) return `<option value="">（这个任务还没有节点）</option>`;
  return nodes
    .map((n) => `<option value="${esc(n.id)}"${n.id === selected ? " selected" : ""}>${esc(n.title)}（${esc(n.id)}）</option>`)
    .join("");
}

/** 选中节点后把右栏「标题」输入框聚焦（双击建节点之后就能直接改名）。 */

function focusProps() {
  const el = $("nTitle");
  if (el && el.focus) el.focus();
  return el;
}

// ---------------- 节点详情 ----------------

async function selectNode(nodeId) {
  state.selected = nodeId;
  state.selectedEdge = null;
  state.selectedGroup = null;
  state.selectedChain = null;
  const r = await api(`/api/nodes/${encodeURIComponent(nodeId)}`);
  if (!r.ok) {
    $("sideBody").innerHTML = `<div class="reject">读取节点失败：${esc(r.body?.error || r.status)}</div>`;
    return;
  }
  const d = r.body;
  const n = d.node;
  const color = STATUS_COLORS[n.status] || "#6b7280";
  const out = [];
  out.push(`<div class="node-head">
    <h2>${esc(n.title)}</h2>
    <div class="goal">${esc(n.goalLine || "（无一行目标）")}</div>
    <div style="margin-top:6px">
      <span class="chip" style="background:${color}">${esc(STATUS_TEXT[n.status] || n.status)}</span>
      <span class="muted">${esc(n.kind)} · 第 ${n.seq} 个 · attempt ${n.attempt} · epoch ${n.cycleEpoch}${n.cycleRegion ? " · 循环 " + esc(n.cycleRegion) : ""}</span>
    </div>
    ${n.blockedReason ? `<div class="muted">阻塞原因：<code>${esc(n.blockedReason)}</code> · 可解除：master 或 lead</div>` : ""}
  </div>`);

  out.push(`<div class="section"><h3>属性（点节点就能改）</h3>
    <div class="propsForm">
      <label>标题（必填，≤120 字）<input id="nTitle" maxlength="120" value="${esc(n.title)}" /></label>
      <label>一行目标<input id="nGoal" value="${esc(n.goalLine || "")}" /></label>
      <label>类型
        <select id="nKind">
          <option value="work">work · 干活</option>
          <option value="review_auto">review_auto · 程序/审核者按规则判</option>
          <option value="review_human">review_human · 人点头</option>
        </select>
      </label>
      <label>循环区 <input disabled value="${esc(n.cycleRegion ? "属于循环组「" + n.cycleRegion + "」" : "（不在循环区里）")}" /></label>
      <div class="muted">循环区不再挂在节点上：把节点圈进一个组，再给那个组声明循环。</div>
      <div class="portsRow"><button type="button" id="saveProps">保存属性</button>
        <span class="muted">换循环区要先断线，否则回边语义会乱</span></div>
      <div id="propsResult" class="formResult"></div>
    </div>
  </div>`);

  const gate = d.input;
  out.push(`<div class="section"><h3>输入条件（${MODE_TEXT[gate.mode] || gate.mode || "无规则组"}${gate.needCount ? " · 需要 " + gate.needCount : ""}）</h3>`);
  if (!gate.items.length) {
    out.push(`<div class="muted">没有入边，可以独立起步。</div>`);
  } else {
    out.push(`<ul>${gate.items.map((i) => `<li>${i.released ? "✅" : "⛔"} ${esc(i.fromTitle)} <span class="muted">（${esc(i.fromStatus)}${i.released ? "" : " · " + esc(i.reason)}）</span></li>`).join("")}</ul>`);
    if (!gate.satisfied) out.push(`<div class="muted">还没满足：缺 ${gate.missing.length} 条</div>`);
  }
  out.push(`</div>`);

  out.push(`<div class="section"><h3>最近三次检查点</h3>`);
  if (!d.checkpoints.length) {
    out.push(`<div class="muted">还没有检查点。</div>`);
  } else {
    for (const c of d.checkpoints) {
      out.push(`<div class="ckp">
        <div class="kv"><span>我在做什么：</span>${esc(c.doing)}</div>
        <div class="kv"><span>接下来：</span>${esc(c.nextStep)}</div>
        <div class="kv"><span>最终目标：</span>${esc(c.goal)}</div>
        <div class="kv"><span>判定：</span><span class="verdict ${esc(c.verdict)}">${c.verdict === "progress" ? "有进展" : "无进展"}</span>
          <span class="muted"> · 第 ${c.cycleVisit} 轮 · ${esc(fmt(c.startedAtUtc))} → ${esc(fmt(c.endedAtUtc))}</span></div>
      </div>`);
    }
  }
  out.push(`</div>`);

  out.push(`<div class="section"><h3>上次被拒原因</h3>`);
  out.push(d.lastRejection ? `<div class="reject">${esc(d.lastRejection)}</div>` : `<div class="muted">没有被拒绝过。</div>`);
  out.push(`</div>`);

  out.push(`<div class="section"><h3>接线口</h3>
    <div class="portsRow">进 <input id="pIn" type="number" min="1" max="12" value="${n.inPorts}" /> 出 <input id="pOut" type="number" min="1" max="12" value="${n.outPorts}" />
      <button type="button" id="savePorts">保存</button></div>
    <div class="muted">改小时不能少于已挂线的口。</div>
    <div id="portsResult" class="formResult"></div>
  </div>`);

  if (d.cycle) {
    out.push(`<div class="section"><h3>所属循环</h3>
      <ul>
        <li>区域 ${esc(d.cycle.regionKey)} · 上限 ${d.cycle.limit}${d.cycle.limitKind === "perpetual" ? "（不限）" : ""} · 已跑 ${d.cycle.visited} 轮</li>
        <li>状态：${d.cycle.pausedReason ? esc(d.cycle.pausedReason) : "运行中"}</li>
      </ul></div>`);
  }

  $("sideBody").innerHTML = out.join("");
  const kindSel = $("nKind");
  if (kindSel) kindSel.value = n.kind;
  const propsBtn = $("saveProps");
  if (propsBtn) propsBtn.onclick = () => saveNodeProps(n.id);
  const saveBtn = $("savePorts");
  if (saveBtn) saveBtn.onclick = () => saveNodePorts(n.id);
}

async function saveNodePorts(nodeId) {
  const inPorts = Number($("pIn")?.value || 1);
  const outPorts = Number($("pOut")?.value || 1);
  const r = await api(`/api/nodes/${encodeURIComponent(nodeId)}/ports`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ inPorts, outPorts })
  });
  if (r.ok) {
    showToast(`接线口已更新：进 ${r.body.inPorts} / 出 ${r.body.outPorts}`, true);
    await refresh();
    await selectNode(nodeId);
  } else {
    const box = $("portsResult");
    if (box) {
      box.className = "formResult err";
      box.innerHTML = `<b>${esc(r.body?.error || r.status)}</b>：${esc(r.body?.message || "")}`;
    }
    showToast(`${r.body?.error || r.status}：${r.body?.message || "改端口失败"}`, false);
  }
  return r;
}
