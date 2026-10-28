# 拆分守恒检查：拆的是文件，不是函数。任何一条红了都说明这一阶段搬丢了东西。
# 用法：pwsh -File verify\run-split-check.ps1   （退出码 0 = 全过）
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
Push-Location $root
$fail = 0
function Check($name, $actual, $expect, $op = 'eq') {
  $ok = switch ($op) {
    'eq' { $actual -eq $expect }
    'le' { $actual -le $expect }
    'ge' { $actual -ge $expect }
    'range' { $actual -ge $expect[0] -and $actual -le $expect[1] }
  }
  if ($ok) { "  [ok]   {0} = {1}" -f $name, $actual }
  else { $script:fail++; "  [FAIL] {0} = {1}（期望 {2}）" -f $name, $actual, ($expect -join '~') }
}

$src = Get-ChildItem 'backend/WorkProto.Api/wwwroot/src/*.js'
$cs = Get-ChildItem 'backend/WorkProto.Api/Proto.*.cs'
$lineOf = { param($f) (Get-Content -LiteralPath $f.FullName).Count }

'== 前端（src）=='
Check 'src 文件数' $src.Count 30
Check 'function 顶层声明' (Select-String -Path $src.FullName -Pattern '^(async )?function ' -AllMatches).Matches.Count 196
Check '顶层 const/let' (Select-String -Path $src.FullName -Pattern '^(const|let) ' -AllMatches).Matches.Count 29
Check 'document. 引用' (Select-String -Path $src.FullName -Pattern 'document\.' -AllMatches).Matches.Count 20
Check 'render( 调用' (Select-String -Path $src.FullName -Pattern '[^A-Za-z]render\(' -AllMatches).Matches.Count 20
Check '单文件最大行数' (($src | ForEach-Object { & $lineOf $_ } | Measure-Object -Maximum).Maximum) 400 le
Check 'import/export 必须为 0' (Select-String -Path $src.FullName -Pattern '^\s*(import|export)\b' -AllMatches).Matches.Count 0
Check 'app.js 已删除' (Test-Path 'backend/WorkProto.Api/wwwroot/app.js') $false

'== 后端（Proto.*.cs）=='
Check 'Proto.*.cs 文件数' $cs.Count 16
Check 'partial class Proto 声明' (Select-String -Path $cs.FullName -Pattern 'public static partial class Proto' -AllMatches).Matches.Count 12
Check 'public static 出现' (Select-String -Path $cs.FullName -Pattern 'public static' -AllMatches).Matches.Count 64
Check 'private static 出现' (Select-String -Path $cs.FullName -Pattern 'private static' -AllMatches).Matches.Count 45
Check 'record 声明' (Select-String -Path $cs.FullName -Pattern '(public|internal|private) sealed record ' -AllMatches).Matches.Count 35
Check 'Program.cs 的 app.Map' (Select-String -Path 'backend/WorkProto.Api/Program.cs' -Pattern 'app\.Map' -AllMatches).Matches.Count 48
Check '后端行数合计' (($cs | ForEach-Object { & $lineOf $_ } | Measure-Object -Sum).Sum) @(2100, 3000) range

'== 装配与索引 =='
$tags = (Select-String -Path 'backend/WorkProto.Api/wwwroot/index.html' -Pattern '<script src=' -AllMatches).Matches.Count
Check 'index.html 的 script 标签' $tags 30
$idx = & node tools/gen-index.mjs --check 2>&1
if ($LASTEXITCODE -eq 0) { '  [ok]   索引 --check 一致' } else { $script:fail++; '  [FAIL] 索引过期（INDEX-STALE）'; $idx | ForEach-Object { '         ' + $_ } }

''
if ($fail -eq 0) { 'VERDICT: 守恒（{0} 条全过）' -f 16 } else { 'VERDICT: DAMAGE（{0} 条不过）' -f $fail; Pop-Location; exit 1 }
Pop-Location
