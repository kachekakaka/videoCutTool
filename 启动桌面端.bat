@echo off
chcp 65001 >nul
title VideoCutTool 启动器
cd /d "%~dp0"
echo ==============================================
echo   正在启动 VideoCutTool 视频裁剪工具桌面端...
echo ==============================================
npx electron .
pause
