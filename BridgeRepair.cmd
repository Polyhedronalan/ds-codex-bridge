@echo off
rem ---------------------------------------------------------------------------
rem  One-click Codex Bridge repair.
rem  Clears nothing by hand: it runs tools\bridge-health.ps1 -Repair, which only
rem  ever touches a process it can prove is our own bridge.mjs, then re-checks.
rem ---------------------------------------------------------------------------
setlocal
set "PS=%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe"
set "SCRIPT=%~dp0tools\bridge-health.ps1"

if not exist "%SCRIPT%" (
  echo [BridgeRepair] tools\bridge-health.ps1 not found next to this file.
  echo [BridgeRepair] expected: %SCRIPT%
  echo [BridgeRepair] keep this cmd in the Bridge folder ^(next to bridge.mjs^).
  echo.
  pause
  exit /b 1
)

echo Checking the Codex Bridge and repairing supported local faults.
echo Upstream, account and proxy faults need the targeted guidance in the report.
echo.
"%PS%" -NoProfile -ExecutionPolicy Bypass -File "%SCRIPT%" -Repair -Report
set "RC=%ERRORLEVEL%"
echo [BridgeRepair] exit code = %RC%   ^(0 = no active problem, 2 = see targeted guidance^)
echo.
pause
exit /b %RC%
