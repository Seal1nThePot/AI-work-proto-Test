// ────────── 99-boot.js ──────────「启动与顶栏接线」
// 用途: 启动：顶栏 10 个按钮接线、5 秒轮询、bootstrap（拉 /api/health → bindSvgEvents → 载任务 → 载图）
// 暴露: bootstrap（其余为顶层语句）
// 依赖: 全部 src 文件
// 被依赖: index.html（最后一个 <script>）

async function bootstrap() {
  const h = await api("/api/health");
  if (h.ok) $("dbNote").textContent = "库：" + (h.body.databasePath || "");
  bindSvgEvents();
  await loadTasks();
  await loadGraph();
  await loadViewLayers();
  renderViewPanel();
}

$("taskSelect").addEventListener("change", async (e) => {
  const prev = state.taskId;
  const next = e.target.value;
  if (next === prev) return;
  const ok = await guardViewDirty();
  if (!ok) { e.target.value = prev; return; }
  state.taskId = next;
  state.selected = null;
  state.selectedIds = new Set();
  state.fittedFor = null;
  $("sideBody").innerHTML = "";
  closeForm();
  resetViewState();
  await loadGraph();
  await loadViewLayers();
});

$("addTaskBtn").addEventListener("click", openTaskForm);
$("addNodeBtn").addEventListener("click", () => { state.pendingPos = null; openNodeForm(); });
$("addEdgeBtn").addEventListener("click", () => openEdgeForm());
$("tplBtn").addEventListener("click", () => openTemplatePanel());
$("viewMenuBtn").addEventListener("click", (e) => openViewMenu(e));
$("fitBtn").addEventListener("click", fitView);
$("refreshBtn").addEventListener("click", () => refresh());

$("bundleFile").addEventListener("change", async () => {
  const input = $("bundleFile");
  const file = input.files && input.files[0];
  if (file) await importBundleFile(file);
  input.value = "";
});

$("autoRefresh").addEventListener("change", (e) => {
  if (state.timer) clearInterval(state.timer);
  state.timer = e.target.checked ? setInterval(() => loadGraph(), 5000) : null;
});

state.timer = setInterval(() => loadGraph(), 5000);
bootstrap();
