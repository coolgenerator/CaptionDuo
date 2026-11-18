#!/bin/bash
# 双击启动 CaptionDuo，并用 Chrome 打开控制面板
cd "$(dirname "$0")" || exit 1
PORT="${PORT:-8787}"
(sleep 1; open -a "Google Chrome" "http://127.0.0.1:${PORT}/panel" 2>/dev/null || open "http://127.0.0.1:${PORT}/panel") &
exec node server.js
