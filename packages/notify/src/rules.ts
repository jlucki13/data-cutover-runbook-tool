/**
 * Deterministic notification rules (PRD §4.5).
 *
 * Every notice is derived from engine output and recorded state. Ordering is stable
 * (severity, then kind, then task ref) so the same event always produces the same list.
 */
import { compareRef, type Graph, type Schedule, type TaskId } from "@cutover/engine";
import type { DirectoryGate, DirectoryTask, Notification, NotifyInput, NotifyOptions, Recipient, Severity } from "./types.js";

const MIN = 60_000;
const mins = (ms: number) => Math.round(ms / MIN);

const SEVERITY_ORDER: Severity[] = ["critical", "warning", "info"];

/** Whole-minute bucket so a notice repeats only when the situation materially changes. */
function bucket(minutes: number, size: number): number {
  return Math.floor(minutes / Math.max(1, size));
}

export function fmtMinutes(m: number): string {
  const sign = m < 0 ? "-" : "";
  const a = Math.abs(Math.round(m));
  const h = Math.floor(a / 60);
  const r = a % 60;
  if (h === 0) return `${sign}${r}m`;
  if (r === 0) return `${sign}${h}h`;
  return `${sign}${h}h ${r}m`;
}

export function fmtTime(ms: number | undefined, tz: string): string {
  if (ms === undefined) return "unknown";
  return new Intl.DateTimeFormat("en-GB", { timeZone: tz, weekday: "short", day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(new Date(ms));
}

/**
 * Evaluate every rule against a schedule. `graph` supplies predecessor relationships;
 * `input.before` (when given) lets transition-only notices fire once.
 */
export function evaluateNotifications(graph: Graph, input: NotifyInput, opts: NotifyOptions = {}): Notification[] {
  const readyWithin = (opts.readyWithinMinutes ?? 0) * MIN;
  const gateWithin = (opts.gateAwaitingWithinMinutes ?? 120) * MIN;
  const bucketSize = opts.magnitudeBucketMinutes ?? 30;
  const skipFinished = opts.skipFinishedTasks ?? true;
  const { event, schedule, before, tasks, gates, asOf } = input;
  const tz = event.timezone;
  const taskById = new Map(tasks.map((t) => [t.id, t] as const));
  const out: Notification[] = [];

  // Tasks a gate stands in front of. A *pending* gate holds nothing in the engine's sense
  // (only a no-go does), so "waiting on this decision" has to be counted from the graph.
  const gatedByGate = new Map<string, TaskId[]>();
  for (const [taskId, gateIds] of graph.gatesByGatedTask) {
    for (const gid of gateIds) {
      const list = gatedByGate.get(gid) ?? [];
      list.push(taskId);
      gatedByGate.set(gid, list);
    }
  }

  const commandCentre: Recipient[] = input.commandCentreUserIds.map((userId) => ({ userId, reason: "command_center" as const }));
  const ownerOf = (t: DirectoryTask): Recipient[] => (t.ownerId ? [{ userId: t.ownerId, reason: "owner" as const }] : []);

  // ------------------------------------------------------------------ tasks
  for (const id of graph.order) {
    const t = taskById.get(id);
    if (!t) continue;
    const finished = t.status === "complete" || t.status === "skipped";
    if (skipFinished && finished) continue;
    const tm = schedule.tasks[id];
    if (!tm) continue;
    const owner = ownerOf(t);
    const label = `${t.ref} ${t.name}`;

    // Held: a no-go gate, or an upstream block/failure.
    if (tm.held) {
      const byGate = tm.held.byGateId ? gates.find((g) => g.id === tm.held!.byGateId) : undefined;
      const byTasks = (tm.held.byTaskIds ?? []).map((x) => taskById.get(x)?.ref ?? x);
      out.push({
        kind: "task_held",
        severity: "warning",
        entityType: "task",
        entityId: id,
        title: `${t.ref} is held: ${tm.held.reason.replace(/_/g, " ")}`,
        body: byGate
          ? `${label} cannot proceed because the gate "${byGate.name}" was decided no-go. Nothing downstream of it will move until that decision changes.`
          : `${label} cannot proceed because ${byTasks.join(", ")} ${byTasks.length === 1 ? "is" : "are"} blocked or failed upstream.`,
        facts: { ref: t.ref, reason: tm.held.reason, byGate: byGate?.name, byTasks },
        recipients: [...owner, ...commandCentre],
        dedupeKey: `task_held:${id}:${tm.held.reason}:${tm.held.byGateId ?? byTasks.join(",")}`,
      });
      continue; // a held task has no projection to be at risk about
    }

    // The owner has stopped: this is the signal a command centre most wants, whether or
    // not the projected recovery happens to breach anything yet.
    if (t.status === "blocked" || t.status === "failed") {
      const resume = tm.assumption?.resumeAt;
      const fromOwner = tm.assumption?.fromOwnerEstimate ?? false;
      out.push({
        kind: "task_blocked",
        severity: t.status === "failed" ? "critical" : "warning",
        entityType: "task",
        entityId: id,
        title: `${t.ref} is ${t.status}${t.statusNote ? `: ${t.statusNote}` : ""}`,
        body: `${label} is ${t.status}.${t.statusNote ? ` The owner noted: ${t.statusNote}.` : ""} Work is assumed to ${t.status === "failed" ? "re-run" : "resume"} at ${fmtTime(resume, tz)} (${fromOwner ? "the owner's estimate" : "the event's default recovery"}), putting its finish at ${fmtTime(tm.earlyFinish, tz)}.`,
        facts: { ref: t.ref, status: t.status, note: t.statusNote, assumedResumeAt: resume, fromOwnerEstimate: fromOwner, projectedFinish: tm.earlyFinish },
        recipients: [...owner, ...commandCentre],
        dedupeKey: `task_blocked:${id}:${t.status}:${resume !== undefined ? bucket(mins(resume), bucketSize) : "none"}`,
      });
    }

    // Ready: not started, nothing upstream outstanding, and startable now.
    if (t.status === "not_started" && tm.earlyStart !== undefined && tm.earlyStart <= asOf + readyWithin) {
      const preds = graph.inEdges.get(id) ?? [];
      const outstanding = preds.filter((e) => {
        const p = taskById.get(e.predecessorId);
        return !p || !(p.status === "complete" || p.status === "skipped");
      });
      const gatesOnTask = (graph.gatesByGatedTask.get(id) ?? []).map((gid) => gates.find((g) => g.id === gid)).filter((g): g is DirectoryGate => !!g);
      const gatesOpen = gatesOnTask.filter((g) => g.decision !== "go");
      if (outstanding.length === 0 && gatesOpen.length === 0) {
        out.push({
          kind: "task_ready",
          severity: "info",
          entityType: "task",
          entityId: id,
          title: `${t.ref} is ready to start`,
          body: `${label} is unblocked: every predecessor is complete and any gate in front of it is approved. Planned duration ${fmtMinutes(mins((tm.earlyFinish ?? tm.earlyStart) - tm.earlyStart))}.`,
          facts: { ref: t.ref, earlyStart: tm.earlyStart, earlyFinish: tm.earlyFinish, workstream: t.workstreamName },
          recipients: owner.length > 0 ? owner : commandCentre,
          dedupeKey: `task_ready:${id}`,
        });
      }
    }

    // Deadline at risk: projected finish past the task's own deadline.
    if (tm.deadlineBreachMinutes !== undefined && tm.deadlineBreachMinutes > 0) {
      out.push({
        kind: "task_deadline_at_risk",
        severity: "critical",
        entityType: "task",
        entityId: id,
        title: `${t.ref} will miss its deadline by ${fmtMinutes(tm.deadlineBreachMinutes)}`,
        body: `${label} is projected to finish at ${fmtTime(tm.earlyFinish, tz)}, ${fmtMinutes(tm.deadlineBreachMinutes)} past its deadline of ${fmtTime(t.windowDeadline, tz)}.${tm.assumedFrom.length > 0 ? " This projection assumes blocked work upstream recovers as estimated." : ""}`,
        facts: { ref: t.ref, breachMinutes: tm.deadlineBreachMinutes, projectedFinish: tm.earlyFinish, deadline: t.windowDeadline, assumed: tm.assumedFrom.length > 0 },
        recipients: [...owner, ...commandCentre],
        dedupeKey: `task_deadline_at_risk:${id}:${bucket(tm.deadlineBreachMinutes, bucketSize)}`,
      });
    } else if (tm.totalFloatMinutes !== undefined && tm.totalFloatMinutes < 0) {
      // Negative float without its own deadline: the plan as a whole needs this back.
      out.push({
        kind: "task_negative_float",
        severity: "warning",
        entityType: "task",
        entityId: id,
        title: `${t.ref} needs ${fmtMinutes(-tm.totalFloatMinutes)} recovered`,
        body: `${label} has ${fmtMinutes(tm.totalFloatMinutes)} of float: it is on the chain that decides whether the event holds its window or its gates. Recovering ${fmtMinutes(-tm.totalFloatMinutes)} here puts the plan back on track.`,
        facts: { ref: t.ref, floatMinutes: tm.totalFloatMinutes, projectedFinish: tm.earlyFinish },
        recipients: [...owner, ...commandCentre],
        dedupeKey: `task_negative_float:${id}:${bucket(-tm.totalFloatMinutes, bucketSize)}`,
      });
    }
  }

  // ------------------------------------------------------------------ gates
  for (const g of [...gates].sort((a, b) => (a.targetDecisionAt ?? Infinity) - (b.targetDecisionAt ?? Infinity) || a.name.localeCompare(b.name))) {
    const gp = schedule.gates[g.id];
    if (!gp) continue;
    const bp = before?.gates[g.id];
    const approver: Recipient[] = g.approverId ? [{ userId: g.approverId, reason: "approver" }] : [];
    const audience = dedupeRecipients([...approver, ...commandCentre]);

    // Decision made (transition only).
    if (g.decision !== "pending" && (!bp || bp.status !== gp.status)) {
      out.push({
        kind: "gate_decided",
        severity: g.decision === "no_go" ? "critical" : "info",
        entityType: "gate",
        entityId: g.id,
        title: `Gate "${g.name}" decided: ${g.decision === "go" ? "GO" : "NO-GO"}`,
        body:
          g.decision === "go"
            ? `${g.decidedByName ?? "The approver"} approved "${g.name}" at ${fmtTime(g.decidedAt, tz)}. Work behind this gate can proceed.${g.isPointOfNoReturn ? " This was the point of no return: rollback is no longer available." : ""}`
            : `${g.decidedByName ?? "The approver"} called no-go on "${g.name}" at ${fmtTime(g.decidedAt, tz)}. Every task behind this gate is held until that changes.`,
        facts: { gate: g.name, decision: g.decision, decidedAt: g.decidedAt, pointOfNoReturn: g.isPointOfNoReturn, heldTaskCount: gp.heldTaskIds.length },
        recipients: audience,
        dedupeKey: `gate_decided:${g.id}:${g.decision}:${g.decidedAt ?? ""}`,
      });
      continue;
    }
    if (g.decision !== "pending") continue;

    // Breached or at risk against its target time.
    if (gp.status === "breached" || gp.status === "at_risk") {
      const slack = gp.slackMinutes ?? 0;
      out.push({
        kind: "gate_at_risk",
        severity: gp.status === "breached" ? "critical" : "warning",
        entityType: "gate",
        entityId: g.id,
        title: gp.status === "breached" ? `Gate "${g.name}" is breached by ${fmtMinutes(-slack)}` : `Gate "${g.name}" has only ${fmtMinutes(slack)} of slack`,
        body: `Entry work for "${g.name}" is projected to finish at ${fmtTime(gp.projectedReadyAt, tz)}, against a target decision time of ${fmtTime(g.targetDecisionAt, tz)}.${gp.assumed ? " This rests on blocked work recovering as estimated." : ""}${g.isPointOfNoReturn ? " This gate is the point of no return." : ""}`,
        facts: { gate: g.name, status: gp.status, slackMinutes: gp.slackMinutes, projectedReadyAt: gp.projectedReadyAt, targetDecisionAt: g.targetDecisionAt, assumed: gp.assumed, pointOfNoReturn: g.isPointOfNoReturn },
        recipients: audience,
        dedupeKey: `gate_at_risk:${g.id}:${gp.status}:${bucket(slack, bucketSize)}`,
      });
    }

    // Awaiting a decision: entry work is done, or the target time is close.
    const waiting = (gatedByGate.get(g.id) ?? []).filter((id) => {
      const t = taskById.get(id);
      return t && t.status !== "complete" && t.status !== "skipped";
    }).length;
    const entryDone = gp.projectedReadyAt !== undefined && gp.projectedReadyAt <= asOf;
    const targetClose = g.targetDecisionAt !== undefined && g.targetDecisionAt - asOf <= gateWithin;
    if (event.status === "live" && (entryDone || targetClose)) {
      out.push({
        kind: "gate_awaiting_decision",
        severity: g.isPointOfNoReturn ? "warning" : "info",
        entityType: "gate",
        entityId: g.id,
        title: `Gate "${g.name}" is waiting on a decision`,
        body: `${entryDone ? "All entry work for this gate is complete." : `This gate is due to be decided at ${fmtTime(g.targetDecisionAt, tz)}.`} ${waiting} task${waiting === 1 ? "" : "s"} ${waiting === 1 ? "waits" : "wait"} on it.${g.approverName ? ` ${g.approverName} is the designated approver.` : ""}`,
        facts: { gate: g.name, entryDone, targetDecisionAt: g.targetDecisionAt, waitingTasks: waiting, approver: g.approverName },
        recipients: audience,
        dedupeKey: `gate_awaiting_decision:${g.id}:${entryDone ? "ready" : "due"}`,
      });
    }
  }

  // ------------------------------------------------------------------ event
  if (schedule.eventWindowBreachMinutes > 0) {
    out.push({
      kind: "event_window_at_risk",
      severity: "critical",
      entityType: "event",
      entityId: event.id,
      title: `${event.name} is projected to overrun its window by ${fmtMinutes(schedule.eventWindowBreachMinutes)}`,
      body: `The plan now finishes at ${fmtTime(schedule.projectedFinish, tz)}, past the window end of ${fmtTime(event.windowEnd, tz)}. The chain deciding this is ${schedule.criticalPath.map((id) => taskById.get(id)?.ref ?? id).join(" → ") || "not yet determined"}.`,
      facts: { breachMinutes: schedule.eventWindowBreachMinutes, projectedFinish: schedule.projectedFinish, windowEnd: event.windowEnd, criticalPath: schedule.criticalPath.map((id) => taskById.get(id)?.ref ?? id) },
      recipients: commandCentre,
      dedupeKey: `event_window_at_risk:${event.id}:${bucket(schedule.eventWindowBreachMinutes, bucketSize)}`,
    });
  }

  const refOf = (n: Notification) => (n.entityType === "task" ? (taskById.get(n.entityId)?.ref ?? n.entityId) : n.entityId);
  return out.sort((a, b) => SEVERITY_ORDER.indexOf(a.severity) - SEVERITY_ORDER.indexOf(b.severity) || a.kind.localeCompare(b.kind) || compareRef(refOf(a), refOf(b)));
}

function dedupeRecipients(rs: Recipient[]): Recipient[] {
  const seen = new Set<string>();
  const out: Recipient[] = [];
  for (const r of rs) {
    if (seen.has(r.userId)) continue;
    seen.add(r.userId);
    out.push(r);
  }
  return out;
}

/** Notices whose dedupe key is not already present in `known`. */
export function newNotifications(candidates: Notification[], known: Iterable<string>): Notification[] {
  const seen = new Set(known);
  return candidates.filter((n) => !seen.has(n.dedupeKey));
}

export type { Graph, Schedule, TaskId };
