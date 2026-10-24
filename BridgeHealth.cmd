@echo off
rem ---------------------------------------------------------------------------
rem  One-click Codex Bridge health check (read-only).
rem  Chinese text is printed by tools\bridge-health.ps1 - this file stays ASCII so
rem  that cmd.exe never has to guess an encoding.
rem ---------------------------------------------------------------------------
setlocal
set "PS=%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe"
set "SCRIPT=%~dp0tools\bridge-health.ps1"

if not exist "%SCRIPT%" (
  echo [BridgeHealth] tools\bridge-health.ps1 not found next to this file.
  echo [BridgeHealth] expected: %SCRIPT%
  echo [BridgeHealth] keep this cmd in the Bridge folder ^(next to bridge.mjs^).
  echo.
  pause
  exit /b 1
)

"%PS%" -NoProfile -ExecutionPolicy Bypass -File "%SCRIPT%" -Report
set "RC=%ERRORLEVEL%"
echo [BridgeHealth] exit code = %RC%   ^(0 = OK, 2 = needs repair^)
echo.
pause
exit /b %RC%
