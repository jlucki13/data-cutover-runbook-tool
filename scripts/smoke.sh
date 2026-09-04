#!/usr/bin/env bash
# End-to-end smoke: start the API and the built web app against a seeded database,
# drive the real UI in Chromium, write screenshots to apps/web/smoke-out, then tear down.
#
#   DATABASE_URL=postgres://cutover:cutover@localhost:5432/cutover scripts/smoke.sh
#
# Assumes Postgres is running, migrated (pnpm db:migrate) and seeded
# (pnpm --filter @cutover/api seed).
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"
export DATABASE_URL="${DATABASE_URL:-postgres://cutover:cutover@localhost:5432/cutover}"
API_PORT="${API_PORT:-4000}"
WEB_PORT="${WEB_PORT:-5173}"
LOG_DIR="${LOG_DIR:-$(mktemp -d)}"
API_LOG="$LOG_DIR/api.log"
WEB_LOG="$LOG_DIR/web.log"

# Stop each server and anything it spawned, parent before children so nothing respawns.
# `pgrep -P` rather than process groups: macOS has no setsid.
kill_tree() {
  local pid="$1" child children
  children="$(pgrep -P "$pid" 2>/dev/null || true)"
  kill "$pid" 2>/dev/null || true
  for child in $children; do kill_tree "$child"; done
}
cleanup() {
  for pid in "${API_PID:-}" "${WEB_PID:-}"; do
    [[ -n "$pid" ]] || continue
    kill_tree "$pid"
  done
}
trap cleanup EXIT

# Clear anything left over from a previous run: a stale server silently serves old routes.
# `ss` is Linux, `lsof` is macOS, and neither always sees the owning pid — so match on the
# command line as well, below.
free_port() {
  local port="$1"
  local pids=""
  if command -v ss >/dev/null 2>&1; then
    pids="$(ss -ltnp 2>/dev/null | awk -v p=":$port" '$4 ~ p' | grep -o 'pid=[0-9]*' | cut -d= -f2 | sort -u || true)"
  elif command -v lsof >/dev/null 2>&1; then
    pids="$(lsof -ti "tcp:$port" -sTCP:LISTEN 2>/dev/null || true)"
  fi
  [[ -n "$pids" ]] && kill $pids 2>/dev/null || true
}
free_port "$API_PORT"
free_port "$WEB_PORT"
pkill -f "tsx src/server.ts" 2>/dev/null || true
pkill -f "vite preview" 2>/dev/null || true
sleep 1

echo "logs: $LOG_DIR"
( cd apps/api && PORT=$API_PORT exec node_modules/.bin/tsx src/server.ts ) >"$API_LOG" 2>&1 &
API_PID=$!

( cd apps/web && node_modules/.bin/vite build ) >"$WEB_LOG" 2>&1
( cd apps/web && API_URL=http://localhost:$API_PORT exec node_modules/.bin/vite preview --port "$WEB_PORT" --strictPort ) >>"$WEB_LOG" 2>&1 &
WEB_PID=$!

ready() { curl -sf "http://localhost:$WEB_PORT/" 2>/dev/null | grep -q 'id="root"'; }
for _ in $(seq 1 60); do
  if curl -sf "http://localhost:$API_PORT/health" >/dev/null && ready; then break; fi
  sleep 1
done
curl -sf "http://localhost:$API_PORT/health" >/dev/null || { echo "API did not start:"; tail -20 "$API_LOG"; exit 1; }
ready || { echo "web did not start:"; tail -20 "$WEB_LOG"; exit 1; }

cd apps/web
WEB_URL="http://localhost:$WEB_PORT" node scripts/smoke.mjs
