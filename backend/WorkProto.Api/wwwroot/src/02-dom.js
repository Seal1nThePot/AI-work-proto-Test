// ────────── 02-dom.js ──────────「DOM 小工具」
// 用途: DOM 小工具：$ 取元素、esc 转义、cut 截断、fmt 时间、showToast 提示条（toastTimer 内部用）
// 暴露: $ esc cut fmt showToast
// 依赖: 无（toastTimer 仅本文件用）
// 被依赖: 全部脚本

const $ = (id) => document.getElementById(id);

function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;" }[c]));
}

function cut(s, n) {
  const str = String(s ?? "");
  return str.length > n ? str.slice(0, n - 1) + "…" : str;
}

function fmt(iso) {
  if (!iso) return "-";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const p = (x) => String(x).padStart(2, "0");
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

let toastTimer = null;
function showToast(message, ok) {
  const box = $("toast");
  if (!box) return;
  box.className = "toast " + (ok ? "ok" : "err");
  box.innerHTML = esc(message);
  box.style.display = "block";
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { box.style.display = "none"; }, 6000);
}
