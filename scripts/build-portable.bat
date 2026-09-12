@echo off
chcp 65001 >nul
where pwsh >nul 2>&1
if errorlevel 1 (
  echo [ERROR] PowerShell 7 is required. Install pwsh and add it to PATH.
  exit /b 1
)
pwsh -NoProfile -File "%~dp0build-portable.ps1"
set "BUILD_EXIT=%errorlevel%"
if /i not "%~1"=="nopause" pause
exit /b %BUILD_EXIT%
