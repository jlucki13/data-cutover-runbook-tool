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
pnpm db:migrate

step "Seeding demo data"
pnpm --filter @cutover/api seed
pnpm --filter @cutover/api seed:live

# Each server runs in its own process group so Ctrl-C takes the whole tree with it.
cleanup() {
  for pid in "${API_PID:-}" "${WEB_PID:-}"; do
    [[ -n "$pid" ]] || continue
    kill -- "-$pid" 2>/dev/null || kill "$pid" 2>/dev/null || true
  done
}
trap cleanup EXIT INT TERM

step "Starting the API on :$API_PORT"
setsid bash -c "cd apps/api && PORT=$API_PORT exec pnpm exec tsx watch src/server.ts" &
API_PID=$!
for i in $(seq 1 60); do
  curl -sf "http://localhost:$API_PORT/health" >/dev/null && break
  [[ $i == 60 ]] && die "API did not start"
  sleep 1
done

step "Starting the web app on :$WEB_PORT"
setsid bash -c "cd apps/web && API_URL=http://localhost:$API_PORT exec pnpm exec vite --port $WEB_PORT --strictPort" &
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
