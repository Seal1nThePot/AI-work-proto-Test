@echo off
rem 停掉占用 5081 的原型进程
for /f "tokens=5" %%p in ('netstat -ano ^| findstr ":5081" ^| findstr LISTENING') do (
  echo kill pid %%p
  taskkill /PID %%p /F
)
