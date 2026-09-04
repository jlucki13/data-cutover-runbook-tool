# Cutover Orchestration Platform

Runbook orchestration for M&A data-migration cutover events. Two features carry the
product: flexible dependency ingestion and deterministic live impact simulation.

- Scope and priorities: [`prd-cutover-platform.md`](./prd-cutover-platform.md)
- Working rules for this build: [`CLAUDE.md`](./CLAUDE.md)
- Design notes: [`docs/proposals/`](./docs/proposals/)

## Status

All six build steps complete: engine, data model, ingestion, API, web app, and
notifications, dashboards and post-event reporting. Design and rules:
[proposal 0001](./docs/proposals/0001-kickoff-architecture.md).

| Package | Purpose |
| --- | --- |
| `@cutover/engine` | Pure scheduling engine: graph validation, CPM, live rules, impact simulation, re-import diff. No I/O, no clock, no dependencies. |
| `@cutover/ingest` | Parsers (CSV/TSV, Excel, MS Project XML, LLM prose) and the worksheet compile + diff step. |
| `@cutover/db` | Drizzle schema, migrations, `createDb()`. |
| `@cutover/api` | Fastify API: import → review → commit, graph, schedule, simulation, live updates, audit. |
| `@cutover/notify` | Deterministic notification rules and message rendering. Pure, like the engine. |
| `@cutover/web` | React app: dashboard, dependency graph, timeline, impact simulation, import review, report, audit log. |

## Try it

```sh
scripts/dev.sh
```

Installs, starts Postgres (Docker, or your own at `DATABASE_URL`), migrates, seeds two demo
events — one in planning, one live around the current time — and runs the API and the web
app on http://localhost:5173. Walkthrough for driving it by hand:
[`docs/testing-guide.md`](./docs/testing-guide.md). Sample worksheets to import:
[`docs/sample-imports/`](./docs/sample-imports/).

## Local setup

```sh
pnpm install
docker compose up -d postgres          # or any Postgres 16 at DATABASE_URL
cp packages/db/.env.example packages/db/.env
pnpm db:migrate
```

`pnpm typecheck` and `pnpm test` run across all workspace packages. The API tests need a
reachable Postgres and use their own database (`TEST_DATABASE_URL`, default
`cutover_test` on localhost), which they drop and re-migrate on every run.

## Running the API

```sh
pnpm --filter @cutover/api seed       # TRBK mock event, users, gates — planning, next October (idempotent)
pnpm --filter @cutover/api seed:live  # rehearsal event whose window straddles now, for live mode
pnpm --filter @cutover/api dev        # http://localhost:4000, identify with x-user-email: jordan@example.com
```

### Optional integrations

| Variable | Effect |
| --- | --- |
| `ANTHROPIC_API_KEY` | Enables prose import, the model-worded dashboard summary, and gate comms drafts. Without it the summary falls back to a deterministic one and prose import is refused. |
| `SLACK_WEBHOOK_URL` | Delivers notifications to a Slack incoming webhook. |
| `SMTP_URL`, `SMTP_FROM` | Delivers notifications by email. |
| `PUBLIC_BASE_URL` | Deep links in notification bodies. |

With no channel configured, notifications still queue and "deliver" to the log, so a
deployment without credentials records exactly what it would have sent.

Set `ANTHROPIC_API_KEY` to enable the prose import format. To evaluate the prose parser:
`pnpm --filter @cutover/ingest eval:prose`.

## Running the web app

```sh
pnpm --filter @cutover/web dev        # http://localhost:5173, proxies /api to the API
```

Identify yourself in the top bar with a seeded email (`jordan@example.com` is the admin).
There is no password: development auth is a header, see `apps/api/src/auth.ts`.

`scripts/smoke.sh` starts the API and the built web app against a seeded database, drives
the real UI in Chromium, and writes screenshots to `apps/web/smoke-out/`.
