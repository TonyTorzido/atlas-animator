@echo off
rem Starts the Atlas Animator editor (if it is not already running) and opens it in the browser.
rem Double-click this file. No terminal needed. The editor runs detached and keeps running after this window closes.
rem Add -Port 5300 etc. to use another port, -Stop to stop the editor on that port.
setlocal
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0start-atlas-animator.ps1" %*
set "AA_EXIT=%ERRORLEVEL%"
if not "%AA_EXIT%"=="0" (
  echo.
  echo Atlas Animator did not start. The log is in the logs folder of your Atlas Animator data folder (default: Documents\Atlas Animator\logs)
  pause
)
exit /b %AA_EXIT%
