// 造一个「极其复杂」的任务：150 节点 / 8 个阶段组 / 循环区 / 择一 / k_of_n / 人工门控。
// 结构刻意做成「1 进 3~4、3~4 合 1」的沙漏串：每个汇合点单独一层，再接下一个扇出点，
// 这样「按组整理」排完图上能直接看出三合一、一进三。
// 用法：node verify\seed-complex.mjs [base] [dbPath]
//   结构走 REST；进度状态直接刷库——这是演示用的"画"，不是真跑出来的。
import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';

const base = process.argv[2] || 'http://127.0.0.1:5081';
const dbPath = process.argv[3] || path.resolve(import.meta.dirname, '..', 'data', 'proto.db');
const TASK_ID = 'tsk-150-demo';
const N = (i) => `q150n${String(i).padStart(3, '0')}`;
const E = (i) => `q150e${String(i).padStart(3, '0')}`;

const PHASES = [
  { key: 'A', name: 'A 需求与验收标准', take: 16, modules: ['任务节点', '连线方向', '逻辑门', '循环与检查点', '材料传递', '阻塞与解除', '审核规则', '画布交互'], actions: ['现状确认', '需求整理', '验收标准'] },
  { key: 'B', name: 'B 契约与数据模型', take: 20, modules: ['nodes 表', 'edges 表', 'input_groups', 'releases', 'cycles', 'checkpoints', 'node_groups', 'templates', 'leases', 'events'], actions: ['字段定稿', '迁移脚本'] },
  { key: 'C', name: 'C 后端实现', take: 28, modules: ['建图', '图增量', '放行', '门判定', '循环轮次', '检查点', '认领排队', '释放租约', '节点属性', '接线口', '节点组', '循环区声明', '模板套用', '删除守卫'], actions: ['实现', '补断言'] },
  { key: 'D', name: 'D 前端实现', take: 28, modules: ['渲染', '连线绘制', '端口命中', '拖动', '框选', '吸附', '缩放平移', '组框', '收纳', '同向链', '右键菜单', '右栏面板', '提示条', '预设库'], actions: ['实现', '打磨'] },
  { key: 'E', name: 'E 联调与压测', take: 20, modules: ['1000 节点渲染', '拖动帧率', '写接口延迟', '并发画线', '5 秒轮询', '断线重连', '库损坏恢复', '长事务', '端口争用', 'WAL 膨胀'], actions: ['压测', '复盘'] },
  { key: 'F', name: 'F 评审循环', take: 12, fixed: ['提交评审', '规则评审', '人工评审', '问题清单', '返工', '复评', '结论确认', '留痕归档', '风险复评', '口径对齐', '抽样复检', '关闭评审'] },
  { key: 'G', name: 'G 上线与观察', take: 18, modules: ['灰度发布', '监控看板', '告警阈值', '回滚预案', '数据备份', '权限核对', '性能基线', '日志采集', '值班交接'], actions: ['准备', '演练'] },
  { key: 'H', name: 'H 复盘与归档', take: 8, fixed: ['收集数据', '复盘会议', '改进项清单', '决策记录', '文档收口', '模板沉淀', '遗留项登记', '归档签字'] },
];
const LOOP_PHASE = 'F';
const PURE_CHAIN = new Set(['H']);      // 纯链：不做扇形，试「同向链」用的

const nodes = [];
const edges = [];
const seenEdge = new Set();
let seq = 0;
let titleCursor = new Map();            // 每个阶段用到第几个标题

function nextTitle(ph) {
  const i = titleCursor.get(ph.key) || 0;
  titleCursor.set(ph.key, i + 1);
  if (ph.fixed) return ph.fixed[i % ph.fixed.length];
  const mod = ph.modules[i % ph.modules.length];
  const act = ph.actions[Math.floor(i / ph.modules.length) % ph.actions.length];
  return `${mod} · ${act}`;
}
function addNode(ph, extra = {}) {
  const title = nextTitle(ph);
  const id = N(nodes.length + 1);
  seq += 1;
  const kind = /评审|复盘|审核/.test(title) ? (seq % 3 === 0 ? 'review_human' : 'review_auto') : 'work';
  nodes.push({
    id, title, goalLine: `${ph.key}${String(seq).padStart(2, '0')}：${title} 的可验证结果`,
    kind, seq, cycleRegion: ph.name, inPorts: 1, outPorts: 1,
  });
  return id;
}
function addEdge(from, to, opts = {}) {
  const kind = opts.kind || 'transfer';
  const key = `${from}|${to}|${kind}`;
  if (seenEdge.has(key)) return null;
  seenEdge.add(key);
  const e = { id: E(edges.length + 1), from, to, kind, gate: opts.gate || 'auto', gateNote: opts.gateNote || '', _confirmed: !!opts._confirmed, _tag: opts.tag || '' };
  edges.push(e);
  return e;
}

const meta = { pick: null, kofn: null, gates: [], exits: new Map(), entries: new Map(), groups: new Map() };

// 每个阶段 = 若干「沙漏」串起来： fan → k 条分支 → merge →（merge 接下一个 fan）
for (const ph of PHASES) {
  meta.groups.set(ph.key, ph.name);
  let left = ph.take;
  let prevExit = null;
  meta.entries.set(ph.key, null);

  if (PURE_CHAIN.has(ph.key) || ph.key === LOOP_PHASE) {
    // 纯链（H 用来试同向链；F 是循环区的环）
    const chain = [];
    for (let i = 0; i < left; i++) chain.push(addNode(ph));
    meta.entries.set(ph.key, chain[0]);
    for (let i = 0; i + 1 < chain.length; i++) addEdge(chain[i], chain[i + 1]);
    if (ph.key === LOOP_PHASE) addEdge(chain.at(-1), chain[0], { kind: 'loop' });
    meta.exits.set(ph.key, chain.at(-1));
    continue;
  }

  let unit = 0;
  while (left >= 5) {
    const k = Math.min(4, left - 2);        // 1 个扇出 + k 条分支 + 1 个汇合
    const fan = addNode(ph);
    if (!meta.entries.get(ph.key)) meta.entries.set(ph.key, fan);
    if (prevExit) addEdge(prevExit, fan);
    const heads = [];
    for (let b = 0; b < k; b++) {
      const branch = addNode(ph);
      addEdge(fan, branch);
      heads.push(branch);
    }
    const merge = addNode(ph);              // 汇合点：单独一层，纵向对准上面几条的重心
    for (const h of heads) addEdge(h, merge);
    // 一线跨过下一组的小跳线，让图别太"教科书"（不影响三合一的主形状）
    if (unit % 2 === 1 && heads.length > 2) addEdge(heads[1], merge === heads[0] ? heads[0] : heads[2]);
    prevExit = merge;
    if (ph.key === 'E' && unit === 0) meta.pick = merge;          // 择一：3 条候选选 1
    if (ph.key === 'E' && unit === 1) meta.kofn = merge;          // k_of_n：4 条里够 2
    if (ph.key === 'D' && unit === 2) meta.gates.push(addEdge(heads[0], merge, { gate: 'human', gateNote: '联调前需要主人确认指标口径', _confirmed: true }));
    if (ph.key === 'E' && unit === 2) meta.gates.push(addEdge(heads[0], merge, { gate: 'human', gateNote: '进评审循环前要人工放行' }));
    left -= k + 2;
    unit += 1;
  }
  while (left > 0) {                        // 尾巴：剩下的做一小段直链
    const n = addNode(ph);
    if (prevExit) addEdge(prevExit, n);
    prevExit = n;
    left -= 1;
  }
  meta.exits.set(ph.key, prevExit);
}

// 阶段之间：上一个的出口 → 下一个的入口（"汇合的终点单独出去，接下一个起点"）
const order = PHASES.map((p) => p.key);
for (let i = 0; i + 1 < order.length; i++) {
  const from = meta.exits.get(order[i]);
  const to = meta.entries.get(order[i + 1]);
  if (from && to) addEdge(from, to);
}
// 两条跨阶段长依赖（真实项目里总会有的）
addEdge(nodes[Math.floor(nodes.length * 0.12)].id, nodes[Math.floor(nodes.length * 0.45)].id);
addEdge(nodes[Math.floor(nodes.length * 0.33)].id, nodes[Math.floor(nodes.length * 0.72)].id);

// 端口按度数分配
const outDeg = new Map(), inDeg = new Map();
for (const e of edges) {
  outDeg.set(e.from, (outDeg.get(e.from) || 0) + 1);
  inDeg.set(e.to, (inDeg.get(e.to) || 0) + 1);
}
const byId = new Map(nodes.map((n) => [n.id, n]));
for (const n of nodes) {
  n.outPorts = Math.min(12, Math.max(1, outDeg.get(n.id) || 1));
  n.inPorts = Math.min(12, Math.max(1, inDeg.get(n.id) || 1));
}
const outCursor = new Map(), inCursor = new Map();
for (const e of edges) {
  const op = outCursor.get(e.from) || 0; outCursor.set(e.from, op + 1);
  const ip = inCursor.get(e.to) || 0; inCursor.set(e.to, ip + 1);
  if (e.kind === 'transfer') {
    e.fromPort = op % byId.get(e.from).outPorts;
    e.toPort = ip % byId.get(e.to).inPorts;
  }
}

// 输入规则组
const groups = [];
const ins = new Map();
for (const e of edges) {
  if (e.kind !== 'transfer') continue;
  (ins.get(e.to) || ins.set(e.to, []).get(e.to)).push(e.id);
}
let gi = 0;
for (const [nodeId, items] of ins) {
  if (items.length < 2) continue;
  gi += 1;
  const mode = nodeId === meta.pick ? 'pick_one' : nodeId === meta.kofn ? 'k_of_n' : 'all';
  groups.push({ id: `q150g${String(gi).padStart(3, '0')}`, nodeId, mode, needCount: mode === 'k_of_n' ? 2 : 0, items });
}

const payload = {
  id: TASK_ID,
  title: '150 节点压测任务 · 工作流引擎端到端',
  goalLine: '拿一张足够复杂的图，把节点/连线/门/循环/检查点/画布全串起来看一遍',
  nodes: nodes.map((n) => ({ ...n })),      // 不带坐标：先让页面按深度自动排，再点「按组整理」
  edges: edges.map(({ _confirmed, _tag, ...e }) => e),
  groups,
  cycles: [{ id: 'q150c001', regionKey: meta.groups.get(LOOP_PHASE), head: meta.entries.get(LOOP_PHASE), tail: meta.exits.get(LOOP_PHASE), limit: 3 }],
};

await fetch(`${base}/api/tasks/${TASK_ID}`, { method: 'DELETE' }).catch(() => {});
const res = await fetch(`${base}/api/tasks`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) });
const rawText = await res.text();
if (res.status !== 201) { console.error('建图失败', res.status, rawText.slice(0, 600)); process.exit(1); }

// ---- 刷一套像真跑过的进度（演示用的"画"）----
const db = new DatabaseSync(dbPath);
db.exec('PRAGMA busy_timeout=5000');
const now = new Date().toISOString();
const setNode = db.prepare('UPDATE nodes SET status=?, attempt=?, cycle_epoch=?, artifact_state=?, blocked_reason=?, active_since_utc=?, compact=? WHERE id=?');
const phaseIds = (k) => nodes.filter((n) => n.cycleRegion === meta.groups.get(k)).map((n) => n.id);
const plan = [];
const mark = (ids, status, opt = {}) => ids.forEach((id) => plan.push({ id, status, ...opt }));
mark(phaseIds('A'), 'approved', { attempt: 1, artifact: 'delivered' });
mark(phaseIds('B'), 'approved', { attempt: 1, artifact: 'delivered' });
mark(phaseIds('C').slice(0, 20), 'approved', { attempt: 1, artifact: 'delivered' });
mark(phaseIds('C').slice(20, 24), 'review', { attempt: 1, artifact: 'delivered', active: now });
mark(phaseIds('C').slice(24), 'active', { attempt: 1, active: now });
mark(phaseIds('D').slice(0, 14), 'approved', { attempt: 1, artifact: 'delivered' });
mark(phaseIds('D').slice(14, 20), 'active', { attempt: 1, active: now });
mark(phaseIds('E').slice(0, 6), 'active', { attempt: 1, active: now });
mark([phaseIds('E')[6]], 'blocked', { attempt: 2, blocked: 'cycle-limit：第 3 轮跑完仍判无进展' });
mark(phaseIds('F'), 'pending', { attempt: 0, epoch: 2 });
if (meta.pick) {
  const pickIns = edges.filter((e) => e.to === meta.pick && e.kind === 'transfer').map((e) => e.from);
  mark([meta.pick], 'active', { attempt: 1, active: now });
  mark([pickIns[0]], 'approved', { attempt: 1, artifact: 'delivered' });
  mark(pickIns.slice(1), 'skipped', { attempt: 0 });
}
const compactTargets = phaseIds('H');
for (const p of plan) {
  const compact = (p.id === compactTargets[3]) ? 1 : (p.id === compactTargets[5]) ? 2 : 0;
  setNode.run(p.status, p.attempt ?? 0, p.epoch ?? 1, p.artifact ?? 'none', p.blocked ?? null, p.active ?? null, compact, p.id);
}
db.prepare("UPDATE tasks SET status='running' WHERE id=?").run(TASK_ID);
db.prepare('UPDATE cycles SET visited=2 WHERE task_id=?').run(TASK_ID);
const confirmed = edges.find((e) => e._confirmed);
if (confirmed) db.prepare("UPDATE edges SET gate_confirmed_by='master', gate_confirmed_at_utc=? WHERE id=?").run(now, confirmed.id);
if (meta.pick) {
  const chosen = edges.find((e) => e.to === meta.pick && e.kind === 'transfer');
  db.prepare("UPDATE input_groups SET chosen_edge_id=? WHERE node_id=? AND mode='pick_one'").run(chosen.id, meta.pick);
}
db.close();

const graph = await (await fetch(`${base}/api/tasks/${TASK_ID}/graph`)).json();
console.log(`建好：${rawText.length ? '150 节点压测任务 · 工作流引擎端到端' : ''}`);
console.log(`  ${graph.nodes.length} 节点 / ${graph.edges.length} 连线 / ${(graph.nodeGroups || []).length} 组 / 1 循环区 / 择一=${meta.pick ? '1' : '0'} / k_of_n=${meta.kofn ? '1' : '0'} / 人工门控=2`);
console.log(`  沙漏单位：每阶段 ${Math.round(graph.nodes.length / 8)} 个节点左右，形状是「1 → 3~4 → 1」串起来`);
console.log(`  看：${base}/  选「150 节点压测任务 · 工作流引擎端到端」，再点工具栏「按组整理」`);
