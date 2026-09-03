import { describe, expect, it } from "vitest";
import { simulateChanges, validateGraph } from "../src/index.js";
import { T0, at, build, plan, rel, view } from "./helpers.js";
import { OWNERS, trbkEvent } from "./fixtures/trbk.js";

describe("TRBK-style mock cutover (end-to-end fixture)", () => {
  it("builds cleanly with no warnings", () => {
    expect(validateGraph(build(trbkEvent()))).toEqual([]);
  });

  it("plans the baseline: migrate chain, gate slack, switch anchored at the go/no-go target", () => {
    const s = plan(trbkEvent());
    expect(view(s, "FRZ-1")).toMatchObject({ es: 0, ef: 30 });
    expect(view(s, "MIG-ACC")).toMatchObject({ es: 150, ef: 330 });
    expect(view(s, "MIG-STM")).toMatchObject({ es: 330, ef: 570 });
    expect(view(s, "MIG-NOT")).toMatchObject({ es: 570, ef: 660, drivenBy: ["task:MIG-STM"] });
    expect(view(s, "REC-BAL")).toMatchObject({ ef: 570, breach: undefined });

    // Gate G1: ready at 11h, target 16h → 5h of slack; the switch waits for the planned decision time.
    expect(s.gates["G1"]).toMatchObject({ status: "ok", slackMinutes: 300, assumed: false });
    expect(rel(s.gates["G1"]!.projectedReadyAt)).toBe(660);
    expect(view(s, "SWI-1")).toMatchObject({ es: 960, ef: 1020, drivenBy: ["gate:G1"] });
    expect(view(s, "RBK-1")).toMatchObject({ es: 1065, ef: 1305 });
    expect(s.gates["G2"]).toMatchObject({ status: "ok", slackMinutes: 135 });
    expect(view(s, "CLS-1")).toMatchObject({ es: 1440, ef: 1470 }); // waits for G2 target at 24h

    expect(rel(s.projectedFinish)).toBe(1470);
    expect(s.windowSlackMinutes).toBe(32 * 60 - 1470);
    expect(s.eventWindowBreachMinutes).toBe(0);
    expect(s.criticalPath).toEqual(["CLS-1"]);
    // Everything before the switch has the gate's 5h of slack.
    expect(view(s, "MIG-NOT").float).toBe(300);
    expect(view(s, "SWI-1").float).toBe(135 + 240 + 45 + 60 - 345); // = 135, G2's slack
  });

  it("a 6-hour slip on statement migration breaches the go/no-go gate and pushes the window", () => {
    const i = trbkEvent();
    const baseline = plan(i);
    const r = simulateChanges(i, baseline, [{ kind: "delay", taskId: "MIG-STM", minutes: 360 }], { mode: "plan", asOf: T0 });
    if (!r.ok) throw new Error("simulate failed");
    const s = r.schedule;
    expect(view(s, "MIG-STM")).toMatchObject({ es: 690, ef: 930 });
    expect(view(s, "MIG-NOT")).toMatchObject({ es: 930, ef: 1020, lf: 960, float: -60, critical: true });
    expect(view(s, "REC-STM")).toMatchObject({ ef: 990, float: -30, critical: true });
    expect(s.gates["G1"]).toMatchObject({ status: "breached", slackMinutes: -60 });
    expect(view(s, "SWI-1")).toMatchObject({ es: 1020, drivenBy: ["task:MIG-NOT"] });
    expect(rel(s.projectedFinish)).toBe(1470); // G2's 24h target still absorbs it: CLS-1 unchanged
    // The chain that breaches the gate is now the critical path (60 minutes to recover).
    expect(s.criticalPath).toEqual(["MIG-STM", "MIG-NOT"]);
    expect(s.criticalTaskIds).toEqual(["MIG-STM", "MIG-NOT", "REC-STM", "CLS-1"]); // CLS-1 keeps zero float against the finish
    expect(view(s, "MIG-ACC").critical).toBe(false);

    expect(r.impact.gates).toEqual([
      { gateId: "G1", before: "ok", after: "breached", slackBeforeMinutes: 300, slackAfterMinutes: -60, readyShiftMinutes: 360 },
      { gateId: "G2", before: "ok", after: "ok", slackBeforeMinutes: 135, slackAfterMinutes: 75, readyShiftMinutes: 60 },
    ]);
    const owners = Object.fromEntries(r.impact.ownersToNotify.map((o) => [o.ownerId, o]));
    expect(owners[OWNERS.statements]).toEqual({ ownerId: OWNERS.statements, taskIds: ["MIG-STM"], reasons: ["now_critical", "shifted_later"] });
    expect(owners[OWNERS.notices]).toEqual({ ownerId: OWNERS.notices, taskIds: ["MIG-NOT"], reasons: ["now_critical", "shifted_later"] });
    expect(owners[OWNERS.recon]).toEqual({ ownerId: OWNERS.recon, taskIds: ["REC-STM"], reasons: ["now_critical", "shifted_later"] });
    expect(owners[OWNERS.ops]).toEqual({ ownerId: OWNERS.ops, taskIds: ["SWI-1", "SWI-2", "RBK-1"], reasons: ["shifted_later"] });
    expect(owners[OWNERS.accounts]).toBeUndefined();
    expect(owners[OWNERS.balances]).toBeUndefined();
    expect(r.impact.eventWindow.finishShiftMinutes).toBe(0);
    expect(r.impact.criticalPath).toEqual({ before: ["CLS-1"], after: ["MIG-STM", "MIG-NOT"], changed: true });
  });

  it("live mid-event snapshot: balances blocked, accounts reconciled, freeze complete", () => {
    const i = trbkEvent();
    const now = at(420); // Saturday 05:00
    const t = (id: string) => i.tasks.find((x) => x.id === id)!;
    Object.assign(t("FRZ-1"), { status: "complete", actualStart: at(0), actualEnd: at(25) });
    Object.assign(t("FRZ-2"), { status: "complete", actualStart: at(25), actualEnd: at(160) });
    Object.assign(t("MIG-ACC"), { status: "complete", actualStart: at(160), actualEnd: at(330) });
    Object.assign(t("REC-ACC"), { status: "complete", actualStart: at(330), actualEnd: at(380) });
    Object.assign(t("MIG-STM"), { status: "in_progress", actualStart: at(335) });
    Object.assign(t("MIG-BAL"), { status: "blocked", actualStart: at(340), remainingDurationMinutes: 60 });

    const r = simulateChanges(i, plan(trbkEvent()), [], { mode: "live", asOf: now });
    if (!r.ok) throw new Error("x");
    const s = r.schedule;
    // Blocked balances: assumed to resume at 450 (default 30 min), 60 left → 510. Reconcile 510-600, deadline 840 ok.
    expect(view(s, "MIG-BAL")).toMatchObject({ es: 340, ef: 510 });
    expect(s.tasks["MIG-BAL"]!.assumption).toMatchObject({ kind: "blocked_recovery", fromOwnerEstimate: false });
    expect(view(s, "REC-BAL")).toMatchObject({ es: 510, ef: 600, breach: undefined });
    expect(s.tasks["REC-BAL"]!.assumedFrom).toEqual(["MIG-BAL"]);
    // Statements in progress since 335: planned 240 → 575.
    expect(view(s, "MIG-STM")).toMatchObject({ es: 335, ef: 575 });
    expect(view(s, "MIG-NOT")).toMatchObject({ es: 575, ef: 665 });
    expect(s.gates["G1"]).toMatchObject({ status: "ok", slackMinutes: 295, assumed: true });
    expect(s.heldTaskIds).toEqual([]);
    expect(view(s, "FRZ-1").critical).toBe(false);
  });

  it("no-go at the point of no return holds the switch and everything after it", () => {
    const i = trbkEvent();
    const r = simulateChanges(i, plan(i), [{ kind: "set_gate_decision", gateId: "G1", decision: "no_go", at: at(960) }], { mode: "plan", asOf: T0 });
    if (!r.ok) throw new Error("x");
    expect(r.schedule.heldTaskIds).toEqual(["SWI-1", "SWI-2", "RBK-1", "CLS-1"]);
    expect(r.schedule.gates["G2"]!.status).toBe("held");
    expect(rel(r.schedule.projectedFinish)).toBe(660);
    // Ops own the four held tasks (and the freeze tasks, now critical against the shortened finish).
    const ops = r.impact.ownersToNotify.find((o) => o.ownerId === OWNERS.ops)!;
    expect(ops).toEqual({ ownerId: OWNERS.ops, taskIds: ["FRZ-1", "FRZ-2", "SWI-1", "SWI-2", "RBK-1", "CLS-1"], reasons: ["held", "now_critical"] });
    const held = r.impact.affectedTasks.filter((a) => a.becameHeld).map((a) => a.taskId);
    expect(held).toEqual(["SWI-1", "SWI-2", "RBK-1", "CLS-1"]);
  });
});
