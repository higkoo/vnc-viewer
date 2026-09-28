#!/bin/bash
# 开发模式：打包成未打包目录然后运行
# 这样能确保 require('electron') 正确解析
set -e

cd "$(dirname "$0")/.."

echo "=== Building ==="
npm run build

echo "=== Packing (dir mode) ==="
npx electron-builder --dir --publish never

echo "=== Finding and launching app ==="
APP_DIR="release/mac-arm64"
if [ ! -d "$APP_DIR" ]; then
  # Fallback: try other arch
  APP_DIR="release/mac"
fi

APP="$APP_DIR/VNC Viewer.app"
if [ ! -d "$APP" ]; then
  echo "ERROR: Cannot find packed app in $APP_DIR"
  ls "$APP_DIR"
  exit 1
fi

echo "=== Launching: $APP ==="
"$APP/Contents/MacOS/VNC Viewer"
