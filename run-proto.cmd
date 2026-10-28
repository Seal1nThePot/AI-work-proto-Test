@echo off
rem 起原型（自带 SQLite，只读页面在同一进程）—— http://127.0.0.1:5081
setlocal
set PROTO_PORT=5081
set PROTO_DB=%~dp0data\proto.db
if not exist "%~dp0data" mkdir "%~dp0data"
cd /d "%~dp0backend\WorkProto.Api"
dotnet build -v q --nologo || exit /b 1
echo 页面： http://127.0.0.1:5081/   库： %PROTO_DB%
start "" http://127.0.0.1:5081/
dotnet "%~dp0backend\WorkProto.Api\bin\Debug\net10.0\WorkProto.Api.dll"
endlocal
