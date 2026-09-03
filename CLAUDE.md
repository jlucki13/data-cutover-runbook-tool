# CLAUDE.md

Guidance for Claude Code working in this repo. Read this alongside `prd-cutover-platform.md` before starting any work — the PRD is the source of truth for scope and priorities; this file is how to work within that scope.

## What this project is

A runbook orchestration platform purpose-built for M&A data-migration cutover events. Two features carry the product: flexible dependency ingestion (§4.1 of the PRD) and live impact simulation (§4.2/4.3). Everything else exists to make those two usable in a real, live cutover event. When in doubt about where to spend effort, spend it there first.

## Non-negotiable architectural rule

**The critical-path/impact-propagation engine is deterministic code, never an LLM call.** This is scheduling math (CPM, slack/float, downstream propagation) and it must return the same answer every time, be unit-testable in isolation, and be auditable. LLM calls are for parsing messy input and generating human-readable summaries — never for computing whether a gate is at risk or what the new critical path is. If a task seems to require an LLM to "decide" something about scheduling impact, stop and flag it rather than implementing it that way.

## Build order

1. Data model + graph/CPM engine, with unit tests, before any UI. This is the trust-critical core (PRD §6.1–6.2) — get it right and well-tested in isolation first.
2. Dependency ingestion pipeline (CSV/spreadsheet parser first, since it's fully deterministic; free-text LLM parser second, with the mandatory human-review step before any parsed dependency is committed to the graph).
3. Dependency visualization (graph + timeline views).
4. Impact simulation UI, wired to the engine from step 1.
5. Task execution, statuses, audit log.
6. Gates, notifications, dashboards, post-event reporting.

Don't build execution/notifications/dashboards ahead of the engine and ingestion — they're meaningless without a trustworthy graph underneath them.

## Model usage inside the product (not the coding agent — that's you)

For any in-app LLM call (free-text dependency parsing, at-risk summaries, draft comms), default to Claude Opus 5 via the API. Only escalate to Fable if an eval shows Opus falling short specifically on the free-text dependency parsing task. Never let the app's LLM calls make scheduling decisions — see the non-negotiable rule above.

## Working style for this build

- This is a long-running, multi-session build. Keep me posted on what you're doing and why as you go, especially before making an architectural choice not already specified in the PRD.
- When the PRD is ambiguous or silent (see PRD §8 open questions), don't guess silently — flag the assumption you're making and keep going, rather than blocking on it.
- Fix root causes, not symptoms — if a bug in the CPM engine surfaces from a bad assumption in the data model, fix the data model, don't patch around it in the UI layer.
- Every change to the CPM/propagation engine needs a corresponding unit test. This is the one part of the codebase where "looks right in the UI" is not sufficient verification.
- Prefer Postgres + a relational schema per PRD §6.3 unless you hit a concrete reason a graph DB is needed at our stated scale (hundreds to low-thousands of tasks per event) — don't reach for a graph DB by default.

## Out of scope reminders

Don't generalize toward cloud migration/DR/release-management use cases, multi-tenant SaaS/billing, SSO, mobile app, or automated execution-triggering (e.g., kicking off Jenkins/Ansible jobs) — see PRD §5. If a feature request during the build smells like scope creep toward those, flag it rather than building it.
