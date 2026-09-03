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

# Each server runs in its own session so we can kill the whole tree, not just the wrapper.
cleanup() {
  for pid in "${API_PID:-}" "${WEB_PID:-}"; do
    [[ -n "$pid" ]] || continue
    kill -- "-$pid" 2>/dev/null || kill "$pid" 2>/dev/null || true
  done
}
trap cleanup EXIT

free_port() {
  local port="$1"
  local pids
  pids="$(ss -ltnp 2>/dev/null | awk -v p=":$port" '$4 ~ p' | grep -o 'pid=[0-9]*' | cut -d= -f2 | sort -u || true)"
  [[ -n "$pids" ]] && kill $pids 2>/dev/null && sleep 1 || true
}
free_port "$API_PORT"
free_port "$WEB_PORT"

echo "logs: $LOG_DIR"
setsid bash -c "cd apps/api && PORT=$API_PORT exec pnpm exec tsx src/server.ts" >"$API_LOG" 2>&1 &
API_PID=$!

( cd apps/web && pnpm exec vite build ) >"$WEB_LOG" 2>&1
setsid bash -c "cd apps/web && API_URL=http://localhost:$API_PORT exec pnpm exec vite preview --port $WEB_PORT --strictPort" >>"$WEB_LOG" 2>&1 &
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
