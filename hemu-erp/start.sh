#!/usr/bin/env bash
# 合沐进销存 · 一键启动（Linux / macOS）
set -e
cd "$(dirname "$0")"

if ! command -v node >/dev/null 2>&1; then
  echo "[hemu-erp] 未检测到 Node.js，请安装 Node.js 22+ 后重试：https://nodejs.org"
  exit 1
fi

NODE_MAJOR=$(node -p "process.versions.node.split('.')[0]")
if [ "$NODE_MAJOR" -lt 22 ]; then
  echo "[hemu-erp] 警告：当前 Node $(node -v)，系统要求 Node 22+（依赖内置 node:sqlite）"
fi

if [ ! -d node_modules ]; then
  echo "[hemu-erp] 首次运行，安装依赖中…"
  npm install --omit=dev
fi

echo "[hemu-erp] 启动服务 http://localhost:8080"
exec node server/index.js
