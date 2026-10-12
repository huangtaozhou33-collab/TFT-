@echo off
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0start-docker.ps1" %*
if errorlevel 1 (
  echo Startup failed. Read the message above before retrying.
  pause
  exit /b 1
)
