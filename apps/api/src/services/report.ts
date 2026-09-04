/**
 * Post-event report (PRD §4.6): the full record of what happened, exportable for audit.
 *
 * Everything here is read from stored facts — audit entries, gate decisions, schedule
 * runs — never recomputed opinion. Planned-vs-actual variance is arithmetic on recorded
 * timestamps.
 */
import { asc, eq } from "drizzle-orm";
import { auditLogEntry, importBatch, notification, scheduleRun, type Db } from "@cutover/db";
import { computeSchedule, buildGraph } from "@cutover/engine";
import { loadRunbook } from "./runbook.js";

const MIN = 60_000;
const iso = (d: Date | null | undefined) => (d ? d.toISOString() : null);
const minutesBetween = (a: Date | null, b: Date | null) => (a && b ? Math.round((b.getTime() - a.getTime()) / MIN) : null);

export interface ReportTaskRow {
  ref: string;
  name: string;
  workstream: string | null;
  owner: string | null;
  status: string;
  plannedStart: string | null;
  plannedDurationMinutes: number;
  windowDeadline: string | null;
  actualStart: string | null;
  actualEnd: string | null;
  actualDurationMinutes: number | null;
  /** actual duration − planned duration; positive means it ran long. */
  durationVarianceMinutes: number | null;
  /** actual start − baseline projected start; positive means it started late. */
  startVarianceMinutes: number | null;
  metDeadline: boolean | null;
  statusNote: string | null;
}

export interface EventReport {
  generatedAt: string;
  event: {
    id: string;
    name: string;
    description: string | null;
    timezone: string;
    status: string;
    windowStart: string;
    windowEnd: string;
    actualStart: string | null;
    actualEnd: string | null;
    overranWindowMinutes: number | null;
  };
  summary: {
    tasks: number;
    complete: number;
    skipped: number;
    failed: number;
    blocked: number;
    notStarted: number;
    inProgress: number;
    dependencies: number;
    gates: number;
    gatesDecided: number;
    deadlinesMissed: number;
    statusChanges: number;
    imports: number;
    notificationsSent: number;
  };
  tasks: ReportTaskRow[];
  gates: {
    name: string;
    approver: string | null;
    isPointOfNoReturn: boolean;
    targetDecisionAt: string | null;
    decision: string;
    decidedAt: string | null;
    decidedBy: string | null;
    decisionNote: string | null;
    /** How late the decision was against its target, in minutes. */
    decisionVarianceMinutes: number | null;
    entryTaskRefs: string[];
    gatedTaskRefs: string[];
  }[];
  statusChanges: { at: string; taskRef: string; from: string | null; to: string | null; actor: string | null; note: string | null }[];
  auditTrail: { at: string; actor: string | null; action: string; entityType: string; entity: string; detail: string }[];
  scheduleRuns: { id: string; kind: string; asOf: string; computedAt: string; engineVersion: string; trigger: unknown }[];
  imports: { filename: string | null; format: string; status: string; committedAt: string | null; committedBy: string | null; summary: unknown }[];
  notifications: { at: string; kind: string; severity: string; title: string; recipient: string | null; channel: string; status: string }[];
}

export async function buildEventReport(db: Db, eventId: string): Promise<EventReport> {
  const rb = await loadRunbook(db, eventId);
  const [audit, runs, imports, notes] = await Promise.all([
    db.select().from(auditLogEntry).where(eq(auditLogEntry.eventId, eventId)).orderBy(asc(auditLogEntry.occurredAt), asc(auditLogEntry.id)),
    db.select().from(scheduleRun).where(eq(scheduleRun.eventId, eventId)).orderBy(asc(scheduleRun.computedAt)),
    db.select().from(importBatch).where(eq(importBatch.eventId, eventId)).orderBy(asc(importBatch.createdAt)),
    db.select().from(notification).where(eq(notification.eventId, eventId)).orderBy(asc(notification.createdAt)),
  ]);
  const userName = (id: string | null | undefined) => (id ? (rb.ownerNameById[id] ?? null) : null);
  const refOf = (id: string) => rb.tasks.find((t) => t.id === id)?.ref ?? id;

  // Baseline projection, for start variance. The first baseline run is the plan of record.
  const baselineRun = runs.find((r) => r.kind === "baseline");
  let baselineStart = new Map<string, number>();
  if (baselineRun) {
    const built = buildGraph(rb.input);
    if (built.ok) {
      const s = computeSchedule(built.graph, { mode: "plan", asOf: rb.event.windowStart.getTime() });
      baselineStart = new Map(Object.entries(s.tasks).map(([id, t]) => [id, t.earlyStart ?? NaN]));
    }
  }

  const tasks: ReportTaskRow[] = rb.tasks.map((t) => {
    const actualDuration = minutesBetween(t.actualStart, t.actualEnd);
    const planned = baselineStart.get(t.id);
    return {
      ref: t.ref,
      name: t.name,
      workstream: t.workstreamId ? (rb.workstreamNameById[t.workstreamId] ?? null) : null,
      owner: userName(t.ownerId) ?? t.ownerHint,
      status: t.status,
      plannedStart: iso(t.plannedStart),
      plannedDurationMinutes: t.plannedDurationMinutes,
      windowDeadline: iso(t.windowDeadline),
      actualStart: iso(t.actualStart),
      actualEnd: iso(t.actualEnd),
      actualDurationMinutes: actualDuration,
      durationVarianceMinutes: actualDuration === null ? null : actualDuration - t.plannedDurationMinutes,
      startVarianceMinutes: t.actualStart && planned !== undefined && Number.isFinite(planned) ? Math.round((t.actualStart.getTime() - planned) / MIN) : null,
      metDeadline: t.windowDeadline && t.actualEnd ? t.actualEnd <= t.windowDeadline : null,
      statusNote: t.statusNote,
    };
  });

  const statusChanges = audit
    .filter((a) => a.action === "task.status_changed")
    .map((a) => ({
      at: a.occurredAt.toISOString(),
      taskRef: refOf(a.entityId),
      from: ((a.before as Record<string, unknown> | null)?.["status"] as string) ?? null,
      to: ((a.after as Record<string, unknown> | null)?.["status"] as string) ?? null,
      actor: userName(a.actorId),
      note: ((a.after as Record<string, unknown> | null)?.["statusNote"] as string) ?? null,
    }));

  const actualStarts = rb.tasks.map((t) => t.actualStart).filter((d): d is Date => !!d);
  const actualEnds = rb.tasks.map((t) => t.actualEnd).filter((d): d is Date => !!d);
  const actualStart = actualStarts.length > 0 ? new Date(Math.min(...actualStarts.map((d) => d.getTime()))) : null;
  const actualEnd = actualEnds.length > 0 && rb.tasks.every((t) => t.status === "complete" || t.status === "skipped") ? new Date(Math.max(...actualEnds.map((d) => d.getTime()))) : null;

  return {
    generatedAt: new Date().toISOString(),
    event: {
      id: rb.event.id,
      name: rb.event.name,
      description: rb.event.description,
      timezone: rb.event.timezone,
      status: rb.event.status,
      windowStart: rb.event.windowStart.toISOString(),
      windowEnd: rb.event.windowEnd.toISOString(),
      actualStart: iso(actualStart),
      actualEnd: iso(actualEnd),
      overranWindowMinutes: actualEnd ? Math.max(0, Math.round((actualEnd.getTime() - rb.event.windowEnd.getTime()) / MIN)) : null,
    },
    summary: {
      tasks: rb.tasks.length,
      complete: rb.tasks.filter((t) => t.status === "complete").length,
      skipped: rb.tasks.filter((t) => t.status === "skipped").length,
      failed: rb.tasks.filter((t) => t.status === "failed").length,
      blocked: rb.tasks.filter((t) => t.status === "blocked").length,
      notStarted: rb.tasks.filter((t) => t.status === "not_started").length,
      inProgress: rb.tasks.filter((t) => t.status === "in_progress").length,
      dependencies: rb.dependencies.length,
      gates: rb.gates.length,
      gatesDecided: rb.gates.filter((g) => g.decision !== "pending").length,
      deadlinesMissed: tasks.filter((t) => t.metDeadline === false).length,
      statusChanges: statusChanges.length,
      imports: imports.filter((i) => i.status === "committed").length,
      notificationsSent: notes.filter((n) => n.status === "sent").length,
    },
    tasks,
    gates: rb.gates.map((g) => ({
      name: g.name,
      approver: userName(g.approverId),
      isPointOfNoReturn: g.isPointOfNoReturn,
      targetDecisionAt: iso(g.targetDecisionAt),
      decision: g.decision,
      decidedAt: iso(g.decidedAt),
      decidedBy: userName(g.decidedById),
      decisionNote: g.decisionNote,
      decisionVarianceMinutes: g.decidedAt && g.targetDecisionAt ? Math.round((g.decidedAt.getTime() - g.targetDecisionAt.getTime()) / MIN) : null,
      entryTaskRefs: g.entryTaskIds.map(refOf),
      gatedTaskRefs: g.gatedTaskIds.map(refOf),
    })),
    statusChanges,
    auditTrail: audit.map((a) => ({
      at: a.occurredAt.toISOString(),
      actor: userName(a.actorId),
      action: a.action,
      entityType: a.entityType,
      entity: a.entityType === "task" ? refOf(a.entityId) : a.entityType === "gate" ? (rb.gates.find((g) => g.id === a.entityId)?.name ?? a.entityId) : a.entityId,
      detail: describeChange(a.before as Record<string, unknown> | null, a.after as Record<string, unknown> | null),
    })),
    scheduleRuns: runs.map((r) => ({ id: r.id, kind: r.kind, asOf: r.asOf.toISOString(), computedAt: r.computedAt.toISOString(), engineVersion: r.engineVersion, trigger: r.trigger })),
    imports: imports.map((i) => ({ filename: i.filename, format: i.format, status: i.status, committedAt: iso(i.committedAt), committedBy: userName(i.committedById), summary: i.summary })),
    notifications: notes.map((n) => ({ at: n.createdAt.toISOString(), kind: n.kind, severity: n.severity, title: n.title, recipient: userName(n.recipientUserId), channel: n.channel, status: n.status })),
  };
}

function describeChange(before: Record<string, unknown> | null, after: Record<string, unknown> | null): string {
  if (!after) return "";
  if (!before) {
    return ["name", "ref", "status", "decision"]
      .filter((k) => k in after)
      .map((k) => `${k}=${String(after[k])}`)
      .join(" ");
  }
  const diffs: string[] = [];
  for (const k of Object.keys(after)) {
    if (k === "updatedAt") continue;
    if (JSON.stringify(before[k]) !== JSON.stringify(after[k])) diffs.push(`${k}: ${short(before[k])} → ${short(after[k])}`);
  }
  return diffs.join("; ");
}
function short(v: unknown): string {
  if (v === null || v === undefined) return "—";
  const s = typeof v === "object" ? JSON.stringify(v) : String(v);
  return s.length > 80 ? s.slice(0, 77) + "…" : s;
}

/** CSV of the audit trail: the artifact a compliance reviewer asks for. */
export function auditCsv(report: EventReport): string {
  const head = ["timestamp", "actor", "action", "entity_type", "entity", "detail"];
  const rows = report.auditTrail.map((a) => [a.at, a.actor ?? "system", a.action, a.entityType, a.entity, a.detail]);
  return toCsv([head, ...rows]);
}

/** CSV of planned vs actual per task. */
export function tasksCsv(report: EventReport): string {
  const head = ["ref", "name", "workstream", "owner", "status", "planned_start", "planned_duration_min", "deadline", "actual_start", "actual_end", "actual_duration_min", "duration_variance_min", "start_variance_min", "met_deadline", "note"];
  const rows = report.tasks.map((t) => [
    t.ref,
    t.name,
    t.workstream ?? "",
    t.owner ?? "",
    t.status,
    t.plannedStart ?? "",
    String(t.plannedDurationMinutes),
    t.windowDeadline ?? "",
    t.actualStart ?? "",
    t.actualEnd ?? "",
    t.actualDurationMinutes === null ? "" : String(t.actualDurationMinutes),
    t.durationVarianceMinutes === null ? "" : String(t.durationVarianceMinutes),
    t.startVarianceMinutes === null ? "" : String(t.startVarianceMinutes),
    t.metDeadline === null ? "" : t.metDeadline ? "yes" : "no",
    t.statusNote ?? "",
  ]);
  return toCsv([head, ...rows]);
}

export function toCsv(rows: string[][]): string {
  return rows.map((r) => r.map(csvCell).join(",")).join("\r\n") + "\r\n";
}
function csvCell(v: string): string {
  // Guard against spreadsheet formula injection in exported audit data.
  const s = /^[=+\-@\t\r]/.test(v) ? `'${v}` : v;
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
