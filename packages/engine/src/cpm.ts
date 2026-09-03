/**
 * Critical Path Method with live-mode rules.
 *
 * Forward pass (topological order): early start/finish from constraints, statuses, gates.
 * Backward pass (reverse order): late start/finish anchored at min(windowEnd, projectedFinish)
 * and per-task deadlines, then propagated back through successors.
 * Float = lateFinish - earlyFinish. Critical = float <= 0.
 *
 * Anchoring at min(windowEnd, projectedFinish) means:
 *  - plan fits in the window  -> floats are relative to the longest path, so the classic
 *    critical path is highlighted even with hours of window slack;
 *  - plan overruns the window -> floats go negative by exactly the minutes to recover.
 *
 * Every rule here is deterministic: no clock reads, no randomness, ref-ordered tie-breaks.
 * See docs/proposals/0001-kickoff-architecture.md §4.3 for the rule table.
 */
import type {
  GateId,
  GateProjection,
  GateStatus,
  Graph,
  Schedule,
  ScheduleOptions,
  TaskId,
  TaskTiming,
  TimingAssumption,
} from "./types.js";
import { compareRef, minutesToMs, msToMinutes, sortedUnique } from "./util.js";

const DEFAULT_RECOVERY_MINUTES = 30;
const DEFAULT_GATE_RISK_MINUTES = 30;

interface Work {
  timing: TaskTiming;
  /** Effective duration (earlyFinish - earlyStart) used by the backward pass. */
  effDurMs: number;
  /** True when live rules pinned the start (started/complete tasks): predecessors do not drive it. */
  pinnedStart: boolean;
  /** Constraint value contributed by each in-edge / gate, keyed by "task:<id>" or "gate:<id>". */
  constraints: Map<string, number>;
}

export function computeSchedule(graph: Graph, opts: ScheduleOptions): Schedule {
  const { mode, asOf } = opts;
  const live = mode === "live";
  const ev = graph.input.event;
  const recoveryMs = minutesToMs(ev.defaultBlockedRecoveryMinutes ?? DEFAULT_RECOVERY_MINUTES);
  const riskThreshold = opts.gateAtRiskThresholdMinutes ?? DEFAULT_GATE_RISK_MINUTES;
  const gateWaitsForTarget = opts.gateWaitsForTarget ?? true;
  const refOf = (id: TaskId) => graph.tasks.get(id)!.ref;
  const byRef = (a: TaskId, b: TaskId) => compareRef(refOf(a), refOf(b));
  const byKey = (a: string, b: string) => {
    const ta = a.startsWith("task:");
    const tb = b.startsWith("task:");
    if (ta && tb) return byRef(a.slice(5), b.slice(5));
    if (ta !== tb) return ta ? -1 : 1;
    return a < b ? -1 : a > b ? 1 : 0;
  };

  const work = new Map<TaskId, Work>();

  // ---------------------------------------------------------------- forward pass
  for (const id of graph.order) {
    const t = graph.tasks.get(id)!;
    const durMs = minutesToMs(t.plannedDurationMinutes);
    const timing: TaskTiming = { taskId: id, isCritical: false, drivenBy: [], assumedFrom: [] };
    const w: Work = { timing, effDurMs: durMs, pinnedStart: false, constraints: new Map() };
    work.set(id, w);

    // Held: a no_go gate on this task, or any predecessor held.
    const gateIds = graph.gatesByGatedTask.get(id) ?? [];
    const heldByGate = gateIds.find((g) => graph.gates.get(g)!.decision === "no_go");
    if (heldByGate !== undefined) {
      timing.held = { reason: "gate_no_go", byGateId: heldByGate };
      continue;
    }
    const heldPreds: TaskId[] = [];
    const assumed = new Set<TaskId>();
    for (const e of graph.inEdges.get(id)!) {
      const p = work.get(e.predecessorId)!;
      if (p.timing.held) heldPreds.push(e.predecessorId);
      for (const a of p.timing.assumedFrom) assumed.add(a);
    }
    if (heldPreds.length > 0) {
      timing.held = { reason: "upstream_held", byTaskIds: sortedUnique(heldPreds, byRef) };
      continue;
    }

    // Constraints from predecessors (including synthetic gate edges) and gate decisions.
    let constraint = -Infinity;
    const addConstraint = (key: string, v: number) => {
      w.constraints.set(key, Math.max(w.constraints.get(key) ?? -Infinity, v));
      if (v > constraint) constraint = v;
    };
    for (const e of graph.inEdges.get(id)!) {
      const p = work.get(e.predecessorId)!.timing;
      const lag = minutesToMs(e.lagMinutes);
      let v: number;
      switch (e.type) {
        case "FS":
          v = p.earlyFinish! + lag;
          break;
        case "SS":
          v = p.earlyStart! + lag;
          break;
        case "FF":
          v = p.earlyFinish! + lag - durMs;
          break;
        case "SF":
          v = p.earlyStart! + lag - durMs;
          break;
      }
      addConstraint(`task:${e.predecessorId}`, v);
    }
    for (const gid of gateIds) {
      const g = graph.gates.get(gid)!;
      if (g.decision === "go") {
        if (g.decidedAt !== undefined) addConstraint(`gate:${gid}`, g.decidedAt);
      } else if (gateWaitsForTarget && g.targetDecisionAt !== undefined) {
        // A pending gate is assumed to be decided no earlier than its planned decision time.
        addConstraint(`gate:${gid}`, g.targetDecisionAt);
      }
    }

    const floor = t.plannedStart ?? ev.windowStart;
    let es: number;
    let ef: number;
    let assumption: TimingAssumption | undefined;

    const status = live ? t.status : "not_started";
    switch (status) {
      case "complete":
      case "skipped": {
        ef = t.actualEnd ?? asOf;
        es = t.actualStart ?? ef;
        if (es > ef) es = ef;
        w.pinnedStart = true;
        break;
      }
      case "in_progress": {
        es = t.actualStart ?? asOf;
        const elapsed = Math.max(0, asOf - es);
        const remaining =
          t.remainingDurationMinutes !== undefined ? minutesToMs(t.remainingDurationMinutes) : Math.max(0, durMs - elapsed);
        ef = Math.max(asOf, es) + remaining;
        w.pinnedStart = true;
        break;
      }
      case "blocked":
      case "failed": {
        const fromOwner = t.expectedUnblockAt !== undefined;
        const resumeAt = Math.max(asOf, fromOwner ? t.expectedUnblockAt! : asOf + recoveryMs);
        assumption = {
          kind: status === "blocked" ? "blocked_recovery" : "failed_rerun",
          resumeAt,
          fromOwnerEstimate: fromOwner,
        };
        // Failed work is assumed to be re-run in full; blocked work resumes with what is left.
        const remaining =
          status === "failed"
            ? durMs
            : t.remainingDurationMinutes !== undefined
              ? minutesToMs(t.remainingDurationMinutes)
              : durMs;
        if (t.actualStart !== undefined) {
          es = t.actualStart;
          ef = resumeAt + remaining;
          w.pinnedStart = true;
        } else {
          es = Math.max(floor, constraint, resumeAt);
          ef = es + remaining;
        }
        break;
      }
      case "not_started": {
        es = Math.max(floor, constraint, live ? asOf : -Infinity);
        ef = es + durMs;
        break;
      }
    }

    timing.earlyStart = es;
    timing.earlyFinish = ef;
    w.effDurMs = ef - es;
    if (!w.pinnedStart) {
      timing.drivenBy = Array.from(w.constraints.entries())
        .filter(([, v]) => v === es)
        .map(([k]) => k)
        .sort(byKey);
    }
    if (assumption) {
      timing.assumption = assumption;
      assumed.add(id);
    }
    timing.assumedFrom = sortedUnique(assumed, byRef);
    if (t.windowDeadline !== undefined && ef > t.windowDeadline) {
      timing.deadlineBreachMinutes = msToMinutes(ef - t.windowDeadline);
    }
  }

  // ---------------------------------------------------------------- projected finish
  let projectedFinish: number | undefined;
  for (const w of work.values()) {
    if (w.timing.held) continue;
    if (projectedFinish === undefined || w.timing.earlyFinish! > projectedFinish) projectedFinish = w.timing.earlyFinish!;
  }
  const anchor = projectedFinish === undefined ? ev.windowEnd : Math.min(ev.windowEnd, projectedFinish);

  // A pending gate assumed to be decided at its target time needs its entry work done by then.
  const entryCap = new Map<TaskId, number>();
  if (gateWaitsForTarget) {
    for (const g of graph.gates.values()) {
      if (g.decision !== "pending" || g.targetDecisionAt === undefined) continue;
      for (const id of g.entryTaskIds) entryCap.set(id, Math.min(entryCap.get(id) ?? Infinity, g.targetDecisionAt));
    }
  }

  // ---------------------------------------------------------------- backward pass
  for (let i = graph.order.length - 1; i >= 0; i--) {
    const id = graph.order[i]!;
    const w = work.get(id)!;
    const t = graph.tasks.get(id)!;
    if (w.timing.held) continue;
    let lf = anchor;
    if (t.windowDeadline !== undefined && t.windowDeadline < lf) lf = t.windowDeadline;
    const cap = entryCap.get(id);
    if (cap !== undefined && cap < lf) lf = cap;
    for (const e of graph.outEdges.get(id)!) {
      const s = work.get(e.successorId)!;
      if (s.timing.held || s.pinnedStart) continue; // a started successor no longer constrains us
      const lag = minutesToMs(e.lagMinutes);
      let v: number;
      switch (e.type) {
        case "FS":
          v = s.timing.lateStart! - lag;
          break;
        case "SS":
          v = s.timing.lateStart! - lag + w.effDurMs;
          break;
        case "FF":
          v = s.timing.lateFinish! - lag;
          break;
        case "SF":
          v = s.timing.lateFinish! - lag + w.effDurMs;
          break;
      }
      if (v < lf) lf = v;
    }
    w.timing.lateFinish = lf;
    w.timing.lateStart = lf - w.effDurMs;
    w.timing.totalFloatMinutes = msToMinutes(lf - w.timing.earlyFinish!);
    const done = live && (t.status === "complete" || t.status === "skipped");
    w.timing.isCritical = !done && w.timing.totalFloatMinutes <= 0;
  }

  // ---------------------------------------------------------------- aggregates
  const tasks: Record<TaskId, TaskTiming> = {};
  const heldTaskIds: TaskId[] = [];
  const deadlineBreaches: Schedule["deadlineBreaches"] = [];
  for (const id of graph.order) {
    const tm = work.get(id)!.timing;
    tasks[id] = tm;
    if (tm.held) heldTaskIds.push(id);
    if (tm.deadlineBreachMinutes !== undefined) deadlineBreaches.push({ taskId: id, minutes: tm.deadlineBreachMinutes });
  }
  deadlineBreaches.sort((a, b) => b.minutes - a.minutes || byRef(a.taskId, b.taskId));

  const criticalTaskIds = graph.order.filter((id) => work.get(id)!.timing.isCritical);
  const criticalPath = canonicalCriticalPath(work, criticalTaskIds, byRef);

  const gates: Record<GateId, GateProjection> = {};
  for (const gid of Array.from(graph.gates.keys()).sort()) {
    gates[gid] = projectGate(graph, gid, work, riskThreshold);
  }

  return {
    mode,
    asOf,
    tasks,
    gates,
    criticalPath,
    criticalTaskIds,
    ...(projectedFinish !== undefined ? { projectedFinish } : {}),
    eventWindowBreachMinutes: projectedFinish !== undefined ? Math.max(0, msToMinutes(projectedFinish - ev.windowEnd)) : 0,
    windowSlackMinutes: projectedFinish !== undefined ? msToMinutes(ev.windowEnd - projectedFinish) : undefined,
    deadlineBreaches,
    heldTaskIds,
  };
}

/**
 * One canonical critical path: start at the critical task needing the most recovery (lowest
 * float; ties: latest finish, then lowest ref), walk back through critical driving predecessors
 * (ties: lowest ref). Returned in forward order.
 * The walk stops at a task whose start is driven by something other than a task (a gate target,
 * a planned-start constraint, "now", or a pinned actual start).
 */
function canonicalCriticalPath(work: Map<TaskId, Work>, critical: TaskId[], byRef: (a: TaskId, b: TaskId) => number): TaskId[] {
  if (critical.length === 0) return [];
  let end = critical[0]!;
  for (const id of critical) {
    const a = work.get(id)!.timing;
    const b = work.get(end)!.timing;
    const fa = a.totalFloatMinutes!;
    const fb = b.totalFloatMinutes!;
    if (fa < fb || (fa === fb && (a.earlyFinish! > b.earlyFinish! || (a.earlyFinish === b.earlyFinish && byRef(id, end) < 0)))) end = id;
  }
  const path: TaskId[] = [end];
  const seen = new Set<TaskId>([end]);
  let cur = end;
  for (;;) {
    const cands = work
      .get(cur)!
      .timing.drivenBy.filter((k) => k.startsWith("task:"))
      .map((k) => k.slice(5))
      .filter((p) => work.get(p)!.timing.isCritical && !seen.has(p))
      .sort(byRef);
    const next = cands[0];
    if (next === undefined) break;
    path.push(next);
    seen.add(next);
    cur = next;
  }
  return path.reverse();
}

function projectGate(graph: Graph, gid: GateId, work: Map<TaskId, Work>, riskThreshold: number): GateProjection {
  const g = graph.gates.get(gid)!;
  const heldTaskIds = g.gatedTaskIds.filter((id) => work.get(id)!.timing.held?.byGateId === gid);
  let ready: number | undefined = g.entryTaskIds.length === 0 ? graph.input.event.windowStart : undefined;
  let anyHeld = false;
  let assumed = false;
  for (const id of g.entryTaskIds) {
    const tm = work.get(id)!.timing;
    if (tm.held) {
      anyHeld = true;
      continue;
    }
    if (tm.assumedFrom.length > 0) assumed = true;
    if (ready === undefined || tm.earlyFinish! > ready) ready = tm.earlyFinish!;
  }
  if (anyHeld) ready = undefined;

  const slackMinutes = ready !== undefined && g.targetDecisionAt !== undefined ? msToMinutes(g.targetDecisionAt - ready) : undefined;
  let status: GateStatus;
  if (g.decision === "go") status = "decided_go";
  else if (g.decision === "no_go") status = "decided_no_go";
  else if (ready === undefined) status = "held";
  else if (slackMinutes === undefined) status = "ok";
  else status = slackMinutes < 0 ? "breached" : slackMinutes < riskThreshold ? "at_risk" : "ok";

  return {
    gateId: gid,
    ...(ready !== undefined ? { projectedReadyAt: ready } : {}),
    ...(slackMinutes !== undefined ? { slackMinutes } : {}),
    status,
    heldTaskIds,
    assumed,
  };
}

/** Convenience: timing of one task or throw. */
export function timingOf(schedule: Schedule, taskId: TaskId): TaskTiming {
  const t = schedule.tasks[taskId];
  if (!t) throw new Error(`no timing for task ${taskId}`);
  return t;
}
