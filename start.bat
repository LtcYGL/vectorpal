@echo off
rem VectorPal launcher: run the pod in background, then open the console.
cd /d "%~dp0"
if exist "%~dp0node.exe" (
  start "" /min "%~dp0node.exe" "%~dp0keepalive.mjs"
) else (
  start "" /min node "%~dp0keepalive.mjs"
)
timeout /t 8 /nobreak >nul
start "" http://127.0.0.1:8090
