/**
 * Public contract of @cutover/engine.
 *
 * Conventions:
 *  - All instants are epoch milliseconds (UTC). All durations/lags/floats are integer minutes.
 *  - The engine never reads a clock: `asOf` is always supplied by the caller.
 *  - Inputs are plain data. The engine never mutates its inputs.
 */

export type TaskId = string;
export type GateId = string;

export type DependencyType = "FS" | "SS" | "FF" | "SF";

export type TaskStatus = "not_started" | "in_progress" | "blocked" | "complete" | "failed" | "skipped";

export type GateDecision = "pending" | "go" | "no_go";

export interface EngineTask {
  id: TaskId;
  /** Human-facing ID from the source plan. Used for deterministic tie-breaks and messages. */
  ref: string;
  name: string;
  ownerId?: string;
  workstreamId?: string;
  /** "Start no earlier than" constraint. Undefined = as early as predecessors allow. */
  plannedStart?: number;
  plannedDurationMinutes: number;
  /** Hard per-task deadline; a breach is reported when projected finish exceeds it. */
  windowDeadline?: number;
  status: TaskStatus;
  actualStart?: number;
  actualEnd?: number;
  /** Owner's live re-estimate of remaining work (in_progress / blocked). */
  remainingDurationMinutes?: number;
  /** For blocked/failed: when the owner expects work to resume. */
  expectedUnblockAt?: number;
}

export interface EngineDependency {
  predecessorId: TaskId;
  successorId: TaskId;
  type: DependencyType;
  /** Positive = lag, negative = lead. */
  lagMinutes: number;
}

export interface EngineGate {
  id: GateId;
  name: string;
  /** Must finish before the gate can be decided. */
  entryTaskIds: TaskId[];
  /** Cannot start until the gate is decided "go". */
  gatedTaskIds: TaskId[];
  decision: GateDecision;
  decidedAt?: number;
  /** When the decision is planned to be made; drives "gate at risk". */
  targetDecisionAt?: number;
  isPointOfNoReturn: boolean;
}

export interface EngineEvent {
  windowStart: number;
  windowEnd: number;
  /** Assumed minutes until a blocked/failed task resumes when no expectedUnblockAt is given. Default 30. */
  defaultBlockedRecoveryMinutes?: number;
}

export interface GraphInput {
  event: EngineEvent;
  tasks: EngineTask[];
  dependencies: EngineDependency[];
  gates: EngineGate[];
}

// ---------------------------------------------------------------------------
// Graph
// ---------------------------------------------------------------------------

export interface Edge {
  predecessorId: TaskId;
  successorId: TaskId;
  type: DependencyType;
  lagMinutes: number;
  /** Set when this edge is synthesized from a gate (entry task -> gated task). */
  viaGateId?: GateId;
}

/** Validated, indexed graph. Treat as opaque; build with `buildGraph`. */
export interface Graph {
  input: GraphInput;
  tasks: ReadonlyMap<TaskId, EngineTask>;
  gates: ReadonlyMap<GateId, EngineGate>;
  /** Deterministic topological order (ties broken by natural ref order). */
  order: readonly TaskId[];
  outEdges: ReadonlyMap<TaskId, readonly Edge[]>;
  inEdges: ReadonlyMap<TaskId, readonly Edge[]>;
  /** Gates for which the task is a gated task. */
  gatesByGatedTask: ReadonlyMap<TaskId, readonly GateId[]>;
}

export type GraphError =
  | { kind: "duplicate_task_id"; taskId: TaskId }
  | { kind: "duplicate_task_ref"; ref: string; taskIds: TaskId[] }
  | { kind: "unknown_task"; taskId: TaskId; referencedBy: string }
  | { kind: "self_loop"; taskId: TaskId }
  | { kind: "duplicate_edge"; predecessorId: TaskId; successorId: TaskId }
  | { kind: "invalid_duration"; taskId: TaskId; value: number }
  | { kind: "gate_unknown_task"; gateId: GateId; taskId: TaskId }
  | { kind: "gate_task_both_roles"; gateId: GateId; taskId: TaskId }
  | { kind: "duplicate_gate_id"; gateId: GateId }
  | { kind: "cycle"; taskIds: TaskId[]; refs: string[] };

export type GraphWarning =
  | { kind: "orphan_task"; taskId: TaskId }
  | { kind: "no_owner"; taskId: TaskId }
  | { kind: "planned_start_before_window"; taskId: TaskId }
  | { kind: "deadline_before_window_start"; taskId: TaskId }
  | { kind: "deadline_after_window_end"; taskId: TaskId }
  | { kind: "gate_without_entry_tasks"; gateId: GateId }
  | { kind: "gate_without_gated_tasks"; gateId: GateId }
  | { kind: "gate_target_after_window_end"; gateId: GateId }
  | { kind: "missing_actuals"; taskId: TaskId; status: TaskStatus }
  | { kind: "negative_lag"; predecessorId: TaskId; successorId: TaskId };

export type BuildResult = { ok: true; graph: Graph } | { ok: false; errors: GraphError[] };

// ---------------------------------------------------------------------------
// Schedule
// ---------------------------------------------------------------------------

export type ScheduleMode = "plan" | "live";

export interface ScheduleOptions {
  /** plan: ignore all actuals/statuses. live: apply live rules (see live.ts). */
  mode: ScheduleMode;
  /** The "now" used by live mode. Required in both modes so output is fully determined by input. */
  asOf: number;
  /** A gate with less slack than this (minutes) is "at_risk". Default 30. */
  gateAtRiskThresholdMinutes?: number;
  /**
   * When true (default), gated tasks cannot start before a pending gate's targetDecisionAt:
   * a planned checkpoint is assumed to be decided at its planned time, not the moment the
   * entry tasks happen to finish. Set false to model "decide as soon as ready".
   */
  gateWaitsForTarget?: boolean;
}

export type HeldReason = "gate_no_go" | "upstream_held";

export interface TimingAssumption {
  kind: "blocked_recovery" | "failed_rerun";
  /** When the engine assumed work resumes. */
  resumeAt: number;
  /** True when the owner supplied expectedUnblockAt; false when the event default was used. */
  fromOwnerEstimate: boolean;
}

export interface TaskTiming {
  taskId: TaskId;
  earlyStart?: number;
  earlyFinish?: number;
  lateStart?: number;
  lateFinish?: number;
  /** lateFinish − earlyFinish in minutes. Negative = must recover this many minutes. */
  totalFloatMinutes?: number;
  isCritical: boolean;
  /** Minutes past windowDeadline (> 0 only when breached). */
  deadlineBreachMinutes?: number;
  /** Predecessors (or gates, as "gate:<id>") whose constraint equals earlyStart. */
  drivenBy: string[];
  /** Set when this task's own projection rests on a recovery assumption. */
  assumption?: TimingAssumption;
  /** Upstream tasks (including self) whose assumptions this projection inherits. Sorted by ref. */
  assumedFrom: TaskId[];
  held?: { reason: HeldReason; byTaskIds?: TaskId[]; byGateId?: GateId };
}

export type GateStatus = "ok" | "at_risk" | "breached" | "held" | "decided_go" | "decided_no_go";

export interface GateProjection {
  gateId: GateId;
  /** Latest projected finish across entry tasks. */
  projectedReadyAt?: number;
  /** targetDecisionAt − projectedReadyAt, in minutes. */
  slackMinutes?: number;
  status: GateStatus;
  /** Gated tasks that currently cannot start because of this gate. */
  heldTaskIds: TaskId[];
  /** Readiness depends on at least one recovery assumption upstream. */
  assumed: boolean;
}

export interface Schedule {
  mode: ScheduleMode;
  asOf: number;
  tasks: Record<TaskId, TaskTiming>;
  gates: Record<GateId, GateProjection>;
  /** Canonical critical path in forward order (deterministic tie-break). */
  criticalPath: TaskId[];
  /** Every task with non-positive float (parallel critical paths included). */
  criticalTaskIds: TaskId[];
  /** Latest projected finish over all scheduled (non-held) tasks. */
  projectedFinish?: number;
  /** max(0, projectedFinish − windowEnd) in minutes. */
  eventWindowBreachMinutes: number;
  /** windowEnd − projectedFinish in minutes (negative when breaching). */
  windowSlackMinutes?: number | undefined;
  deadlineBreaches: { taskId: TaskId; minutes: number }[];
  heldTaskIds: TaskId[];
}

// ---------------------------------------------------------------------------
// Simulation
// ---------------------------------------------------------------------------

export type Change =
  | { kind: "set_planned_start"; taskId: TaskId; plannedStart?: number }
  | { kind: "set_duration"; taskId: TaskId; plannedDurationMinutes: number }
  | { kind: "set_deadline"; taskId: TaskId; windowDeadline?: number }
  /** Shift the task's projected timing by N minutes (interpretation depends on status; see simulate.ts). */
  | { kind: "delay"; taskId: TaskId; minutes: number }
  | {
      kind: "set_status";
      taskId: TaskId;
      status: TaskStatus;
      at: number;
      remainingDurationMinutes?: number;
      expectedUnblockAt?: number;
    }
  | { kind: "set_expected_unblock"; taskId: TaskId; expectedUnblockAt?: number }
  | { kind: "set_gate_decision"; gateId: GateId; decision: GateDecision; at: number }
  | { kind: "add_dependency"; dependency: EngineDependency }
  | { kind: "remove_dependency"; predecessorId: TaskId; successorId: TaskId };

export type NotifyReason =
  | "shifted_later"
  | "shifted_earlier"
  | "now_critical"
  | "deadline_breached"
  | "deadline_recovered"
  | "held"
  | "released";

export interface AffectedTask {
  taskId: TaskId;
  ref: string;
  ownerId?: string;
  before: TimingSnapshot;
  after: TimingSnapshot;
  /** after.earlyStart − before.earlyStart in minutes (undefined if either side has no time). */
  startShiftMinutes?: number;
  finishShiftMinutes?: number;
  becameCritical: boolean;
  leftCriticalPath: boolean;
  becameHeld: boolean;
  released: boolean;
  deadlineBreachMinutes?: number;
}

export interface TimingSnapshot {
  earlyStart?: number;
  earlyFinish?: number;
  totalFloatMinutes?: number;
  isCritical: boolean;
  held: boolean;
  deadlineBreachMinutes?: number;
}

export interface ImpactReport {
  affectedTasks: AffectedTask[];
  deadlineBreaches: { new: TaskId[]; resolved: TaskId[]; worsened: TaskId[]; improved: TaskId[] };
  gates: {
    gateId: GateId;
    before: GateStatus;
    after: GateStatus;
    slackBeforeMinutes?: number;
    slackAfterMinutes?: number;
    readyShiftMinutes?: number;
  }[];
  criticalPath: { before: TaskId[]; after: TaskId[]; changed: boolean };
  eventWindow: {
    projectedFinishBefore?: number;
    projectedFinishAfter?: number;
    breachMinutesBefore: number;
    breachMinutesAfter: number;
    finishShiftMinutes?: number;
  };
  ownersToNotify: { ownerId: string; taskIds: TaskId[]; reasons: NotifyReason[] }[];
  /** Tasks affected but with no owner assigned — surface separately so nobody is silently missed. */
  unownedAffectedTaskIds: TaskId[];
}

export type SimulateResult =
  | { ok: true; input: GraphInput; graph: Graph; schedule: Schedule; impact: ImpactReport }
  | { ok: false; errors: GraphError[] };

// ---------------------------------------------------------------------------
// Re-import diff
// ---------------------------------------------------------------------------

export interface TaskFieldChange {
  field: keyof EngineTask;
  before: unknown;
  after: unknown;
}

export interface GraphDiff {
  tasks: {
    added: EngineTask[];
    removed: EngineTask[];
    changed: { ref: string; before: EngineTask; after: EngineTask; fields: TaskFieldChange[] }[];
    unchanged: string[];
  };
  dependencies: {
    added: RefDependency[];
    removed: RefDependency[];
    changed: { before: RefDependency; after: RefDependency }[];
    unchanged: RefDependency[];
  };
  /** Refs the incoming dependencies point to that exist neither in the incoming nor the current tasks. */
  unresolvedRefs: string[];
}

/** A dependency expressed by task ref rather than id (what import sources speak). */
export interface RefDependency {
  predecessorRef: string;
  successorRef: string;
  type: DependencyType;
  lagMinutes: number;
}
