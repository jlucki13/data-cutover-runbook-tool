import { describe, expect, it } from "vitest";
import { ChangeError, applyChanges, simulateChanges } from "../src/index.js";
import type { GraphInput, Schedule } from "../src/index.js";
import { at, dep, gate, input, plan, rel, task, view, T0 } from "./helpers.js";

/**
 *  A(60, owner o1) -> B(60, o2) -> D(30, o2, deadline 200)
 *  A               -> C(120, no owner) -> D
 *  gate G: entry D, gated E(30, o3), target 260
 */
const base = (): GraphInput =>
  input(
    [
      task("A", 60, { ownerId: "o1" }),
      task("B", 60, { ownerId: "o2" }),
      task("C", 120),
      task("D", 30, { ownerId: "o2", windowDeadline: at(230) }),
      task("E", 30, { ownerId: "o3" }),
    ],
    [dep("A", "B"), dep("A", "C"), dep("B", "D"), dep("C", "D")],
    [gate("G", ["D"], ["E"], { targetDecisionAt: at(260) })],
    { windowEnd: at(600) },
  );

const sim = (i: GraphInput, baseline: Schedule, changes: Parameters<typeof simulateChanges>[2], mode: "plan" | "live" = "plan", asOf = T0) => {
  const r = simulateChanges(i, baseline, changes, { mode, asOf });
  if (!r.ok) throw new Error(JSON.stringify(r.errors));
  return r;
};

describe("applyChanges", () => {
  it("never mutates its input", () => {
    const i = base();
    const frozen = JSON.stringify(i);
    applyChanges(i, [
      { kind: "set_duration", taskId: "A", plannedDurationMinutes: 999 },
      { kind: "set_gate_decision", gateId: "G", decision: "go", at: T0 },
      { kind: "add_dependency", dependency: dep("B", "C") },
    ]);
    expect(JSON.stringify(i)).toBe(frozen);
  });

  it("rejects unknown tasks and delays on finished tasks", () => {
    expect(() => applyChanges(base(), [{ kind: "set_duration", taskId: "nope", plannedDurationMinutes: 1 }])).toThrow(ChangeError);
    const done = base();
    done.tasks[0]!.status = "complete";
    expect(() => applyChanges(done, [{ kind: "delay", taskId: "A", minutes: 10 }])).toThrow(/cannot delay/);
  });

  it("set_status fills actuals sensibly", () => {
    const out = applyChanges(base(), [
      { kind: "set_status", taskId: "A", status: "in_progress", at: at(5) },
      { kind: "set_status", taskId: "B", status: "complete", at: at(50) },
      { kind: "set_status", taskId: "C", status: "blocked", at: at(20), expectedUnblockAt: at(90) },
    ]);
    expect(out.tasks[0]).toMatchObject({ status: "in_progress", actualStart: at(5) });
    expect(out.tasks[1]).toMatchObject({ status: "complete", actualStart: at(50), actualEnd: at(50) });
    expect(out.tasks[2]).toMatchObject({ status: "blocked", expectedUnblockAt: at(90) });
  });
});

describe("simulateChanges: delaying a task", () => {
  it("reports downstream shifts, breaches, gate risk, critical path change, and owners to notify", () => {
    const i = base();
    const baseline = plan(i);
    // Baseline: A 0-60, B 60-120, C 60-180, D 180-210, G ready 210 (slack 50, ok), E 260-290.
    expect(view(baseline, "D")).toMatchObject({ es: 180, ef: 210 });
    expect(baseline.gates["G"]).toMatchObject({ status: "ok", slackMinutes: 50 });
    expect(baseline.criticalPath).toEqual(["E"]);

    // What if B slips by 90 minutes? B 150-210, D 210-240 (deadline 230 → breach 10), G ready 240 (slack 20 → at_risk), E unchanged (target 260).
    const r = sim(i, baseline, [{ kind: "delay", taskId: "B", minutes: 90 }]);
    expect(view(r.schedule, "B")).toMatchObject({ es: 150, ef: 210 });
    expect(view(r.schedule, "D")).toMatchObject({ es: 210, ef: 240, breach: 10 });
    expect(view(r.schedule, "E")).toMatchObject({ es: 260 });

    const byId = Object.fromEntries(r.impact.affectedTasks.map((a) => [a.taskId, a]));
    expect(byId["B"]).toMatchObject({ startShiftMinutes: 90, finishShiftMinutes: 90, becameCritical: true });
    expect(byId["D"]).toMatchObject({ startShiftMinutes: 30, finishShiftMinutes: 30, deadlineBreachMinutes: 10, becameCritical: true });
    // C and A are untouched: their late dates hang off D's deadline, which did not move.
    expect(byId["C"]).toBeUndefined();
    expect(byId["A"]).toBeUndefined();
    expect(byId["E"]).toBeUndefined();

    expect(r.impact.deadlineBreaches).toEqual({ new: ["D"], resolved: [], worsened: [], improved: [] });
    expect(r.impact.gates).toEqual([{ gateId: "G", before: "ok", after: "at_risk", slackBeforeMinutes: 50, slackAfterMinutes: 20, readyShiftMinutes: 30 }]);
    expect(r.impact.criticalPath).toMatchObject({ changed: true, after: ["B", "D"] });
    expect(r.impact.eventWindow).toMatchObject({ breachMinutesBefore: 0, breachMinutesAfter: 0, finishShiftMinutes: 0 });
    expect(r.impact.ownersToNotify).toEqual([{ ownerId: "o2", taskIds: ["B", "D"], reasons: ["deadline_breached", "now_critical", "shifted_later"] }]);
    expect(r.impact.unownedAffectedTaskIds).toEqual([]);
  });

  it("lists affected tasks without an owner separately so nobody is silently missed", () => {
    const i = base();
    const baseline = plan(i);
    const r = sim(i, baseline, [{ kind: "delay", taskId: "A", minutes: 10 }]);
    expect(r.impact.unownedAffectedTaskIds).toEqual(["C"]);
    expect(r.impact.ownersToNotify.map((o) => o.ownerId)).toEqual(["o1", "o2"]);
  });

  it("a delay large enough moves the event finish and breaches the window", () => {
    const i = base();
    const baseline = plan(i);
    const r = sim(i, baseline, [{ kind: "delay", taskId: "C", minutes: 500 }]);
    // C 560-680, D 680-710, E 710-740 → window 600 breached by 140
    expect(r.impact.eventWindow).toMatchObject({ breachMinutesBefore: 0, breachMinutesAfter: 140, finishShiftMinutes: 450 });
    expect(r.impact.gates[0]).toMatchObject({ gateId: "G", after: "breached" });
    // D's deadline breach (−480) needs more recovery than the window breach on E (−140): C→D is the canonical path.
    expect(r.schedule.criticalPath).toEqual(["C", "D"]);
    expect(r.schedule.criticalTaskIds).toEqual(["C", "D", "E"]);
    expect(view(r.schedule, "E").float).toBe(-140);
  });

  it("pulling a task earlier reports shifted_earlier and recovered deadlines", () => {
    const i = base();
    const slipped = sim(i, plan(i), [{ kind: "delay", taskId: "B", minutes: 90 }]);
    const r = sim(slipped.input, slipped.schedule, [{ kind: "set_duration", taskId: "B", plannedDurationMinutes: 30 }]);
    expect(r.impact.deadlineBreaches.resolved).toEqual(["D"]);
    expect(r.impact.ownersToNotify[0]!.reasons).toContain("deadline_recovered");
    expect(r.impact.ownersToNotify[0]!.reasons).toContain("shifted_earlier");
  });
});

describe("simulateChanges: status and gate changes in live mode", () => {
  it("blocking a task projects an assumed recovery and marks everything downstream as assumed", () => {
    const i = base();
    const asOf = at(70);
    const baseline = simulateChanges(i, plan(i), [{ kind: "set_status", taskId: "A", status: "complete", at: at(60) }], { mode: "live", asOf });
    if (!baseline.ok) throw new Error("baseline failed");
    const r = simulateChanges(baseline.input, baseline.schedule, [{ kind: "set_status", taskId: "C", status: "blocked", at: asOf }], { mode: "live", asOf });
    if (!r.ok) throw new Error("failed");
    // C blocked at 70, assumed resume 100, full 120 → 220. D 220-250 (breach 20).
    expect(view(r.schedule, "C")).toMatchObject({ es: 100, ef: 220 });
    expect(r.schedule.tasks["D"]!.assumedFrom).toEqual(["C"]);
    expect(r.schedule.gates["G"]!.assumed).toBe(true);
    expect(r.impact.deadlineBreaches.new).toEqual(["D"]);
  });

  it("a no_go decision holds gated work and a later go releases it", () => {
    const i = base();
    const baseline = plan(i);
    const noGo = sim(i, baseline, [{ kind: "set_gate_decision", gateId: "G", decision: "no_go", at: at(210) }]);
    expect(noGo.schedule.tasks["E"]!.held).toEqual({ reason: "gate_no_go", byGateId: "G" });
    // E is held; with it gone the projected finish shrinks to D's end, so A–C–D become the critical chain.
    expect(noGo.impact.ownersToNotify).toEqual([
      { ownerId: "o1", taskIds: ["A"], reasons: ["now_critical"] },
      { ownerId: "o2", taskIds: ["D"], reasons: ["now_critical"] },
      { ownerId: "o3", taskIds: ["E"], reasons: ["held"] },
    ]);
    expect(noGo.impact.unownedAffectedTaskIds).toEqual(["C"]);
    expect(noGo.impact.gates[0]).toMatchObject({ before: "ok", after: "decided_no_go" });

    const go = sim(noGo.input, noGo.schedule, [{ kind: "set_gate_decision", gateId: "G", decision: "go", at: at(300) }]);
    expect(view(go.schedule, "E")).toMatchObject({ es: 300, held: undefined });
    // Released, and trivially critical as the last task in the plan.
    expect(go.impact.ownersToNotify).toEqual([{ ownerId: "o3", taskIds: ["E"], reasons: ["now_critical", "released"] }]);
    const e = go.impact.affectedTasks.find((a) => a.taskId === "E")!;
    expect(e.released).toBe(true);
    expect(e.startShiftMinutes).toBeUndefined(); // no "before" time to shift from
  });

  it("delaying an in-progress task extends its remaining work", () => {
    const i = base();
    const asOf = at(30);
    const started = simulateChanges(i, plan(i), [{ kind: "set_status", taskId: "A", status: "in_progress", at: at(0) }], { mode: "live", asOf });
    if (!started.ok) throw new Error("x");
    expect(view(started.schedule, "A")).toMatchObject({ es: 0, ef: 60 });
    const r = simulateChanges(started.input, started.schedule, [{ kind: "delay", taskId: "A", minutes: 45 }], { mode: "live", asOf });
    if (!r.ok) throw new Error("x");
    expect(r.input.tasks[0]!.remainingDurationMinutes).toBe(75);
    expect(view(r.schedule, "A")).toMatchObject({ ef: 105 });
    expect(rel(r.schedule.projectedFinish)).toBe(rel(started.schedule.projectedFinish)); // E still pinned to gate target 260
  });
});

describe("simulateChanges: structural changes", () => {
  it("adding a dependency that creates a cycle returns errors instead of a schedule", () => {
    const i = base();
    const r = simulateChanges(i, plan(i), [{ kind: "add_dependency", dependency: dep("D", "A") }], { mode: "plan", asOf: T0 });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors[0]!.kind).toBe("cycle");
  });

  it("removing a dependency frees the successor", () => {
    const i = base();
    const r = sim(i, plan(i), [{ kind: "remove_dependency", predecessorId: "C", successorId: "D" }]);
    expect(view(r.schedule, "D")).toMatchObject({ es: 120 });
    expect(r.impact.affectedTasks.find((a) => a.taskId === "D")).toMatchObject({ startShiftMinutes: -60 });
  });

  it("an empty change list produces an empty impact", () => {
    const i = base();
    const r = sim(i, plan(i), []);
    expect(r.impact.affectedTasks).toEqual([]);
    expect(r.impact.gates).toEqual([]);
    expect(r.impact.criticalPath.changed).toBe(false);
    expect(r.impact.ownersToNotify).toEqual([]);
  });
});
