#!/usr/bin/env bash
# AgentDeck 启动入口（macOS / Linux）
# 用法: ./run.sh [--port 48080] [--no-open]
set -euo pipefail
cd "$(dirname "$0")"

# 首次运行自动安装依赖
if [ ! -d node_modules ]; then
  echo "首次运行，安装依赖…"
  npm install
fi

exec npm start -- "$@"
