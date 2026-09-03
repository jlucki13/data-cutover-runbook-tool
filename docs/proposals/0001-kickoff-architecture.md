# Proposal 0001 — Kickoff: repo structure, data model, engine contract

**Status:** Accepted. Jordan answered the design-changing questions on 2026-09-03 (see §5);
build step 1 (engine + tests) is implemented against this document.
**Inputs:** `prd-cutover-platform.md`, `CLAUDE.md`, `docs/kickoff-prompt.md`.

What is in the repo:

| Path | What it is |
| --- | --- |
| `packages/db/src/schema.ts` | The data model as a real Drizzle/Postgres schema (§3). |
| `packages/db/drizzle/0000_init.sql`, `0002_kickoff_answers.sql` | Generated DDL. |
| `packages/db/drizzle/0001_audit_log_append_only.sql` | Hand-written migration: triggers that reject UPDATE/DELETE/TRUNCATE on the audit log. |
| `packages/engine/` | The CPM / impact engine (§4) with 112 unit, property, determinism and performance tests. |
| `packages/engine/test/fixtures/trbk.ts` | TRBK-style mock cutover event used by the tests (and later the seed). |
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

12. **Admin-configurable runbook columns** (from Jordan's answer on roles). `event_column`
    holds per-event column configuration: relabelled built-in columns and admin-defined
    custom columns, whose values live in `task.custom_fields` JSON. Only the `admin` role
    may change column definitions; everyone else reads them.

13. **Assumed recovery for blocked work** (from Jordan's answer). `event.default_blocked_recovery_minutes`
    (default 30) plus `task.expected_unblock_at` feed the engine rule in §4.3.

Not yet modeled, deliberately, until its build step: the notifications outbox (step 6).
Visibility restrictions are not needed: all users are in one org and see the whole event.

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

### 4.3 Scheduling rules (deterministic, all unit-tested)

**Forward pass**

- `not_started`: early start = max(plannedStart or window start, every predecessor constraint, gate constraints, and in live mode `asOf`). Work cannot be scheduled in the past; this is what makes a slip propagate.
- `complete` / `skipped`: pinned to actuals (skipped is done at `actualEnd`, zero duration). Successors proceed.
- `in_progress`: early start = actual start; early finish = `asOf + (remainingDurationMinutes ?? max(0, plannedDuration − elapsed))`.
- `blocked` / `failed` (Jordan: show an assumed recovery, not an unknown): work resumes at `expectedUnblockAt` if the owner gave one, else `asOf + event.defaultBlockedRecoveryMinutes`. Blocked resumes with the remaining work; failed re-runs the full planned duration. The task carries an `assumption` and every downstream task lists it in `assumedFrom`, so the UI can mark projections that rest on a guess.
- Dependency constraints with lag L: FS `ES_s ≥ EF_p + L`; SS `ES_s ≥ ES_p + L`; FF `EF_s ≥ EF_p + L`; SF `EF_s ≥ ES_p + L`.
- Gates are synthetic FS edges from each entry task to each gated task, plus: `pending` with a target → gated tasks start no earlier than `targetDecisionAt` (a planned checkpoint is decided at its planned time; `gateWaitsForTarget: false` switches to "decide as soon as ready"); `go` → gated tasks start no earlier than `decidedAt`; `no_go` → gated tasks and everything downstream are `held` with no projected time.
- Plan mode ignores statuses and actuals entirely.

**Backward pass and float**

- Late finish anchors at `min(windowEnd, projectedFinish)`. When the plan fits the window, floats are relative to the longest path, so the classic critical path is highlighted even with hours of window slack. When the plan overruns, floats go negative by exactly the minutes to recover. `windowSlackMinutes` reports the window margin separately.
- A task's own `windowDeadline` caps its late finish. A pending gate's `targetDecisionAt` caps the late finish of its entry tasks, so a gate breach shows up as negative float on the chain that causes it.
- Total float = late finish − early finish. Critical = float ≤ 0 (finished tasks are never critical). Started successors do not constrain their predecessors' late dates.
- The canonical `criticalPath` starts from the critical task needing the most recovery (lowest float; ties: latest finish, then lowest ref) and walks back through critical driving predecessors. `criticalTaskIds` lists every critical task, so parallel critical branches are never hidden.
- Determinism: forward pass in a unique topological order (Kahn's algorithm with a natural-ref-ordered heap); every tie broken by ref; no clock reads inside the engine. Shuffling input arrays yields a byte-identical schedule (tested).

### 4.4 Performance (measured)

Jordan: events range from 100 to 15,000 tasks. Forward plus backward pass is O(V + E), so
the design is **full recompute on every change**, persisted as a new `schedule_run`.
Measured in the test suite on the CI container (layered random DAG, ~2 edges per task):

| Tasks | Build graph | Schedule | Change → new schedule + impact report |
| --- | --- | --- | --- |
| 1,000 | 35 ms | 13 ms | 46 ms |
| 5,000 | 140 ms | 54 ms | 188 ms |
| 15,000 | 462 ms | 201 ms | 551 ms |

Well inside the PRD's "a few seconds" for 1,000 tasks and still sub-second at the top of
Jordan's range. Rendering a 15,000-node DAG is the harder problem and belongs to build
step 3 (filtering and neighborhood zoom rather than drawing everything).

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

## 5. Open questions and Jordan's answers (2026-09-03)

| # | Question | Answer / decision | Effect on the design |
| --- | --- | --- | --- |
| 1 | Largest realistic task count? | **100 to 15,000 tasks per event.** | Full recompute per change stays (measured sub-second at 15k, §4.4). The graph view must filter/zoom rather than render everything; perf tests pin 15k. |
| 2 | Which source formats, and one sheet or per workstream? | **Runbook owners send worksheets first; the tool compiles them into the complete runbook across workstreams.** | Ingestion is a compile step: N per-workstream worksheets → one event graph. `diffGraphInputs` takes a scope so a re-submitted worksheet only adds/changes/removes within its workstream; cross-workstream edges resolve by task ref against the whole event. Format priority still assumed: CSV, MS Project XML, Gantt CSV, prose. |
| 3 | Internal only, or external users with restricted visibility? | **All users in one org. A few admins can update column headers, add columns, and a few other locked features.** | Added the `admin` role and `event_column` + `task.custom_fields` (§3 item 12). No row-level visibility filtering. Everyone sees the whole event; owners get a filtered "mine" view. |
| 4 | Audit retention, export format, tamper-evidence? | **Agreed with the assumption:** retain indefinitely, JSON + CSV export plus PDF summary, database-enforced append-only, no hash chain. | No change. |
| 5 | `planned_start`: fixed or earliest start? | Proceeding on the assumption: earliest-start constraint. | As designed. |
| 6 | Blocked/failed: no projection, or assumed recovery? | **Assumed recovery.** | Engine rule in §4.3; `event.default_blocked_recovery_minutes` and `task.expected_unblock_at` added. Projections built on an assumption are flagged (`assumption`, `assumedFrom`, `GateProjection.assumed`). |
| 7 | Gate unblocks listed tasks only, or everything downstream of entry tasks? | Proceeding on the assumption: explicit gated list; holds propagate downstream automatically. | As designed. |
| 8 | Working-time calendars? | Proceeding on the assumption: continuous 24×7 window. | None in v1. |
| 9 | Minute granularity? | Proceeding on the assumption: minutes. | As designed. |

Two engine rules were chosen during implementation and are worth a glance from Jordan
because they are judgment calls, both switchable:

- **Pending gates are decided at their target time, not the moment entry work finishes**
  (`gateWaitsForTarget`, default on). Consequence: upstream slips smaller than the gate's
  slack show zero downstream impact beyond the gate, which is the honest answer to "do we
  still hit our window". The gate's own slack is reported separately.
- **A pending gate's target caps the late finish of its entry tasks.** Consequence: when a
  gate is breached, the chain causing it becomes the critical path with negative float,
  rather than the last task in the plan.

## 6. Build step 1 as delivered

`@cutover/engine` is implemented against §4 with vitest suites, before any other package:

- Textbook CPM fixtures with hand-verified early/late/float answers.
- Every dependency type with positive and negative lag.
- Cycle detection returning the offending path; duplicate and self-loop rejection.
- Each live-mode rule in §4.3 in isolation, then combined.
- Gate projections: ok, at risk, breached, held, decided.
- Determinism: shuffle input order, assert byte-identical output.
- Property test over random DAGs: every early start satisfies every predecessor constraint; float is non-negative whenever nothing breaches.
- Performance test at 1,000 and 5,000 tasks against the §4.4 target.
- A TRBK-style mock event fixture (freeze → migrate → validate → gate → switch → rollback-eligible window) shared by the tests and, later, the database seed.

Next: build step 2, the ingestion pipeline (CSV first, then MS Project XML and Gantt CSV,
then the LLM prose parser), all landing in the `import_candidate_*` staging tables with the
worksheet-compile and review flow on top of `diffGraphInputs`.
