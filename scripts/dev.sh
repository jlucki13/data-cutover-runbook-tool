#!/usr/bin/env bash
# One command to get a testable app: dependencies, database, migrations, seed data,
# API and web app. Ctrl-C stops everything.
#
#   scripts/dev.sh
#
# Needs Node 22+, pnpm, and either Docker (for the bundled Postgres 16) or your own
# Postgres reachable at DATABASE_URL.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"
export DATABASE_URL="${DATABASE_URL:-postgres://cutover:cutover@localhost:5432/cutover}"
API_PORT="${API_PORT:-4000}"
WEB_PORT="${WEB_PORT:-5173}"

step() { printf '\n\033[1m▸ %s\033[0m\n' "$*"; }
die() { printf '\n\033[31m%s\033[0m\n' "$*" >&2; exit 1; }

command -v pnpm >/dev/null || die "pnpm not found — install it: npm i -g pnpm"
node -e 'process.exit(parseInt(process.versions.node) >= 22 ? 0 : 1)' || die "Node 22+ required (found $(node -v))"

# A leftover server from a previous run silently serves stale code, and vite refuses the
# port outright. Say which one and what to do, rather than failing at the health check.
port_busy() { node -e '
const net = require("net"), s = net.createServer();
s.once("error", () => process.exit(0));
s.once("listening", () => s.close(() => process.exit(1)));
s.listen(Number(process.argv[1]), "127.0.0.1");
' "$1" 2>/dev/null; }
for p in "$API_PORT" "$WEB_PORT"; do
  port_busy "$p" && die "Port $p is already in use — another copy is probably still running.
Stop it, or pick different ports: API_PORT=4001 WEB_PORT=5174 scripts/dev.sh"
done

step "Installing dependencies"
pnpm install --silent

# Bring up the bundled Postgres unless one is already listening.
if ! node -e '
const net = require("net"), u = new URL(process.env.DATABASE_URL);
const s = net.connect({ host: u.hostname, port: u.port || 5432 });
s.on("connect", () => { s.end(); process.exit(0); });
s.on("error", () => process.exit(1));
setTimeout(() => process.exit(1), 2000);
' 2>/dev/null; then
  command -v docker >/dev/null || die "No Postgres at $DATABASE_URL and Docker is not installed.
Start Postgres 16 yourself and re-run with DATABASE_URL=postgres://user:pass@host:5432/db"
  step "Starting Postgres (docker compose)"
  docker compose up -d postgres
  for i in $(seq 1 60); do
    docker compose exec -T postgres pg_isready -U cutover >/dev/null 2>&1 && break
    [[ $i == 60 ]] && die "Postgres did not become ready"
    sleep 1
  done
fi

step "Applying migrations"
pnpm db:migrate || die "Could not migrate $DATABASE_URL.
If you are using your own Postgres rather than Docker, create the database first and pass
its URL: createdb cutover && DATABASE_URL=postgres://\$(whoami)@localhost:5432/cutover scripts/dev.sh"

step "Seeding demo data"
pnpm --filter @cutover/api seed
pnpm --filter @cutover/api seed:live

# Servers are started through their local binaries rather than `pnpm exec`, so the pid we
# background is the node process itself and not a wrapper that outlives the signal. The API
# runs without `tsx watch` on purpose: the watcher forks the server and restarts it when it
# dies, which on Ctrl-C leaves an orphan still holding the port. This script is for driving
# the app, not editing it — `pnpm --filter @cutover/api dev` is the reloading one.
#
# Ctrl-C still walks the tree for anything that spawns helpers (vite's esbuild), killing
# each parent before its children so nothing gets a chance to respawn. `pgrep -P` is the
# portable way; process groups would need `setsid`, which macOS does not ship.
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
trap cleanup EXIT INT TERM

[[ -x apps/api/node_modules/.bin/tsx && -x apps/web/node_modules/.bin/vite ]] || die "Dependencies look incomplete — run 'pnpm install' and try again."

step "Starting the API on :$API_PORT"
( cd apps/api && PORT=$API_PORT exec node_modules/.bin/tsx src/server.ts ) &
API_PID=$!
for i in $(seq 1 60); do
  curl -sf "http://localhost:$API_PORT/health" >/dev/null && break
  [[ $i == 60 ]] && die "API did not start"
  sleep 1
done

step "Starting the web app on :$WEB_PORT"
( cd apps/web && API_URL=http://localhost:$API_PORT exec node_modules/.bin/vite --port "$WEB_PORT" --strictPort ) &
WEB_PID=$!

cat <<EOF

  Open  http://localhost:$WEB_PORT

  Sign in with one of these (top right — there is no password, see docs/testing-guide.md):
    jordan@example.com   admin          everything
    ops@example.com      builder        plan, import, gates
    cc@example.com       command_center gate decisions, live updates
    bala@example.com     task_owner     own task statuses only
    audit@example.com    auditor        read only

  Events: "TRBK Cutover" (planning, next October) and "Meridian Rehearsal" (live, around now).
  Walkthrough: docs/testing-guide.md          Ctrl-C to stop.

EOF
wait
