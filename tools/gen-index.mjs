#!/usr/bin/env node
// gen-index.mjs — 逐文件夹生成「索引.md」。
// 契约：每个源文件头 12 行内用下面四行声明身份（缺项显示「（未标注）」）：
//   用途: 一句话说人话（中文）
//   暴露: 对外符号，空格分隔（前端顶层函数/常量，后端 public 成员）
//   依赖: 依赖谁，写成「文件(符号)」空格分隔
//   被依赖: 谁依赖我
// 用法：node tools/gen-index.mjs [--check]
//   --check：只比对不写盘；有差异退出码 1（给 run-split-check 用）
import { readdirSync, readFileSync, writeFileSync, statSync, existsSync } from 'node:fs';
import { join, dirname, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const CHECK = process.argv.includes('--check');

// 逐文件夹：'.' 指仓库根；顺序即依赖层级（后端 → 页面 → 页面 src → 文档/验收）
const DIRS = [
  '.',
  'backend',
  'backend/WorkProto.Api',
  'backend/WorkProto.Api/wwwroot',
  'backend/WorkProto.Api/wwwroot/src',
  'docs',
  'verify',
  'tools',
];
const SKIP = new Set(['索引.md', 'notes.md']);
const CODE = /\.(cs|ts|js|mjs|ps1|cmd|html|css|json|csproj)$/i;
const DOC = /\.md$/i;

function walk(files) {
  return files.filter((f) => {
    if (SKIP.has(f)) return false;
    if (f.startsWith('.')) return false;
    const st = statSync(join(dir, f));
    return st.isFile() && (CODE.test(f) || DOC.test(f));
  });
}

let dir = '';
const FIELD = {
  用途: /^\s*(?:\/\/|#|\/\*|--)?\s*用途\s*[:：]\s*(.+)$/,
  暴露: /^\s*(?:\/\/|#|\/\*|--)?\s*暴露\s*[:：]\s*(.+)$/,
  依赖: /^\s*(?:\/\/|#|\/\*|--)?\s*依赖\s*[:：]\s*(.+)$/,
  被依赖: /^\s*(?:\/\/|#|\/\*|--)?\s*被依赖\s*[:：]\s*(.+)$/,
};

function parse(file) {
  const text = readFileSync(join(dir, file), 'utf8');
  const lines = text.split(/\r?\n/);
  const out = { 用途: '', 暴露: '', 依赖: '', 被依赖: '', 行数: text.length ? lines.length - (lines.at(-1) === '' ? 1 : 0) : 0 };
  const head = lines.slice(0, 12);
  for (const line of head) {
    for (const [k, re] of Object.entries(FIELD)) {
      if (out[k]) continue;
      const m = line.match(re);
      if (m) out[k] = m[1].trim();
    }
  }
  if (!out.用途) {
    const t = head.find((l) => /^#\s+\S/.test(l));
    out.用途 = t ? t.replace(/^#\s+/, '').trim() : '（未标注）';
  }
  return out;
}

const esc = (s) => String(s || '').replace(/\|/g, '\\|');
const natural = (a, b) => a.localeCompare(b, 'zh-CN', { numeric: true });

function bucketOf(name) {
  const m = name.match(/^(\d\d)/);
  if (!m) return '其他';
  const n = Number(m[1]);
  const map = [[9, '层 0 · 基建'], [19, '层 1 · 数据与几何'], [29, '层 2 · 渲染'], [39, '层 3 · 交互态'],
    [49, '层 4 · 面板'], [69, '层 5 · 表单与写操作'], [79, '层 6 · 手势'], [89, '层 7 · 装配'], [999, '层 7 · 装配']];
  for (const [hi, label] of map) if (n <= hi) return label;
  return '其他';
}

let written = 0, stale = [];
for (dir of DIRS) {
  const abs = join(ROOT, dir);
  if (!existsSync(abs)) continue;
  const files = walk(readdirSync(abs)).sort(natural);
  if (!files.length) continue;

  const rows = files.map((f) => ({ f, ...parse(f) }));
  const total = rows.reduce((s, r) => s + r.行数, 0);
  const isSrc = dir.endsWith('/src');

  const L = [];
  L.push('# ' + (dir === '.' ? '仓库根' : dir.replace(/\//g, '\\')) + ' · 索引');
  L.push('');
  L.push('> 由 `tools/gen-index.mjs` 生成，**勿手改**；改文件头注释后重跑。');
  L.push('> 规模：' + rows.length + ' 个文件 / ' + total + ' 行。');
  L.push('');
  if (isSrc) {
    L.push('## 分层（数字前缀即加载顺序）');
    L.push('');
    L.push('| 层 | 文件 |');
    L.push('| --- | --- |');
    const groups = new Map();
    for (const r of rows) {
      const b = bucketOf(r.f);
      if (!groups.has(b)) groups.set(b, []);
      groups.get(b).push(r.f);
    }
    for (const [b, fs] of groups) L.push('| ' + b + ' | ' + fs.join(' · ') + ' |');
    L.push('');
  }
  L.push('## 文件');
  L.push('');
  L.push('| 文件 | 行数 | 用途 | 暴露 | 依赖 |');
  L.push('| --- | --- | --- | --- | --- |');
  for (const r of rows) {
    const line = '| [' + r.f + '](' + encodeURI(r.f) + ') | ' + r.行数 + ' | ' + esc(r.用途) + ' | ' +
      esc(r.暴露 || '—') + ' | ' + esc(r.依赖 || '—') + ' |';
    L.push(line.length > 1 ? line : '');
  }
  L.push('');
  const edges = rows.filter((r) => r.依赖).map((r) => '- ' + r.f + ' → ' + r.依赖);
  if (edges.length) {
    L.push('## 依赖边');
    L.push('');
    L.push(...edges);
    L.push('');
  }
  const missing = rows.filter((r) => r.用途 === '（未标注）').map((r) => r.f);
  if (missing.length) {
    L.push('## 待补头注释');
    L.push('');
    L.push('未声明 `用途:` 的文件：' + missing.join('、'));
    L.push('');
  }
  const text = L.join('\n');
  const target = join(abs, '索引.md');
  const old = existsSync(target) ? readFileSync(target, 'utf8') : null;
  // 工作树可能是 CRLF（core.autocrlf=true / checkout 重写），比对前统一换行符，
  // 否则每次 checkout 后 --check 都会误报 INDEX-STALE。
  const same = old !== null && old.replace(/\r\n/g, '\n') === text;
  if (!same) {
    stale.push(relative(ROOT, target));
    if (!CHECK) { writeFileSync(target, text, 'utf8'); written++; }
  }
}
if (CHECK) {
  if (stale.length) {
    console.log('INDEX-STALE: ' + stale.length + ' 个索引与磁盘不一致');
    for (const s of stale) console.log('  · ' + s.split(sep).join('/'));
    console.log('修复：node tools/gen-index.mjs');
    process.exit(1);
  }
  console.log('index: fresh (' + DIRS.length + ' 个目录已核对)');
} else {
  console.log('gen-index: 更新 ' + written + ' 个索引.md');
  for (const s of stale) console.log('  · ' + s.split(sep).join('/'));
}
