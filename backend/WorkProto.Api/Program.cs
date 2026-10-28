// ────────── Program.cs ──────────「端点表」
// 用途: 40 个端点的接线与请求体绑定，一一对上 docs\api.md 的端点表
// 暴露: 无（顶层语句）
// 依赖: Proto.*.cs（15 个 partial 文件）
// 被依赖: run-proto.cmd、verify 脚本
using WorkProto.Api;

// content root 钉在程序目录：直接 dotnet WorkProto.Api.dll 也能找到 wwwroot
var builder = WebApplication.CreateBuilder(new WebApplicationOptions
{
    ContentRootPath = AppContext.BaseDirectory
});

var port = Environment.GetEnvironmentVariable("PROTO_PORT");
if (!string.IsNullOrWhiteSpace(port))
    builder.WebHost.UseUrls($"http://127.0.0.1:{port}");

builder.Logging.SetMinimumLevel(LogLevel.Warning);
var app = builder.Build();

ProtoDb.EnsureSchema();

app.UseDefaultFiles();
app.UseStaticFiles();

static IResult Done(ApiResult r) => Results.Json(r.Body, statusCode: r.Status);

app.MapGet("/api/health", () => Done(ApiResult.Ok(new
{
    status = "ok",
    databasePath = ProtoDb.DbPath,
    note = "原型数据，不用于判断真实任务完成"
})));

app.MapGet("/api/tasks", () => Done(Proto.ListTasks()));

app.MapPost("/api/tasks", (CreateTaskRequest req) => Done(Proto.CreateTask(req)));

app.MapDelete("/api/tasks/{id}", (string id) => Done(Proto.DeleteTask(id)));

// 图增量：新建节点 / 新建连线（规则与建图同一套）
app.MapPost("/api/tasks/{id}/nodes", (string id, NodeSpec req) => Done(Proto.AddNode(id, req, "api")));

app.MapPost("/api/tasks/{id}/edges", (string id, EdgeSpec req) => Done(Proto.AddEdge(id, req, "api")));

// 连线本身：点它就看/改走向·类型·端口·门控；人工门控要人点头
app.MapGet("/api/edges/{id}", (string id) => Done(Proto.GetEdge(id)));

app.MapPost("/api/edges/{id}", (string id, EdgePatchRequest req) => Done(Proto.UpdateEdge(id, req, "api")));

app.MapDelete("/api/edges/{id}", (string id) => Done(Proto.DeleteEdge(id, "api")));

app.MapPost("/api/edges/{id}/confirm", (string id, ByRequest? req) => Done(Proto.ConfirmEdgeGate(id, req ?? new ByRequest("api", null), "api")));

app.MapPost("/api/tasks/{id}/cycles", (string id, CycleSpec req) => Done(Proto.AddCycle(id, req, "api")));

// 画布位置：拖动后落坐标（展示状态，不写 events）；批量版给框选一起拖
app.MapPost("/api/nodes/{id}/move", (string id, MoveRequest req) => Done(Proto.MoveNode(id, req)));

app.MapPost("/api/tasks/{id}/layout", (string id, MoveBatchRequest req) => Done(Proto.MoveNodes(id, req)));

app.MapDelete("/api/nodes/{id}", (string id) => Done(Proto.DeleteNode(id, "api")));

// 节点属性（点节点就能改）：标题 / 一行目标 / 类型 / 循环区
app.MapPost("/api/nodes/{id}/props", (string id, NodePatchRequest req) => Done(Proto.UpdateNode(id, req, "api")));

// 节点组（右键多选建，纯视觉分组，不参与执行）
app.MapPost("/api/tasks/{id}/node-groups", (string id, NodeGroupSpec req) => Done(Proto.CreateNodeGroup(id, req, "api")));

// 把组声明成循环区（组＋回边＋检查点），以及撤销
app.MapPost("/api/node-groups/{id}/loop", (string id, LoopSpecRequest req) => Done(Proto.DeclareLoop(id, req, "api")));

app.MapDelete("/api/node-groups/{id}/loop", (string id) => Done(Proto.UndoLoop(id, "api")));

// 收纳/展开只是看图状态
app.MapPost("/api/node-groups/{id}/collapse", (string id, CollapseRequest req) => Done(Proto.SetGroupCollapsed(id, req)));

// 单个节点收纳：0 完整 / 1 仅标题 / 2 仅关键字
app.MapPost("/api/nodes/{id}/compact", (string id, CompactRequest req) => Done(Proto.SetNodeCompact(id, req)));

// withNodes=true 才连节点一起删（组里有一个删不起就整批不动）
app.MapDelete("/api/node-groups/{id}", (string id, bool? withNodes) =>
    Done(Proto.DeleteNodeGroup(id, "api", withNodes ?? false)));

// 接线口数量（每个节点可自定义，1–12）
app.MapPost("/api/nodes/{id}/ports", (string id, PortsRequest req) => Done(Proto.UpdatePorts(id, req)));

app.MapGet("/api/tasks/{id}/graph", (string id) => Done(Proto.GetGraph(id)));

// 预设（模板库，跨任务复用）：一次存、到处套
app.MapGet("/api/templates", () => Done(Proto.ListTemplates()));

app.MapPost("/api/templates/nodes", (NodeTemplateSpec req) => Done(Proto.CreateNodeTemplate(req, "api")));

app.MapDelete("/api/templates/nodes/{id}", (string id) => Done(Proto.DeleteNodeTemplate(id, "api")));

app.MapPost("/api/templates/groups", (GroupTemplateSpec req) => Done(Proto.CreateGroupTemplate(req, "api")));

app.MapDelete("/api/templates/groups/{id}", (string id) => Done(Proto.DeleteGroupTemplate(id, "api")));

app.MapPost("/api/tasks/{id}/apply-node-template", (string id, ApplyTemplateRequest req) => Done(Proto.ApplyNodeTemplate(id, req, "api")));

app.MapPost("/api/tasks/{id}/apply-group-template", (string id, ApplyTemplateRequest req) => Done(Proto.ApplyGroupTemplate(id, req, "api")));

app.MapPost("/api/tasks/{id}/claim", (string id, ClaimRequest? req) =>
    Done(Proto.Claim(id, req?.Agent ?? Environment.GetEnvironmentVariable("PROTO_AGENT") ?? "dsh-root")));

app.MapPost("/api/tasks/{id}/release", (string id, ClaimRequest? req) =>
    Done(Proto.ReleaseLease(id, req?.Agent ?? "dsh-root")));

app.MapPost("/api/tasks/{id}/checkpoint", (string id, CheckpointRequest req) => Done(Proto.Checkpoint(id, req)));

app.MapPost("/api/tasks/{id}/pick", (string id, PickRequest req) => Done(Proto.Pick(id, req)));

app.MapGet("/api/nodes/{id}", (string id) => Done(Proto.GetNode(id)));

app.MapPost("/api/nodes/{id}/start", (string id, ByRequest? req) => Done(Proto.StartNode(id, req?.By ?? "api")));

app.MapPost("/api/nodes/{id}/complete", (string id, ByRequest? req) => Done(Proto.CompleteNode(id, req?.By ?? "api")));

app.MapPost("/api/nodes/{id}/rework", (string id, ByRequest? req) => Done(Proto.ReworkNode(id, req?.By ?? "api", req?.Reason)));

app.MapPost("/api/nodes/{id}/unblock", (string id, ByRequest req) => Done(Proto.Unblock(id, req)));

app.MapPost("/api/cycles/{id}/raise", (string id, RaiseRequest req) => Done(Proto.RaiseLimit(id, req)));

app.Logger.LogInformation("WorkProto on {Urls}, db={Db}", string.Join(",", app.Urls.DefaultIfEmpty("http://127.0.0.1:5081")), ProtoDb.DbPath);
app.Run();
