@echo off
chcp 65001 >nul
title 合沐进销存 - 新疆合沐纯牛奶
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo [hemu-erp] 未检测到 Node.js，请安装 Node.js 22+ 后重试：https://nodejs.org
  pause
  exit /b 1
)

if not exist node_modules (
  echo [hemu-erp] 首次运行，安装依赖中...
  call npm install --omit=dev
)

echo [hemu-erp] 启动服务 http://localhost:8080
echo [hemu-erp] 手机访问：http://本机IP:8080  （需同一局域网）
node server/index.js
pause
