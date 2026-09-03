import { describe, expect, it } from "vitest";
import { at, dep, gate, input, plan, rel, task, view } from "./helpers.js";

/**
 * Textbook diamond, durations in minutes:
 *   A(180) -> B(120) -> D(60) -> E(120)
 *   A(180) -> C(240) -> D(60)
 */
const diamond = (windowEndMin = 600) =>
  input(
    [task("A", 180), task("B", 120), task("C", 240), task("D", 60), task("E", 120)],
    [dep("A", "B"), dep("A", "C"), dep("B", "D"), dep("C", "D"), dep("D", "E")],
    [],
    { windowEnd: at(windowEndMin) },
  );

describe("forward/backward pass on the textbook diamond", () => {
  it("computes early/late times and float exactly", () => {
    const s = plan(diamond(600));
    expect(view(s, "A")).toMatchObject({ es: 0, ef: 180, ls: 0, lf: 180, float: 0, critical: true });
    expect(view(s, "B")).toMatchObject({ es: 180, ef: 300, ls: 300, lf: 420, float: 120, critical: false });
    expect(view(s, "C")).toMatchObject({ es: 180, ef: 420, ls: 180, lf: 420, float: 0, critical: true });
    expect(view(s, "D")).toMatchObject({ es: 420, ef: 480, ls: 420, lf: 480, float: 0, critical: true });
    expect(view(s, "E")).toMatchObject({ es: 480, ef: 600, ls: 480, lf: 600, float: 0, critical: true });
    expect(s.criticalPath).toEqual(["A", "C", "D", "E"]);
    expect(s.criticalTaskIds).toEqual(["A", "C", "D", "E"]);
    expect(rel(s.projectedFinish)).toBe(600);
    expect(s.eventWindowBreachMinutes).toBe(0);
    expect(s.windowSlackMinutes).toBe(0);
    expect(s.deadlineBreaches).toEqual([]);
  });

  it("keeps the longest path critical when the window has slack (floats anchor to projected finish)", () => {
    const s = plan(diamond(800));
    expect(view(s, "B").float).toBe(120);
    expect(view(s, "C").float).toBe(0);
    expect(s.criticalPath).toEqual(["A", "C", "D", "E"]);
    expect(s.windowSlackMinutes).toBe(200);
    expect(s.eventWindowBreachMinutes).toBe(0);
  });

  it("reports negative float and a window breach when the plan overruns the window", () => {
    const s = plan(diamond(540));
    expect(view(s, "E")).toMatchObject({ ef: 600, lf: 540, float: -60, critical: true });
    expect(view(s, "A").float).toBe(-60);
    expect(view(s, "B").float).toBe(60);
    expect(s.eventWindowBreachMinutes).toBe(60);
    expect(s.windowSlackMinutes).toBe(-60);
  });

  it("reports what drives each task's start", () => {
    const s = plan(diamond());
    expect(view(s, "D").drivenBy).toEqual(["task:C"]);
    expect(view(s, "A").drivenBy).toEqual([]);
  });
});

describe("constraints", () => {
  it("honours plannedStart as a start-no-earlier-than constraint", () => {
    const s = plan(input(diamond().tasks.map((t) => (t.id === "B" ? { ...t, plannedStart: at(400) } : t)), diamond().dependencies, [], { windowEnd: at(700) }));
    expect(view(s, "B")).toMatchObject({ es: 400, ef: 520 });
    expect(view(s, "D")).toMatchObject({ es: 520, ef: 580 });
    expect(view(s, "E")).toMatchObject({ es: 580, ef: 700, float: 0 });
    expect(view(s, "C").float).toBe(100);
    // B is critical but its start is driven by its own constraint, so the canonical path starts at B.
    expect(s.criticalPath).toEqual(["B", "D", "E"]);
    expect(s.criticalTaskIds).toEqual(["B", "D", "E"]);
  });

  it("tasks with no predecessors and no plannedStart start at the window start", () => {
    const s = plan(input([task("A", 10)], [], [], { windowStart: at(60), windowEnd: at(600) }));
    expect(view(s, "A")).toMatchObject({ es: 60, ef: 70 });
  });

  it("zero-duration milestones work", () => {
    const s = plan(input([task("A", 60), task("M", 0), task("B", 30)], [dep("A", "M"), dep("M", "B")]));
    expect(view(s, "M")).toMatchObject({ es: 60, ef: 60, critical: true });
    expect(s.criticalPath).toEqual(["A", "M", "B"]);
  });

  it("per-task deadline caps late finish and reports a breach", () => {
    const tasks = diamond().tasks.map((t) => (t.id === "D" ? { ...t, windowDeadline: at(450) } : t));
    const s = plan(input(tasks, diamond().dependencies, [], { windowEnd: at(800) }));
    expect(view(s, "D")).toMatchObject({ ef: 480, lf: 450, float: -30, breach: 30 });
    expect(view(s, "C").float).toBe(-30);
    expect(view(s, "A").float).toBe(-30);
    expect(view(s, "E").float).toBe(0); // downstream of the deadline is unaffected
    expect(s.deadlineBreaches).toEqual([{ taskId: "D", minutes: 30 }]);
    expect(s.eventWindowBreachMinutes).toBe(0);
  });
});

describe("dependency types and lag", () => {
  const pair = (type: "FS" | "SS" | "FF" | "SF", lag: number) => plan(input([task("P", 100), task("S", 40)], [dep("P", "S", type, lag)], [], { windowEnd: at(1000) }));

  it("FS: successor starts after predecessor finishes plus lag", () => {
    expect(view(pair("FS", 30), "S")).toMatchObject({ es: 130, ef: 170 });
    expect(view(pair("FS", -20), "S")).toMatchObject({ es: 80, ef: 120 });
  });
  it("SS: successor starts after predecessor starts plus lag", () => {
    expect(view(pair("SS", 30), "S")).toMatchObject({ es: 30, ef: 70 });
  });
  it("FF: successor finishes after predecessor finishes plus lag", () => {
    expect(view(pair("FF", 30), "S")).toMatchObject({ es: 90, ef: 130 });
  });
  it("SF: successor finishes after predecessor starts plus lag", () => {
    expect(view(pair("SF", 60), "S")).toMatchObject({ es: 20, ef: 60 });
  });

  it("backward pass respects each type so float is consistent (LS = LF - duration, float = LF - EF)", () => {
    for (const type of ["FS", "SS", "FF", "SF"] as const) {
      const s = pair(type, 30);
      for (const id of ["P", "S"]) {
        const v = view(s, id);
        expect(v.ls! + (v.ef! - v.es!)).toBe(v.lf);
        expect(v.float).toBe(v.lf! - v.ef!);
      }
      // the finishing task is always on the path
      const last = view(s, "S").ef! >= view(s, "P").ef! ? "S" : "P";
      expect(view(s, last).float).toBe(0);
    }
  });

  it("SS predecessor late finish is derived from the successor's late start", () => {
    // P(100) SS+30 S(40); window 1000 → anchor = projectedFinish = 100 (P finishes last).
    const s = pair("SS", 30);
    expect(view(s, "P")).toMatchObject({ es: 0, ef: 100, lf: 100, float: 0, critical: true });
    expect(view(s, "S")).toMatchObject({ es: 30, ef: 70, lf: 100, float: 30, critical: false });
  });
});

describe("critical path selection", () => {
  it("includes every zero-float task and picks the lowest-ref branch as canonical", () => {
    const s = plan(input([task("A", 60), task("B", 240), task("C", 240), task("D", 30)], [dep("A", "B"), dep("A", "C"), dep("B", "D"), dep("C", "D")]));
    expect(s.criticalTaskIds).toEqual(["A", "B", "C", "D"]);
    expect(s.criticalPath).toEqual(["A", "B", "D"]);
    expect(view(s, "D").drivenBy).toEqual(["task:B", "task:C"]);
  });

  it("ends at the latest-finishing critical task when there are several sinks", () => {
    const s = plan(input([task("A", 60), task("X", 10), task("Y", 500)], [dep("A", "X"), dep("A", "Y")]));
    expect(s.criticalPath).toEqual(["A", "Y"]);
    expect(view(s, "X").float).toBe(490);
  });

  it("is empty when there are no tasks", () => {
    const s = plan(input([]));
    expect(s.criticalPath).toEqual([]);
    expect(s.projectedFinish).toBeUndefined();
  });
});

describe("gates in plan mode", () => {
  const base = () =>
    input(
      [task("R1", 60), task("R2", 120), task("S", 30), task("T", 30)],
      [dep("S", "T")],
      [gate("G", ["R1", "R2"], ["S"], { targetDecisionAt: at(300) })],
      { windowEnd: at(1000) },
    );

  it("gated tasks wait for entry tasks and, by default, for the gate's target decision time", () => {
    const s = plan(base());
    expect(s.gates["G"]).toMatchObject({ status: "ok", slackMinutes: 180, heldTaskIds: [], assumed: false });
    expect(rel(s.gates["G"]!.projectedReadyAt)).toBe(120);
    expect(view(s, "S")).toMatchObject({ es: 300, ef: 330, drivenBy: ["gate:G"] });
    // Entry tasks have float up to the target; the canonical path begins at the gated task.
    expect(view(s, "R2").float).toBe(180);
    expect(s.criticalPath).toEqual(["S", "T"]);
  });

  it("with gateWaitsForTarget=false the gated task starts as soon as the entry tasks finish", () => {
    const s = plan(base(), { gateWaitsForTarget: false });
    expect(view(s, "S")).toMatchObject({ es: 120, drivenBy: ["task:R2"] });
    expect(s.criticalPath).toEqual(["R2", "S", "T"]);
  });

  it("entry tasks finishing after the target put the gate at risk or breach it", () => {
    const risky = base();
    risky.tasks[1]!.plannedDurationMinutes = 290; // ready at 290, target 300 → slack 10
    expect(plan(risky).gates["G"]).toMatchObject({ status: "at_risk", slackMinutes: 10 });
    expect(plan(risky, { gateAtRiskThresholdMinutes: 5 }).gates["G"]!.status).toBe("ok");
    risky.tasks[1]!.plannedDurationMinutes = 360; // ready at 360 → slack −60
    const s = plan(risky);
    expect(s.gates["G"]).toMatchObject({ status: "breached", slackMinutes: -60 });
    expect(view(s, "S")).toMatchObject({ es: 360, drivenBy: ["task:R2"] });
  });

  it("a go decision anchors gated tasks at the decision time", () => {
    const i = base();
    i.gates[0]!.decision = "go";
    i.gates[0]!.decidedAt = at(200);
    const s = plan(i);
    expect(s.gates["G"]!.status).toBe("decided_go");
    expect(view(s, "S")).toMatchObject({ es: 200, drivenBy: ["gate:G"] });
  });

  it("a no_go decision holds gated tasks and everything downstream", () => {
    const i = base();
    i.gates[0]!.decision = "no_go";
    i.gates[0]!.decidedAt = at(200);
    const s = plan(i);
    expect(s.gates["G"]).toMatchObject({ status: "decided_no_go", heldTaskIds: ["S"] });
    expect(s.tasks["S"]!.held).toEqual({ reason: "gate_no_go", byGateId: "G" });
    expect(s.tasks["T"]!.held).toEqual({ reason: "upstream_held", byTaskIds: ["S"] });
    expect(s.heldTaskIds).toEqual(["S", "T"]);
    expect(s.tasks["T"]!.earlyStart).toBeUndefined();
    expect(rel(s.projectedFinish)).toBe(120); // held tasks do not count toward the projected finish
    expect(s.criticalPath).toEqual(["R2"]);
  });

  it("a gate without a target has no slack and is simply ok", () => {
    const i = base();
    delete i.gates[0]!.targetDecisionAt;
    const s = plan(i);
    expect(s.gates["G"]).toMatchObject({ status: "ok" });
    expect(s.gates["G"]!.slackMinutes).toBeUndefined();
    expect(view(s, "S").es).toBe(120);
  });
});
