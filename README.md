# Cutover Orchestration Platform

Runbook orchestration for M&A data-migration cutover events. Two features carry the
product: flexible dependency ingestion and deterministic live impact simulation.

- Scope and priorities: [`prd-cutover-platform.md`](./prd-cutover-platform.md)
- Working rules for this build: [`CLAUDE.md`](./CLAUDE.md)
- Design notes: [`docs/proposals/`](./docs/proposals/)

## Status

Build steps 1 and 2 complete: engine, data model, ingestion pipeline and the API import
workflow. Design and rules: [proposal 0001](./docs/proposals/0001-kickoff-architecture.md).
Next: visualization (build step 3).

| Package | Purpose |
| --- | --- |
| `@cutover/engine` | Pure scheduling engine: graph validation, CPM, live rules, impact simulation, re-import diff. No I/O, no clock, no dependencies. |
| `@cutover/ingest` | Parsers (CSV/TSV, Excel, MS Project XML, LLM prose) and the worksheet compile + diff step. |
| `@cutover/db` | Drizzle schema, migrations, `createDb()`. |
| `@cutover/api` | Fastify API: import → review → commit, graph, schedule, simulation, live updates, audit. |

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
pnpm --filter @cutover/api seed     # TRBK mock event, users, gates (idempotent)
pnpm --filter @cutover/api dev      # http://localhost:4000, identify with x-user-email: jordan@example.com
```

Set `ANTHROPIC_API_KEY` to enable the prose import format. To evaluate the prose parser:
`pnpm --filter @cutover/ingest eval:prose`.
