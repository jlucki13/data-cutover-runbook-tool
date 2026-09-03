# Cutover Orchestration Platform

Runbook orchestration for M&A data-migration cutover events. Two features carry the
product: flexible dependency ingestion and deterministic live impact simulation.

- Scope and priorities: [`prd-cutover-platform.md`](./prd-cutover-platform.md)
- Working rules for this build: [`CLAUDE.md`](./CLAUDE.md)
- Design notes: [`docs/proposals/`](./docs/proposals/)

## Status

Build step 1 complete. The data model is a Postgres schema (`packages/db`) and the
deterministic CPM / impact engine (`packages/engine`) is implemented with its test
suites. Design and rules: [proposal 0001](./docs/proposals/0001-kickoff-architecture.md).
Next: dependency ingestion (build step 2).

| Package | Purpose |
| --- | --- |
| `@cutover/engine` | Pure scheduling engine: graph validation, CPM, live rules, impact simulation, re-import diff. No I/O, no clock, no dependencies. |
| `@cutover/db` | Drizzle schema, migrations, `createDb()`. |

## Local setup

```sh
pnpm install
docker compose up -d postgres          # or any Postgres 16 at DATABASE_URL
cp packages/db/.env.example packages/db/.env
pnpm db:migrate
```

`pnpm typecheck` and `pnpm test` run across all workspace packages.
