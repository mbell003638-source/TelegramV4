#!/usr/bin/env bash
# Dual launcher: bridge API (node index.js) + WebUI (webui/).
# macOS / Linux. No apt/winget — assumes node and npm are already on PATH.
set -e

cd "$(dirname "$0")"
ROOT="$(pwd)"

PIDS=()

cleanup() {
  trap - EXIT INT TERM
  local pid
  for pid in "${PIDS[@]}"; do
    kill "$pid" 2>/dev/null || true
  done
  wait 2>/dev/null || true
}
trap cleanup EXIT INT TERM

BRIDGE_PORT="${DASHBOARD_PORT:-3141}"
WEBUI_ORIGIN="${WEBUI_ORIGIN:-http://127.0.0.1:3000}"

echo "Starting Agent OS — two processes (bridge + WebUI)"

node index.js &
PIDS+=("$!")

if [ -d "$ROOT/webui/.next" ]; then
  echo "WebUI: npm run start (webui/.next found)"
  npm run start --prefix webui &
else
  echo "WebUI: npm run dev (no webui/.next — production build not present)"
  npm run dev --prefix webui &
fi
PIDS+=("$!")

echo ""
echo "  WebUI (Mission Control): ${WEBUI_ORIGIN}"
echo "  Bridge API:              http://127.0.0.1:${BRIDGE_PORT}"
echo "  Legacy HUD:              http://127.0.0.1:${BRIDGE_PORT}/legacy"
echo ""
echo "Two processes, one UI. Ctrl+C stops both."

wait
