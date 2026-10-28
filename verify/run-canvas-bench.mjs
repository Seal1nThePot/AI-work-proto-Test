// 用无头 Chrome 打开画布，切到 150 节点任务，量渲染成本并截图。
// 用法：node verify\.tmp\shot.mjs [base] [taskId] [outPng]
import { spawn } from 'node:child_process';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const base = process.argv[2] || 'http://127.0.0.1:5081';
const taskId = process.argv[3] || 'tsk-150-demo';
const outPng = process.argv[4] || path.resolve(import.meta.dirname, '..', 'docs', 'screenshot-150-nodes.png');
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const PORT = 9222;

const chrome = spawn(CHROME, [
  '--headless=new', `--remote-debugging-port=${PORT}`, '--window-size=1920,1080',
  '--hide-scrollbars', '--no-first-run', '--no-default-browser-check',
  `--user-data-dir=${mkdtempSync(path.join(tmpdir(), 'cr-'))}`, 'about:blank',
], { stdio: 'ignore' });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function version() {
  for (let i = 0; i < 60; i++) {
    try { return await (await fetch(`http://127.0.0.1:${PORT}/json/version`)).json(); } catch { await sleep(200); }
  }
  throw new Error('chrome 没起来');
}
const ver = await version();
const target = await (await fetch(`http://127.0.0.1:${PORT}/json/new?${encodeURIComponent(base + '/')}`, { method: 'PUT' })).json();

const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((r) => ws.addEventListener('open', r, { once: true }));
let seq = 0;
const pending = new Map();
const events = [];
ws.addEventListener('message', (ev) => {
  const msg = JSON.parse(ev.data);
  if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); }
  else if (msg.method) events.push(msg);
});
const send = (method, params = {}) => new Promise((resolve) => {
  const id = ++seq;
  pending.set(id, resolve);
  ws.send(JSON.stringify({ id, method, params }));
});
const evaluate = async (expression) => {
  const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  if (r.result?.exceptionDetails) throw new Error(r.result.exceptionDetails.text + ' ' + (r.result.exceptionDetails.exception?.description || ''));
  return r.result?.result?.value;
};

await send('Page.enable');
await send('Runtime.enable');
await send('Log.enable');
await send('Page.navigate', { url: base + '/' });
await sleep(1200);
await evaluate(`new Promise((res) => { const t = setInterval(() => { if (document.readyState === 'complete' && state.tasks.length) { clearInterval(t); res(1); } }, 50); })`);
await evaluate(`
  (() => {
    const sel = document.getElementById('taskSelect');
    sel.value = ${JSON.stringify(taskId)};
    sel.dispatchEvent(new Event('change'));
    return sel.value;
  })()
`);
await evaluate(`new Promise((res) => { const t = setInterval(() => { if (state.graph && state.graph.nodes.length > 1) { clearInterval(t); res(state.graph.nodes.length); } }, 50); })`);
await sleep(600);

const stats = await evaluate(`
  (() => {
    const t0 = performance.now();
    render();
    const renderMs = performance.now() - t0;
    const t1 = performance.now();
    fitView();
    const fitMs = performance.now() - t1;
    return {
      nodes: state.graph.nodes.length,
      edges: state.graph.edges.length,
      groups: (state.graph.nodeGroups || []).length,
      domNodeBoxes: document.querySelectorAll('#graph .node-box').length,
      domEdges: document.querySelectorAll('#graph path.edge').length,
      domChainBoxes: document.querySelectorAll('#graph .chain-box').length,
      domPorts: document.querySelectorAll('#graph .port').length,
      domTotal: document.querySelectorAll('#graph *').length,
      renderMs: +renderMs.toFixed(1),
      fitMs: +fitMs.toFixed(1),
      svgSize: document.getElementById('graph').getBoundingClientRect().width + '×' + document.getElementById('graph').getBoundingClientRect().height,
      payloadKb: +(JSON.stringify(state.graph).length / 1024).toFixed(1),
    };
  })()
`);
await sleep(300);
const shot = await send('Page.captureScreenshot', { format: 'png' });
writeFileSync(outPng, Buffer.from(shot.result.data, 'base64'));

const errors = events
  .filter((e) => e.method === 'Runtime.exceptionThrown' || (e.method === 'Log.entryAdded' && e.params.entry.level === 'error'))
  .map((e) => e.params?.exceptionDetails?.exception?.description || e.params?.entry?.text);
console.log(JSON.stringify(stats, null, 2));
console.log('控制台报错:', errors.length ? errors.slice(0, 3) : '无');
console.log('截图:', outPng);

ws.close();
chrome.kill();
process.exit(0);
