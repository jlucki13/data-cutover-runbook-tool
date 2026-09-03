/**
 * Live changes: a task status/timing update or a gate decision, recorded in the audit
 * log and followed by an engine recompute whose impact report is persisted as a live
 * schedule run. Same transaction, so the audit entry always points at the run it caused.
 */
import { eq } from "drizzle-orm";
import { gate, task, type Db } from "@cutover/db";
import { simulateChanges, type Change, type GateDecision, type ImpactReport, type Schedule, type TaskStatus } from "@cutover/engine";
import { badRequest, conflict, notFound } from "../errors.js";
import { snapshot, writeAudit } from "./audit.js";
import { loadRunbook, persistScheduleRun, scheduleFor, type TaskRow } from "./runbook.js";

export interface TaskUpdateInput {
  status?: TaskStatus;
  statusNote?: string | null;
  actualStart?: number | null;
  actualEnd?: number | null;
  remainingDurationMinutes?: number | null;
  expectedUnblockAt?: number | null;
  plannedStart?: number | null;
  plannedDurationMinutes?: number;
  windowDeadline?: number | null;
  name?: string;
  ownerId?: string | null;
  workstreamId?: string | null;
  customFields?: Record<string, unknown>;
}

export interface LiveChangeResult {
  task?: TaskRow;
  gate?: typeof gate.$inferSelect;
  scheduleRunId: string;
  schedule: Schedule;
  impact: ImpactReport;
}

const d = (n: number | null | undefined) => (n === undefined ? undefined : n === null ? null : new Date(n));

/** Apply a task change, audit it, recompute, persist the live run with its impact. */
export async function updateTask(db: Db, taskId: string, input: TaskUpdateInput, actorId: string, now = Date.now()): Promise<LiveChangeResult> {
  const before = (await db.select().from(task).where(eq(task.id, taskId)).limit(1))[0];
  if (!before) throw notFound("task");
  const runbook = await loadRunbook(db, before.eventId);
  const mode = runbook.event.status === "live" ? "live" : "plan";
  const baseline = scheduleFor(runbook.input, mode, now);

  const set: Partial<typeof task.$inferInsert> = { updatedAt: new Date() };
  const at = input.actualStart ?? input.actualEnd ?? now;
  if (input.status !== undefined && input.status !== before.status) {
    set.status = input.status;
    switch (input.status) {
      case "in_progress":
        set.actualStart = d(input.actualStart) ?? before.actualStart ?? new Date(at);
        set.actualEnd = null;
        set.expectedUnblockAt = null;
        break;
      case "complete":
      case "skipped":
        set.actualStart = d(input.actualStart) ?? before.actualStart ?? new Date(at);
        set.actualEnd = d(input.actualEnd) ?? new Date(input.actualEnd ?? now);
        set.remainingDurationMinutes = null;
        set.expectedUnblockAt = null;
        break;
      case "blocked":
      case "failed":
        set.actualEnd = null;
        break;
      case "not_started":
        set.actualStart = null;
        set.actualEnd = null;
        set.remainingDurationMinutes = null;
        set.expectedUnblockAt = null;
        break;
    }
  }
  if (input.statusNote !== undefined) set.statusNote = input.statusNote;
  if (input.actualStart !== undefined && set.actualStart === undefined) set.actualStart = d(input.actualStart);
  if (input.actualEnd !== undefined && set.actualEnd === undefined) set.actualEnd = d(input.actualEnd);
  if (input.remainingDurationMinutes !== undefined) set.remainingDurationMinutes = input.remainingDurationMinutes;
  if (input.expectedUnblockAt !== undefined && set.expectedUnblockAt === undefined) set.expectedUnblockAt = d(input.expectedUnblockAt);
  if (input.plannedStart !== undefined) set.plannedStart = d(input.plannedStart);
  if (input.plannedDurationMinutes !== undefined) {
    if (input.plannedDurationMinutes < 0) throw badRequest("plannedDurationMinutes must be >= 0");
    set.plannedDurationMinutes = input.plannedDurationMinutes;
  }
  if (input.windowDeadline !== undefined) set.windowDeadline = d(input.windowDeadline);
  if (input.name !== undefined) set.name = input.name;
  if (input.ownerId !== undefined) set.ownerId = input.ownerId;
  if (input.workstreamId !== undefined) set.workstreamId = input.workstreamId;
  if (input.customFields !== undefined) set.customFields = { ...(before.customFields ?? {}), ...input.customFields };
  const finalStart = set.actualStart === undefined ? before.actualStart : set.actualStart;
  const finalEnd = set.actualEnd === undefined ? before.actualEnd : set.actualEnd;
  if (finalStart && finalEnd && finalEnd < finalStart) throw badRequest("actualEnd is before actualStart");

  return db.transaction(async (tx) => {
    const [after] = await tx.update(task).set(set).where(eq(task.id, taskId)).returning();
    const updated = await loadRunbook(tx, before.eventId);
    const r = simulateChanges(updated.input, baseline, [], { mode, asOf: now });
    if (!r.ok) throw conflict("graph invalid after update", r.errors);
    const kind = mode === "live" ? "live" : "scenario";
    const runId = await persistScheduleRun(tx, {
      eventId: before.eventId,
      kind,
      schedule: r.schedule,
      impact: r.impact,
      trigger: { type: "task.updated", taskId, ref: before.ref, fields: Object.keys(set).filter((k) => k !== "updatedAt") },
      createdById: actorId,
    });
    await writeAudit(tx, { eventId: before.eventId, entityType: "task", entityId: taskId, action: set.status ? "task.status_changed" : "task.updated", before: snapshot(before), after: snapshot(after), actorId, scheduleRunId: runId });
    return { task: after!, scheduleRunId: runId, schedule: r.schedule, impact: r.impact };
  });
}

export async function decideGate(db: Db, gateId: string, decision: GateDecision, note: string | undefined, actorId: string, now = Date.now()): Promise<LiveChangeResult> {
  const before = (await db.select().from(gate).where(eq(gate.id, gateId)).limit(1))[0];
  if (!before) throw notFound("gate");
  const runbook = await loadRunbook(db, before.eventId);
  const mode = runbook.event.status === "live" ? "live" : "plan";
  const baseline = scheduleFor(runbook.input, mode, now);
  return db.transaction(async (tx) => {
    const [after] = await tx
      .update(gate)
      .set({ decision, decidedAt: decision === "pending" ? null : new Date(now), decidedById: decision === "pending" ? null : actorId, decisionNote: note ?? null, updatedAt: new Date() })
      .where(eq(gate.id, gateId))
      .returning();
    const updated = await loadRunbook(tx, before.eventId);
    const r = simulateChanges(updated.input, baseline, [], { mode, asOf: now });
    if (!r.ok) throw conflict("graph invalid after update", r.errors);
    const runId = await persistScheduleRun(tx, { eventId: before.eventId, kind: mode === "live" ? "live" : "scenario", schedule: r.schedule, impact: r.impact, trigger: { type: "gate.decided", gateId, decision }, createdById: actorId });
    await writeAudit(tx, { eventId: before.eventId, entityType: "gate", entityId: gateId, action: "gate.decided", before: snapshot(before), after: snapshot(after), actorId, scheduleRunId: runId });
    return { gate: after!, scheduleRunId: runId, schedule: r.schedule, impact: r.impact };
  });
}

/** Pre-event what-if (or live what-if): no side effects unless `save`. */
export async function simulate(db: Db, eventId: string, changes: Change[], opts: { mode?: "plan" | "live"; asOf?: number; save?: boolean; actorId?: string }): Promise<{ schedule: Schedule; impact: ImpactReport; scheduleRunId?: string; baseline: Schedule }> {
  const runbook = await loadRunbook(db, eventId);
  const mode = opts.mode ?? (runbook.event.status === "live" ? "live" : "plan");
  const asOf = opts.asOf ?? Date.now();
  const baseline = scheduleFor(runbook.input, mode, asOf);
  const r = simulateChanges(runbook.input, baseline, changes, { mode, asOf });
  if (!r.ok) throw conflict("the change would make the graph invalid", r.errors);
  let scheduleRunId: string | undefined;
  if (opts.save) {
    scheduleRunId = await persistScheduleRun(db, { eventId, kind: "scenario", schedule: r.schedule, impact: r.impact, trigger: { type: "scenario", changes }, createdById: opts.actorId });
  }
  return { schedule: r.schedule, impact: r.impact, baseline, ...(scheduleRunId ? { scheduleRunId } : {}) };
}
