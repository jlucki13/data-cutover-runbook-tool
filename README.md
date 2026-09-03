# Cutover Orchestration Platform

Runbook orchestration for M&A data-migration cutover events. Two features carry the
product: flexible dependency ingestion and deterministic live impact simulation.

- Scope and priorities: [`prd-cutover-platform.md`](./prd-cutover-platform.md)
- Working rules for this build: [`CLAUDE.md`](./CLAUDE.md)
- Design notes: [`docs/proposals/`](./docs/proposals/)

## Status

Kickoff. The data model exists as a Postgres schema (`packages/db`); the graph/CPM
engine is specified in [proposal 0001](./docs/proposals/0001-kickoff-architecture.md)
and awaits go-ahead before implementation.

## Local setup

```sh
pnpm install
docker compose up -d postgres          # or any Postgres 16 at DATABASE_URL
cp packages/db/.env.example packages/db/.env
pnpm db:migrate
```

`pnpm typecheck` and `pnpm test` run across all workspace packages.
