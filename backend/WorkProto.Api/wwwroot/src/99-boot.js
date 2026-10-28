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
}

$("taskSelect").addEventListener("change", async (e) => {
  state.taskId = e.target.value;
  state.selected = null;
  state.selectedIds = new Set();
  state.fittedFor = null;
  $("sideBody").innerHTML = "";
  closeForm();
  await loadGraph();
});

$("addTaskBtn").addEventListener("click", openTaskForm);
$("addNodeBtn").addEventListener("click", () => { state.pendingPos = null; openNodeForm(); });
$("addEdgeBtn").addEventListener("click", () => openEdgeForm());
$("tplBtn").addEventListener("click", () => openTemplatePanel());
$("arrangeBtn").addEventListener("click", () => arrangeByGroups());
$("overviewBtn").addEventListener("click", () => toggleOverview());
$("fitBtn").addEventListener("click", fitView);
$("refreshBtn").addEventListener("click", () => refresh());

$("autoRefresh").addEventListener("change", (e) => {
  if (state.timer) clearInterval(state.timer);
  state.timer = e.target.checked ? setInterval(() => loadGraph(), 5000) : null;
});

state.timer = setInterval(() => loadGraph(), 5000);
bootstrap();
