# Proposal 0001 — Kickoff: repo structure, data model, engine contract

**Status:** Awaiting go-ahead from Jordan before engine implementation begins.
**Inputs:** `prd-cutover-platform.md`, `CLAUDE.md`, `docs/kickoff-prompt.md`.

This answers steps 2–5 of the kickoff prompt. Per CLAUDE.md's build order, nothing
beyond the schema exists yet: no engine code, no UI, no parsers, no notifications.

What is in the repo right now:

| Path | What it is |
| --- | --- |
| `packages/db/src/schema.ts` | The data model as a real Drizzle/Postgres schema (step 3). |
| `packages/db/drizzle/0000_init.sql` | Generated DDL from that schema. |
| `packages/db/drizzle/0001_audit_log_append_only.sql` | Hand-written migration: triggers that reject UPDATE/DELETE/TRUNCATE on the audit log. |
| `docker-compose.yml` | Local Postgres 16. |

Both migrations were applied to a local Postgres 16 and smoke-tested: self-loop
dependency rejected, duplicate task ref rejected, gate decided without timestamp
rejected, and UPDATE/DELETE/TRUNCATE on `audit_log_entry` all rejected by trigger.

---

## 1. Stack decision

**TypeScript monorepo (pnpm workspaces).** Engine, API, and web share one language, so
the engine's types are the API's DTOs and the UI's simulation types with no translation
layer. CPM on a few thousand tasks is trivial in either TS or Python; the deciding
factor is that the impact-simulation UI needs to call the same engine contract the
server does, and shipping the engine to the browser for instant pre-event what-if is a
free option in TS.

**Postgres + Drizzle ORM.** Drizzle over Prisma because the schema is written as plain
TypeScript that maps 1:1 to SQL, migrations are readable SQL files we can hand-edit
(we already needed that for the append-only triggers), and it stays out of the way
when we want raw SQL for reporting queries. No graph database, per CLAUDE.md.

**Fastify** for the API (schema-validated routes, WebSocket plugin for live impact
pushes). **React + Vite** for the web app. Graph rendering library is decided at build
step 3; leading candidates are React Flow with ELK layout for the DAG and a purpose-
built SVG timeline for the Gantt-hybrid view. In-app LLM calls go through the
Anthropic SDK with Claude Opus 5 as default, per CLAUDE.md.

---

## 2. Repo structure

```
cutover-platform/
├── prd-cutover-platform.md        # source of truth for scope
├── CLAUDE.md                      # working rules
├── docs/
│   ├── kickoff-prompt.md
│   └── proposals/                 # numbered design notes; this file is 0001
├── packages/
│   ├── engine/    @cutover/engine # PURE. Zero runtime deps. No DB, no clock, no I/O.
│   │   ├── src/
│   │   │   ├── types.ts           # GraphInput, Schedule, Change, ImpactReport (the contract, §4)
│   │   │   ├── graph.ts           # buildGraph, cycle detection, topological order
│   │   │   ├── cpm.ts             # forward/backward pass, float, critical path
│   │   │   ├── live.ts            # live-mode rules (actuals, held tasks, gates)
│   │   │   ├── simulate.ts        # applyChanges + diffSchedules → ImpactReport
│   │   │   └── merge.ts           # diffGraphInputs for re-import
│   │   └── test/                  # vitest; fixtures incl. TRBK-style mock event
│   ├── db/        @cutover/db     # Drizzle schema, migrations, createDb()
│   └── shared/    @cutover/shared # zod DTOs for API ⇄ web (added at build step 2)
├── apps/
│   ├── api/       @cutover/api    # Fastify. Thin adapters: load graph → call engine → persist run.
│   │   └── src/ingest/            # csv/, msproject/, prose-llm/ parsers → import_candidate_* rows
│   └── web/       @cutover/web    # React. graph view, timeline, simulation panel, owner list, dashboard
└── docker-compose.yml
```

Dependency direction is strict: `engine` imports nothing from the workspace. `db`
imports nothing from the workspace. `api` imports `engine`, `db`, `shared`. `web`
imports `engine` (for client-side what-if) and `shared`. Nothing imports from `api`.

---

## 3. Data model

Thirteen tables. Column-level detail and comments are in `packages/db/src/schema.ts`;
this section covers the decisions.

| Table | Purpose |
| --- | --- |
| `app_user` | People. Role enum: builder, task_owner, command_center, auditor. Slack ID for notifications. |
| `event` | The cutover event. Window start/end, display timezone, status planning/live/closed. |
| `workstream` | Named lane within an event (accounts, balances, statements…). |
| `task` | The node. Builder intent, live actuals, provenance. See semantics below. |
| `dependency` | Directed edge. Type FS/SS/FF/SF, lag minutes, provenance. |
| `gate` | Go/no-go checkpoint. Approver, target decision time, decision, point-of-no-return flag. |
| `gate_task` | Links tasks to a gate with role `entry` (must finish before decision) or `gated` (cannot start until go). |
| `schedule_run` | One engine execution: baseline, live, or scenario. Stores the trigger and the `ImpactReport`. |
| `schedule_task_result` | Per-task engine output for a run: early/late start/finish, float, critical flag, breach, held reason. |
| `import_batch` | One upload. Format, raw content retained, parser/model version, status through review to commit. |
| `import_candidate_task` | Staged task rows from an import, matched to existing tasks by ref. |
| `import_candidate_dependency` | Staged edges with LLM confidence, source evidence text, diff kind, review state. |
| `audit_log_entry` | Append-only. Entity, action, before/after JSON, actor, linked schedule run. |

### Decisions that differ from or refine PRD §6.1

1. **Engine output is stored separately from tasks.** `task` holds only what humans
   set (planned_*, actual_*, status). Computed times live in `schedule_task_result`
   keyed by run. This is what makes baseline vs. live vs. what-if comparable, makes
   every impact report reproducible from stored inputs, and keeps the engine from
   ever mutating plan data.

2. **`planned_start` is a "start no earlier than" constraint, not a fixed start.** The
   engine computes early start as the later of that constraint and what predecessors
   allow. This matches MS Project semantics and how cutover plans are actually
   written ("batch window opens 02:00 Saturday"). Null means "as early as possible."
   Flagged as open question 5 below because it changes the math if you disagree.

3. **Gates are graph nodes with two edge roles.** PRD lists only `gated_tasks`. A gate
   also needs *entry* criteria (the reconciliation tasks that must pass before anyone
   can decide) or the engine cannot compute when a gate becomes decidable, which is
   the whole basis of "is this gate at risk." Hence `gate_task.role ∈ {entry, gated}`.

4. **Point of no return is a flag on a gate,** not a timestamp on the event. It is a
   decision someone makes, so it needs an approver and an audit entry like any gate.

5. **Task status splits `failed` and `skipped`.** PRD has "failed/skipped" as one
   state. They propagate differently: failed holds successors; skipped lets them
   proceed. Both are recorded distinctly for the audit report.

6. **Two engine-specific task fields added:** `remaining_duration_minutes` (owner's
   live re-estimate for in-progress work, the single most common live input) and
   `status_note` (why blocked; surfaces in notifications).

7. **`ref` is the human ID from the source plan and the merge key for re-import.**
   Unique per event. All import diffs key on it; UUIDs are internal only.

8. **Dependencies carry lag/lead** (`lag_minutes`, signed) because Gantt exports
   routinely encode `14FS+2h`. Ignoring it would silently corrupt imported plans.

9. **Provenance on committed rows.** `source` and `import_batch_id` on task and
   dependency, and `raw_content` plus parser/model version on the batch, so an
   auditor can trace any edge back to the row or sentence that produced it.

10. **Append-only audit log enforced in the database**, not just by convention
    (migration 0001). `event_id` on the log is `ON DELETE RESTRICT` so an event cannot
    be deleted out from under its history.

11. **All timestamps are `timestamptz` in UTC**; the event carries an IANA timezone
    for display only. Durations and lags are integer minutes.

Not yet modeled, deliberately, until their build step: notifications outbox
(step 6), user-to-workstream visibility restrictions (depends on open question 3).

---

## 4. Engine contract (`@cutover/engine`)

The engine is a pure module: plain-data in, plain-data out, no database types, no
`Date.now()`. Times are epoch milliseconds in UTC, durations are integer minutes, and
the caller always passes `asOf`. Same input, same output, byte for byte.

### 4.1 Input types

```ts
type TaskId = string; type GateId = string;
type DependencyType = 'FS' | 'SS' | 'FF' | 'SF';
type TaskStatus = 'not_started' | 'in_progress' | 'blocked' | 'complete' | 'failed' | 'skipped';

interface EngineTask {
  id: TaskId; ref: string; name: string;
  ownerId?: string; workstreamId?: string;
  plannedStart?: number;              // start-no-earlier-than constraint
  plannedDurationMinutes: number;
  windowDeadline?: number;            // hard per-task deadline
  status: TaskStatus;
  actualStart?: number; actualEnd?: number;
  remainingDurationMinutes?: number;  // live re-estimate for in_progress
}
interface EngineDependency { predecessorId: TaskId; successorId: TaskId; type: DependencyType; lagMinutes: number }
interface EngineGate {
  id: GateId; name: string;
  entryTaskIds: TaskId[]; gatedTaskIds: TaskId[];
  decision: 'pending' | 'go' | 'no_go'; decidedAt?: number;
  targetDecisionAt?: number; isPointOfNoReturn: boolean;
}
interface GraphInput { event: { windowStart: number; windowEnd: number }; tasks: EngineTask[]; dependencies: EngineDependency[]; gates: EngineGate[] }
```

### 4.2 Functions

```ts
// 1. Build and validate. Fatal errors stop everything; a graph with a cycle never reaches CPM.
buildGraph(input: GraphInput): { ok: true; graph: Graph } | { ok: false; errors: GraphError[] }
//   GraphError.kind: 'unknown_task' | 'self_loop' | 'duplicate_edge' | 'cycle' (with the ref path) | 'gate_unknown_task' | 'gate_task_both_roles'
validateGraph(graph: Graph): GraphWarning[]
//   Non-fatal: orphan task, deadline before window start, task with no owner, gate with no entry tasks, etc.

// 2. Schedule. Mode 'plan' ignores actuals; mode 'live' applies the rules in §4.3.
computeSchedule(graph: Graph, opts: { mode: 'plan' | 'live'; asOf: number }): Schedule

interface Schedule {
  mode: 'plan' | 'live'; asOf: number;
  tasks: Record<TaskId, TaskTiming>;
  gates: Record<GateId, GateProjection>;
  criticalPath: TaskId[];                 // canonical longest zero-float path (deterministic tiebreak)
  criticalTaskIds: TaskId[];              // every zero-or-negative-float task, when paths branch
  projectedFinish?: number;               // undefined if any sink is held
  eventWindowBreachMinutes: number;       // > 0 means we miss the window by this much
  deadlineBreaches: { taskId: TaskId; minutes: number }[];
}
interface TaskTiming {
  earlyStart?: number; earlyFinish?: number; lateStart?: number; lateFinish?: number;
  totalFloatMinutes?: number; isCritical: boolean;
  deadlineBreachMinutes?: number;
  held?: { reason: 'blocked_upstream' | 'failed_upstream' | 'gate_pending' | 'gate_no_go'; byTaskIds?: TaskId[]; byGateId?: GateId };
}
interface GateProjection {
  gateId: GateId;
  projectedReadyAt?: number;              // when all entry tasks are projected to finish
  slackMinutes?: number;                  // targetDecisionAt − projectedReadyAt
  status: 'ok' | 'at_risk' | 'breached' | 'held' | 'decided_go' | 'decided_no_go';
  heldTaskIds: TaskId[];                  // gated tasks currently waiting on this gate
}

// 3. Simulate. Pure: returns a new schedule and the delta. Used by both what-if (pre-event) and live mode.
type Change =
  | { kind: 'set_planned_start'; taskId: TaskId; plannedStart?: number }
  | { kind: 'set_duration'; taskId: TaskId; plannedDurationMinutes: number }
  | { kind: 'delay'; taskId: TaskId; minutes: number }
  | { kind: 'set_status'; taskId: TaskId; status: TaskStatus; at: number; remainingDurationMinutes?: number }
  | { kind: 'set_gate_decision'; gateId: GateId; decision: 'go' | 'no_go' | 'pending'; at: number }
  | { kind: 'add_dependency'; dependency: EngineDependency }
  | { kind: 'remove_dependency'; predecessorId: TaskId; successorId: TaskId };

simulateChanges(graph: Graph, baseline: Schedule, changes: Change[], opts: { asOf: number; assumeHeldResolvesInMinutes?: number }):
  { graph: Graph; schedule: Schedule; impact: ImpactReport }
diffSchedules(before: Schedule, after: Schedule, graph: Graph): ImpactReport

interface ImpactReport {
  affectedTasks: {
    taskId: TaskId; ref: string; ownerId?: string;
    before: Pick<TaskTiming, 'earlyStart' | 'earlyFinish' | 'totalFloatMinutes' | 'isCritical'>;
    after:  Pick<TaskTiming, 'earlyStart' | 'earlyFinish' | 'totalFloatMinutes' | 'isCritical'>;
    shiftMinutes: number; becameCritical: boolean; leftCriticalPath: boolean;
    deadlineBreachMinutes?: number; becameHeld: boolean;
  }[];
  deadlineBreaches: { new: TaskId[]; resolved: TaskId[]; worsened: TaskId[] };
  gates: { gateId: GateId; before: GateProjection['status']; after: GateProjection['status']; slackBefore?: number; slackAfter?: number }[];
  criticalPath: { before: TaskId[]; after: TaskId[]; changed: boolean };
  eventWindow: { projectedFinishBefore?: number; projectedFinishAfter?: number; breachMinutesBefore: number; breachMinutesAfter: number };
  ownersToNotify: { ownerId: string; taskIds: TaskId[]; reasons: ('shifted' | 'now_critical' | 'deadline_at_risk' | 'held' | 'unblocked')[] }[];
}

// 4. Topology helpers for the UI (neighborhood zoom, owner views).
downstreamOf(graph, taskId, maxDepth?): TaskId[]
upstreamOf(graph, taskId, maxDepth?): TaskId[]
topologicalOrder(graph): TaskId[]          // deterministic: ties broken by ref

// 5. Re-import support (build step 2 consumes this).
diffGraphInputs(current: GraphInput, incoming: Partial<GraphInput>): GraphDiff   // keyed by ref: tasks/deps added, removed, changed
```

### 4.3 Live-mode rules (deterministic, all unit-tested)

- `complete`: early start/finish are the actuals. Immovable.
- `skipped`: treated as complete at `actualEnd ?? asOf` with zero duration. Successors proceed.
- `in_progress`: early start = actual start; early finish = `asOf + (remainingDurationMinutes ?? max(0, plannedDuration − elapsed))`.
- `not_started`: early start = max(asOf, plannedStart, predecessor constraints, gate constraints). Work cannot be scheduled in the past; this is what makes a slip propagate.
- `blocked` / `failed`: no projected finish. Every dependent task is `held` with the reason and the originating task. In what-if mode the caller may pass `assumeHeldResolvesInMinutes` to project a recovery instead.
- Gate `pending`: gated tasks cannot start before the later of the gate's projected-ready time and `asOf`; in live mode they are additionally held until `go`. Gate `no_go`: gated tasks held. Gate `go`: no constraint beyond `decidedAt`.
- Dependency constraints with lag L: FS `ES_s ≥ EF_p + L`; SS `ES_s ≥ ES_p + L`; FF `EF_s ≥ EF_p + L`; SF `EF_s ≥ ES_p + L`.
- Backward pass anchors each sink's late finish at `min(event.windowEnd, task.windowDeadline)`. Total float = LS − ES. Critical = float ≤ 0. Negative float is reported, not clamped: it is exactly "how many minutes we must recover."
- Determinism: forward pass in topological order with ties broken by `ref`; integer-minute arithmetic; no clock reads inside the engine.

### 4.4 Performance target

Forward plus backward pass is O(V + E). At the PRD's 1,000-task target, and even at
5,000 tasks with 25,000 edges, a full recompute is well under 50 ms on a laptop, so the
design is **full recompute on every change**, persisted as a new `schedule_run`. No
incremental propagation unless open question 1 comes back much larger.

### 4.5 How the API wraps it (build step 4/5, listed for the contract's sake)

| Endpoint | Behavior |
| --- | --- |
| `POST /events/:id/schedule/baseline` | Builder locks the plan. Computes in plan mode, persists a `baseline` run. |
| `GET /events/:id/schedule/live` | Latest live run plus per-task timings. |
| `POST /events/:id/simulate` | Body is `Change[]`. Returns schedule + impact. Persists a `scenario` run only if `save: true`. Never touches tasks. |
| `PATCH /tasks/:id` | Status/timing change. In one transaction: write audit entry, recompute live, persist run, link run to audit entry, push `impact.updated` over WebSocket. |
| `POST /gates/:id/decision` | Same transaction pattern as task updates. |
| `GET /events/:id/graph` | `GraphInput` for the UI. `GET /tasks/:id/neighborhood?radius=n` for zoom. |

---

## 5. Open questions that would change the design

The first four are PRD §8. The rest surfaced while drafting the schema and contract.
Each has the assumption I will proceed on unless told otherwise.

| # | Question | Why it matters | Assumption if unanswered |
| --- | --- | --- | --- |
| 1 | **Largest realistic task count per event?** | Above roughly 20k tasks, full recompute per change and a fully rendered DAG both stop being viable; we would need incremental propagation and graph virtualization from the start. | ≤ 5,000 tasks, ≤ 25,000 dependencies. Full recompute per change. |
| 2 | **Which source formats show up most on real engagements?** And is it one master sheet or one sheet per workstream owner? | Sets parser priority for build step 2, and per-workstream sheets make partial re-import/merge (already designed for) a must rather than a nice-to-have. A real anonymized sample would be worth more than an answer. | Order: plain CSV with a depends-on column, MS Project XML, Gantt-style CSV with `14FS+2h` predecessor syntax, prose. Per-workstream sheets are common. |
| 3 | **Internal only, or external client users with restricted visibility?** | Restricted visibility means row-level filtering in every query, a workstream-level ACL table, and possibly auditing reads. Cheap to add to the schema now, expensive to retrofit into every API handler later. | Single org. Four roles. Everyone can see the whole event; owners get a filtered "mine" view, not an access restriction. |
| 4 | **Audit retention period and export format regulators expect?** Do they need tamper-evidence? | If tamper-evidence is required, add a hash chain (`prev_hash`, `hash`) to `audit_log_entry` in the first migration rather than later. Export format decides whether the post-event report needs a PDF renderer. | Retain indefinitely. Export JSON + CSV, PDF summary. Database-enforced append-only, no hash chain. |
| 5 | **Is `planned_start` a fixed start or an earliest start?** | Changes the CPM math and what "shift" means in an impact report. Fixed starts also make imported plans inconsistent the moment one task slips. | Earliest-start constraint (MS Project semantics). |
| 6 | **When a task is blocked or failed, should downstream show "no projected time" or an assumed recovery?** | Determines what the command center sees during the worst moment of the event. | Hold with no projection by default; what-if mode lets the user supply an assumed recovery. |
| 7 | **Does a gate unblock only its listed gated tasks, or everything downstream of its entry tasks?** | Changes how gates are authored on import and how many tasks a `no_go` freezes. | Explicit gated list. The engine propagates the hold downstream from those automatically. |
| 8 | **Any working-time calendars, or is the cutover window continuous 24×7?** | Calendars add a duration-to-elapsed conversion layer to the engine. | Continuous window. No calendars in v1. |
| 9 | **Minute granularity sufficient?** | Sub-minute tasks would force millisecond arithmetic everywhere. | Minutes. |

Questions 1, 3, and 4 are the ones worth answering before the engine and API are
built. The rest I can proceed on and revisit.

---

## 6. What happens on go-ahead (build step 1)

Implement `@cutover/engine` against §4 with vitest suites before any other package:

- Textbook CPM fixtures with hand-verified early/late/float answers.
- Every dependency type with positive and negative lag.
- Cycle detection returning the offending path; duplicate and self-loop rejection.
- Each live-mode rule in §4.3 in isolation, then combined.
- Gate projections: ok, at risk, breached, held, decided.
- Determinism: shuffle input order, assert byte-identical output.
- Property test over random DAGs: every early start satisfies every predecessor constraint; float is non-negative whenever nothing breaches.
- Performance test at 1,000 and 5,000 tasks against the §4.4 target.
- A TRBK-style mock event fixture (freeze → migrate → validate → gate → switch → rollback-eligible window) shared by the tests and, later, the database seed.
