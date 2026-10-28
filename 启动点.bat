@echo off
chcp 65001 >nul
rem 用途: 一键入口：双击＝构建+起服务+等健康后拉起浏览器新窗口；stop 停；check 跑四条验收；open 只开窗口
rem 暴露: 无
rem 依赖: dotnet SDK、backend\WorkProto.Api、verify\wait-and-open.ps1、Chrome/Edge/Firefox 任一
rem 被依赖: 手工双击、桌面快捷方式
setlocal
cd /d "%~dp0"
set "ARG=%~1"
set "BROWSER="
for %%b in (chrome edge firefox) do if /i "%ARG%"=="%%b" set "BROWSER=%%b"
if /i "%ARG%"=="stop"  goto :stop
if /i "%ARG%"=="check" goto :check
if /i "%ARG%"=="build" goto :build
if /i "%ARG%"=="open"  goto :open
goto :start

:build
echo [1/3] 停旧进程（避免 dll 被锁）
call :stopquiet
echo [2/3] 构建
dotnet build backend\WorkProto.Api\WorkProto.Api.csproj -v q --nologo || goto :buildfail
echo [3/3] 构建完成。
goto :eof

:start
call :build || exit /b 1
set "PROTO_PORT=5081"
set "PROTO_DB=%~dp0data\proto.db"
if not exist "%~dp0data" mkdir "%~dp0data"
echo.
echo 页面： http://127.0.0.1:5081/    库： %PROTO_DB%
echo 浏览器：%BROWSER% （空＝Edge，没装就 Chrome，再没有用系统默认；也可写 chrome / firefox）
echo 服务就在这个窗口跑，关窗口即停。
echo.
rem 先起「等健康再开窗」的助手，再起服务：避免浏览器先打开吃到 ERR_CONNECTION_REFUSED
start "" /min pwsh -NoProfile -WindowStyle Hidden -File "%~dp0verify\wait-and-open.ps1" -Port %PROTO_PORT% -Browser "%BROWSER%"
dotnet "%~dp0backend\WorkProto.Api\bin\Debug\net10.0\WorkProto.Api.dll"
goto :eof

:open
set "PROTO_PORT=5081"
pwsh -NoProfile -File "%~dp0verify\wait-and-open.ps1" -Port 5081 -Browser "%BROWSER%"
goto :eof

:stop
call :stopquiet
echo 已停。
goto :eof

:stopquiet
for /f "tokens=5" %%p in ('netstat -ano ^| findstr ":5081" ^| findstr LISTENING') do taskkill /PID %%p /F >nul 2>&1
goto :eof

:buildfail
echo 构建失败，已中止。
exit /b 1

:check
call :build || exit /b 1
echo.
echo ===== 1/3 接口验收（176） =====
pwsh -NoProfile -File "verify\run-acceptance.ps1" || goto :checkfail
echo.
echo ===== 2/3 页面冒烟（231） =====
pwsh -NoProfile -File "verify\run-ui-smoke.ps1" || goto :checkfail
echo.
echo ===== 3/3 拆分守恒（16） =====
pwsh -NoProfile -File "verify\run-split-check.ps1" || goto :checkfail
echo.
echo 四条全绿。
goto :eof

:checkfail
echo.
echo 有红：先看上面最后一段输出，别跳过。
exit /b 1
