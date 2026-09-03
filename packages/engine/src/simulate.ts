import { buildGraph } from "./graph.js";
import { computeSchedule } from "./cpm.js";
import type {
  AffectedTask,
  Change,
  EngineTask,
  GateStatus,
  Graph,
  GraphInput,
  ImpactReport,
  NotifyReason,
  Schedule,
  ScheduleOptions,
  SimulateResult,
  TaskId,
  TimingSnapshot,
} from "./types.js";
import { compareRef, minutesToMs, msToMinutes } from "./util.js";

export class ChangeError extends Error {
  constructor(
    message: string,
    readonly change: Change,
  ) {
    super(message);
    this.name = "ChangeError";
  }
}

/**
 * Apply changes to a GraphInput, returning a new input (inputs are never mutated).
 * `baseline` lets relative changes ("delay by 30") resolve against projected times.
 */
export function applyChanges(input: GraphInput, changes: Change[], baseline?: Schedule): GraphInput {
  const tasks = input.tasks.map((t) => ({ ...t }));
  const byId = new Map(tasks.map((t) => [t.id, t] as const));
  let dependencies = input.dependencies.map((d) => ({ ...d }));
  const gates = input.gates.map((g) => ({ ...g, entryTaskIds: [...g.entryTaskIds], gatedTaskIds: [...g.gatedTaskIds] }));
  const gateById = new Map(gates.map((g) => [g.id, g] as const));

  const need = (c: Change, id: TaskId): EngineTask => {
    const t = byId.get(id);
    if (!t) throw new ChangeError(`unknown task ${id}`, c);
    return t;
  };
  const setOpt = <K extends keyof EngineTask>(t: EngineTask, k: K, v: EngineTask[K] | undefined) => {
    if (v === undefined) delete t[k];
    else t[k] = v;
  };

  for (const c of changes) {
    switch (c.kind) {
      case "set_planned_start":
        setOpt(need(c, c.taskId), "plannedStart", c.plannedStart);
        break;
      case "set_duration": {
        if (c.plannedDurationMinutes < 0) throw new ChangeError("duration must be >= 0", c);
        need(c, c.taskId).plannedDurationMinutes = c.plannedDurationMinutes;
        break;
      }
      case "set_deadline":
        setOpt(need(c, c.taskId), "windowDeadline", c.windowDeadline);
        break;
      case "delay": {
        const t = need(c, c.taskId);
        const base = baseline?.tasks[t.id];
        const ms = minutesToMs(c.minutes);
        switch (t.status) {
          case "complete":
          case "skipped":
            throw new ChangeError(`cannot delay a ${t.status} task`, c);
          case "in_progress": {
            const rem =
              t.remainingDurationMinutes ??
              (base?.earlyFinish !== undefined && baseline ? Math.max(0, msToMinutes(base.earlyFinish - baseline.asOf)) : t.plannedDurationMinutes);
            t.remainingDurationMinutes = Math.max(0, rem + c.minutes);
            break;
          }
          case "blocked":
          case "failed": {
            const resume = t.expectedUnblockAt ?? base?.assumption?.resumeAt;
            if (resume === undefined) throw new ChangeError("delay on a blocked task needs a baseline or expectedUnblockAt", c);
            t.expectedUnblockAt = resume + ms;
            break;
          }
          case "not_started": {
            const from = base?.earlyStart ?? t.plannedStart ?? input.event.windowStart;
            t.plannedStart = from + ms;
            break;
          }
        }
        break;
      }
      case "set_status": {
        const t = need(c, c.taskId);
        t.status = c.status;
        switch (c.status) {
          case "not_started":
            delete t.actualStart;
            delete t.actualEnd;
            delete t.remainingDurationMinutes;
            delete t.expectedUnblockAt;
            break;
          case "in_progress":
            t.actualStart ??= c.at;
            delete t.actualEnd;
            setOpt(t, "remainingDurationMinutes", c.remainingDurationMinutes);
            delete t.expectedUnblockAt;
            break;
          case "blocked":
          case "failed":
            delete t.actualEnd;
            if (c.remainingDurationMinutes !== undefined) t.remainingDurationMinutes = c.remainingDurationMinutes;
            setOpt(t, "expectedUnblockAt", c.expectedUnblockAt);
            break;
          case "complete":
          case "skipped":
            t.actualStart ??= c.at;
            t.actualEnd = c.at;
            delete t.remainingDurationMinutes;
            delete t.expectedUnblockAt;
            break;
        }
        break;
      }
      case "set_expected_unblock":
        setOpt(need(c, c.taskId), "expectedUnblockAt", c.expectedUnblockAt);
        break;
      case "set_gate_decision": {
        const g = gateById.get(c.gateId);
        if (!g) throw new ChangeError(`unknown gate ${c.gateId}`, c);
        g.decision = c.decision;
        if (c.decision === "pending") delete g.decidedAt;
        else g.decidedAt = c.at;
        break;
      }
      case "add_dependency":
        dependencies.push({ ...c.dependency });
        break;
      case "remove_dependency":
        dependencies = dependencies.filter((d) => !(d.predecessorId === c.predecessorId && d.successorId === c.successorId));
        break;
    }
  }
  return { event: { ...input.event }, tasks, dependencies, gates };
}

/**
 * Apply changes, rebuild, reschedule, and diff against the baseline. Pure.
 * Used for pre-event what-if (mode "plan" or "live") and for live recompute after a real change.
 */
export function simulateChanges(input: GraphInput, baseline: Schedule, changes: Change[], opts: ScheduleOptions): SimulateResult {
  const next = applyChanges(input, changes, baseline);
  const built = buildGraph(next);
  if (!built.ok) return built;
  const schedule = computeSchedule(built.graph, opts);
  return { ok: true, input: next, graph: built.graph, schedule, impact: diffSchedules(baseline, schedule, built.graph) };
}

function snap(s: Schedule, id: TaskId): TimingSnapshot {
  const t = s.tasks[id];
  if (!t) return { isCritical: false, held: false };
  return {
    ...(t.earlyStart !== undefined ? { earlyStart: t.earlyStart } : {}),
    ...(t.earlyFinish !== undefined ? { earlyFinish: t.earlyFinish } : {}),
    ...(t.totalFloatMinutes !== undefined ? { totalFloatMinutes: t.totalFloatMinutes } : {}),
    isCritical: t.isCritical,
    held: t.held !== undefined,
    ...(t.deadlineBreachMinutes !== undefined ? { deadlineBreachMinutes: t.deadlineBreachMinutes } : {}),
  };
}

const shift = (a?: number, b?: number) => (a !== undefined && b !== undefined ? msToMinutes(b - a) : undefined);

/** Compare two schedules over `graph`'s tasks and produce the impact report. */
export function diffSchedules(before: Schedule, after: Schedule, graph: Graph): ImpactReport {
  const affected: AffectedTask[] = [];
  const breaches = { new: [] as TaskId[], resolved: [] as TaskId[], worsened: [] as TaskId[], improved: [] as TaskId[] };
  const owners = new Map<string, { taskIds: TaskId[]; reasons: Set<NotifyReason> }>();
  const unowned: TaskId[] = [];

  for (const id of graph.order) {
    const b = snap(before, id);
    const a = snap(after, id);
    const startShift = shift(b.earlyStart, a.earlyStart);
    const finishShift = shift(b.earlyFinish, a.earlyFinish);
    const becameCritical = !b.isCritical && a.isCritical;
    const leftCriticalPath = b.isCritical && !a.isCritical;
    const becameHeld = !b.held && a.held;
    const released = b.held && !a.held;
    const bb = b.deadlineBreachMinutes ?? 0;
    const ab = a.deadlineBreachMinutes ?? 0;

    const reasons = new Set<NotifyReason>();
    if ((startShift ?? 0) > 0 || (finishShift ?? 0) > 0) reasons.add("shifted_later");
    else if ((startShift ?? 0) < 0 || (finishShift ?? 0) < 0) reasons.add("shifted_earlier");
    if (becameCritical) reasons.add("now_critical");
    if (becameHeld) reasons.add("held");
    if (released) reasons.add("released");
    if (bb === 0 && ab > 0) {
      breaches.new.push(id);
      reasons.add("deadline_breached");
    } else if (bb > 0 && ab === 0) {
      breaches.resolved.push(id);
      reasons.add("deadline_recovered");
    } else if (ab > bb) breaches.worsened.push(id);
    else if (ab < bb) breaches.improved.push(id);

    const changed = reasons.size > 0 || leftCriticalPath || ab !== bb || (b.totalFloatMinutes ?? 0) !== (a.totalFloatMinutes ?? 0);
    if (!changed) continue;

    const task = graph.tasks.get(id)!;
    affected.push({
      taskId: id,
      ref: task.ref,
      ...(task.ownerId !== undefined ? { ownerId: task.ownerId } : {}),
      before: b,
      after: a,
      ...(startShift !== undefined ? { startShiftMinutes: startShift } : {}),
      ...(finishShift !== undefined ? { finishShiftMinutes: finishShift } : {}),
      becameCritical,
      leftCriticalPath,
      becameHeld,
      released,
      ...(ab > 0 ? { deadlineBreachMinutes: ab } : {}),
    });
    if (reasons.size === 0) continue; // float-only changes do not warrant a notification
    if (task.ownerId === undefined) unowned.push(id);
    else {
      const o = owners.get(task.ownerId) ?? { taskIds: [], reasons: new Set<NotifyReason>() };
      o.taskIds.push(id);
      for (const r of reasons) o.reasons.add(r);
      owners.set(task.ownerId, o);
    }
  }

  const gates: ImpactReport["gates"] = [];
  for (const gid of Object.keys(after.gates).sort()) {
    const a = after.gates[gid]!;
    const b = before.gates[gid];
    const bs: GateStatus = b?.status ?? "ok";
    const readyShift = shift(b?.projectedReadyAt, a.projectedReadyAt);
    if (bs === a.status && (readyShift ?? 0) === 0 && b?.slackMinutes === a.slackMinutes) continue;
    gates.push({
      gateId: gid,
      before: bs,
      after: a.status,
      ...(b?.slackMinutes !== undefined ? { slackBeforeMinutes: b.slackMinutes } : {}),
      ...(a.slackMinutes !== undefined ? { slackAfterMinutes: a.slackMinutes } : {}),
      ...(readyShift !== undefined ? { readyShiftMinutes: readyShift } : {}),
    });
  }

  const pathChanged = before.criticalPath.length !== after.criticalPath.length || before.criticalPath.some((id, i) => id !== after.criticalPath[i]);
  const finishShift = shift(before.projectedFinish, after.projectedFinish);
  const reasonOrder: NotifyReason[] = ["held", "deadline_breached", "now_critical", "shifted_later", "released", "deadline_recovered", "shifted_earlier"];

  return {
    affectedTasks: affected,
    deadlineBreaches: breaches,
    gates,
    criticalPath: { before: before.criticalPath, after: after.criticalPath, changed: pathChanged },
    eventWindow: {
      ...(before.projectedFinish !== undefined ? { projectedFinishBefore: before.projectedFinish } : {}),
      ...(after.projectedFinish !== undefined ? { projectedFinishAfter: after.projectedFinish } : {}),
      breachMinutesBefore: before.eventWindowBreachMinutes,
      breachMinutesAfter: after.eventWindowBreachMinutes,
      ...(finishShift !== undefined ? { finishShiftMinutes: finishShift } : {}),
    },
    ownersToNotify: Array.from(owners.entries())
      .sort(([a], [b]) => compareRef(a, b))
      .map(([ownerId, o]) => ({ ownerId, taskIds: o.taskIds, reasons: reasonOrder.filter((r) => o.reasons.has(r)) })),
    unownedAffectedTaskIds: unowned,
  };
}
