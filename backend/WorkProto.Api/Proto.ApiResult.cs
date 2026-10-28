// ────────── Proto.ApiResult.cs ──────────「统一返回体」
// 用途: 统一返回体：Ok/Created/Fail 三个工厂，端点只返它
// 暴露: ApiResult
// 依赖: 无
// 被依赖: Program.cs、Proto.* 全部端点文件
using System.Text.Json;
using Microsoft.Data.Sqlite;

namespace WorkProto.Api;

public sealed record ApiResult(int Status, object Body)
{
    public static ApiResult Ok(object body) => new(200, body);
    public static ApiResult Created(object body) => new(201, body);

    public static ApiResult Fail(int status, string error, string message, object? details = null)
        => new(status, details is null
            ? new { error, message }
            : new { error, message, details });
}
