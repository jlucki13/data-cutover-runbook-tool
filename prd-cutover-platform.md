# PRD: Cutover Orchestration Platform for M&A Data Migration Events

**Status:** Draft v1 — for engineering kickoff
**Owner:** Jordan
**Intended reader:** Claude Code (Fable) — this doc is the build brief

---

## 1. Problem Statement

M&A core-system conversions (banking, insurance, and similar regulated industries) run on cutover weekends: a fixed, high-stakes window where account/customer/product data is migrated from an acquired entity's system onto the acquirer's platform. These events are currently run on generic runbook tools (Cutover.com, spreadsheets, or DR-oriented platforms) that are built for cloud migrations and disaster recovery, not for the specific shape of an M&A conversion:

- Hard, immovable go-live windows (often a single weekend, with a "point of no return")
- Deep task interdependency across data-domain workstreams (accounts → balances → statements → notices)
- Reconciliation and validation gates that must pass before downstream work can start
- Regulatory sign-off and audit trail requirements
- Dependency information that lives in inconsistent formats across workstream owners (spreadsheets, Gantt exports, prose task lists, prior runbooks)

The core unsolved problem: when a task slips or changes during live execution, nobody can quickly and confidently answer "what does this break downstream, and do we still hit our window?" Today that's a person mentally tracing a spreadsheet under time pressure during a live event.

## 2. Goal

Build a runbook orchestration platform, purpose-built for M&A data conversion cutover events, with two core differentiators versus incumbents:

1. **Flexible dependency ingestion** — runbook builders define dependencies in whatever format they already use; the system normalizes them into a single dependency graph.
2. **Live impact simulation** — when any activity's timing or status changes, the system immediately shows the propagated downstream impact (critical path shift, at-risk gates, task owners to notify) before and during live execution.

Everything else (task execution, notifications, dashboards, audit log) is table stakes needed to make the above two features usable in a real event — build them, but don't over-invest relative to the differentiators.

## 3. Target User & Primary Use Case

- **Runbook builder / cutover lead** (e.g., a PM or MD on an M&A integration engagement): defines the plan pre-event, imports dependency data, reviews the generated graph, sets go/no-go gates.
- **Task owner / workstream lead**: executes tasks live, marks complete/blocked, sees only what's relevant to them.
- **Command center / event lead**: watches the live dashboard during the cutover window, makes go/no-go calls, needs instant impact reads when something slips.
- **Compliance / audit reviewer**: needs an immutable record after the fact — what happened, when, who approved what.

Primary use case for v1: a single large cutover event (hundreds to low-thousands of tasks) run over a defined weekend window, planned over the preceding weeks.

## 4. Core Features (v1 scope)

### 4.1 Dependency Ingestion (flexible format)
- Accept dependency definitions via:
  - CSV/spreadsheet upload (column-based: task ID, depends-on IDs)
  - Free-text/prose task lists (e.g., "Task 14 starts after Task 9 and Task 11 complete") — parsed via LLM into structured dependencies
  - Gantt export formats (MS Project XML, common Gantt CSV shapes)
  - Manual entry/edit in-app after import
- All formats normalize into one internal graph model (see §6.1).
- Import produces a **review step**: parsed dependencies shown to the builder for confirmation/correction before they're committed — never silently trust an LLM-parsed dependency into a live plan.
- Support re-import/merge (a workstream owner updates their sheet; system diffs against existing graph rather than overwriting blindly).

### 4.2 Dependency Visualization
- Interactive graph view (DAG) of all tasks and dependencies, filterable by workstream, owner, time window, or status.
- Critical path highlighted by default.
- Timeline/Gantt-hybrid view as an alternate visualization (many cutover leads think in time, not just graph topology).
- Zoom from full-event view down to a single workstream's local dependency neighborhood.

### 4.3 Impact Simulation ("what if this changes")
- Given a proposed or actual change to one task (new start time, duration, delay, status = blocked/failed), compute and display:
  - Every downstream task whose earliest-start time shifts, and by how much
  - Whether the shift breaches any task's defined window/deadline
  - Whether any go/no-go gate is put at risk
  - The new critical path, if it changes
  - Suggested owners to notify (derived from affected tasks' assigned owners)
- Two modes:
  - **Pre-event "what if" mode**: builder tests scenarios against the plan before go-live (no side effects).
  - **Live mode**: when a task owner marks an actual delay/status change, the same computation runs automatically and surfaces impact to the command center in real time.
- Impact computation must be deterministic and auditable (critical-path/scheduling math — not an LLM guess). See §6.2 on where LLM vs. deterministic logic is used.

### 4.4 Runbook Execution
- Task list per owner with clear "what's mine, what's next, what's blocked on me."
- Status states: not started, in progress, blocked, complete, failed/skipped.
- Timestamped audit log of every state change, automatically generated (not manually written).
- Go/no-go decision gates: named checkpoints requiring explicit approval from a designated approver before downstream work is unblocked.

### 4.5 Notifications
- Automated alerts on: task unblocked/ready, task at risk of breaching window, gate awaiting decision, gate decision made.
- Channels: email and Slack for v1 (Teams can follow in v2). Reuse of existing connectors preferred over building bespoke integrations from scratch.

### 4.6 Dashboards & Reporting
- Live event dashboard: overall status, current critical path, at-risk items, open gates.
- Post-event report: full timeline, all status changes, all gate decisions with approver and timestamp — exportable for audit/compliance review.

## 5. Explicitly Out of Scope (v1)

- Cloud migration / DR / release-management use cases (Cutover.com's core markets) — do not generalize the data model toward these; optimize for the M&A conversion shape.
- Multi-tenant SaaS packaging, billing, SSO/enterprise auth beyond basic role-based access — single-org deployment assumption for v1.
- Mobile app (responsive web is sufficient for v1).
- Automated task execution/orchestration (triggering actual migration jobs, e.g., via Jenkins/Ansible) — v1 is planning + tracking + impact analysis, not an execution engine. Integrations to trigger external jobs are a v2 candidate.
- Multi-runbook/multi-tenant portfolio dashboards (Cutover's "Multi Runbook Dashboard") — single event focus first.

## 6. Technical Notes for the Build

### 6.1 Data Model (starting point, expect iteration)
- `Task`: id, name, workstream, owner, planned_start, planned_duration, window_deadline (optional), status, actual_start, actual_end
- `Dependency`: predecessor_task_id, successor_task_id, type (finish-to-start default; support start-to-start/finish-to-finish if source data implies it)
- `Gate`: id, name, gated_tasks (tasks that cannot proceed until gate approved), approver, decision, decision_timestamp
- `Event`: the overarching cutover event; owns all tasks/dependencies/gates for a given cutover
- `AuditLogEntry`: entity_type, entity_id, change, actor, timestamp — append-only

### 6.2 Where LLM vs. deterministic logic belongs
- **Deterministic (do NOT use an LLM for this):** critical path method (CPM) calculation, slack/float calculation, downstream propagation of a time or status change, gate-risk evaluation. This is graph/scheduling math and must be reliable and auditable every time.
- **LLM-assisted:** parsing free-text or inconsistently-structured dependency input into structured `Dependency` records (with mandatory human review before commit); generating plain-language summaries of "what just happened" or "what's at risk" for the dashboard/notifications; drafting stakeholder communications when a gate is at risk.
- Recommend prototyping the LLM-assisted pieces against Claude Opus 5 first; only move to Fable if evals show Opus falling short on the free-text dependency parsing task specifically (this is the most open-ended, reasoning-heavy piece).

### 6.3 Suggested Stack (adjust as Claude Code sees fit)
- Backend: Node/TypeScript or Python — builder's call, optimize for whichever gives the fastest, most maintainable graph-computation layer.
- Graph/critical-path engine: implement as a standalone, well-tested module — this is the trust-critical core of the product and deserves isolated unit tests independent of the rest of the app.
- Frontend: React, with a graph-visualization library (e.g., a DAG/network rendering library) plus a timeline/Gantt view.
- Storage: relational DB (Postgres) — the data model above is inherently relational; a graph DB is not necessary at this scale (hundreds to low-thousands of tasks per event).

## 7. Success Criteria for v1

- A builder can import a real dependency spreadsheet (or messy prose task list) and get a reviewable, corrected dependency graph in under an hour.
- Changing a single task's timing recomputes and displays full downstream impact in near-real-time (target: under a few seconds for an event of ~1,000 tasks).
- A full mock cutover event (e.g., simulate the TRBK-style migration structure: freeze → migrate → validate → switch → rollback-eligible window) can be planned, run, and reported on end-to-end in the tool.

## 8. Open Questions (flag back to Jordan, don't guess)

- Expected event scale (task count) for the largest realistic engagement — affects graph-engine performance targets.
- Which existing dependency source formats are most common on real engagements (worth prioritizing parsers for those first)?
- Auth/access model — is this used solely internally, or does it need to support external client users (e.g., the acquired company's team) with restricted visibility?
- Retention/compliance requirements on the audit log (how long, what export format regulators expect)?
