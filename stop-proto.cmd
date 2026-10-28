@echo off
rem 用途: 停掉占用 5081 的原型进程（build 前要跑，否则 dll 被锁）
rem 暴露: 无
rem 依赖: netstat / taskkill
rem 被依赖: 手工、重 build 前
for /f "tokens=5" %%p in ('netstat -ano ^| findstr ":5081" ^| findstr LISTENING') do (
  echo kill pid %%p
  taskkill /PID %%p /F
)
