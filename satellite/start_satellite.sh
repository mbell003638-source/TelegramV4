#!/usr/bin/env bash
# Unix counterpart of start_satellite.bat.
# Reads VPS_URL / SATELLITE_KEY / SATELLITE_ID from the environment
# (desktop-worker.js already honors those, plus config.json and CLI flags).
set -e

cd "$(dirname "$0")"

echo "Starting ClaudeClaw Satellite Worker..."
if [ -n "${VPS_URL:-}" ]; then
  echo "  VPS_URL=${VPS_URL}"
fi
if [ -n "${SATELLITE_KEY:-}" ]; then
  echo "  SATELLITE_KEY is set"
fi

exec node desktop-worker.js
