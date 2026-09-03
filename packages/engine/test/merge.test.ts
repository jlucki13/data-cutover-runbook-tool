import { describe, expect, it } from "vitest";
import { diffGraphInputs, toRefDependencies } from "../src/index.js";
import type { RefDependency } from "../src/index.js";
import { at, dep, task } from "./helpers.js";

const rd = (p: string, s: string, type: RefDependency["type"] = "FS", lagMinutes = 0): RefDependency => ({ predecessorRef: p, successorRef: s, type, lagMinutes });

const current = {
  tasks: [
    task("id-a1", 60, { ref: "ACC-1", workstreamId: "accounts", ownerId: "o1" }),
    task("id-a2", 30, { ref: "ACC-2", workstreamId: "accounts", ownerId: "o1" }),
    task("id-b1", 90, { ref: "BAL-1", workstreamId: "balances", ownerId: "o2" }),
  ],
  dependencies: [dep("id-a1", "id-a2"), dep("id-a2", "id-b1", "FS", 15)],
};

describe("diffGraphInputs (re-import / worksheet compile)", () => {
  it("classifies tasks as added, changed (with fields), unchanged, and removed within scope only", () => {
    const d = diffGraphInputs(
      current,
      {
        tasks: [
          task("x", 60, { ref: "ACC-1", workstreamId: "accounts", ownerId: "o1" }),
          task("y", 45, { ref: "ACC-2", workstreamId: "accounts", ownerId: "o9", plannedStart: at(60) }),
          task("z", 20, { ref: "ACC-3", workstreamId: "accounts" }),
        ],
        dependencies: [rd("ACC-1", "ACC-2"), rd("ACC-2", "ACC-3"), rd("ACC-3", "BAL-1")],
      },
      { scope: (t) => t.workstreamId === "accounts" },
    );
    expect(d.tasks.added.map((t) => t.ref)).toEqual(["ACC-3"]);
    expect(d.tasks.unchanged).toEqual(["ACC-1"]);
    expect(d.tasks.removed).toEqual([]); // BAL-1 is outside the accounts worksheet's scope
    expect(d.tasks.changed).toHaveLength(1);
    expect(d.tasks.changed[0]!.ref).toBe("ACC-2");
    expect(d.tasks.changed[0]!.fields).toEqual([
      { field: "ownerId", before: "o1", after: "o9" },
      { field: "plannedStart", before: undefined, after: at(60) },
      { field: "plannedDurationMinutes", before: 30, after: 45 },
    ]);
    expect(d.dependencies.unchanged).toEqual([rd("ACC-1", "ACC-2")]);
    expect(d.dependencies.added).toEqual([rd("ACC-2", "ACC-3"), rd("ACC-3", "BAL-1")]);
    // ACC-2 -> BAL-1 belongs to the balances sheet (its successor is BAL-1), so the accounts sheet cannot remove it.
    expect(d.dependencies.removed).toEqual([]);
    expect(d.unresolvedRefs).toEqual([]);
  });

  it("a sheet removes only the predecessors of its own tasks that it no longer lists", () => {
    const d = diffGraphInputs(
      current,
      { tasks: [task("y", 30, { ref: "ACC-2", workstreamId: "accounts", ownerId: "o1" })], dependencies: [] },
      { scope: (t) => t.workstreamId === "accounts" },
    );
    expect(d.dependencies.removed).toEqual([rd("ACC-1", "ACC-2")]); // successor ACC-2 is in scope
    expect(d.tasks.removed.map((t) => t.ref)).toEqual(["ACC-1"]);
  });

  it("a full re-import removes anything missing", () => {
    const d = diffGraphInputs(current, { tasks: [task("q", 60, { ref: "ACC-1", workstreamId: "accounts", ownerId: "o1" })], dependencies: [] });
    expect(d.tasks.removed.map((t) => t.ref)).toEqual(["ACC-2", "BAL-1"]);
    expect(d.dependencies.removed).toHaveLength(2);
  });

  it("detects changed dependency type/lag and unresolved refs", () => {
    const d = diffGraphInputs(current, { dependencies: [rd("ACC-1", "ACC-2", "SS", 10), rd("ACC-2", "NOPE-1")] });
    expect(d.dependencies.changed).toEqual([{ before: rd("ACC-1", "ACC-2"), after: rd("ACC-1", "ACC-2", "SS", 10) }]);
    expect(d.unresolvedRefs).toEqual(["NOPE-1"]);
    expect(d.tasks.removed).toEqual([]); // no incoming task list => no task removals
    expect(d.dependencies.removed.map((x) => `${x.predecessorRef}>${x.successorRef}`)).toEqual(["ACC-2>BAL-1"]);
    // An unscoped diff with no task list still compares edges against the whole graph.
    const same = diffGraphInputs(current, { dependencies: [rd("ACC-1", "ACC-2"), rd("ACC-2", "BAL-1", "FS", 15)] });
    expect(same.dependencies.added).toEqual([]);
    expect(same.dependencies.unchanged).toHaveLength(2);
    expect(same.dependencies.removed).toEqual([]);
  });

  it("toRefDependencies drops edges whose endpoints are unknown", () => {
    expect(toRefDependencies(current.tasks, [dep("id-a1", "ghost"), dep("id-a1", "id-b1")])).toEqual([rd("ACC-1", "BAL-1")]);
  });
});
