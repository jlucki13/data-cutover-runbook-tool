import { describe, expect, it } from "vitest";
import type { EngineTask } from "@cutover/engine";
import { compileWorksheets, parseCsvText, type CurrentRunbook } from "../src/index.js";

const T0 = Date.UTC(2026, 9, 16, 22);

const existingTask = (id: string, ref: string, name: string, ws: string, dur: number, extra: Partial<EngineTask> = {}): EngineTask => ({
  id,
  ref,
  name,
  workstreamId: ws,
  plannedDurationMinutes: dur,
  status: "not_started",
  ...extra,
});

const current = (): CurrentRunbook => ({
  event: { windowStart: T0, windowEnd: T0 + 32 * 3600_000 },
  tasks: [
    existingTask("t-frz1", "FRZ-1", "Declare freeze", "ws-core", 30),
    existingTask("t-frz2", "FRZ-2", "Final extract", "ws-core", 120),
    existingTask("t-acc1", "ACC-1", "Extract accounts", "ws-acc", 90, { ownerId: "u-priya" }),
    existingTask("t-acc2", "ACC-2", "Load accounts", "ws-acc", 120, { status: "in_progress", actualStart: T0 + 60_000 }),
    existingTask("t-acc9", "ACC-9", "Old obsolete step", "ws-acc", 15),
    existingTask("t-bal1", "BAL-1", "Extract balances", "ws-bal", 30),
  ],
  dependencies: [
    { predecessorId: "t-frz1", successorId: "t-frz2", type: "FS", lagMinutes: 0 },
    { predecessorId: "t-frz2", successorId: "t-acc1", type: "FS", lagMinutes: 0 },
    { predecessorId: "t-acc1", successorId: "t-acc2", type: "FS", lagMinutes: 0 },
    { predecessorId: "t-acc2", successorId: "t-acc9", type: "FS", lagMinutes: 0 },
    { predecessorId: "t-acc1", successorId: "t-bal1", type: "FS", lagMinutes: 0 },
  ],
  gates: [{ id: "g1", name: "Go", entryTaskIds: ["t-acc2", "t-acc9"], gatedTaskIds: ["t-bal1"], decision: "pending", isPointOfNoReturn: false }],
  workstreamNameById: { "ws-core": "Core", "ws-acc": "Accounts", "ws-bal": "Balances" },
  ownerNameById: { "u-priya": "Priya" },
});

const ACCOUNTS = `id,task,workstream,owner,duration,depends on
ACC-1,Extract accounts,Accounts,Priya,90,frz-2
ACC-2,Load accounts,Accounts,Priya,150,ACC-1
ACC-3,Reconcile accounts,Accounts,Recon,45,"ACC-2, BAL-2"
`;
const BALANCES = `id,task,workstream,duration,depends on
BAL-1,Extract balances,Balances,30,ACC-1
BAL-2,Load balances,Balances,60,BAL-1SS+10m
BAL-3,Notify,Balances,5,BAL-2; ACC-7
`;

describe("compileWorksheets", () => {
  const acc = parseCsvText(ACCOUNTS);
  const bal = parseCsvText(BALANCES);
  const r = compileWorksheets([acc, bal], current());

  it("merges sheets and resolves cross-sheet refs exactly or loosely", () => {
    expect(r.tasks.map((t) => t.ref)).toEqual(["ACC-1", "ACC-2", "ACC-3", "BAL-1", "BAL-2", "BAL-3"]);
    const byKey = Object.fromEntries(r.dependencies.map((d) => [`${d.predecessorRef}>${d.successorRef}`, d.resolution]));
    expect(byKey).toEqual({
      "FRZ-2>ACC-1": "loose", // "frz-2" in the sheet
      "ACC-1>ACC-2": "exact",
      "ACC-2>ACC-3": "exact",
      "BAL-2>ACC-3": "exact", // defined in the other worksheet
      "ACC-1>BAL-1": "exact",
      "BAL-1>BAL-2": "exact",
      "BAL-2>BAL-3": "exact",
      "ACC-7>BAL-3": "unresolved",
    });
    expect(r.issues.find((i) => i.code === "loose_ref_match")).toBeDefined();
  });

  it("lists unresolved refs with suggestions and blocks with an error", () => {
    expect(r.unresolved).toEqual([{ ref: "ACC-7", suggestions: ["ACC-1", "ACC-2", "ACC-3"], usedBy: ["ACC-7 → BAL-3"] }]);
    expect(r.issues.filter((i) => i.code === "unresolved_ref" && i.severity === "error")).toHaveLength(1);
    // the per-sheet "info" unresolved notices are replaced by the compile-level verdict
    expect(r.issues.filter((i) => i.code === "unresolved_ref" && i.severity === "info")).toHaveLength(0);
  });

  it("diffs against the committed graph by ref, scoping removals to the incoming workstreams", () => {
    expect(r.diff.tasks.added.map((t) => t.ref)).toEqual(["ACC-3", "BAL-2", "BAL-3"]);
    expect(r.diff.tasks.unchanged).toEqual(["ACC-1", "BAL-1"]);
    expect(r.diff.tasks.changed.map((c) => [c.ref, c.fields.map((f) => f.field)])).toEqual([["ACC-2", ["ownerId", "plannedDurationMinutes"]]]); // sheet names Priya; existing row had no owner
    expect(r.diff.tasks.removed.map((t) => t.ref)).toEqual(["ACC-9"]); // Accounts sheet no longer lists it
    // Core tasks are untouched: no Core worksheet was submitted.
    expect(r.diff.tasks.removed.find((t) => t.ref.startsWith("FRZ"))).toBeUndefined();
    expect(r.diff.dependencies.added.map((d) => `${d.predecessorRef}>${d.successorRef}`)).toEqual(["ACC-2>ACC-3", "BAL-1>BAL-2", "BAL-2>ACC-3", "BAL-2>BAL-3"]);
    expect(r.diff.dependencies.removed.map((d) => `${d.predecessorRef}>${d.successorRef}`)).toEqual(["ACC-2>ACC-9"]);
    expect(r.summary).toMatchObject({ worksheets: 2, incomingTasks: 6, tasksAdded: 3, tasksChanged: 1, tasksRemoved: 1, dependenciesAdded: 4, dependenciesRemoved: 1, errors: 1 });
  });

  it("keeps live fields on existing tasks and reuses their ids in the preview", () => {
    const acc2 = r.preview.input.tasks.find((t) => t.ref === "ACC-2")!;
    expect(acc2).toMatchObject({ id: "t-acc2", status: "in_progress", actualStart: T0 + 60_000, plannedDurationMinutes: 150 });
    expect(r.preview.input.tasks.find((t) => t.ref === "ACC-3")!.id).toBe("new:ACC-3");
    expect(r.preview.input.tasks.find((t) => t.ref === "ACC-9")).toBeUndefined();
    // Gate references to the removed task are dropped in the preview.
    expect(r.preview.input.gates[0]!.entryTaskIds).toEqual(["t-acc2"]);
    expect(r.preview.ok).toBe(true);
  });

  it("detects a cycle the merged graph would create", () => {
    const cyc = parseCsvText(`id,task,workstream,duration,depends on\nFRZ-1,Declare freeze,Core,30,ACC-2\n`);
    const res = compileWorksheets([cyc], current(), { removalScope: "none" });
    expect(res.preview.ok).toBe(false);
    const err = res.issues.find((i) => i.code === "cycle")!;
    expect(err.severity).toBe("error");
    expect(err.message).toContain("FRZ-1");
  });

  it("flags conflicting duplicates across sheets and conflicting dependency definitions", () => {
    const a = parseCsvText(`id,task,workstream,duration,depends on\nX-1,Thing,Alpha,10,\nX-2,Other,Alpha,10,X-1FS+30m\n`);
    const b = parseCsvText(`id,task,workstream,duration,depends on\nX-1,Different thing,Beta,10,\nX-2,Other,Alpha,10,X-1\n`);
    const res = compileWorksheets([a, b], { event: { windowStart: T0, windowEnd: T0 + 3600_000 }, tasks: [], dependencies: [] });
    expect(res.issues.filter((i) => i.code === "cross_sheet_duplicate").map((i) => i.severity)).toEqual(["error", "warning"]);
    expect(res.issues.find((i) => i.code === "conflicting_dependency")).toBeDefined();
    expect(res.dependencies).toHaveLength(1);
    expect(res.dependencies[0]!.lagMinutes).toBe(30); // first definition kept
  });

  it("removalScope controls what a partial upload may delete", () => {
    const none = compileWorksheets([acc], current(), { removalScope: "none" });
    expect(none.diff.tasks.removed).toEqual([]);
    const all = compileWorksheets([acc], current(), { removalScope: "all" });
    expect(all.diff.tasks.removed.map((t) => t.ref)).toEqual(["ACC-9", "BAL-1", "FRZ-1", "FRZ-2"]);
  });

  it("with no workstream on incoming tasks, nothing is proposed for removal", () => {
    const plain = parseCsvText(`id,task,duration\nACC-1,Extract accounts,90\n`);
    const res = compileWorksheets([plain], current());
    expect(res.diff.tasks.removed).toEqual([]);
    expect(res.issues.find((i) => i.code === "no_removal_scope")).toBeDefined();
  });
});
