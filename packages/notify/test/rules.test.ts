import { describe, expect, it } from "vitest";
import { buildGraph, computeSchedule, type GraphInput, type Schedule } from "@cutover/engine";
import { evaluateNotifications, newNotifications, render, type DirectoryGate, type DirectoryTask, type NotifyInput } from "../src/index.js";

const T0 = Date.UTC(2026, 9, 16, 22);
const at = (m: number) => T0 + m * 60_000;

/**
 * FRZ-1(30) → MIG(120) → REC(60, deadline 5h)
 * gate G1: entry REC, gated SWI(60), target 8h, point of no return
 */
function fixture(overrides: Partial<GraphInput["tasks"][number]>[] = [], gateOverrides: Partial<DirectoryGate> = {}) {
  const tasks: GraphInput["tasks"] = [
    { id: "t1", ref: "FRZ-1", name: "Declare freeze", plannedDurationMinutes: 30, status: "not_started", ownerId: "u-ops", workstreamId: "core" },
    { id: "t2", ref: "MIG-1", name: "Migrate accounts", plannedDurationMinutes: 120, status: "not_started", ownerId: "u-priya", workstreamId: "acc" },
    { id: "t3", ref: "REC-1", name: "Reconcile accounts", plannedDurationMinutes: 60, status: "not_started", ownerId: "u-recon", workstreamId: "recon", windowDeadline: at(300) },
    { id: "t4", ref: "SWI-1", name: "Switch routing", plannedDurationMinutes: 60, status: "not_started", ownerId: "u-ops", workstreamId: "core" },
  ].map((t) => ({ ...t, ...(overrides.find((o) => o.id === t.id) ?? {}) })) as GraphInput["tasks"];
  const input: GraphInput = {
    event: { windowStart: T0, windowEnd: at(600) },
    tasks,
    dependencies: [
      { predecessorId: "t1", successorId: "t2", type: "FS", lagMinutes: 0 },
      { predecessorId: "t2", successorId: "t3", type: "FS", lagMinutes: 0 },
    ],
    gates: [{ id: "g1", name: "Go/No-Go", entryTaskIds: ["t3"], gatedTaskIds: ["t4"], decision: "pending", targetDecisionAt: at(480), isPointOfNoReturn: true }],
  };
  if (gateOverrides.decision) {
    input.gates[0]!.decision = gateOverrides.decision;
    if (gateOverrides.decidedAt) input.gates[0]!.decidedAt = gateOverrides.decidedAt;
  }
  const built = buildGraph(input);
  if (!built.ok) throw new Error(JSON.stringify(built.errors));
  const dirTasks: DirectoryTask[] = tasks.map((t) => ({
    id: t.id,
    ref: t.ref,
    name: t.name,
    ownerId: t.ownerId,
    ownerName: t.ownerId,
    workstreamName: t.workstreamId,
    status: t.status,
    windowDeadline: t.windowDeadline,
  }));
  const dirGates: DirectoryGate[] = [
    { id: "g1", name: "Go/No-Go", approverId: "u-cc", approverName: "Command Centre", targetDecisionAt: at(480), isPointOfNoReturn: true, decision: input.gates[0]!.decision, decidedAt: input.gates[0]!.decidedAt, decidedByName: "Command Centre", ...gateOverrides },
  ];
  return { input, graph: built.graph, dirTasks, dirGates };
}

function notify(f: ReturnType<typeof fixture>, asOfMin: number, mode: "plan" | "live" = "live", before?: Schedule) {
  const schedule = computeSchedule(f.graph, { mode, asOf: at(asOfMin) });
  const input: NotifyInput = {
    event: { id: "e1", name: "TRBK", timezone: "UTC", windowEnd: at(600), status: mode === "live" ? "live" : "planning" },
    tasks: f.dirTasks,
    gates: f.dirGates,
    schedule,
    before,
    commandCentreUserIds: ["u-cc"],
    asOf: at(asOfMin),
  };
  return { schedule, notifications: evaluateNotifications(f.graph, input) };
}

describe("task rules", () => {
  it("tells the owner when a task becomes ready, and nobody else", () => {
    const f = fixture([{ id: "t1", status: "complete", actualStart: at(0), actualEnd: at(30) } as never]);
    f.dirTasks[0]!.status = "complete";
    const { notifications } = notify(f, 30);
    const ready = notifications.filter((n) => n.kind === "task_ready");
    expect(ready.map((n) => n.entityId)).toEqual(["t2"]);
    expect(ready[0]!.recipients).toEqual([{ userId: "u-priya", reason: "owner" }]);
    expect(ready[0]!.title).toBe("MIG-1 is ready to start");
    expect(ready[0]!.severity).toBe("info");
  });

  it("does not call a task ready while a predecessor is outstanding or a gate is undecided", () => {
    const { notifications } = notify(fixture(), 0);
    expect(notifications.filter((n) => n.kind === "task_ready").map((n) => n.entityId)).toEqual(["t1"]);
    // SWI-1 is gated by a pending gate, so it is never "ready" even once its time arrives.
    const late = notify(fixture(), 480).notifications.filter((n) => n.kind === "task_ready" && n.entityId === "t4");
    expect(late).toEqual([]);
  });

  it("raises a critical notice when a task will miss its own deadline, to owner and command centre", () => {
    // Blocked migration pushes reconciliation past its 5h deadline.
    const f = fixture([{ id: "t2", status: "blocked", actualStart: at(30), expectedUnblockAt: at(300) } as never]);
    f.dirTasks[1]!.status = "blocked";
    const { notifications } = notify(f, 60);
    const risk = notifications.find((n) => n.kind === "task_deadline_at_risk");
    expect(risk).toBeDefined();
    expect(risk!.entityId).toBe("t3");
    expect(risk!.severity).toBe("critical");
    expect(risk!.recipients.map((r) => r.userId)).toEqual(["u-recon", "u-cc"]);
    expect(risk!.facts.assumed).toBe(true);
    expect(risk!.body).toContain("assumes blocked work upstream recovers");
  });

  it("tells the owner and command centre when work stops, with the assumed recovery", () => {
    const f = fixture([{ id: "t2", status: "blocked", actualStart: at(30), expectedUnblockAt: at(300) } as never]);
    f.dirTasks[1]!.status = "blocked";
    f.dirTasks[1]!.statusNote = "source system unavailable";
    const { notifications } = notify(f, 60);
    const b = notifications.find((n) => n.kind === "task_blocked");
    expect(b).toBeDefined();
    expect(b!.entityId).toBe("t2");
    expect(b!.severity).toBe("warning");
    expect(b!.title).toBe("MIG-1 is blocked: source system unavailable");
    expect(b!.body).toContain("the owner's estimate");
    expect(b!.recipients.map((r) => r.userId)).toEqual(["u-priya", "u-cc"]);
    expect(b!.facts.fromOwnerEstimate).toBe(true);
    // A failure is more serious than a block and says the work re-runs.
    const failed = fixture([{ id: "t2", status: "failed", actualStart: at(30) } as never]);
    failed.dirTasks[1]!.status = "failed";
    const fb = notify(failed, 60).notifications.find((n) => n.kind === "task_blocked")!;
    expect(fb.severity).toBe("critical");
    expect(fb.body).toContain("re-run");
    expect(fb.facts.fromOwnerEstimate).toBe(false);
  });

  it("reports held tasks with the reason, and does not also call them at risk", () => {
    const f = fixture([], { decision: "no_go", decidedAt: at(100) });
    const { notifications } = notify(f, 120);
    const held = notifications.filter((n) => n.kind === "task_held");
    expect(held.map((n) => n.entityId)).toEqual(["t4"]);
    expect(held[0]!.body).toContain('gate "Go/No-Go" was decided no-go');
    expect(notifications.some((n) => n.entityId === "t4" && n.kind !== "task_held")).toBe(false);
  });

  it("flags negative float on a task with no deadline of its own", () => {
    // A very long migration leaves the chain unable to hold the gate target.
    const f = fixture([{ id: "t2", plannedDurationMinutes: 600 } as never]);
    const { notifications } = notify(f, 0);
    const neg = notifications.filter((n) => n.kind === "task_negative_float").map((n) => n.entityId);
    expect(neg).toContain("t2");
    expect(notifications.find((n) => n.kind === "task_negative_float")!.title).toMatch(/needs .* recovered/);
  });

  it("says nothing about finished tasks", () => {
    const f = fixture([{ id: "t1", status: "complete", actualStart: at(0), actualEnd: at(30) } as never]);
    f.dirTasks[0]!.status = "complete";
    const { notifications } = notify(f, 30);
    expect(notifications.some((n) => n.entityId === "t1")).toBe(false);
  });
});

describe("gate rules", () => {
  it("warns when a gate is at risk and escalates when it is breached", () => {
    const f = fixture([{ id: "t2", plannedDurationMinutes: 400 } as never]); // ready at 8h10 vs target 8h
    const { notifications } = notify(f, 0);
    const g = notifications.find((n) => n.kind === "gate_at_risk");
    expect(g).toBeDefined();
    expect(g!.severity).toBe("critical");
    expect(g!.title).toContain("breached");
    expect(g!.body).toContain("point of no return");
    expect(g!.recipients.map((r) => r.userId)).toEqual(["u-cc"]);
  });

  it("asks for a decision once entry work is done", () => {
    const f = fixture([
      { id: "t1", status: "complete", actualStart: at(0), actualEnd: at(30) } as never,
      { id: "t2", status: "complete", actualStart: at(30), actualEnd: at(150) } as never,
      { id: "t3", status: "complete", actualStart: at(150), actualEnd: at(210) } as never,
    ]);
    for (const i of [0, 1, 2]) f.dirTasks[i]!.status = "complete";
    const { notifications } = notify(f, 220);
    const awaiting = notifications.find((n) => n.kind === "gate_awaiting_decision");
    expect(awaiting).toBeDefined();
    expect(awaiting!.facts.entryDone).toBe(true);
    expect(awaiting!.body).toContain("1 task waits on it"); // SWI-1 is the only task behind this gate
    expect(awaiting!.severity).toBe("warning"); // point of no return
  });

  it("announces a decision once, on the transition", () => {
    const pending = fixture();
    const beforeSchedule = notify(pending, 100).schedule;
    const decided = fixture([], { decision: "go", decidedAt: at(120) });
    const first = notify(decided, 130, "live", beforeSchedule).notifications.filter((n) => n.kind === "gate_decided");
    expect(first).toHaveLength(1);
    expect(first[0]!.title).toContain("GO");
    expect(first[0]!.body).toContain("point of no return");
    // Re-evaluated against a schedule that already had the decision: no repeat.
    const afterSchedule = notify(decided, 130).schedule;
    expect(notify(decided, 140, "live", afterSchedule).notifications.filter((n) => n.kind === "gate_decided")).toHaveLength(0);
  });

  it("does not ask for gate decisions while the event is still in planning", () => {
    const f = fixture([
      { id: "t1", status: "complete", actualStart: at(0), actualEnd: at(30) } as never,
      { id: "t2", status: "complete", actualStart: at(30), actualEnd: at(150) } as never,
      { id: "t3", status: "complete", actualStart: at(150), actualEnd: at(210) } as never,
    ]);
    for (const i of [0, 1, 2]) f.dirTasks[i]!.status = "complete";
    expect(notify(f, 220, "plan").notifications.some((n) => n.kind === "gate_awaiting_decision")).toBe(false);
  });
});

describe("event rules", () => {
  it("raises the window breach to the command centre with the deciding chain", () => {
    const f = fixture([{ id: "t2", plannedDurationMinutes: 900 } as never]);
    const { notifications } = notify(f, 0);
    const w = notifications.find((n) => n.kind === "event_window_at_risk");
    expect(w).toBeDefined();
    expect(w!.severity).toBe("critical");
    expect(w!.recipients).toEqual([{ userId: "u-cc", reason: "command_center" }]);
    expect(w!.facts.criticalPath).toContain("MIG-1");
  });
});

describe("determinism and dedupe", () => {
  it("produces identical output for identical input", () => {
    const a = JSON.stringify(notify(fixture(), 60).notifications);
    const b = JSON.stringify(notify(fixture(), 60).notifications);
    expect(a).toBe(b);
  });

  it("orders by severity, then kind, then task ref", () => {
    const f = fixture([{ id: "t2", plannedDurationMinutes: 900 } as never]);
    const sev = notify(f, 0).notifications.map((n) => n.severity);
    expect(sev).toEqual([...sev].sort((x, y) => ["critical", "warning", "info"].indexOf(x) - ["critical", "warning", "info"].indexOf(y)));
  });

  it("suppresses a repeat while the situation is unchanged and re-notifies when it worsens", () => {
    const mild = fixture([{ id: "t2", status: "blocked", actualStart: at(30), expectedUnblockAt: at(300) } as never]);
    mild.dirTasks[1]!.status = "blocked";
    const first = notify(mild, 60).notifications.filter((n) => n.kind === "task_deadline_at_risk");
    const again = notify(mild, 60).notifications.filter((n) => n.kind === "task_deadline_at_risk");
    expect(newNotifications(again, first.map((n) => n.dedupeKey))).toEqual([]);

    const worse = fixture([{ id: "t2", status: "blocked", actualStart: at(30), expectedUnblockAt: at(500) } as never]);
    worse.dirTasks[1]!.status = "blocked";
    const escalated = notify(worse, 60).notifications.filter((n) => n.kind === "task_deadline_at_risk");
    expect(newNotifications(escalated, first.map((n) => n.dedupeKey))).toHaveLength(1);
  });
});

describe("rendering", () => {
  const f = fixture([{ id: "t2", status: "blocked", actualStart: at(30), expectedUnblockAt: at(300) } as never]);
  f.dirTasks[1]!.status = "blocked";
  const n = notify(f, 60).notifications.find((x) => x.kind === "task_deadline_at_risk")!;

  it("renders email with subject, facts and a link", () => {
    const m = render(n, "email", { eventName: "TRBK", link: "https://runbook.example/tasks/t3" });
    expect(m.subject).toBe("[TRBK] REC-1 will miss its deadline by 3h");
    expect(m.body).toContain("Details:");
    expect(m.body).toContain("Breach Minutes: 180");
    expect(m.body).toContain("https://runbook.example/tasks/t3");
  });

  it("renders Slack mrkdwn with a severity marker and an escaped body", () => {
    const m = render(n, "slack", { eventName: "TRBK", link: "https://runbook.example/tasks/t3", summary: "Balances are the constraint." });
    expect(m.body.startsWith("🔴 *REC-1 will miss")).toBe(true);
    expect(m.body).toContain("<https://runbook.example/tasks/t3|Open in the runbook>");
    expect(m.body).toContain("_Balances are the constraint._");
    expect(m.body).not.toMatch(/[<>]REC/);
  });
});
