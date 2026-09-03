/**
 * Relational schema for the cutover orchestration platform (PRD §6.1).
 *
 * Design rules encoded here:
 *  - Builder intent (planned_*), live reality (actual_*), and engine output
 *    (schedule_task_result) are stored separately. The CPM engine never writes
 *    to task rows; it writes schedule runs. This keeps baseline vs. live vs.
 *    what-if scenarios comparable and auditable.
 *  - LLM/parsed input lands in import_candidate_* staging tables and only
 *    reaches task/dependency after explicit human review (PRD §4.1).
 *  - audit_log_entry is append-only (enforced by trigger in a custom migration).
 *  - All timestamps are timestamptz stored in UTC; the event carries a display
 *    timezone.
 */
import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  index,
  integer,
  jsonb,
  numeric,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  bigserial,
  type AnyPgColumn,
} from "drizzle-orm/pg-core";

// ---------------------------------------------------------------------------
// Enums
// ---------------------------------------------------------------------------

export const userRole = pgEnum("user_role", [
  "admin", // can change column headers, add custom columns, manage users/config
  "builder", // runbook builder / cutover lead
  "task_owner", // workstream lead / executor
  "command_center", // event lead, go/no-go caller
  "auditor", // read-only compliance reviewer
]);

export const eventStatus = pgEnum("event_status", ["planning", "live", "closed"]);

export const taskStatus = pgEnum("task_status", [
  "not_started",
  "in_progress",
  "blocked",
  "complete",
  "failed",
  "skipped",
]);

/** Precedence relationship. FS is the default; others only when source data implies it. */
export const dependencyType = pgEnum("dependency_type", ["FS", "SS", "FF", "SF"]);

/** Where a task/dependency/import came from. Provenance is kept on committed rows. */
export const sourceFormat = pgEnum("source_format", [
  "manual",
  "csv",
  "gantt_csv",
  "ms_project_xml",
  "prose_llm",
]);

export const gateDecision = pgEnum("gate_decision", ["pending", "go", "no_go"]);

/** entry: must complete before the gate can be decided. gated: cannot start until gate = go. */
export const gateTaskRole = pgEnum("gate_task_role", ["entry", "gated"]);

export const scheduleRunKind = pgEnum("schedule_run_kind", [
  "baseline", // the committed pre-event plan
  "live", // recomputed on every real status/timing change during the event
  "scenario", // pre-event "what if"; no side effects on tasks
]);

export const importStatus = pgEnum("import_status", [
  "uploaded",
  "parsing",
  "review",
  "committed",
  "discarded",
]);

export const reviewState = pgEnum("review_state", ["proposed", "accepted", "edited", "rejected"]);

/** Data type of a runbook column (built-in or admin-defined). */
export const columnDataType = pgEnum("column_data_type", [
  "text",
  "number",
  "boolean",
  "date",
  "datetime",
  "duration_minutes",
  "select",
  "user",
]);

// ---------------------------------------------------------------------------
// Users & event
// ---------------------------------------------------------------------------

const timestamps = {
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
};

export const appUser = pgTable(
  "app_user",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    name: text("name").notNull(),
    email: text("email").notNull(),
    role: userRole("role").notNull().default("task_owner"),
    slackUserId: text("slack_user_id"),
    isActive: boolean("is_active").notNull().default(true),
    ...timestamps,
  },
  (t) => [uniqueIndex("app_user_email_uq").on(sql`lower(${t.email})`)],
);

export const event = pgTable(
  "event",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    name: text("name").notNull(),
    description: text("description"),
    /** IANA zone used for display only; storage is UTC. */
    timezone: text("timezone").notNull().default("UTC"),
    windowStart: timestamp("window_start", { withTimezone: true }).notNull(),
    windowEnd: timestamp("window_end", { withTimezone: true }).notNull(),
    status: eventStatus("status").notNull().default("planning"),
    /**
     * When a task is blocked/failed and the owner has not given an expected unblock time,
     * the engine assumes work resumes this many minutes after "now" (Jordan: blocked tasks
     * show an assumed recovery rather than an unknown).
     */
    defaultBlockedRecoveryMinutes: integer("default_blocked_recovery_minutes").notNull().default(30),
    createdById: uuid("created_by_id").references(() => appUser.id),
    ...timestamps,
  },
  (t) => [
    check("event_window_chk", sql`${t.windowEnd} > ${t.windowStart}`),
    check("event_recovery_nonneg_chk", sql`${t.defaultBlockedRecoveryMinutes} >= 0`),
  ],
);

/**
 * Runbook column configuration per event. Admins can relabel built-in columns
 * (`builtinKey` set) and add custom columns (`builtinKey` null; values live in
 * `task.custom_fields[key]`). Everyone else sees columns read-only.
 */
export const eventColumn = pgTable(
  "event_column",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    eventId: uuid("event_id")
      .notNull()
      .references(() => event.id, { onDelete: "cascade" }),
    /** Stable machine key. For custom columns this is the JSON key in task.custom_fields. */
    key: text("key").notNull(),
    /** Built-in task column this row configures (e.g. "planned_start"); null for custom columns. */
    builtinKey: text("builtin_key"),
    label: text("label").notNull(),
    dataType: columnDataType("data_type").notNull().default("text"),
    /** For data_type = select: { options: string[] }. */
    config: jsonb("config").$type<Record<string, unknown>>().notNull().default({}),
    position: integer("position").notNull().default(0),
    isVisible: boolean("is_visible").notNull().default(true),
    isRequired: boolean("is_required").notNull().default(false),
    createdById: uuid("created_by_id").references(() => appUser.id, { onDelete: "set null" }),
    ...timestamps,
  },
  (t) => [
    uniqueIndex("event_column_event_key_uq").on(t.eventId, t.key),
    check("event_column_key_format_chk", sql`${t.key} ~ '^[a-z][a-z0-9_]{0,63}$'`),
  ],
);

export const workstream = pgTable(
  "workstream",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    eventId: uuid("event_id")
      .notNull()
      .references(() => event.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    color: text("color"),
    leadId: uuid("lead_id").references(() => appUser.id, { onDelete: "set null" }),
    ...timestamps,
  },
  (t) => [uniqueIndex("workstream_event_name_uq").on(t.eventId, t.name)],
);

// ---------------------------------------------------------------------------
// Graph: tasks, dependencies, gates
// ---------------------------------------------------------------------------

export const task = pgTable(
  "task",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    eventId: uuid("event_id")
      .notNull()
      .references(() => event.id, { onDelete: "cascade" }),
    /** Human-facing ID from the source plan (e.g. "T-014", "ACCT-3.2"). Unique per event. Import merges key on this. */
    ref: text("ref").notNull(),
    name: text("name").notNull(),
    description: text("description"),
    workstreamId: uuid("workstream_id").references(() => workstream.id, { onDelete: "set null" }),
    ownerId: uuid("owner_id").references(() => appUser.id, { onDelete: "set null" }),

    // --- builder intent (inputs to CPM) ---
    /** Optional "start no earlier than" constraint. Null = as early as predecessors allow. */
    plannedStart: timestamp("planned_start", { withTimezone: true }),
    plannedDurationMinutes: integer("planned_duration_minutes").notNull().default(0),
    /** Hard deadline. The engine reports a breach when projected finish exceeds this. */
    windowDeadline: timestamp("window_deadline", { withTimezone: true }),

    // --- live reality (inputs to live-mode CPM) ---
    status: taskStatus("status").notNull().default("not_started"),
    statusNote: text("status_note"),
    actualStart: timestamp("actual_start", { withTimezone: true }),
    actualEnd: timestamp("actual_end", { withTimezone: true }),
    /** Owner's live re-estimate for an in-progress task. Null = planned duration minus elapsed. */
    remainingDurationMinutes: integer("remaining_duration_minutes"),
    /** For blocked/failed tasks: when the owner expects to resume. Null = event default recovery. */
    expectedUnblockAt: timestamp("expected_unblock_at", { withTimezone: true }),

    // --- admin-defined columns (keys defined in event_column) ---
    customFields: jsonb("custom_fields").$type<Record<string, unknown>>().notNull().default({}),

    // --- provenance ---
    source: sourceFormat("source").notNull().default("manual"),
    importBatchId: uuid("import_batch_id").references((): AnyPgColumn => importBatch.id, {
      onDelete: "set null",
    }),
    ...timestamps,
  },
  (t) => [
    uniqueIndex("task_event_ref_uq").on(t.eventId, t.ref),
    index("task_event_status_idx").on(t.eventId, t.status),
    index("task_owner_idx").on(t.ownerId),
    index("task_workstream_idx").on(t.workstreamId),
    check("task_duration_nonneg_chk", sql`${t.plannedDurationMinutes} >= 0`),
    check(
      "task_remaining_nonneg_chk",
      sql`${t.remainingDurationMinutes} IS NULL OR ${t.remainingDurationMinutes} >= 0`,
    ),
    check(
      "task_actual_order_chk",
      sql`${t.actualEnd} IS NULL OR ${t.actualStart} IS NULL OR ${t.actualEnd} >= ${t.actualStart}`,
    ),
  ],
);

export const dependency = pgTable(
  "dependency",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    eventId: uuid("event_id")
      .notNull()
      .references(() => event.id, { onDelete: "cascade" }),
    predecessorTaskId: uuid("predecessor_task_id")
      .notNull()
      .references(() => task.id, { onDelete: "cascade" }),
    successorTaskId: uuid("successor_task_id")
      .notNull()
      .references(() => task.id, { onDelete: "cascade" }),
    type: dependencyType("type").notNull().default("FS"),
    /** Positive = lag, negative = lead. Common in Gantt exports. */
    lagMinutes: integer("lag_minutes").notNull().default(0),
    source: sourceFormat("source").notNull().default("manual"),
    importBatchId: uuid("import_batch_id").references((): AnyPgColumn => importBatch.id, {
      onDelete: "set null",
    }),
    ...timestamps,
  },
  (t) => [
    uniqueIndex("dependency_edge_uq").on(t.predecessorTaskId, t.successorTaskId),
    index("dependency_successor_idx").on(t.successorTaskId),
    index("dependency_event_idx").on(t.eventId),
    check("dependency_no_self_loop_chk", sql`${t.predecessorTaskId} <> ${t.successorTaskId}`),
  ],
);

export const gate = pgTable(
  "gate",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    eventId: uuid("event_id")
      .notNull()
      .references(() => event.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    description: text("description"),
    approverId: uuid("approver_id").references(() => appUser.id, { onDelete: "set null" }),
    /** When the decision is planned to be made. Used by the engine for "gate at risk". */
    targetDecisionAt: timestamp("target_decision_at", { withTimezone: true }),
    /** Marks the event's point of no return (rollback no longer possible after go). */
    isPointOfNoReturn: boolean("is_point_of_no_return").notNull().default(false),
    decision: gateDecision("decision").notNull().default("pending"),
    decidedById: uuid("decided_by_id").references(() => appUser.id, { onDelete: "set null" }),
    decidedAt: timestamp("decided_at", { withTimezone: true }),
    decisionNote: text("decision_note"),
    ...timestamps,
  },
  (t) => [
    uniqueIndex("gate_event_name_uq").on(t.eventId, t.name),
    check(
      "gate_decision_consistency_chk",
      sql`(${t.decision} = 'pending' AND ${t.decidedAt} IS NULL) OR (${t.decision} <> 'pending' AND ${t.decidedAt} IS NOT NULL)`,
    ),
  ],
);

export const gateTask = pgTable(
  "gate_task",
  {
    gateId: uuid("gate_id")
      .notNull()
      .references(() => gate.id, { onDelete: "cascade" }),
    taskId: uuid("task_id")
      .notNull()
      .references(() => task.id, { onDelete: "cascade" }),
    role: gateTaskRole("role").notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.gateId, t.taskId, t.role] }),
    index("gate_task_task_idx").on(t.taskId),
  ],
);

// ---------------------------------------------------------------------------
// Engine output: schedule runs (baseline / live / scenario)
// ---------------------------------------------------------------------------

export const scheduleRun = pgTable(
  "schedule_run",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    eventId: uuid("event_id")
      .notNull()
      .references(() => event.id, { onDelete: "cascade" }),
    kind: scheduleRunKind("kind").notNull(),
    /** For live/scenario runs: the run whose results this one is compared against in the impact report. */
    basedOnRunId: uuid("based_on_run_id").references((): AnyPgColumn => scheduleRun.id, {
      onDelete: "set null",
    }),
    /** The "now" the engine used (live mode clamps unstarted work to >= as_of). */
    asOf: timestamp("as_of", { withTimezone: true }).notNull(),
    /** What caused the run: engine `Change[]` for scenarios, or the task/gate mutation for live runs. */
    trigger: jsonb("trigger").$type<Record<string, unknown>>().notNull(),
    /** Engine `ImpactReport` (affected tasks, breaches, gates at risk, critical path delta, owners to notify). */
    impact: jsonb("impact").$type<Record<string, unknown>>(),
    engineVersion: text("engine_version").notNull(),
    createdById: uuid("created_by_id").references(() => appUser.id, { onDelete: "set null" }),
    computedAt: timestamp("computed_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("schedule_run_event_kind_idx").on(t.eventId, t.kind, t.computedAt)],
);

export const scheduleTaskResult = pgTable(
  "schedule_task_result",
  {
    runId: uuid("run_id")
      .notNull()
      .references(() => scheduleRun.id, { onDelete: "cascade" }),
    taskId: uuid("task_id")
      .notNull()
      .references(() => task.id, { onDelete: "cascade" }),
    /** Null when the task is held (blocked/failed upstream) and no time can be projected. */
    earlyStart: timestamp("early_start", { withTimezone: true }),
    earlyFinish: timestamp("early_finish", { withTimezone: true }),
    lateStart: timestamp("late_start", { withTimezone: true }),
    lateFinish: timestamp("late_finish", { withTimezone: true }),
    totalFloatMinutes: integer("total_float_minutes"),
    isCritical: boolean("is_critical").notNull().default(false),
    /** Positive = projected finish is this many minutes past window_deadline. */
    deadlineBreachMinutes: integer("deadline_breach_minutes"),
    /** e.g. "blocked_upstream:<task_ref>" or "gate_pending:<gate_name>". */
    heldReason: text("held_reason"),
  },
  (t) => [primaryKey({ columns: [t.runId, t.taskId] }), index("schedule_task_result_task_idx").on(t.taskId)],
);

// ---------------------------------------------------------------------------
// Ingestion staging (review before commit)
// ---------------------------------------------------------------------------

export const importBatch = pgTable(
  "import_batch",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    eventId: uuid("event_id")
      .notNull()
      .references(() => event.id, { onDelete: "cascade" }),
    format: sourceFormat("format").notNull(),
    filename: text("filename"),
    /** Raw input retained for audit (prose text, CSV body, or XML). */
    rawContent: text("raw_content"),
    status: importStatus("status").notNull().default("uploaded"),
    /** Model + prompt version for LLM-parsed batches; parser version for deterministic ones. */
    parserVersion: text("parser_version"),
    parserModel: text("parser_model"),
    createdById: uuid("created_by_id").references(() => appUser.id, { onDelete: "set null" }),
    committedById: uuid("committed_by_id").references(() => appUser.id, { onDelete: "set null" }),
    committedAt: timestamp("committed_at", { withTimezone: true }),
    ...timestamps,
  },
  (t) => [index("import_batch_event_idx").on(t.eventId, t.createdAt)],
);

export const importCandidateTask = pgTable(
  "import_candidate_task",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    batchId: uuid("batch_id")
      .notNull()
      .references(() => importBatch.id, { onDelete: "cascade" }),
    ref: text("ref").notNull(),
    name: text("name").notNull(),
    workstreamName: text("workstream_name"),
    ownerName: text("owner_name"),
    plannedStart: timestamp("planned_start", { withTimezone: true }),
    plannedDurationMinutes: integer("planned_duration_minutes"),
    windowDeadline: timestamp("window_deadline", { withTimezone: true }),
    /** Existing task this candidate would update (matched on ref). Null = would create. */
    matchedTaskId: uuid("matched_task_id").references(() => task.id, { onDelete: "set null" }),
    reviewState: reviewState("review_state").notNull().default("proposed"),
    /** Source snippet / row that produced this candidate. */
    evidence: text("evidence"),
  },
  (t) => [uniqueIndex("import_candidate_task_batch_ref_uq").on(t.batchId, t.ref)],
);

export const importCandidateDependency = pgTable(
  "import_candidate_dependency",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    batchId: uuid("batch_id")
      .notNull()
      .references(() => importBatch.id, { onDelete: "cascade" }),
    predecessorRef: text("predecessor_ref").notNull(),
    successorRef: text("successor_ref").notNull(),
    type: dependencyType("type").notNull().default("FS"),
    lagMinutes: integer("lag_minutes").notNull().default(0),
    /** 0.00–1.00 from the LLM parser; null for deterministic parsers. */
    confidence: numeric("confidence", { precision: 3, scale: 2 }),
    /** The exact source text that implied this edge; shown in the review UI. */
    evidence: text("evidence"),
    /** Result of diffing against the committed graph: add | unchanged | change | remove. */
    diffKind: text("diff_kind"),
    reviewState: reviewState("review_state").notNull().default("proposed"),
    reviewerNote: text("reviewer_note"),
    reviewedById: uuid("reviewed_by_id").references(() => appUser.id, { onDelete: "set null" }),
    reviewedAt: timestamp("reviewed_at", { withTimezone: true }),
  },
  (t) => [
    index("import_candidate_dependency_batch_idx").on(t.batchId),
    check(
      "import_candidate_dependency_no_self_loop_chk",
      sql`${t.predecessorRef} <> ${t.successorRef}`,
    ),
  ],
);

// ---------------------------------------------------------------------------
// Audit log (append-only; see migration 0001)
// ---------------------------------------------------------------------------

export const auditLogEntry = pgTable(
  "audit_log_entry",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    eventId: uuid("event_id")
      .notNull()
      .references(() => event.id, { onDelete: "restrict" }),
    entityType: text("entity_type").notNull(), // task | dependency | gate | event | import_batch | ...
    entityId: uuid("entity_id").notNull(),
    /** Dotted verb, e.g. task.status_changed, gate.decided, dependency.created, import.committed */
    action: text("action").notNull(),
    before: jsonb("before").$type<Record<string, unknown>>(),
    after: jsonb("after").$type<Record<string, unknown>>(),
    /** Null = system-generated (e.g. auto recompute). */
    actorId: uuid("actor_id").references(() => appUser.id, { onDelete: "set null" }),
    /** Live schedule run produced as a consequence of this change, if any. */
    scheduleRunId: uuid("schedule_run_id").references(() => scheduleRun.id, { onDelete: "set null" }),
    occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("audit_log_event_time_idx").on(t.eventId, t.occurredAt),
    index("audit_log_entity_idx").on(t.entityType, t.entityId),
  ],
);
