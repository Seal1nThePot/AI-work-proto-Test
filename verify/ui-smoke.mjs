// 页面逻辑冒烟：用极简 DOM 桩在 Node 里跑 app.js 的交互链路（不渲染、不比像素）。
// 覆盖：拖动落坐标 / 双击空白建节点 / 右键长按连线 / 新建任务 / 表单路径 / 各类拒绝。
// 由 verify\run-ui-smoke.ps1 起临时库服务后调用。
const BASE = process.env.PROTO_BASE || 'http://127.0.0.1:5083';
const APP = new URL('../backend/WorkProto.Api/wwwroot/app.js', import.meta.url);

class El {
  constructor(id) {
    this.id = id;
    this._html = '';
    this.value = '';
    this.className = '';
    this.textContent = '';
    this.disabled = false;
    this.children = [];
    this.attrs = {};
    this.style = {};
    this.rectCalls = 0;
  }
  set innerHTML(v) { this._html = String(v); }
  get innerHTML() { return this._html; }
  setAttribute(k, v) { this.attrs[k] = v; }
  getAttribute(k) { return this.attrs[k]; }
  addEventListener(ev, fn) { this['on' + ev] = fn; }
  querySelector() { return null; }
  querySelectorAll() { return []; }
  getBoundingClientRect() {
    this.rectCalls += 1;
    return { left: 0, top: 0, width: 800, height: 600 };
  }
  closest() { return null; }
  appendChild(c) { this.children.push(c); }
  remove() { }
  focus() { this.focused = true; }
}

const els = new Map();
const el = (id) => {
  if (!els.has(id)) els.set(id, new El(id));
  return els.get(id);
};

const realFetch = globalThis.fetch;
const fetchShim = (url, opts) => realFetch(url.startsWith('http') ? url : BASE + url, opts);

globalThis.document = {
  getElementById: el,
  createElement: (t) => new El(t),
  createElementNS: (ns, t) => new El(t),
  elementFromPoint: () => null,
  querySelectorAll: () => [],
  addEventListener: (ev, fn) => { globalThis.document["on" + ev] = fn; }
};
globalThis.window = globalThis;

const src = (await import('node:fs')).readFileSync(APP, 'utf8');
let frameRequests = 0;
const fakeSetTimeout = (cb) => { frameRequests += 1; return frameRequests; };
const load = new Function(
  'document', 'fetch', 'setInterval', 'clearTimeout', 'setTimeout',
  src + '\n;return { state, loadTasks, loadGraph, refresh, render, layout, portPoint, portCircles, edgePath, startConnect, svgPoint, worldToScreen, captureView, scheduleDragFrame, applyDragFrame, nearestPortIndex, saveNodePorts, saveLayout, saveNodePosition, nodesInRect, zoomAt, fitView, applyViewport, setSelection, toggleSelection, startDrag, moveNodeTo, startMarquee, updateMarquee, endMarquee, openTaskForm, submitTask, openNodeForm, submitNode, requestNodeAt, openEdgeForm, submitEdge, fillPortSelect, createTask, connectNodes, selectNode, closeForm, snapX, drawAlignGuide, onSvgPointerDown, onSvgPointerMove, onSvgPointerUp, quickAddNode, saveNodeProps, deleteNode, createNodeGroup, deleteNodeGroup, openContextMenu, closeContextMenu, openNodeMenu, openGroupMenu, groupBounds, groupTitle, focusProps, redrawGroupBox, redrawBoxesFor, collapseGroup, pillRect, groupMembers, hiddenNodeIds, collapsedGroupIds, snapAxis, setNodeCompact, selectEdge, renderEdgePanel, saveEdge, confirmEdgeGate, removeEdge, selectGroup, renderGroupPanel, deleteSelected, deleteNodes, isTypingTarget, openTemplatePanel, applyNodeTemplate, applyGroupTemplate, saveNodeTemplate, saveGroupTemplate, deleteNodeTemplate, deleteGroupTemplate, centerWorld, collapseChain, collapseChainOfNode, toggleChain, selectChain, renderChainPanel, toggleNodeCompact, toggleGroupCollapsed, walkChainLocal, graphChains, chainRect, chainMembers, chainTitleText, chainFrameRect, chainIsCollapsed, chainIdOf, openChainMenu };'
);
const app = load(globalThis.document, fetchShim, () => 0, () => {}, fakeSetTimeout);

const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok, detail });
  console.log(`[${ok ? 'PASS' : 'FAIL'}] ${name}${detail ? '  —  ' + detail : ''}`);
};

async function call(method, path, body) {
  const res = await fetchShim(path, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined
  });
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { }
  return { status: res.status, body: json };
}

const nodeOf = (title) => (app.state.graph?.nodes || []).find((n) => n.title === title);

// ---------- 准备：一个只有一个节点的任务 ----------
const created = await call('POST', '/api/tasks', {
  id: 't-ui', title: 'UI 冒烟任务', goalLine: '验四个编辑动作',
  nodes: [{ id: 'U-A', title: '上游 A', goalLine: '先做完', seq: 1 }],
  edges: [], groups: [], cycles: []
});
check('准备任务', created.status === 201, `status=${created.status}`);

app.state.taskId = 't-ui';
await app.refresh();
check('页面载入任务图', (app.state.graph?.nodes || []).length === 1, `nodes=${(app.state.graph?.nodes || []).length}`);

// 认领 / 完工必须发生在下游节点出现之前，否则它会在认领时被一起起步
await call('POST', '/api/tasks/t-ui/claim', { agent: 'ui' });
await call('POST', '/api/nodes/U-A/complete', { by: 'ui' });

// ---------- 1. 拖动落坐标 ----------
const moved = await app.saveNodePosition('U-A', 420, 336);
check('拖动后坐标落库', moved.ok && nodeOf('上游 A').posX === 420 && nodeOf('上游 A').posY === 336,
  `pos=(${nodeOf('上游 A').posX},${nodeOf('上游 A').posY})`);
const fresh = await call('GET', '/api/tasks/t-ui/graph');
const freshA = fresh.body.nodes.find((n) => n.id === 'U-A');
check('刷新后位置还在（不是前端假动）', freshA.posX === 420 && freshA.posY === 336, `pos=(${freshA.posX},${freshA.posY})`);

// ---------- 2. 工具栏表单按落点建节点（带落点坐标） ----------
const at = app.requestNodeAt(140, 480);
check('表单入口把落点交给表单', at.x === 140 - 107 && at.y === 480 - 44, `pending=(${at.x},${at.y})`);
el('fTitle').value = '下游 B';
el('fGoal').value = '接 A 的材料';
el('fKind').value = 'work';
el('fRegion').value = '';
await app.submitNode();
const b = nodeOf('下游 B');
check('双击位置建出新节点', !!b && b.seq === 2 && b.posX === at.x && b.posY === at.y,
  `seq=${b?.seq} pos=(${b?.posX},${b?.posY})`);
check('建节点后表单清空、位置不残留', el('fTitle').value === '' && app.state.pendingPos === null);

// ---------- 3. 右键长按连线（直接调用手势落点后的动作） ----------
const connected = await app.connectNodes('U-A', b.id, 'transfer');
check('右键连线建成', connected.ok && /已连线/.test(el('toast').innerHTML), el('toast').innerHTML.slice(0, 90));
check('新线自动建组并起步下游', connected.ok && connected.body.groupCreated === true && (connected.body.activated || []).includes(b.id),
  `activated=${(connected.body?.activated || []).join(',')}`);

const dup = await app.connectNodes('U-A', b.id, 'transfer');
check('重复连线回显原因码', !dup.ok && dup.body.error === 'edge-duplicate' && /edge-duplicate/.test(el('toast').innerHTML),
  el('toast').innerHTML.slice(0, 90));

const selfLoop = await app.connectNodes(b.id, b.id, 'transfer');
check('普通线自环被拒（loop-needs-cycle）', !selfLoop.ok && selfLoop.body.error === 'loop-needs-cycle',
  `error=${selfLoop.body?.error}`);

// ---------- 4. 新建任务 ----------
app.openTaskForm();
check('点「新建任务」出表单', el('formHost').innerHTML.includes('新建任务') && !!el('tTitle'));
el('tTitle').value = 'UI 任务二';
el('tGoal').value = '空图起手';
await app.submitTask();
const newId = app.state.taskId;
check('建任务后切到新任务', newId && newId !== 't-ui' && app.state.tasks.some((t) => t.id === newId), `taskId=${newId}`);
check('新任务是空图（0 节点）', (app.state.graph?.nodes || []).length === 0, `nodes=${(app.state.graph?.nodes || []).length}`);
check('建任务后表单清空并给下一步提示', el('tTitle').value === '' && /双击空白/.test(el('formResult').innerHTML));

// ---------- 5. 表单路径与前端拦截 ----------
app.state.taskId = 't-ui';
await app.refresh();
app.openNodeForm();
el('fTitle').value = '   ';
await app.submitNode();
check('空标题在前端就被拦下', el('formResult').className.includes('err') && /标题必填/.test(el('formResult').innerHTML));

app.requestNodeAt(560, 480);
el('fTitle').value = '下游 C';
el('fGoal').value = '';
el('fKind').value = 'review_human';
el('fRegion').value = '';
await app.submitNode();
const c = nodeOf('下游 C');
check('表单建人工审核节点', !!c && c.kind === 'review_human', `kind=${c?.kind}`);

app.openEdgeForm();
el('eFrom').value = b.id;
el('eTo').value = c.id;
el('eKind').value = 'transfer';
await app.submitEdge();
check('表单连线也走同一条规则', el('formResult').className.includes('ok'), el('formResult').innerHTML.slice(0, 80));

// ---------- 6. 节点详情仍能读 ----------
await app.selectNode(b.id);
check('点节点仍能读到输入条件与检查点区', el('sideBody').innerHTML.includes('输入条件') && el('sideBody').innerHTML.includes('最近三次检查点'),
  el('sideBody').innerHTML.length + ' chars');

// ---------- 7. 接线区（端口）与连线实时跟随 ----------
app.render();
const svgHtml = el('graph').innerHTML;
check('节点上画出了进出线口', svgHtml.includes('data-port="in"') && svgHtml.includes('data-port="out"'),
  `ports=${(svgHtml.match(/data-port="/g) || []).length}`);
check('每条连线可被单独重绘（带 data-edge）', /data-edge="/.test(svgHtml),
  `edges=${(svgHtml.match(/data-edge="/g) || []).length}`);

const probe = { x: 100, y: 200, w: 214, h: 88 };
const outPt = app.portPoint('out', probe);
const inPt = app.portPoint('in', probe);
const botPt = app.portPoint('bottom', probe);
check('出线口在右缘中点', outPt.x === 314 && outPt.y === 244, JSON.stringify(outPt));
check('进线口在左缘中点', inPt.x === 100 && inPt.y === 244, JSON.stringify(inPt));
check('底部端口留给回边', botPt.x === 207 && botPt.y === 288, JSON.stringify(botPt));

const d1 = app.edgePath({ x: 0, y: 0, w: 214, h: 88 }, { x: 400, y: 300, w: 214, h: 88 }, { kind: 'transfer' });
const d2 = app.edgePath({ x: 0, y: 120, w: 214, h: 88 }, { x: 400, y: 300, w: 214, h: 88 }, { kind: 'transfer' });
check('连线端点跟着节点坐标算（拖动即可实时重算）', d1 !== d2, `${d1.slice(0, 24)}… vs ${d2.slice(0, 24)}…`);

const bPos = app.state.positions.get(b.id);
app.startConnect(b.id, { shiftKey: false, preventDefault() { } });
check('从出线口起手，临时线锚在右缘',
  app.state.connect?.from === b.id && app.state.connect.origin.x === bPos.x + 214 && app.state.connect.origin.y === bPos.y + 44,
  JSON.stringify(app.state.connect?.origin));
app.startConnect(b.id, { shiftKey: true, preventDefault() { } });
check('Shift 连线锚在底部（回边）', app.state.connect.kind === 'loop' && app.state.connect.origin.y === bPos.y + 88,
  JSON.stringify(app.state.connect?.origin));
app.state.connect = null;

// ---------- 8. 拖动流畅度：视口只量一次 + 高频事件合并成一帧 ----------
const svgEl = el('graph');
svgEl.rectCalls = 0;
app.state.view = null;
app.captureView();
for (let i = 0; i < 60; i++) app.svgPoint({ clientX: 100 + i, clientY: 200 + i });
check('拖动中坐标换算只量一次视口（不再每帧 getBoundingClientRect）', svgEl.rectCalls === 1, `rectCalls=${svgEl.rectCalls}`);

app.state.frame = null;
const before = frameRequests;
app.state.drag = { id: b.id, nodeEl: null, offsetX: 0, offsetY: 0, moved: false, x: 0, y: 0, pending: { x: 500, y: 400 } };
app.scheduleDragFrame();
app.scheduleDragFrame();
app.scheduleDragFrame();
check('高频 pointermove 合并成一帧只排一次', frameRequests - before === 1, `frames=${frameRequests - before}`);

app.applyDragFrame();
const movedPos = app.state.positions.get(b.id);
check('合并帧后节点坐标确实更新', movedPos.x === 500 && movedPos.y === 400, `pos=(${movedPos.x},${movedPos.y})`);
const bEdgeCount = app.state.graph.edges.filter((e) => e.fromNodeId === b.id || e.toNodeId === b.id).length;
check('邻接索引只收相连的线（重绘范围就是这些，不是整图）',
  app.state.incident.get(b.id)?.size === bEdgeCount, `incident=${app.state.incident.get(b.id)?.size} 图中总边=${app.state.graph.edges.length}`);
app.state.drag = null;
app.state.frame = null;

// ---------- 9. 自定义端口数量 ----------
const p3 = { x: 0, y: 0, w: 214, h: 88 };
check('三口的进线口在 1/4、1/2、3/4 处',
  app.portPoint('in', p3, 0, 3).y === 22 && app.portPoint('in', p3, 1, 3).y === 44 && app.portPoint('in', p3, 2, 3).y === 66,
  [0, 1, 2].map((i) => app.portPoint('in', p3, i, 3).y).join(','));
const circles = app.portCircles('in', { ...p3, inPorts: 3 }, '#000');
check('三个进线口都画出来且带序号（每个口一个圆，自己吃事件）',
  (circles.match(/data-port="in"/g) || []).length === 3 && /data-index="2"/.test(circles) && /pointer-events="all"/.test(circles),
  `circles=${(circles.match(/data-port="in"/g) || []).length}`);

const withPorts = await call('POST', '/api/tasks/t-ui/nodes', { title: '多口节点', inPorts: 3, outPorts: 2, x: 720, y: 660 });
const mp = withPorts.body?.node;
check('按指定口数建节点（3 进 2 出）', withPorts.status === 201 && mp?.inPorts === 3 && mp?.outPorts === 2,
  `in=${mp?.inPorts} out=${mp?.outPorts}`);
await app.refresh();
check('图接口回带口数，前端拿得到', app.state.positions.get(mp.id)?.inPorts === 3 && app.state.positions.get(mp.id)?.outPorts === 2,
  JSON.stringify({ in: app.state.positions.get(mp.id)?.inPorts, out: app.state.positions.get(mp.id)?.outPorts }));
check('还没连线的节点不进邻接索引', !app.state.incident.get(mp.id), `incident=${app.state.incident.get(mp.id)}`);

const mpEdge = await app.connectNodes(b.id, mp.id, 'transfer', 0, 2);
check('连线可以指定挂在第几个口', mpEdge.ok && mpEdge.body.edge.fromPort === 0 && mpEdge.body.edge.toPort === 2,
  `from=${mpEdge.body?.edge?.fromPort} to=${mpEdge.body?.edge?.toPort}`);

const badPort = await app.connectNodes(b.id, mp.id, 'transfer', 9, 0);
check('口号越界被拒（port-out-of-range）', !badPort.ok && badPort.body.error === 'port-out-of-range', badPort.body?.error);

app.openNodeForm();
el('fTitle').value = '带口的节点';
el('fGoal').value = '';
el('fKind').value = 'work';
el('fRegion').value = '';
el('fInPorts').value = '4';
el('fOutPorts').value = '2';
await app.submitNode();
const withPorts2 = nodeOf('带口的节点');
check('表单也能建多口节点', withPorts2?.inPorts === 4 && withPorts2?.outPorts === 2,
  `in=${withPorts2?.inPorts} out=${withPorts2?.outPorts}`);

// ---------- 10. 滚轮缩放（锚点在光标下） ----------
app.state.viewport = { scale: 1, tx: 0, ty: 0 };
app.state.view = null;
app.captureView();
const zoomIn = app.zoomAt(400, 300, -240);
const anchorScreen = app.worldToScreen(zoomIn.anchor);
check('缩放时锚点不动（同一世界坐标仍落在光标处）',
  Math.abs(anchorScreen.x - 400) < 0.01 && Math.abs(anchorScreen.y - 300) < 0.01,
  `scale=${zoomIn.scale.toFixed(2)} screen=(${anchorScreen.x.toFixed(1)},${anchorScreen.y.toFixed(1)})`);
check('滚轮向上放大且在限内', zoomIn.scale > 1 && zoomIn.scale <= 2.5, `scale=${zoomIn.scale.toFixed(2)}`);
const zoomOut = app.zoomAt(400, 300, 8000);
check('滚轮向下缩小有下限（大图要能缩到 0.2）', zoomOut.scale >= 0.2 && zoomOut.scale <= 1, `scale=${zoomOut.scale.toFixed(2)}`);
app.state.viewport = { scale: 2, tx: 10, ty: 20 };
app.state.view = null;
app.captureView();
const wp = app.svgPoint({ clientX: 210, clientY: 220 });
check('缩放平移后屏幕坐标正确换算到世界坐标', Math.round(wp.x) === 100 && Math.round(wp.y) === 100, JSON.stringify(wp));

// ---------- 11. 框选 + 多选一起拖 ----------
app.state.viewport = { scale: 1, tx: 0, ty: 0 };
app.state.view = null;
await app.refresh();
const two = app.state.graph.nodes.slice(0, 2).map((n) => n.id);
const pA = app.state.positions.get(two[0]);
const pB = app.state.positions.get(two[1]);
const box = {
  x: Math.min(pA.x, pB.x) - 6,
  y: Math.min(pA.y, pB.y) - 6,
  w: Math.max(pA.x + pA.w, pB.x + pB.w) - Math.min(pA.x, pB.x) + 12,
  h: Math.max(pA.y + pA.h, pB.y + pB.h) - Math.min(pA.y, pB.y) + 12
};
const hits = app.nodesInRect(box);
check('框选命中框内的节点', two.every((id) => hits.includes(id)) && hits.length >= 2, `hits=${hits.length}`);

app.setSelection(two);
const beforeA = { ...app.state.positions.get(two[0]) };
const beforeB = { ...app.state.positions.get(two[1]) };
app.startDrag(two[0], { clientX: beforeA.x + 8, clientY: beforeA.y + 8, preventDefault() { } });
app.state.drag.pending = { x: beforeA.x + 108, y: beforeA.y + 58 };
app.applyDragFrame();
const afterA = app.state.positions.get(two[0]);
const afterB = app.state.positions.get(two[1]);
check('两个选中的节点一起走同样的位移',
  Math.round(afterA.x - beforeA.x) === 100 && Math.round(afterB.x - beforeB.x) === 100 &&
  Math.round(afterA.y - beforeA.y) === 50 && Math.round(afterB.y - beforeB.y) === 50,
  `A=(${Math.round(afterA.x - beforeA.x)},${Math.round(afterA.y - beforeA.y)}) B=(${Math.round(afterB.x - beforeB.x)},${Math.round(afterB.y - beforeB.y)})`);
const saved = await app.saveLayout(two);
check('一起拖的坐标一次批量落库', saved.ok && saved.body.moved === two.length, `moved=${saved.body?.moved}`);
const afterSave = await call('GET', '/api/tasks/t-ui/graph');
const savedA = afterSave.body.nodes.find((n) => n.id === two[0]);
check('刷新后批量坐标还在', savedA.posX === Math.round(afterA.x) && savedA.posY === Math.round(afterA.y),
  `pos=(${savedA.posX},${savedA.posY})`);

// 框选式选择（起手 → 拖动 → 收手）
app.state.marquee = null;
app.startMarquee({ clientX: box.x, clientY: box.y, preventDefault() { } });
app.updateMarquee({ clientX: box.x + box.w, clientY: box.y + box.h });
check('框选过程中记录起止点', app.state.marquee?.moved === true, `moved=${app.state.marquee?.moved}`);
app.endMarquee();
check('收手后选区包含框内节点', two.every((id) => app.state.selectedIds.has(id)), `selected=${app.state.selectedIds.size}`);
app.setSelection([]);

// ---------- 12. 跟手性：位置同步生效，连线才等帧 ----------
const framesBefore = frameRequests;
const syncId = app.state.graph.nodes[0].id;
app.state.frame = null;
app.state.drag = { id: syncId, nodeEl: null, offsetX: 0, offsetY: 0, moved: false, x: 0, y: 0, pending: { x: 260, y: 180 } };
app.applyDragFrame();
check('拖动位置同步生效，不等下一帧',
  app.state.positions.get(syncId).x === 260 && app.state.positions.get(syncId).y === 180 && frameRequests === framesBefore,
  `pos=(${app.state.positions.get(syncId).x},${app.state.positions.get(syncId).y}) 新排帧=${frameRequests - framesBefore}`);
app.state.drag = null;
app.state.frame = null;

// ---------- 13. 画布没有边缘（负坐标照收 + 底纹跟着视口走） ----------
app.state.viewport = { scale: 1, tx: 0, ty: 0 };
app.state.view = null;
await app.refresh();
const negId = app.state.graph.nodes[0].id;
const negSaved = await app.saveNodePosition(negId, -320, -240);
check('拖到负坐标也照存（不再夹到 0）', negSaved.ok && negSaved.body.posX === -320 && negSaved.body.posY === -240,
  `pos=(${negSaved.body?.posX},${negSaved.body?.posY})`);
const negFresh = (await call('GET', '/api/tasks/t-ui/graph')).body.nodes.find((n) => n.id === negId);
check('负坐标刷新后还在（不是前端假动）', negFresh.posX === -320 && negFresh.posY === -240, `pos=(${negFresh.posX},${negFresh.posY})`);

app.state.frame = null;
app.state.drag = { id: negId, nodeEl: null, offsetX: 0, offsetY: 0, moved: false, x: 0, y: 0, pending: { x: -180, y: -120 } };
app.applyDragFrame();
const negDrag = app.state.positions.get(negId);
check('拖动帧允许负坐标（跟手不被夹）', negDrag.x === -180 && negDrag.y === -120, `pos=(${negDrag.x},${negDrag.y})`);
app.state.drag = null;
app.state.frame = null;

const negAt = app.requestNodeAt(-40, -30);
check('双击负坐标处建节点，落点不被夹到 0', negAt.x === -40 - 107 && negAt.y === -30 - 44, `pending=(${negAt.x},${negAt.y})`);
app.state.pendingPos = null;
app.closeForm();

app.state.viewport = { scale: 1, tx: 0, ty: 0 };
app.applyViewport();
const gridHome = el('graph').style.backgroundPosition;
app.state.viewport = { scale: 1, tx: -180, ty: -90 };
app.applyViewport();
check('底纹跟着平移走（画布没边，格子不钉在屏幕上）',
  gridHome === '0px 0px' && el('graph').style.backgroundPosition === '-180px -90px',
  `${gridHome} → ${el('graph').style.backgroundPosition}`);
app.state.viewport = { scale: 1, tx: -50000, ty: -40000 };
app.applyViewport();
check('平移出去很远也不夹（没有边缘）', el('graph').style.backgroundPosition === '-50000px -40000px',
  el('graph').style.backgroundPosition);
app.state.viewport = { scale: 2, tx: 0, ty: 0 };
app.applyViewport();
check('底纹随缩放放大（2× → 一格 48px）', el('graph').style.backgroundSize === '48px 48px', el('graph').style.backgroundSize);
app.state.viewport = { scale: 0.3, tx: 0, ty: 0 };
app.applyViewport();
check('缩到 30% 时格子自动放大（24→96，一格 28.8px，不糊成一片）',
  el('graph').style.backgroundSize === '28.8px 28.8px', el('graph').style.backgroundSize);
app.state.viewport = { scale: 1, tx: 0, ty: 0 };
app.applyViewport();

// ---------- 14. 拖动不回弹（真值同步 + 拖完不整图重绘） ----------
app.state.viewport = { scale: 1, tx: 0, ty: 0 };
app.state.view = null;
await app.refresh();
const rbId = app.state.graph.nodes[0].id;
const rbStart = { ...app.state.positions.get(rbId) };
app.state.selectedIds = new Set([rbId]);
app.startDrag(rbId, { clientX: rbStart.x + 10, clientY: rbStart.y + 10, shiftKey: false, preventDefault() { } });
app.onSvgPointerMove({ clientX: rbStart.x + 210, clientY: rbStart.y + 110, shiftKey: false });
const rbDrag = { ...app.state.positions.get(rbId) };
const rbNode = app.state.nodesById.get(rbId);
check('拖动后图里的坐标同步改了（重绘不会按旧坐标摆回去）',
  Math.round(rbNode.posX) === Math.round(rbDrag.x) && Math.round(rbNode.posY) === Math.round(rbDrag.y),
  `positions=(${Math.round(rbDrag.x)},${Math.round(rbDrag.y)}) graph=(${rbNode.posX},${rbNode.posY})`);
app.render();
const rbAfterRender = app.state.positions.get(rbId);
check('★拖动中立刻整图重绘也停在拖到的位置（回弹回归）',
  Math.round(rbAfterRender.x) === Math.round(rbDrag.x) && Math.round(rbAfterRender.y) === Math.round(rbDrag.y),
  `重绘后=(${Math.round(rbAfterRender.x)},${Math.round(rbAfterRender.y)}) 拖到=(${Math.round(rbDrag.x)},${Math.round(rbDrag.y)})`);

await app.onSvgPointerUp({ clientX: rbStart.x + 210, clientY: rbStart.y + 110, preventDefault() { } });
check('拖完落库并压掉紧随其后的 click 重绘', app.state.suppressClick === true,
  `suppressClick=${app.state.suppressClick}`);
const rbSaved = (await call('GET', '/api/tasks/t-ui/graph')).body.nodes.find((n) => n.id === rbId);
check('松手后库里的位置就是拖到的地方', rbSaved.posX === Math.round(rbDrag.x) && rbSaved.posY === Math.round(rbDrag.y),
  `pos=(${rbSaved.posX},${rbSaved.posY})`);

const rbBeforeClick = { ...app.state.positions.get(rbId) };
el('graph').onclick({ target: { closest: () => ({ getAttribute: () => rbId }) }, shiftKey: false });
const rbAfterClick = app.state.positions.get(rbId);
check('拖完那颗 click 不再把节点摆回原位',
  rbAfterClick.x === rbBeforeClick.x && rbAfterClick.y === rbBeforeClick.y && app.state.suppressClick === false,
  `click前=(${Math.round(rbBeforeClick.x)},${Math.round(rbBeforeClick.y)}) click后=(${Math.round(rbAfterClick.x)},${Math.round(rbAfterClick.y)})`);

// ---------- 15. Shift 拖动＝左/右吸附对齐 ----------
await app.refresh();
const n15 = app.state.graph.nodes;
const refP = app.state.positions.get(n15[0].id);
const dragId2 = n15[1].id;

const runAlign = (pendingX, pendingY) => {
  app.state.drag = {
    id: dragId2, ids: [dragId2], startPositions: new Map([[dragId2, { x: 0, y: 0 }]]),
    startPrimary: { x: 0, y: 0 }, cycleIds: [], offsetX: 0, offsetY: 0,
    moved: false, pending: { x: pendingX, y: pendingY }, align: true
  };
  app.applyDragFrame();
  return app.state.positions.get(dragId2);
};

let snapped = runAlign(refP.x + 5, refP.y + 220);
check('Shift 拖动时左缘吸到参照节点的左缘（差 5px → 吸上）',
  Math.round(snapped.x) === Math.round(refP.x),
  `拖到 x=${refP.x + 5} 吸成 x=${Math.round(snapped.x)} 参照 x=${Math.round(refP.x)}`);
check('吸附时给出参考线与对齐说明',
  (app.state.aligns || []).some((g) => g.axis === "x" && Math.round(g.at) === Math.round(refP.x) && /对齐|贴到/.test(g.tip)),
  JSON.stringify((app.state.aligns || []).map((g) => `${g.axis}:${Math.round(g.at)}:${g.tip}`)));

snapped = runAlign(refP.x + 40, refP.y + 220);
check('离得远就不吸（阈值 12px）',
  Math.round(snapped.x) === Math.round(refP.x + 40) && !(app.state.aligns || []).some((g) => g.axis === "x"),
  `x=${Math.round(snapped.x)} aligns=${(app.state.aligns || []).length}`);

snapped = runAlign(refP.x - 214 + 4, refP.y + 220);
check('贴到邻居左侧也吸（右缘贴它左缘）',
  Math.round(snapped.x) === Math.round(refP.x - 214) && (app.state.aligns || []).some((g) => /贴到左侧/.test(g.tip)),
  `x=${Math.round(snapped.x)} tips=${(app.state.aligns || []).map((g) => g.tip).join(",")}`);

snapped = runAlign(refP.x + 214 - 4, refP.y + 220);
check('贴到邻居右侧也吸（左缘贴它右缘）',
  Math.round(snapped.x) === Math.round(refP.x + 214) && (app.state.aligns || []).some((g) => /贴到右侧/.test(g.tip)),
  `x=${Math.round(snapped.x)} tips=${(app.state.aligns || []).map((g) => g.tip).join(",")}`);

// 前后（上下）方向：同一套四种候选
snapped = runAlign(refP.x + 600, refP.y + 5);
check('前后也能吸：上缘对齐（差 5px → 吸上）',
  Math.round(snapped.y) === Math.round(refP.y) && (app.state.aligns || []).some((g) => g.axis === "y" && /上对齐/.test(g.tip)),
  `y=${Math.round(snapped.y)} 参照 y=${Math.round(refP.y)} tips=${(app.state.aligns || []).map((g) => g.tip).join(",")}`);

snapped = runAlign(refP.x + 600, refP.y + 40);
check('前后方向也守阈值（差 40px 不吸）',
  Math.round(snapped.y) === Math.round(refP.y + 40) && !(app.state.aligns || []).some((g) => g.axis === "y"),
  `y=${Math.round(snapped.y)} aligns=${(app.state.aligns || []).length}`);

snapped = runAlign(refP.x + 600, refP.y + 88 + 6);
check('贴到下方也吸（上缘贴它下缘）',
  Math.round(snapped.y) === Math.round(refP.y + 88) && (app.state.aligns || []).some((g) => /贴到下方/.test(g.tip)),
  `y=${Math.round(snapped.y)} tips=${(app.state.aligns || []).map((g) => g.tip).join(",")}`);

snapped = runAlign(refP.x + 600, refP.y - 88 - 6);
check('贴到上方也吸（下缘贴它上缘）',
  Math.round(snapped.y) === Math.round(refP.y - 88) && (app.state.aligns || []).some((g) => /贴到上方/.test(g.tip)),
  `y=${Math.round(snapped.y)} tips=${(app.state.aligns || []).map((g) => g.tip).join(",")}`);

// 两轴同时吸：既成一列又成一行
snapped = runAlign(refP.x + 4, refP.y + 5);
const axes = (app.state.aligns || []).map((g) => g.axis).sort().join(",");
check('左右与前后能同时吸（画两条参考线）',
  Math.round(snapped.x) === Math.round(refP.x) && Math.round(snapped.y) === Math.round(refP.y) && axes === "x,y",
  `pos=(${Math.round(snapped.x)},${Math.round(snapped.y)}) axes=${axes}`);

app.state.drag = null;
app.state.align = null;

// 组拖 + Shift：对齐主节点，其余同位移
const twoIds = [n15[0].id, n15[1].id];
app.setSelection(twoIds);
const gA = { ...app.state.positions.get(twoIds[0]) };
const gB = { ...app.state.positions.get(twoIds[1]) };
const refThird = app.state.positions.get(n15[2].id);
app.startDrag(twoIds[0], { clientX: gA.x + 5, clientY: gA.y + 5, shiftKey: false, preventDefault() { } });
app.state.drag.align = true;
app.state.drag.pending = { x: refThird.x + 3, y: gA.y + 160 };
app.applyDragFrame();
const gA2 = app.state.positions.get(twoIds[0]);
const gB2 = app.state.positions.get(twoIds[1]);
check('整组按住 Shift 也对齐（对齐主节点，其余同位移）',
  Math.round(gA2.x) === Math.round(refThird.x) &&
  Math.round(gB2.x - gB.x) === Math.round(gA2.x - gA.x) &&
  Math.round(gB2.y - gB.y) === Math.round(gA2.y - gA.y),
  `主=${Math.round(gA2.x)} 参照=${Math.round(refThird.x)} ΔA=${Math.round(gA2.x - gA.x)} ΔB=${Math.round(gB2.x - gB.x)}`);
app.state.drag = null;
app.state.align = null;

// Shift 点一下（没拖）＝加/减选，不抢选区
app.setSelection([n15[0].id]);
app.startDrag(dragId2, { clientX: 300, clientY: 300, shiftKey: true, preventDefault() { } });
check('Shift 按下不抢选区（没拖之前什么都没变）',
  app.state.selectedIds.has(n15[0].id) && !app.state.selectedIds.has(dragId2),
  `selected=${[...app.state.selectedIds].join(",")}`);
await app.onSvgPointerUp({ clientX: 300, clientY: 300, preventDefault() { } });
check('Shift 点一下＝把它加进选区（老行为保住了）',
  app.state.selectedIds.has(dragId2) && app.state.selectedIds.has(n15[0].id) && app.state.drag === null,
  `selected=${[...app.state.selectedIds].join(",")}`);
app.setSelection([]);

// ---------- 16. 双击直接建节点 / 点节点改属性 ----------
await app.refresh();
const beforeCount = app.state.graph.nodes.length;
const quickRes = await app.quickAddNode(900, 620);
const quickTitle = `新节点 ${beforeCount + 1}`;
const quickNode = nodeOf(quickTitle);
check('双击空白直接建出默认节点（不发表单）',
  quickRes.ok && !!quickNode, `title=${quickNode?.title} status=${quickRes.status}`);
check('默认节点落在双击处（中心对齐）且右栏名字框已聚焦',
  quickNode?.posX === 900 - 107 && quickNode?.posY === 620 - 44 && el('nTitle').focused === true,
  `pos=(${quickNode?.posX},${quickNode?.posY}) focused=${el('nTitle').focused}`);

el('nTitle').value = '改名后的节点';
el('nGoal').value = '收三份材料';
el('nKind').value = 'review_human';
const savedProps = await app.saveNodeProps(quickNode.id);
check('点节点改属性：标题/目标/类型都落库',
  savedProps.ok && savedProps.body.node.title === '改名后的节点' &&
  savedProps.body.node.goalLine === '收三份材料' && savedProps.body.node.kind === 'review_human',
  `changed=${(savedProps.body?.changed || []).length} title=${savedProps.body?.node?.title}`);
const freshQuick = (await call('GET', '/api/tasks/t-ui/graph')).body.nodes.find((n) => n.id === quickNode.id);
check('改完刷新图还是新名字新类型',
  freshQuick.title === '改名后的节点' && freshQuick.kind === 'review_human' && freshQuick.goalLine === '收三份材料',
  `${freshQuick.title}/${freshQuick.kind}`);

el('nTitle').value = '   ';
const badProps = await app.saveNodeProps(freshQuick.id);
check('标题改成空被后端拦下（title-required）',
  !badProps.ok && badProps.body.error === 'title-required' && el('propsResult').className.includes('err'),
  `error=${badProps.body?.error}`);

// ---------- 17. 右键：点一下出菜单，拖出去才是连线 ----------
await app.refresh();
const menuNode = app.state.graph.nodes[0].id;
app.startConnect(menuNode, { button: 2, clientX: 10, clientY: 10, preventDefault() { } });
check('右键按下先不算连线（等拖出去）', app.state.connect?.moved === false, `moved=${app.state.connect?.moved}`);
await app.onSvgPointerUp({ clientX: 11, clientY: 11 });
check('右键点一下＝弹节点菜单', app.state.ctxItems.length >= 3 &&
  app.state.ctxItems.some((i) => /删除节点/.test(i.label)) && app.state.connect === null,
  `items=${app.state.ctxItems.map((i) => i.label).join(" | ")}`);
const groupItem = app.state.ctxItems.find((i) => /建立节点组/.test(i.label));
check('单选时「建立节点组」是灰的（先多选）', !!groupItem && groupItem.disabled === true, `disabled=${groupItem?.disabled}`);
app.closeContextMenu();
check('菜单能关掉', app.state.ctxItems.length === 0);

app.startConnect(menuNode, { button: 2, clientX: 10, clientY: 10, preventDefault() { } });
app.onSvgPointerMove({ clientX: 80, clientY: 80 });
check('拖出去才算连线（画临时线）', app.state.connect?.moved === true, `moved=${app.state.connect?.moved}`);
await app.onSvgPointerUp({ clientX: 80, clientY: 80 });
check('拖着连线松手不会弹菜单', app.state.ctxItems.length === 0, `items=${app.state.ctxItems.length}`);

// ---------- 18. 多选 + 建组 + 删组 ----------
await app.refresh();
const grpIds = [app.state.graph.nodes[0].id, app.state.graph.nodes[1].id];
app.setSelection(grpIds);
app.openNodeMenu(grpIds[0], { clientX: 40, clientY: 40 });
const groupItem2 = app.state.ctxItems.find((i) => /建立节点组/.test(i.label));
check('多选之后「建立节点组」可点，且带数量', !!groupItem2 && !groupItem2.disabled && /2 个/.test(groupItem2.label),
  groupItem2?.label);

const madeGroup = await app.createNodeGroup(grpIds, '前半段');
const gid = madeGroup.body?.id;
check('建组成功（2 个节点）', madeGroup.ok && madeGroup.body.nodeIds.length === 2, `id=${gid}`);
const gAfter = (await call('GET', '/api/tasks/t-ui/graph')).body;
check('图接口回带节点组，两个节点都带 groupId',
  (gAfter.nodeGroups || []).length === 1 && gAfter.nodeGroups[0].nodeIds.length === 2 &&
  gAfter.nodes.filter((n) => n.groupId === gid).length === 2,
  `groups=${(gAfter.nodeGroups || []).length}`);

await app.refresh();
const boxHtml = el('graph').innerHTML;
check('画布上画出了组框与组标签', /data-nodegroup="/.test(boxHtml) && /组 · 前半段/.test(boxHtml),
  `len=${boxHtml.length}`);
const gb1 = app.groupBounds(gid);
const movableId = grpIds[0];
app.setSelection(grpIds);
const mv0 = app.state.positions.get(movableId);
app.startDrag(movableId, { clientX: mv0.x + 10, clientY: mv0.y + 10, shiftKey: false, preventDefault() { } });
app.state.drag.pending = { x: mv0.x + 70, y: mv0.y + 10 };
app.applyDragFrame();
const gb2 = app.groupBounds(gid);
check('拖组内节点时组框跟着动（不是钉死的）', Math.round(gb2.x1 - gb1.x1) === 60,
  `Δx1=${Math.round(gb2.x1 - gb1.x1)}`);
app.state.drag = null;

app.openGroupMenu(gid, { clientX: 60, clientY: 60 });
check('点组＝组菜单（收纳 / 选中 / 存预设 / 两种删除都在）',
  app.state.ctxItems.length === 5 &&
  app.state.ctxItems.some((i) => /收纳这个组/.test(i.label)) &&
  app.state.ctxItems.some((i) => /存成组预设/.test(i.label)) &&
  app.state.ctxItems.some((i) => /删除分组「/.test(i.label)) &&
  app.state.ctxItems.some((i) => /删除分组与组内/.test(i.label)),
  app.state.ctxItems.map((i) => i.label).join(" | "));
const dissolved = await app.deleteNodeGroup(gid, false);
check('删组只解散（节点都留着）', dissolved.ok && dissolved.body.released === 2, `released=${dissolved.body?.released}`);
const gGone = (await call('GET', '/api/tasks/t-ui/graph')).body;
check('解散后组没了、节点还在、group_id 清空',
  (gGone.nodeGroups || []).length === 0 && gGone.nodes.filter((n) => n.groupId).length === 0 &&
  !!gGone.nodes.find((n) => n.id === grpIds[0]),
  `groups=${(gGone.nodeGroups || []).length} nodes=${gGone.nodes.length}`);

// ---------- 19. 右键删节点（守卫在后端） ----------
await app.refresh();
const pairA = await app.quickAddNode(1400, 700, '要连线的上游');
const pairB = await app.quickAddNode(1400, 900, '接了线的下游');
await app.connectNodes(pairA.body.node.id, pairB.body.node.id, 'transfer');
await app.refresh();
const denied = await app.deleteNode(pairA.body.node.id);
check('挂着线的节点删不掉（node-has-edges）', !denied.ok && denied.body.error === 'node-has-edges',
  `error=${denied.body?.error}`);
const denied2 = await app.deleteNode(pairB.body.node.id);
// 下游既挂线又已起步：两条守卫随便哪条先拦住都算对（原型没有删边接口，node-not-pending 事实上到不了）
check('已起步的下游同样删不掉', !denied2.ok && ["node-has-edges", "node-not-pending"].includes(denied2.body.error),
  `error=${denied2.body?.error}`);
const freshOne = await app.quickAddNode(1200, 900, '临时节点');
const removed = await app.deleteNode(freshOne.body.node.id);
check('刚建的空节点能删掉（200）', removed.ok, `status=${removed.status}`);
const afterDel = (await call('GET', '/api/tasks/t-ui/graph')).body;
check('删完图里确实少了它', !afterDel.nodes.some((n) => n.id === freshOne.body.node.id), `nodes=${afterDel.nodes.length}`);

// ---------- 20. 收纳查看 + 删组连节点 ----------
await app.refresh();
const boxIds = app.state.graph.nodes.slice(0, 2).map((n) => n.id);
const boxGroup = await app.createNodeGroup(boxIds, '收纳测试组');
const bgid = boxGroup.body.id;
await app.refresh();
const outer = app.state.graph.nodes.find((n) => !boxIds.includes(n.id));
await app.connectNodes(boxIds[0], outer.id, 'transfer');
await app.refresh();

const collapsedRes = await app.collapseGroup(bgid, true);
await app.refresh();
check('收纳后组的 collapsed 落库（刷新还在）',
  collapsedRes.ok && (app.state.graph.nodeGroups.find((g) => g.id === bgid) || {}).collapsed === true,
  `collapsed=${(app.state.graph.nodeGroups.find((g) => g.id === bgid) || {}).collapsed}`);
check('收纳后成员被藏起来（里画的节点里没有它们）',
  boxIds.every((id) => app.state.hiddenIds.has(id)) && !boxIds.some((id) => el('graph').innerHTML.includes(`data-node="${id}"`)),
  `hidden=${app.state.hiddenIds.size}`);
check('收纳后画出一块替身牌', /data-nodegroup-pill="/.test(el('graph').innerHTML) && /已收纳/.test(el('graph').innerHTML),
  `len=${el('graph').innerHTML.length}`);
check('收纳后组内的线不画、跨边界的线收拢到牌上',
  app.state.graph.edges.length >= 1 && (el('graph').innerHTML.match(/data-edge="/g) || []).length <= app.state.graph.edges.length,
  `画出的线=${(el('graph').innerHTML.match(/data-edge="/g) || []).length} 库里=${app.state.graph.edges.length}`);
check('框选不再选到藏起来的成员', !app.nodesInRect({ x: -100000, y: -100000, w: 200000, h: 200000 }).some((id) => boxIds.includes(id)),
  `hits=${app.nodesInRect({ x: -100000, y: -100000, w: 200000, h: 200000 }).length}`);

// 拖那块牌＝整组一起挪（走真实入口：点牌 → startDrag 带 groupId）
app.state.viewport = { scale: 1, tx: 0, ty: 0 };
app.state.view = null;
const pill = app.pillRect(bgid);
const before0 = { ...app.state.positions.get(boxIds[0]) };
const before1 = { ...app.state.positions.get(boxIds[1]) };
const pillTarget = { closest: (sel) => (sel === "[data-nodegroup-pill]" ? { getAttribute: () => bgid } : null) };
app.onSvgPointerDown({ target: pillTarget, button: 0, clientX: before0.x + 5, clientY: before0.y + 5, preventDefault() { } });
check('按住收纳牌＝把整组选上再拖', app.state.drag?.ids?.length === 2 && app.state.drag.groupId === bgid,
  `ids=${app.state.drag?.ids?.length} groupId=${app.state.drag?.groupId}`);
app.state.drag.pending = { x: before0.x + 65, y: before0.y + 45 };
app.applyDragFrame();
const after0 = app.state.positions.get(boxIds[0]);
const after1 = app.state.positions.get(boxIds[1]);
check('拖收纳牌＝组内成员同位移一起走',
  Math.round(after0.x - before0.x) === 60 && Math.round(after1.x - before1.x) === 60 &&
  Math.round(after0.y - before0.y) === 40 && Math.round(after1.y - before1.y) === 40,
  `Δ0=(${Math.round(after0.x - before0.x)},${Math.round(after0.y - before0.y)}) Δ1=(${Math.round(after1.x - before1.x)},${Math.round(after1.y - before1.y)})`);
check('收纳牌的锚点就是成员包围盒左上角',
  Math.round(app.pillRect(bgid).x) === Math.round(Math.min(after0.x, after1.x)) && pill.h === 78,   // 牌子是三行字：完成/进行/阻塞 + 已收纳
  `pill.x=${Math.round(app.pillRect(bgid).x)}`);
app.state.drag = null;

// 点牌（没拖动）＝组菜单
app.onSvgPointerDown({ target: pillTarget, button: 0, clientX: before0.x + 5, clientY: before0.y + 5, preventDefault() { } });
await app.onSvgPointerUp({ clientX: before0.x + 5, clientY: before0.y + 5, preventDefault() { } });
check('点一下收纳牌＝选中这个组（右栏出组面板）',
  app.state.selectedGroup === bgid && /节点组：/.test(el('sideBody').innerHTML),
  `selectedGroup=${app.state.selectedGroup}`);
app.openGroupMenu(bgid, { clientX: 30, clientY: 30 });
check('右键收纳牌仍出组菜单（展开/选中/存预设/两种删除）',
  app.state.ctxItems.length === 5 && app.state.ctxItems.some((i) => /展开这个组/.test(i.label)),
  app.state.ctxItems.map((i) => i.label).join(" | "));
app.closeContextMenu();

const expandRes = await app.collapseGroup(bgid, false);
await app.refresh();
check('展开后成员回来、牌消失',
  expandRes.ok && app.state.hiddenIds.size === 0 && !/data-nodegroup-pill="/.test(el('graph').innerHTML),
  `hidden=${app.state.hiddenIds.size}`);

// 删组连节点：先试「组里有挂线的节点」→ 整批拒绝
const blockedDel = await app.deleteNodeGroup(bgid, true);
check('组里有删不起的节点时整批拒绝（node-group-not-deletable），并点名是谁',
  !blockedDel.ok && blockedDel.body.error === 'node-group-not-deletable' && /删不起/.test(blockedDel.body.message),
  blockedDel.body?.message || blockedDel.body?.error);
const stillThere = (await call('GET', '/api/tasks/t-ui/graph')).body;
check('被拒绝时一个节点都没少', stillThere.nodes.filter((n) => boxIds.includes(n.id)).length === 2, `nodes=${stillThere.nodes.length}`);

await app.deleteNodeGroup(bgid, false);

// 干净的两个空节点：可以连节点一起删
const dA = await app.quickAddNode(1600, 700, '可删甲');
const dB = await app.quickAddNode(1600, 900, '可删乙');
const delGroup = await app.createNodeGroup([dA.body.node.id, dB.body.node.id], '待删组');
const withNodes = await app.deleteNodeGroup(delGroup.body.id, true);
check('删组连节点：一次删掉组和 2 个节点', withNodes.ok && withNodes.body.nodesDeleted === 2,
  `nodesDeleted=${withNodes.body?.nodesDeleted}`);
const gone = (await call('GET', '/api/tasks/t-ui/graph')).body;
check('连节点删完之后组没了、节点也没了',
  !gone.nodeGroups.some((g) => g.id === delGroup.body.id) &&
  ![dA.body.node.id, dB.body.node.id].some((id) => gone.nodes.some((n) => n.id === id)),
  `groups=${gone.nodeGroups.length} nodes=${gone.nodes.length}`);

// ---------- 21. 节点收纳（仅标题 / 仅关键字）----------
await app.refresh();
const kn = await app.quickAddNode(1800, 760, '关键字测试');
const knId = kn.body.node.id;
el('nTitle').value = '关键字测试';
el('nGoal').value = '收齐三份可用材料';
el('nKind').value = 'work';
await app.saveNodeProps(knId);
await app.refresh();

const compactLabel = () => (el('graph').innerHTML.match(/class="compact-title"[^>]*>([^<]*)</) || [])[1] || null;
const knPosFull = app.state.positions.get(knId);
check('默认是完整卡片（214×88）', knPosFull.w === 214 && knPosFull.h === 88, `${knPosFull.w}×${knPosFull.h}`);

const c1 = await app.setNodeCompact(knId, 1);
await app.refresh();
const knPos1 = app.state.positions.get(knId);
check('收纳为仅标题：卡片变窄变矮', c1.ok && knPos1.w === 140 && knPos1.h === 40, `${knPos1.w}×${knPos1.h}`);
check('仅标题：卡片上只显示标题', compactLabel() === '关键字测试', `label=${compactLabel()}`);
check('窄卡片的出线口跟着新宽度走', app.portPoint('out', knPos1).x === knPos1.x + 140,
  `x=${Math.round(app.portPoint('out', knPos1).x)} 右缘=${Math.round(knPos1.x + 140)}`);

const c2 = await app.setNodeCompact(knId, 2);
await app.refresh();
check('收纳为仅关键字：卡片上显示一行目标',
  c2.ok && compactLabel() === '收齐三份可用材料', `label=${compactLabel()}`);

const badLevel = await app.setNodeCompact(knId, 5);
check('非法收纳级别被拒（bad-request）', !badLevel.ok && badLevel.body.error === 'bad-request', `error=${badLevel.body?.error}`);

const c0 = await app.setNodeCompact(knId, 0);
await app.refresh();
const knPos0 = app.state.positions.get(knId);
check('展开回完整卡片（214×88）', c0.ok && knPos0.w === 214 && knPos0.h === 88, `${knPos0.w}×${knPos0.h}`);

// ---------- 22. 点节点高亮相连的线 ----------
await app.refresh();
const focusEdge = app.state.graph.edges[0];
const incident = app.state.incident.get(focusEdge.fromNodeId).size;
app.setSelection([focusEdge.fromNodeId]);
app.render();
const htmlFocused = el('graph').innerHTML;
const focusCount = (htmlFocused.match(/class="edge edge-focus"/g) || []).length;
const dimCount = (htmlFocused.match(/class="edge edge-dim"/g) || []).length;
check('点中节点：与它相连的线被高亮', focusCount === incident, `高亮=${focusCount} 该节点连着的线=${incident}`);
check('其余线被压暗（不是全都亮）', dimCount > 0 && focusCount + dimCount === app.state.graph.edges.length,
  `压暗=${dimCount} 高亮=${focusCount} 总边=${app.state.graph.edges.length}`);

app.setSelection([]);
app.render();
const htmlNone = el('graph').innerHTML;
check('取消选中后高亮与压暗都撤掉',
  !/edge-focus/.test(htmlNone) && !/edge-dim/.test(htmlNone),
  `focus=${(htmlNone.match(/edge-focus/g) || []).length} dim=${(htmlNone.match(/edge-dim/g) || []).length}`);

// ---------- 23. 点连线：面板 / 门控 / 改 / 点头 / 删 ----------
const gateTask = await call('POST', '/api/tasks', {
  id: 't-gateui', title: 'UI 门控任务', goalLine: '连线也能挂闸门',
  nodes: [{ id: 'GU-A', title: '写稿', seq: 1 }, { id: 'GU-B', title: '复核', seq: 2 }],
  edges: [{ id: 'eGU', from: 'GU-A', to: 'GU-B', kind: 'transfer', gate: 'human', gateNote: '对过口径' }],
  groups: [], cycles: []
});
check('准备一条带人工门控的任务', gateTask.status === 201, `status=${gateTask.status}`);
app.state.taskId = 't-gateui';
app.state.fittedFor = null;
await app.refresh();
check('人工门控没点头的线画成橙色虚线并标「门控待确认」',
  /edge-gated/.test(el('graph').innerHTML) && /门控待确认/.test(el('graph').innerHTML),
  `len=${el('graph').innerHTML.length}`);

await app.selectEdge('eGU');
const edgePanel = el('sideBody').innerHTML;
check('点连线出「连线」面板（走向 + 门控）',
  /连线：写稿 → 复核/.test(edgePanel) && /门控/.test(edgePanel) && /人工门控/.test(edgePanel),
  edgePanel.slice(0, 60));
check('门控未确认时面板给「确认门控」按钮', !!el('confirmGateBtn'));

el('eGateNote').value = '对过口径再放行';
const savedEdge = await app.saveEdge('eGU');
check('改门控说明落库', savedEdge.ok && savedEdge.body.edge.gateNote === '对过口径再放行',
  `note=${savedEdge.body?.edge?.gateNote}`);

await call('POST', '/api/tasks/t-gateui/claim', { agent: 'ui-gate' });
await call('POST', '/api/nodes/GU-A/complete', { by: 'ui-gate' });
const gb = (await call('GET', '/api/nodes/GU-B')).body;
const gbItem = (gb.input.items || []).find((i) => i.edgeId === 'eGU') || {};
check('门控没点头：上游做完下游仍 pending，拒因 gate-needs-confirm',
  gb.node.status === 'pending' && gbItem.reason === 'gate-needs-confirm',
  `status=${gb.node.status} reason=${gbItem.reason}`);

const conf = await app.confirmEdgeGate('eGU');
await app.refresh();
check('点「确认门控」→ 立刻起步下游',
  conf.ok && (conf.body.activated || []).includes('GU-B') && /门控✓/.test(el('graph').innerHTML),
  `activated=${(conf.body?.activated || []).join(",")}`);

// 命不中细线也点得到：透明命中带
app.state.suppressClick = false;
el('graph').onclick({ target: { closest: (sel) => (sel === "[data-edge-hit]" ? { getAttribute: () => 'eGU' } : null) }, shiftKey: false });
check('点线的透明命中带＝选中那条线', app.state.selectedEdge === 'eGU', `selectedEdge=${app.state.selectedEdge}`);

await call('POST', '/api/tasks/t-gateui/nodes', { id: 'GU-C', title: '排版', seq: 3 });
await app.refresh();
const spareEdge = await call('POST', '/api/tasks/t-gateui/edges', { from: 'GU-B', to: 'GU-C', kind: 'transfer' });
const spareId = spareEdge.body.edge.id;
const removedEdge = await app.removeEdge(spareId);
check('删一条没放行过的线（200）', removedEdge.ok, `status=${removedEdge.status}`);
const goneEdges = (await call('GET', '/api/tasks/t-gateui/graph')).body;
check('删完图里少一条线', !goneEdges.edges.some((x) => x.id === spareId), `edges=${goneEdges.edges.length}`);

app.state.taskId = 't-ui';
app.state.fittedFor = null;
await app.refresh();

// ---------- 24. 选中的东西按 Delete 就能删 ----------
const pressDelete = async (target = { tagName: "BODY" }) => {
  const fn = globalThis.document.onkeydown;
  let prevented = false;
  if (fn) fn({ key: "Delete", target, preventDefault() { prevented = true; } });
  await new Promise((r) => setTimeout(r, 120));   // 让键盘触发的异步删除跑完（这里是真定时器）
  return prevented;
};

await app.refresh();
// 单节点：没挂线、没起步 → 删得掉
const delNode1 = await app.quickAddNode(2000, 700, '按 Delete 删我');
app.setSelection([delNode1.body.node.id]);
await pressDelete();
await app.refresh();
check('选中节点按 Delete 就删掉', !app.state.graph.nodes.some((n) => n.id === delNode1.body.node.id),
  `nodes=${app.state.graph.nodes.length}`);

// 挂线的节点：删不掉，而且要说出原因
const guarded = app.state.graph.edges[0];
app.setSelection([guarded.fromNodeId]);
const beforeGuard = app.state.graph.nodes.length;
await pressDelete();
await app.refresh();
check('删不起的节点按 Delete 会报原因、节点还在',
  app.state.graph.nodes.length === beforeGuard && /node-has-edges|node-not-pending/.test(el('toast').innerHTML),
  el('toast').innerHTML.slice(0, 80));

// 多选：能删的都删掉，删不掉的点名
const settleGraph = async (times = 3) => {
  for (let i = 0; i < times; i++) {
    await new Promise((r) => setTimeout(r, 60));
    await app.refresh();
  }
};
const m1 = await app.quickAddNode(2200, 700, '多选甲');
const m2 = await app.quickAddNode(2200, 900, '多选乙');
app.setSelection([m1.body.node.id, m2.body.node.id]);
await pressDelete();
await settleGraph();
check('多选按 Delete 一次删掉两个',
  ![m1.body.node.id, m2.body.node.id].some((id) => app.state.graph.nodes.some((n) => n.id === id)) &&
  /删掉 2 个节点/.test(el('toast').innerHTML),
  "left=" + [m1.body.node.id, m2.body.node.id].filter((id) => app.state.graph.nodes.some((n) => n.id === id)).join(",") +
  " toast=" + el('toast').innerHTML.slice(0, 60));

// 输入框里按 Delete 不删东西
const keep = await app.quickAddNode(2400, 700, '别删我');
app.setSelection([keep.body.node.id]);
const toastBefore = el('toast').innerHTML;
const prevented = await pressDelete({ tagName: "INPUT" });
await app.refresh();
check('在输入框里按 Delete 只删字不动节点',
  !prevented && app.state.graph.nodes.some((n) => n.id === keep.body.node.id) && el('toast').innerHTML === toastBefore,
  "prevented=" + prevented + " 还在=" + app.state.graph.nodes.some((n) => n.id === keep.body.node.id));

// 选中连线按 Delete
await call('POST', '/api/tasks/t-ui/nodes', { id: 'DEL-1', title: '删线甲', seq: 90 });
await call('POST', '/api/tasks/t-ui/nodes', { id: 'DEL-2', title: '删线乙', seq: 91 });
const delEdge = await call('POST', '/api/tasks/t-ui/edges', { from: 'DEL-1', to: 'DEL-2', kind: 'transfer' });
const delEdgeId = delEdge.body.edge.id;
await app.refresh();
await app.selectEdge(delEdgeId);
await pressDelete();
await app.refresh();
check('选中连线按 Delete 删掉它', !app.state.graph.edges.some((e) => e.id === delEdgeId), `edges=${app.state.graph.edges.length}`);

// 选中节点组按 Delete：默认只解散，节点都留着
const gIds = app.state.graph.nodes.slice(0, 2).map((n) => n.id);
const delGrp = await app.createNodeGroup(gIds, '按 Delete 解散我');
const dgid = delGrp.body.id;
await app.refresh();
const chip = { closest: (sel) => (sel === "[data-nodegroup-chip]" ? { getAttribute: () => dgid } : null) };
app.onSvgPointerDown({ target: chip, button: 0, clientX: 10, clientY: 10, preventDefault() { } });
check('按住组标签＝先把整组选上（可以整组拖）', app.state.drag?.ids?.length >= 2 && app.state.drag.groupId === dgid,
  `ids=${app.state.drag?.ids?.length} groupId=${app.state.drag?.groupId}`);
await app.onSvgPointerUp({ clientX: 10, clientY: 10, preventDefault() { } });
check('点组标签（没拖）＝选中这个组（右栏出组面板）',
  app.state.selectedGroup === dgid && /节点组：/.test(el('sideBody').innerHTML),
  `selectedGroup=${app.state.selectedGroup}`);
check('组面板里两种删除都在', !!el('grpDissolveBtn') && !!el('grpDeleteAllBtn'));

const nodesBeforeGroupDel = app.state.graph.nodes.length;
await pressDelete();
await app.refresh();
check('选中组按 Delete＝只解散，节点一个不少',
  !(app.state.graph.nodeGroups || []).some((g) => g.id === dgid) && app.state.graph.nodes.length === nodesBeforeGroupDel,
  `groups=${(app.state.graph.nodeGroups || []).length} nodes=${app.state.graph.nodes.length}`);

// 什么都没选：Delete 不做任何事，也不拦浏览器默认行为
app.setSelection([]);
const toastIdle = el('toast').innerHTML;
const preventedIdle = await pressDelete();
await app.refresh();
check('没选东西按 Delete 什么都不发生', !preventedIdle && el('toast').innerHTML === toastIdle,
  "prevented=" + preventedIdle);

// ---------- 25. 预设：存节点/存组、套用模板 ----------
await app.refresh();
const tplSrc = app.state.graph.nodes[0].id;
const savedTpl = await app.saveNodeTemplate(tplSrc);
check('右键节点→存成节点预设（201）', savedTpl.ok && !!savedTpl.body.id, `id=${savedTpl.body?.id}`);

const tplGroupIds = app.state.graph.nodes.slice(0, 2).map((n) => n.id);
const tplGrp = await app.createNodeGroup(tplGroupIds, '预设用的组');
await app.refresh();
const savedGrpTpl = await app.saveGroupTemplate(tplGrp.body.id);
check('组面板→存成组预设（201，带节点数与线数）',
  savedGrpTpl.ok && savedGrpTpl.body.nodeCount === 2,
  `nodes=${savedGrpTpl.body?.nodeCount} edges=${savedGrpTpl.body?.edgeCount}`);

const panel = await app.openTemplatePanel();
check('模板库面板列出两类预设',
  panel.ok && (app.state.templates.nodeTemplates || []).length >= 1 && (app.state.templates.groupTemplates || []).length >= 1,
  `nodes=${(app.state.templates?.nodeTemplates || []).length} groups=${(app.state.templates?.groupTemplates || []).length}`);
check('面板里写清套用落在哪、预设怎么来的',
  /模板库/.test(el('formHost').innerHTML) && /套用会把预设放到当前视野中间/.test(el('formHost').innerHTML),
  el('formHost').innerHTML.length + ' chars');

const beforeApply = app.state.graph.nodes.length;
const appliedNode = await app.applyNodeTemplate(savedTpl.body.id);
await app.refresh();
check('套用节点预设：图里多一个节点，字段照预设',
  appliedNode.ok && app.state.graph.nodes.length === beforeApply + 1 &&
  app.state.graph.nodes.some((n) => n.id === appliedNode.body.node.id && n.title === appliedNode.body.node.title),
  `nodes=${app.state.graph.nodes.length}`);

const beforeGroupApply = app.state.graph.nodes.length;
const appliedGroup = await app.applyGroupTemplate(savedGrpTpl.body.id);
await app.refresh();
check('套用组预设：节点整块落下并圈成一个组',
  appliedGroup.ok && app.state.graph.nodes.length === beforeGroupApply + 2 &&
  (app.state.graph.nodeGroups || []).some((g) => g.id === appliedGroup.body.groupId),
  `nodes=${app.state.graph.nodes.length} group=${appliedGroup.body?.groupId}`);
check('套用组预设后自动选中那个组（右栏出组面板）',
  app.state.selectedGroup === appliedGroup.body.groupId, `selectedGroup=${app.state.selectedGroup}`);

const delTpl = await app.deleteNodeTemplate(savedTpl.body.id);
check('删节点预设（200）', delTpl.ok, `status=${delTpl.status}`);
const listAfter = (await call('GET', '/api/templates')).body;
check('删完模板库里确实少了它',
  !(listAfter.nodeTemplates || []).some((t) => t.id === savedTpl.body.id),
  `nodeTemplates=${(listAfter.nodeTemplates || []).length}`);

// 收尾：把这次建的组预设删掉，别留在库里
await app.deleteGroupTemplate(savedGrpTpl.body.id);
await app.deleteNodeTemplate(listAfter.nodeTemplates?.[0]?.id || 'none');

// ---------- 26. 双击标题＝快收快开（节点 / 组 / 链）----------
await app.refresh();
const dblTarget = (attr, id) => ({ closest: (sel) => (sel === attr ? { getAttribute: () => id } : null) });
const dblClick = (target, clientX = 60, clientY = 60) =>
  el('graph').ondblclick({ target, clientX, clientY, preventDefault() { } });

const dn = await app.quickAddNode(2600, 760, '双击收纳我');
await settleGraph();
const dnId = dn.body.node.id;
dblClick(dblTarget('[data-node]', dnId));
await settleGraph();
const dnC1 = app.state.graph.nodes.find((n) => n.id === dnId);
check('双击节点标题＝收成仅标题', dnC1.compact === 1, `compact=${dnC1.compact}`);
check('收起来的卡片变窄（140×40）', app.state.positions.get(dnId)?.w === 140 && app.state.positions.get(dnId)?.h === 40,
  `${app.state.positions.get(dnId)?.w}×${app.state.positions.get(dnId)?.h}`);
dblClick(dblTarget('[data-node]', dnId));
await settleGraph();
const dnC0 = app.state.graph.nodes.find((n) => n.id === dnId);
check('再双击＝摊回完整卡片', dnC0.compact === 0, `compact=${dnC0.compact}`);

const gA26 = await app.quickAddNode(2900, 700, '双击组甲');
const gB26 = await app.quickAddNode(2900, 900, '双击组乙');
const dblGrp = await app.createNodeGroup([gA26.body.node.id, gB26.body.node.id], '双击测试组');
await settleGraph();
const dgId26 = dblGrp.body.id;
dblClick(dblTarget('[data-nodegroup-chip]', dgId26));
await settleGraph();
const dgC1 = (app.state.graph.nodeGroups || []).find((g) => g.id === dgId26) || {};
check('双击组标题＝收成一块牌（成员藏起来）',
  dgC1.collapsed === true && app.state.hiddenIds.has(gA26.body.node.id),
  `collapsed=${dgC1.collapsed} hidden=${app.state.hiddenIds.size}`);
dblClick(dblTarget('[data-nodegroup-pill]', dgId26));
await settleGraph();
const dgC0 = (app.state.graph.nodeGroups || []).find((g) => g.id === dgId26) || {};
check('双击收纳牌＝摊开这个组', dgC0.collapsed === false && !app.state.hiddenIds.has(gA26.body.node.id),
  `collapsed=${dgC0.collapsed} hidden=${app.state.hiddenIds.size}`);
await app.deleteNodeGroup(dgId26, false);

const blankBefore = app.state.graph.nodes.length;
app.state.viewport = { scale: 1, tx: 0, ty: 0 };
app.state.view = null;
dblClick({ closest: () => null }, 300, 300);
await settleGraph();
check('双击空白仍然建节点（没被标题双击抢走）',
  app.state.graph.nodes.length === blankBefore + 1, `nodes=${app.state.graph.nodes.length}/${blankBefore}`);

// ---------- 27. 同向链：五合一收成一块（纯前端看法，后端一个字段都没加）----------
// 两头各留一个分叉/汇合，链才是干净的 5 节（否则一路往回追会把上下游也吞进来）
await call('POST', '/api/tasks/t-ui/nodes', { id: 'CH-U', title: '链上游', seq: 60, x: 3200, y: 620 });
await call('POST', '/api/tasks/t-ui/nodes', { id: 'CH-X', title: '链旁支', seq: 61, x: 3200, y: 860 });
for (let i = 1; i <= 5; i++) {
  await call('POST', '/api/tasks/t-ui/nodes', { id: `CH-${i}`, title: `链节 ${i}`, seq: 61 + i, x: 3200 + i * 260, y: 620 });
}
await call('POST', '/api/tasks/t-ui/nodes', { id: 'CH-D', title: '链下游', seq: 70, x: 3200 + 6 * 260, y: 620 });
await call('POST', '/api/tasks/t-ui/edges', { from: 'CH-U', to: 'CH-1', kind: 'transfer' });
await call('POST', '/api/tasks/t-ui/edges', { from: 'CH-U', to: 'CH-X', kind: 'transfer' });
for (let i = 1; i < 5; i++) await call('POST', '/api/tasks/t-ui/edges', { from: `CH-${i}`, to: `CH-${i + 1}`, kind: 'transfer' });
await call('POST', '/api/tasks/t-ui/edges', { from: 'CH-5', to: 'CH-D', kind: 'transfer' });
await call('POST', '/api/tasks/t-ui/edges', { from: 'CH-X', to: 'CH-D', kind: 'transfer' });
await app.refresh();

const walked = app.walkChainLocal('CH-3');
check('从链中间也能认出整条同向链（5 节，往两头都走）',
  walked.length === 5 && walked[0] === 'CH-1' && walked[4] === 'CH-5',
  walked.join('→'));
check('图里从每个链头各出一条链（同一串不重复）',
  app.state.chains.filter((c) => c.id === 'ch:CH-1').length === 1 &&
  new Set(app.state.chains.map((c) => c.id)).size === app.state.chains.length &&
  app.state.chains.find((c) => c.id === 'ch:CH-1').count === 5,
  app.state.chains.map((c) => `${c.id}:${c.count}`).join(','));

app.setSelection(['CH-3']);
app.openNodeMenu('CH-3', { clientX: 20, clientY: 20 });
const chainItem = app.state.ctxItems.find((i) => /同向链收成一块/.test(i.label));
check('右键节点有「同向链收成一块」，并写清会收几个',
  !!chainItem && !chainItem.disabled && /5 个/.test(chainItem.label), chainItem?.label);
app.closeContextMenu();

const edgeDrawnBefore = (el('graph').innerHTML.match(/data-edge="/g) || []).length;
const chained = app.collapseChainOfNode('CH-3');
const chainId = 'ch:CH-1';
const chainNow = () => app.state.chains.find((c) => c.id === chainId) || {};
check('收成一块（链头是 CH-1、共 5 个，全在前端）',
  chained.ok && app.state.collapsedChains.has('CH-1') && chainNow().count === 5,
  `collapsed=${[...app.state.collapsedChains].join(',')} count=${chainNow().count}`);

const htmlChain = el('graph').innerHTML;
check('画布上画出链块，写清「5 个合 1」',
  new RegExp(`data-chain="${chainId}"`).test(htmlChain) && /同向链 · 5 个合 1/.test(htmlChain) && /×5/.test(htmlChain),
  `chain块=${/data-chain="/.test(htmlChain)}`);
check('链上 5 节都藏起来（画布里没有它们的 data-node）',
  ['CH-1', 'CH-2', 'CH-3', 'CH-4', 'CH-5'].every((id) => app.state.hiddenIds.has(id) && !htmlChain.includes(`data-node="${id}"`)),
  `hidden=${app.state.hiddenIds.size}`);
const edgeDrawnAfter = (el('graph').innerHTML.match(/data-edge="/g) || []).length;
check('链内部的 4 条线不画，两头跨界的线收拢到链块上',
  edgeDrawnAfter === edgeDrawnBefore - 4, `前=${edgeDrawnBefore} 后=${edgeDrawnAfter}`);
check('链块位置就是链头坐标（拖它就等于拖整条）',
  app.state.chainRects.get(chainId).x === app.state.positions.get('CH-1').x &&
  app.state.chainRects.get(chainId).w === 246,
  `x=${app.state.chainRects.get(chainId)?.x} headX=${app.state.positions.get('CH-1')?.x}`);

// 拖链块＝整条一起挪（走的还是老的批量落坐标接口）
const chainTarget = { closest: (sel) => (sel === '[data-chain]' ? { getAttribute: () => chainId } : null) };
const headPos = { ...app.state.positions.get('CH-1') };
app.state.viewport = { scale: 1, tx: 0, ty: 0 };
app.state.view = null;
app.onSvgPointerDown({ target: chainTarget, button: 0, clientX: headPos.x + 20, clientY: headPos.y + 20, preventDefault() { } });
check('按住链块＝把 5 节选上再拖', app.state.drag?.ids?.length === 5 && app.state.drag.chainId === chainId,
  `ids=${app.state.drag?.ids?.length} chainId=${app.state.drag?.chainId}`);
app.state.drag.pending = { x: headPos.x + 120, y: headPos.y + 60 };
app.applyDragFrame();
const allShifted = [1, 2, 3, 4, 5].every((i) => {
  const p = app.state.positions.get(`CH-${i}`);
  return Math.round(p.x - (3200 + i * 260)) === 100 && Math.round(p.y - 620) === 40;
});
check('拖链块＝链上 5 节同位移一起走', allShifted,
  [1, 3, 5].map((i) => `${i}:${Math.round(app.state.positions.get(`CH-${i}`).x - (3200 + i * 260))}`).join(' '));
check('拖动过程中链块自己跟着链头走',
  Math.round(app.state.chainRects.get(chainId).x) === Math.round(app.state.positions.get('CH-1').x),
  `box=${Math.round(app.state.chainRects.get(chainId).x)} head=${Math.round(app.state.positions.get('CH-1').x)}`);
await app.onSvgPointerUp({ clientX: headPos.x + 120, clientY: headPos.y + 60, preventDefault() { } });
await settleGraph();
const savedChainNode = (await call('GET', '/api/tasks/t-ui/graph')).body.nodes.find((n) => n.id === 'CH-3');
check('松手后整条链的新坐标都落库（还是老接口，没为链加东西）',
  savedChainNode.posX === 3200 + 3 * 260 + 100 && savedChainNode.posY === 660,
  `pos=(${savedChainNode.posX},${savedChainNode.posY})`);
check('刷新之后图里没有链这种东西（纯看法，不落库）',
  !('chains' in (await call('GET', '/api/tasks/t-ui/graph')).body),
  Object.keys((await call('GET', '/api/tasks/t-ui/graph')).body).join(','));

// 点一下链块＝选中这条链（右栏出链面板）
app.collapseChainOfNode('CH-2');
app.onSvgPointerDown({ target: chainTarget, button: 0, clientX: 3330, clientY: 640, preventDefault() { } });
await app.onSvgPointerUp({ clientX: 3330, clientY: 640, preventDefault() { } });
check('点链块＝选中这条链，右栏出链面板', app.state.selectedChain === chainId && /同向链：/.test(el('sideBody').innerHTML),
  `selectedChain=${app.state.selectedChain}`);
check('链面板写清「只是看图」并能收/开',
  /只是看图/.test(el('sideBody').innerHTML) && !!el('chainCollapseBtn') && /摊开这条链/.test(el('sideBody').innerHTML));

// 双击链块标题＝摊开（成员回来、画一圈虚线标位置）
dblClick(dblTarget('[data-chain]', chainId));
check('双击链块标题＝摊开这条链',
  !app.state.collapsedChains.has('CH-1') && !app.state.hiddenIds.has('CH-3') &&
  new RegExp(`data-chain-frame="${chainId}"`).test(el('graph').innerHTML),
  `collapsed=${app.state.collapsedChains.size} frame=${/data-chain-frame="/.test(el('graph').innerHTML)}`);
check('摊开时那 5 节都画回来', [1, 2, 3, 4, 5].every((i) => el('graph').innerHTML.includes(`data-node="CH-${i}"`)));

dblClick(dblTarget('[data-chain]', chainId));
check('再双击＝又收成一块（同一串只有一条链，不会收两份）',
  app.state.collapsedChains.has('CH-1') && app.state.hiddenIds.has('CH-5') && chainNow().count === 5 &&
  new Set(app.state.chains.map((c) => c.id)).size === app.state.chains.length,
  `collapsed=${[...app.state.collapsedChains].join(',')}`);

// 选中链块按 Delete＝摊开（节点与线一个不少）
await app.selectChain(chainId);
const nodesBeforeExpand = app.state.graph.nodes.length;
const edgesBeforeExpand = app.state.graph.edges.length;
await pressDelete();
check('选中链块按 Delete＝摊开，节点与连线一个不少',
  !app.state.collapsedChains.has('CH-1') && app.state.graph.nodes.length === nodesBeforeExpand &&
  app.state.graph.edges.length === edgesBeforeExpand && !app.state.hiddenIds.has('CH-3'),
  `collapsed=${app.state.collapsedChains.size} nodes=${app.state.graph.nodes.length}/${nodesBeforeExpand}`);

// 链是算出来的：断掉中间那条线，同一串就不再是 5 节
const midEdge = app.state.graph.edges.find((e) => e.fromNodeId === 'CH-2' && e.toNodeId === 'CH-3');
await app.removeEdge(midEdge.id);
await settleGraph();
const afterCut = app.walkChainLocal('CH-1');
check('断线后链自己缩短（5 节变 2 节，不用手动维护）',
  afterCut.length === 2 && chainNow().count === 2,
  `walked=${afterCut.join('→')} count=${chainNow().count}`);

// ---------- 28. 组的名字/边缘＝抓手：拖就整组走，点空白取消 ----------
await app.refresh();
const g1 = await app.quickAddNode(3600, 700, '抓手甲');
const g2 = await app.quickAddNode(3600, 900, '抓手乙');
const grabGrp = await app.createNodeGroup([g1.body.node.id, g2.body.node.id], '抓手测试组');
await settleGraph();
const gid28 = grabGrp.body.id;
const ids28 = [g1.body.node.id, g2.body.node.id];

const html28 = el('graph').innerHTML;
check('展开的组画两条：一条看得见的框 + 一条透明的宽边当抓手',
  new RegExp(`data-nodegroup="${gid28}"`).test(html28) &&
  new RegExp(`data-nodegroup-edge="${gid28}"`).test(html28),
  `框=${new RegExp(`data-nodegroup="${gid28}"`).test(html28)} 抓手=${new RegExp(`data-nodegroup-edge="${gid28}"`).test(html28)}`);
const gb28 = app.groupBounds(gid28);
check('抓手贴着组框（同一条几何）',
  new RegExp(`data-nodegroup-edge="${gid28}" x="${gb28.x1}" y="${gb28.y1}" width="${gb28.x2 - gb28.x1}"`).test(html28),
  `bounds=(${gb28.x1},${gb28.y1},${gb28.x2 - gb28.x1})`);

const css = (await import('node:fs')).readFileSync(new URL('../backend/WorkProto.Api/wwwroot/style.css', import.meta.url), 'utf8');
const groupBlock = (css.match(/#graph \.node-group \{[^}]*\}/) || [''])[0];
const edgeBlock = (css.match(/#graph \.node-group-edge \{[^}]*\}/) || [''])[0];
check('CSS 契约：组框本身不吃事件（框里空白仍能框选/双击建节点），只有那圈边吃',
  /pointer-events:\s*none/.test(groupBlock) && /pointer-events:\s*stroke/.test(edgeBlock),
  `组框=${/pointer-events:\s*none/.test(groupBlock)} 边=${/pointer-events:\s*stroke/.test(edgeBlock)}`);

const chipTarget28 = { closest: (sel) => (sel === '[data-nodegroup-chip]' ? { getAttribute: () => gid28 } : null) };
const before28 = ids28.map((id) => ({ ...app.state.positions.get(id) }));
app.state.viewport = { scale: 1, tx: 0, ty: 0 };
app.state.view = null;
app.onSvgPointerDown({ target: chipTarget28, button: 0, clientX: before28[0].x + 30, clientY: before28[0].y - 30, preventDefault() { } });
check('按住组名＝把整组选上再拖', app.state.drag?.ids?.length === 2 && app.state.drag.groupId === gid28,
  `ids=${app.state.drag?.ids?.length} groupId=${app.state.drag?.groupId}`);
app.state.drag.pending = { x: before28[0].x + 130, y: before28[0].y + 70 };
app.applyDragFrame();
// 按下点相对节点是 (+30,-30)，拖到 (+130,+70) ＝整组平移 (+100,+100)
const shifted28 = ids28.every((id, i) => Math.round(app.state.positions.get(id).x - before28[i].x) === 100 &&
  Math.round(app.state.positions.get(id).y - before28[i].y) === 100);
check('拖组名＝组内每个节点同位移一起走', shifted28,
  ids28.map((id, i) => `${Math.round(app.state.positions.get(id).x - before28[i].x)},${Math.round(app.state.positions.get(id).y - before28[i].y)}`).join(' | '));
check('拖动时组框自己也跟着走（包围盒实时重算）',
  Math.round(app.groupBounds(gid28).x1) === Math.round(Math.min(...ids28.map((id) => app.state.positions.get(id).x))) - 22,
  `box.x1=${Math.round(app.groupBounds(gid28).x1)}`);
await app.onSvgPointerUp({ clientX: before28[0].x + 130, clientY: before28[0].y + 70, preventDefault() { } });
await settleGraph();
const saved28 = (await call('GET', '/api/tasks/t-ui/graph')).body.nodes.find((n) => n.id === ids28[0]);
check('松手后整组坐标落库', saved28.posX === before28[0].x + 100 && saved28.posY === before28[0].y + 100,
  `pos=(${saved28.posX},${saved28.posY}) 原=(${before28[0].x},${before28[0].y})`);

// 点组名（不拖）＝选中这个组
const beforeTap = { ...app.state.positions.get(ids28[0]) };
app.onSvgPointerDown({ target: chipTarget28, button: 0, clientX: beforeTap.x + 30, clientY: beforeTap.y - 30, preventDefault() { } });
await app.onSvgPointerUp({ clientX: beforeTap.x + 30, clientY: beforeTap.y - 30, preventDefault() { } });
check('点一下组名（没拖）＝选中这个组，右栏出组面板',
  app.state.selectedGroup === gid28 && /节点组：/.test(el('sideBody').innerHTML),
  `selectedGroup=${app.state.selectedGroup}`);
check('点一下不会把节点挪走',
  Math.round(app.state.positions.get(ids28[0]).x) === Math.round(beforeTap.x),
  `x=${Math.round(app.state.positions.get(ids28[0]).x)} 原=${Math.round(beforeTap.x)}`);

// 拖组的边（那一圈描边）＝同样整组走
const edgeTarget28 = { closest: (sel) => (sel === '[data-nodegroup-edge]' ? { getAttribute: () => gid28 } : null) };
const beforeEdge = ids28.map((id) => ({ ...app.state.positions.get(id) }));
app.onSvgPointerDown({ target: edgeTarget28, button: 0, clientX: beforeEdge[0].x - 22, clientY: beforeEdge[0].y + 30, preventDefault() { } });
check('按住组边框＝也是把整组选上再拖', app.state.drag?.ids?.length === 2 && app.state.drag.groupId === gid28,
  `ids=${app.state.drag?.ids?.length}`);
app.state.drag.pending = { x: beforeEdge[0].x - 22 + 60, y: beforeEdge[0].y + 30 + 40 };
app.applyDragFrame();
check('拖组边框＝组内每个节点同位移一起走',
  ids28.every((id, i) => Math.round(app.state.positions.get(id).x - beforeEdge[i].x) === 60),
  ids28.map((id, i) => Math.round(app.state.positions.get(id).x - beforeEdge[i].x)).join(','));
await app.onSvgPointerUp({ clientX: beforeEdge[0].x + 38, clientY: beforeEdge[0].y + 70, preventDefault() { } });
await settleGraph();

// 右键组边框＝组菜单（不用先选中）
app.onSvgPointerDown({ target: edgeTarget28, button: 2, clientX: 10, clientY: 10, preventDefault() { } });
check('右键组边框＝组菜单（收纳/选中/存预设/两种删除）',
  app.state.ctxItems.length === 5 && app.state.ctxItems.some((i) => /收纳这个组/.test(i.label)),
  app.state.ctxItems.map((i) => i.label).join(' | '));
app.closeContextMenu();

// 点空白＝取消选中
app.selectGroup(gid28);
const blankTarget = { closest: () => null };
app.onSvgPointerDown({ target: blankTarget, button: 0, clientX: 20, clientY: 20, preventDefault() { } });
await app.onSvgPointerUp({ clientX: 20, clientY: 20, preventDefault() { } });
check('点空白处＝取消选中（组没选中、右栏清空、节点还在）',
  app.state.selectedGroup === null && el('sideBody').innerHTML === '' &&
  app.state.graph.nodes.filter((n) => ids28.includes(n.id)).length === 2,
  `selectedGroup=${app.state.selectedGroup} side=${el('sideBody').innerHTML.length}`);

await app.deleteNodeGroup(gid28, false);

const failed = results.filter((r) => !r.ok);
console.log(`\n总计 ${results.length} 项：通过 ${results.length - failed.length}，失败 ${failed.length}`);
process.exit(failed.length ? 1 : 0);
