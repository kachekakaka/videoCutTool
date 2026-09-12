@echo off
chcp 65001 >nul
cd /d "%~dp0\.."

echo ========================================================
echo   VideoCutTool Clean Root Launcher Packaging Script
echo ========================================================
echo.

echo [1/4] Clean old build and backup workspace.json...
taskkill /f /im VideoCutTool.exe >nul 2>&1
ping 127.0.0.1 -n 2 >nul
if exist "release\workspace.json" copy /y "release\workspace.json" "%TEMP%\vct_workspace_backup.json" >nul
if exist "release\app" rmdir /s /q "release\app"
if exist "release\win-unpacked" rmdir /s /q "release\win-unpacked"
if exist "release\builder-debug.yml" del /f /q "release\builder-debug.yml"
if exist "release\VideoCutTool.exe" del /f /q "release\VideoCutTool.exe"
if exist "release\VideoCutTool-1.0.0-Portable.exe" del /f /q "release\VideoCutTool-1.0.0-Portable.exe"

echo.
echo [2/4] Compiling frontend, main process and packaging app directory...
call npm run package

if %errorlevel% neq 0 (
  echo.
  echo [ERROR] Build failed! Check compiler logs.
  if exist "%TEMP%\vct_workspace_backup.json" copy /y "%TEMP%\vct_workspace_backup.json" "release\workspace.json" >nul
  if "%1" neq "nopause" pause
  exit /b %errorlevel%
)

echo.
echo [3/4] Organizing release\app and compiling native launcher...
taskkill /f /im VideoCutTool.exe >nul 2>&1
if exist "release\app" rmdir /s /q "release\app"
if exist "release\win-unpacked" move /y "release\win-unpacked" "release\app" >nul
if exist "release\builder-debug.yml" del /f /q "release\builder-debug.yml"

set "CSC_EXE=C:\Windows\Microsoft.NET\Framework64\v4.0.30319\csc.exe"
if not exist "%CSC_EXE%" set "CSC_EXE=C:\Windows\Microsoft.NET\Framework\v4.0.30319\csc.exe"
if not exist "%CSC_EXE%" set "CSC_EXE=csc.exe"

"%CSC_EXE%" /target:winexe /optimize+ /out:"release\VideoCutTool.exe" "scripts\launcher.cs" >nul

if exist "%TEMP%\vct_workspace_backup.json" (
  if not exist "release\workspace.json" copy /y "%TEMP%\vct_workspace_backup.json" "release\workspace.json" >nul
  del /f /q "%TEMP%\vct_workspace_backup.json" >nul
)
if exist "release\workspace.json" copy /y "release\workspace.json" "release\app\workspace.json" >nul

echo.
echo [4/4] Verifying deliverables...
if exist "release\VideoCutTool.exe" (
  echo ========================================================
  echo  [SUCCESS] Clean Root Architecture packaging succeeded!
  echo.
  echo  Entry Launcher:   release\VideoCutTool.exe
  echo  Workspace Pointer: release\workspace.json
  echo  Runtime Folder:   release\app\
  echo ========================================================
) else (
  echo [WARNING] Failed to generate release\VideoCutTool.exe
)

if "%1" neq "nopause" pause
