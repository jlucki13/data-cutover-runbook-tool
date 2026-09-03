You're starting a new project: a runbook orchestration platform purpose-built for M&A data-migration cutover events. Two documents are in this repo and are your source of truth:

- `prd-cutover-platform.md` — full product requirements
- `CLAUDE.md` — working rules for this build (read this too, not just the PRD)

Before writing any code, do the following and report back:

1. Read both documents in full.
2. Propose the initial repo structure (backend, frontend, engine module layout) consistent with CLAUDE.md's build order and the "graph engine as an isolated, deterministic module" rule.
3. Draft the core data model (Task, Dependency, Gate, Event, AuditLogEntry from PRD §6.1) as actual schema — pick Postgres + an ORM/schema tool of your choice, and justify the choice briefly if it's not the obvious default.
4. Propose the initial API surface for the CPM/impact-propagation engine specifically: what functions/endpoints does it need to expose (e.g., "given a task ID and a new planned_start, return affected tasks + new critical path + at-risk gates") so the rest of the app can be built against a stable contract.
5. List the specific open questions from PRD §8 that would change your design if answered differently, so I can decide whether to answer them now or let you proceed on stated assumptions.

Do not start on the UI, ingestion parsers, notifications, or dashboards yet — per CLAUDE.md's build order, the engine and data model come first, with unit tests, before anything else. Stop after step 5 above and wait for my go-ahead before implementing.
