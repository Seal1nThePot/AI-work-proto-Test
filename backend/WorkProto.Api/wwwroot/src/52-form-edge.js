// ────────── 52-form-edge.js ──────────「连线表单」
// 用途: 建线表单：打开表单、按节点端口的数量填充下拉、提交建线
// 暴露: openEdgeForm fillPortSelect submitEdge
// 依赖: 01-state.js 02-dom.js 03-api.js 10-geo.js
// 被依赖: 20-render.js 41-panel-edge.js 与 app.js

function openEdgeForm(prefillFrom) {
  if (!state.taskId) { $("formHost").innerHTML = `<div class="form"><div class="formResult err">先新建或选一个任务</div></div>`; return; }
  const nodes = state.graph?.nodes || [];
  $("formHost").innerHTML = `
  <div class="form">
    <div class="formhead"><b>新建连线</b><button type="button" id="closeForm">关闭</button></div>
    <label>起点（材料从哪来）<select id="eFrom">${nodeOptions(prefillFrom || state.selected)}</select></label>
    <label>起点出线口<select id="eFromPort"></select></label>
    <label>终点（材料给谁）<select id="eTo">${nodeOptions(null)}</select></label>
    <label>终点进线口<select id="eToPort"></select></label>
    <label>类型
      <select id="eKind">
        <option value="transfer">transfer · 传递（接材料 / 等上游做完）</option>
        <option value="loop">loop · 回边（进下一轮）</option>
      </select>
    </label>
    <div class="muted">也可以直接在图上右键按住起点拖到终点，或从出线口拖出来。按住 Shift 是回边。</div>
    <div class="actions" style="margin-top:8px"><button type="button" class="primary" id="submitEdge">连线</button></div>
    <div id="formResult" class="formResult"></div>
  </div>`;
  $("closeForm").onclick = closeForm;
  $("submitEdge").onclick = submitEdge;
  fillPortSelect("eFromPort", $("eFrom").value, "out");
  fillPortSelect("eToPort", $("eTo").value, "in");
  $("eFrom").onchange = () => fillPortSelect("eFromPort", $("eFrom").value, "out");
  $("eTo").onchange = () => fillPortSelect("eToPort", $("eTo").value, "in");
  if (!nodes.length) showFormResult(false, "这个任务还没有节点，先建节点再连线");
}

function fillPortSelect(selectId, nodeId, side) {
  const box = $(selectId);
  if (!box) return;
  const p = state.positions.get(nodeId);
  const count = p ? (side === "in" ? p.inPorts || 1 : p.outPorts || 1) : 1;
  const items = [];
  for (let i = 0; i < count; i++) items.push(`<option value="${i}">第 ${i + 1} 个${count === 1 ? "（唯一）" : ""}</option>`);
  box.innerHTML = items.join("");
}

async function submitEdge() {
  const from = $("eFrom").value;
  const to = $("eTo").value;
  const kind = $("eKind").value;
  if (!from || !to) { showFormResult(false, "起点和终点都要选"); return; }
  const fromPort = Number($("eFromPort")?.value || 0);
  const toPort = Number($("eToPort")?.value || 0);
  $("submitEdge").disabled = true;
  const r = await connectNodes(from, to, kind, fromPort, toPort);
  $("submitEdge").disabled = false;
  if (r.ok) {
    await openEdgeForm(from);
    showFormResult(true, "已连线（规则组与起步情况见上方提示）");
  } else {
    const waiting = r.body?.details?.waitingOn || [];
    showFormResult(false, `<b>${esc(r.body?.error || r.status)}</b>：${esc(r.body?.message || "提交失败")}` +
      (waiting.length ? `<ul>${waiting.map((w) => `<li>${esc(w.edgeId || "-")} · ${esc(w.reason)}</li>`).join("")}</ul>` : ""));
  }
  return r;
}
