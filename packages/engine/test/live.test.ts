import { describe, expect, it } from "vitest";
import { at, dep, gate, input, live, plan, rel, task, view } from "./helpers.js";

// Chain: A(60) -> B(60) -> C(60), window 600.
const chain = (overrides: Record<string, Parameters<typeof task>[2]> = {}) =>
  input([task("A", 60, overrides["A"]), task("B", 60, overrides["B"]), task("C", 60, overrides["C"])], [dep("A", "B"), dep("B", "C")], [], { windowEnd: at(600) });

describe("plan mode", () => {
  it("ignores statuses and actuals entirely", () => {
    const s = plan(chain({ A: { status: "complete", actualStart: at(10), actualEnd: at(200) } }));
    expect(view(s, "A")).toMatchObject({ es: 0, ef: 60, critical: true });
    expect(view(s, "B")).toMatchObject({ es: 60 });
  });
});

describe("live mode: complete and skipped", () => {
  it("pins complete tasks to their actuals and schedules successors from actual end", () => {
    const s = live(chain({ A: { status: "complete", actualStart: at(5), actualEnd: at(90) } }), 100);
    expect(view(s, "A")).toMatchObject({ es: 5, ef: 90, critical: false, drivenBy: [] });
    // B not started: cannot start before asOf (100) even though A finished at 90.
    expect(view(s, "B")).toMatchObject({ es: 100, ef: 160, drivenBy: [] });
    expect(view(s, "C")).toMatchObject({ es: 160, ef: 220, critical: true });
    expect(s.criticalPath).toEqual(["B", "C"]);
  });

  it("treats skipped as done at its actual end and lets successors proceed", () => {
    const s = live(chain({ A: { status: "complete", actualStart: at(0), actualEnd: at(60) }, B: { status: "skipped", actualEnd: at(70) } }), 70);
    expect(view(s, "B")).toMatchObject({ es: 70, ef: 70, critical: false });
    expect(view(s, "C")).toMatchObject({ es: 70, ef: 130 });
  });

  it("a complete task with no actuals falls back to asOf and is flagged by validateGraph, not the scheduler", () => {
    const s = live(chain({ A: { status: "complete" } }), 100);
    expect(view(s, "A")).toMatchObject({ es: 100, ef: 100 });
  });
});

describe("live mode: in progress", () => {
  it("projects finish as asOf + (planned − elapsed) by default", () => {
    const s = live(chain({ A: { status: "in_progress", actualStart: at(20) } }), 50);
    expect(view(s, "A")).toMatchObject({ es: 20, ef: 80, critical: true });
    expect(view(s, "B")).toMatchObject({ es: 80 });
  });

  it("uses the owner's remaining estimate when given, even past the planned duration", () => {
    const s = live(chain({ A: { status: "in_progress", actualStart: at(20), remainingDurationMinutes: 90 } }), 50);
    expect(view(s, "A")).toMatchObject({ es: 20, ef: 140 });
    expect(view(s, "B")).toMatchObject({ es: 140 });
  });

  it("an overrunning task with no estimate finishes no earlier than now", () => {
    const s = live(chain({ A: { status: "in_progress", actualStart: at(0) } }), 200);
    expect(view(s, "A")).toMatchObject({ es: 0, ef: 200 });
  });

  it("a started task does not constrain its predecessors' late dates", () => {
    // B already started while A is (inconsistently) still not started: A's LF is the anchor, not B's LS.
    const s = live(chain({ B: { status: "in_progress", actualStart: at(30) } }), 40);
    expect(view(s, "A")).toMatchObject({ es: 40, ef: 100 });
    expect(view(s, "B")).toMatchObject({ es: 30, ef: 90 });
    expect(view(s, "A").lf).toBe(150); // anchored at projected finish (C ends at 150)
  });
});

describe("live mode: not started work cannot be scheduled in the past", () => {
  it("clamps early start to asOf and propagates the slip", () => {
    const s = live(chain(), 45);
    expect(view(s, "A")).toMatchObject({ es: 45, ef: 105 });
    expect(view(s, "C")).toMatchObject({ ef: 225 });
    expect(rel(s.projectedFinish)).toBe(225);
  });

  it("does not pull work earlier than its plannedStart", () => {
    const s = live(chain({ A: { plannedStart: at(100) } }), 45);
    expect(view(s, "A")).toMatchObject({ es: 100 });
  });
});

describe("live mode: blocked and failed (assumed recovery)", () => {
  it("assumes a blocked, not-yet-started task resumes after the event default recovery and flags the assumption", () => {
    const s = live(chain({ A: { status: "blocked" } }), 100);
    const a = s.tasks["A"]!;
    expect(view(s, "A")).toMatchObject({ es: 130, ef: 190 });
    expect(a.assumption).toEqual({ kind: "blocked_recovery", resumeAt: at(130), fromOwnerEstimate: false });
    expect(a.assumedFrom).toEqual(["A"]);
    expect(s.tasks["B"]!.assumedFrom).toEqual(["A"]);
    expect(s.tasks["C"]!.assumedFrom).toEqual(["A"]);
    expect(s.tasks["C"]!.assumption).toBeUndefined();
  });

  it("uses the event's own default recovery when set", () => {
    const i = chain({ A: { status: "blocked" } });
    i.event.defaultBlockedRecoveryMinutes = 5;
    expect(view(live(i, 100), "A")).toMatchObject({ es: 105 });
  });

  it("respects the owner's expected unblock time and remaining estimate for a started task", () => {
    const s = live(chain({ A: { status: "blocked", actualStart: at(10), expectedUnblockAt: at(300), remainingDurationMinutes: 15 } }), 100);
    expect(view(s, "A")).toMatchObject({ es: 10, ef: 315 });
    expect(s.tasks["A"]!.assumption).toEqual({ kind: "blocked_recovery", resumeAt: at(300), fromOwnerEstimate: true });
    expect(view(s, "B")).toMatchObject({ es: 315 });
  });

  it("an expected unblock time in the past is clamped to now", () => {
    const s = live(chain({ A: { status: "blocked", expectedUnblockAt: at(50) } }), 100);
    expect(view(s, "A")).toMatchObject({ es: 100, ef: 160 });
  });

  it("a blocked task that has not started still waits for its predecessors", () => {
    const s = live(chain({ B: { status: "blocked" } }), 0);
    expect(view(s, "A")).toMatchObject({ es: 0, ef: 60 });
    expect(view(s, "B")).toMatchObject({ es: 60, ef: 120 }); // predecessor constraint (60) > assumed resume (30)
  });

  it("a failed task is assumed to be re-run in full after recovery", () => {
    const s = live(chain({ A: { status: "failed", actualStart: at(0), remainingDurationMinutes: 5 } }), 40);
    expect(view(s, "A")).toMatchObject({ es: 0, ef: 130 }); // resume 70 + full 60, remaining ignored
    expect(s.tasks["A"]!.assumption?.kind).toBe("failed_rerun");
  });

  it("assumptions propagate into gate projections", () => {
    const s = live(
      input([task("R", 60, { status: "blocked" }), task("S", 30)], [], [gate("G", ["R"], ["S"], { targetDecisionAt: at(120) })], { windowEnd: at(600) }),
      0,
    );
    expect(s.gates["G"]).toMatchObject({ status: "ok", slackMinutes: 30, assumed: true });
    expect(rel(s.gates["G"]!.projectedReadyAt)).toBe(90);
  });
});

describe("live mode: gates", () => {
  it("a pending gate whose entry work is done still waits for its target time", () => {
    const s = live(
      input([task("R", 60, { status: "complete", actualStart: at(0), actualEnd: at(50) }), task("S", 30)], [], [gate("G", ["R"], ["S"], { targetDecisionAt: at(120) })], {
        windowEnd: at(600),
      }),
      60,
    );
    expect(view(s, "S")).toMatchObject({ es: 120, drivenBy: ["gate:G"] });
    expect(s.gates["G"]).toMatchObject({ status: "ok", slackMinutes: 70 });
  });

  it("a late go decision anchors gated work at the decision, not the target", () => {
    const s = live(
      input([task("R", 60, { status: "complete", actualStart: at(0), actualEnd: at(50) }), task("S", 30)], [], [
        gate("G", ["R"], ["S"], { targetDecisionAt: at(120), decision: "go", decidedAt: at(150) }),
      ]),
      160,
    );
    expect(view(s, "S")).toMatchObject({ es: 160 }); // decidedAt 150, but not-started work cannot start before asOf 160
    expect(s.gates["G"]!.status).toBe("decided_go");
  });
});
