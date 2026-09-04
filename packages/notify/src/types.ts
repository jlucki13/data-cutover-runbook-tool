/**
 * Notification contract.
 *
 * Rules are deterministic and derive entirely from engine output plus recorded state —
 * an LLM never decides whether something is at risk, only (elsewhere, optionally) how to
 * word a summary. Same inputs, same notifications, same dedupe keys.
 */
import type { GateProjection, Schedule, TaskId, TaskStatus } from "@cutover/engine";

export type NotificationKind =
  /** Every constraint is satisfied: the owner can start now. */
  | "task_ready"
  /** Projected finish breaches the task's own deadline. */
  | "task_deadline_at_risk"
  /** Float has gone negative: the task must be recovered to hold the plan. */
  | "task_negative_float"
  /** The task cannot proceed: a no-go gate or an upstream block/failure. */
  | "task_held"
  /** The owner marked their own task blocked or failed. */
  | "task_blocked"
  /** Entry work is done (or projected done) and the gate still needs a decision. */
  | "gate_awaiting_decision"
  /** A gate's projected ready time is later than its target decision time. */
  | "gate_at_risk"
  /** Somebody decided a gate. */
  | "gate_decided"
  /** The projected finish is past the event window. */
  | "event_window_at_risk";

export type Severity = "info" | "warning" | "critical";

export type Channel = "email" | "slack";

export interface Recipient {
  userId: string;
  /** Why this person is on the notice: their task, the gate they approve, their command-centre role. */
  reason: "owner" | "approver" | "command_center" | "builder";
}

export interface Notification {
  kind: NotificationKind;
  severity: Severity;
  entityType: "task" | "gate" | "event";
  entityId: string;
  /** Short line for Slack and the notification list. */
  title: string;
  /** Plain-language body; deterministic, no model involved. */
  body: string;
  /** Facts behind the notice, for the UI, the audit trail, and (optionally) an LLM summary. */
  facts: Record<string, unknown>;
  recipients: Recipient[];
  /**
   * Stable identity of "this fact, in this state". Re-evaluating an unchanged event
   * produces the same key, so the outbox can suppress duplicates; a materially different
   * state (a bigger breach, a new decision) produces a new key and notifies again.
   */
  dedupeKey: string;
}

export interface DirectoryTask {
  id: TaskId;
  ref: string;
  name: string;
  ownerId?: string | undefined;
  ownerName?: string | undefined;
  workstreamName?: string | undefined;
  status: TaskStatus;
  windowDeadline?: number | undefined;
  statusNote?: string | undefined;
}

export interface DirectoryGate {
  id: string;
  name: string;
  approverId?: string | undefined;
  approverName?: string | undefined;
  targetDecisionAt?: number | undefined;
  isPointOfNoReturn: boolean;
  decision: "pending" | "go" | "no_go";
  decidedAt?: number | undefined;
  decidedByName?: string | undefined;
}

export interface NotifyEvent {
  id: string;
  name: string;
  timezone: string;
  windowEnd: number;
  status: "planning" | "live" | "closed";
}

export interface NotifyInput {
  event: NotifyEvent;
  tasks: DirectoryTask[];
  gates: DirectoryGate[];
  /** The schedule the notices describe. */
  schedule: Schedule;
  /** The previous schedule, when there is one: lets "decided"/"released" transitions be detected. */
  before?: Schedule | undefined;
  /** Users who should hear about event-level risk regardless of ownership. */
  commandCentreUserIds: string[];
  asOf: number;
}

export interface NotifyOptions {
  /** A task whose early start is within this many minutes of now counts as ready. Default 0 (already startable). */
  readyWithinMinutes?: number;
  /** Warn when a pending gate's decision time is this close. Default 120. */
  gateAwaitingWithinMinutes?: number;
  /** Bucket size for dedupe of "how bad is it" notices, in minutes. Default 30. */
  magnitudeBucketMinutes?: number;
  /** Suppress task-level notices for tasks that are already complete/skipped. Default true. */
  skipFinishedTasks?: boolean;
}

export type GateStatusName = GateProjection["status"];
