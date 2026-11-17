#!/bin/sh
# Plume XPU Console 1.4.0 on Linux or macOS: serves the pages and opens Deer Valley. Needs Node.js or Python 3.
#   ./start.sh                 Deer Valley
#   ./start.sh index.html      the console (also simmy.html, show.html, verify.html)
# SPDX-License-Identifier: GPL-3.0-only
cd "$(dirname "$0")" || exit 1
PAGE="${1:-valley.html}"
URL="http://127.0.0.1:8788/$PAGE"
open_url() {
  if command -v xdg-open >/dev/null 2>&1; then xdg-open "$1" >/dev/null 2>&1 &
  elif command -v open >/dev/null 2>&1; then open "$1"
  else echo "Open $1 in your browser."; fi
}
if command -v node >/dev/null 2>&1; then
  node serve.mjs &
  SERVER=$!
  trap 'kill "$SERVER" 2>/dev/null' EXIT INT TERM
  sleep 1
  open_url "$URL"
  echo "Serving $URL (Ctrl+C stops)."
  wait "$SERVER"
elif command -v python3 >/dev/null 2>&1; then
  python3 -B host/plume_photon.py --page "$PAGE"
  rc=$?
  if [ "$rc" -eq 3 ]; then exec python3 -B host/plume_photon.py --page "$PAGE" --no-photon; fi
  exit "$rc"
else
  echo "Plume needs Node.js or Python 3, and neither was found."
  exit 1
fi
