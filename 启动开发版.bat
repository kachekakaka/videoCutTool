@echo off
chcp 65001 >nul
title VideoCutTool 开发版
cd /d "%~dp0"
echo ==============================================
echo   正在启动 VideoCutTool 开发热重载模式...
echo ==============================================
npm run dev
pause
