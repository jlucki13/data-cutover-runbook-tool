import { describe, expect, it } from "vitest";
import { buildGraph, validateGraph, topologicalOrder, downstreamOf, upstreamOf, neighborhood, sources, sinks } from "../src/index.js";
import { at, build, dep, gate, input, task } from "./helpers.js";

const errKinds = (i: ReturnType<typeof input>) => {
  const r = buildGraph(i);
  return r.ok ? [] : r.errors.map((e) => e.kind);
};

describe("buildGraph validation", () => {
  it("rejects a dependency that references an unknown task", () => {
    expect(errKinds(input([task("A", 10)], [dep("A", "ZZZ")]))).toEqual(["unknown_task"]);
  });

  it("rejects self-loops", () => {
    expect(errKinds(input([task("A", 10)], [dep("A", "A")]))).toEqual(["self_loop"]);
  });

  it("rejects duplicate edges", () => {
    expect(errKinds(input([task("A", 10), task("B", 10)], [dep("A", "B"), dep("A", "B", "SS")]))).toEqual(["duplicate_edge"]);
  });

  it("rejects duplicate task ids and refs", () => {
    expect(errKinds(input([task("A", 10), task("A", 5)]))).toEqual(["duplicate_task_id"]);
    expect(errKinds(input([task("A", 10, { ref: "X" }), task("B", 5, { ref: "X" })]))).toEqual(["duplicate_task_ref"]);
  });

  it("rejects negative durations", () => {
    expect(errKinds(input([task("A", -1)]))).toEqual(["invalid_duration"]);
  });

  it("rejects gates that reference unknown tasks or put a task in both roles", () => {
    expect(errKinds(input([task("A", 10), task("B", 10)], [], [gate("G", ["A"], ["nope"])]))).toEqual(["gate_unknown_task"]);
    expect(errKinds(input([task("A", 10), task("B", 10)], [], [gate("G", ["A"], ["A"])]))).toEqual(["gate_task_both_roles"]);
  });

  it("detects a cycle and reports its path by ref", () => {
    const r = buildGraph(input([task("A", 1), task("B", 1), task("C", 1), task("D", 1)], [dep("A", "B"), dep("B", "C"), dep("C", "B"), dep("C", "D")]));
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.errors).toHaveLength(1);
    const e = r.errors[0]!;
    expect(e.kind).toBe("cycle");
    if (e.kind !== "cycle") return;
    expect(e.refs).toEqual(["B", "C", "B"]);
  });

  it("detects a cycle introduced through a gate", () => {
    // A -> B, gate entry B gated A  => B must finish before A, but A precedes B.
    const r = buildGraph(input([task("A", 1), task("B", 1)], [dep("A", "B")], [gate("G", ["B"], ["A"])]));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors[0]!.kind).toBe("cycle");
  });

  it("collects several independent errors in one pass", () => {
    const kinds = errKinds(input([task("A", 10), task("B", -5)], [dep("A", "A"), dep("A", "Q")]));
    expect(kinds.sort()).toEqual(["invalid_duration", "self_loop", "unknown_task"]);
  });
});

describe("topological order", () => {
  it("is a valid ordering that breaks ties by natural ref order", () => {
    const g = build(input([task("T-10", 1), task("T-2", 1), task("T-1", 1), task("T-3", 1)], [dep("T-3", "T-1")]));
    expect(topologicalOrder(g)).toEqual(["T-2", "T-3", "T-1", "T-10"]);
  });

  it("does not depend on input order", () => {
    const tasks = [task("C", 1), task("A", 1), task("B", 1)];
    const deps = [dep("A", "B"), dep("B", "C")];
    const g1 = build(input(tasks, deps));
    const g2 = build(input([...tasks].reverse(), [...deps].reverse()));
    expect(topologicalOrder(g1)).toEqual(topologicalOrder(g2));
    expect(topologicalOrder(g1)).toEqual(["A", "B", "C"]);
  });
});

describe("topology helpers", () => {
  const g = build(
    input(
      [task("A", 1), task("B", 1), task("C", 1), task("D", 1), task("E", 1), task("X", 1)],
      [dep("A", "B"), dep("B", "C"), dep("C", "D"), dep("B", "E")],
      [gate("G", ["E"], ["X"])],
    ),
  );

  it("downstream traverses transitively and through gates", () => {
    expect(downstreamOf(g, "A")).toEqual(["B", "C", "D", "E", "X"]);
    expect(downstreamOf(g, "A", 1)).toEqual(["B"]);
    expect(downstreamOf(g, "D")).toEqual([]);
  });

  it("upstream traverses transitively", () => {
    expect(upstreamOf(g, "X")).toEqual(["A", "B", "E"]);
    expect(upstreamOf(g, "X", 1)).toEqual(["E"]);
  });

  it("neighborhood includes self within the radius", () => {
    expect(neighborhood(g, "B", 1)).toEqual(["A", "B", "C", "E"]);
  });

  it("sources and sinks", () => {
    expect(sources(g)).toEqual(["A"]);
    expect(sinks(g)).toEqual(["D", "X"]);
  });

  it("throws on unknown task", () => {
    expect(() => downstreamOf(g, "nope")).toThrow(/unknown task/);
  });
});

describe("validateGraph warnings", () => {
  it("flags orphan tasks, missing owners, out-of-window constraints, and gate shape", () => {
    const g = build(
      input(
        [
          task("A", 10, { ownerId: "o", plannedStart: at(-60) }),
          task("B", 10, { ownerId: "o", windowDeadline: at(40 * 60) }),
          task("C", 10, { status: "complete" }),
        ],
        [dep("A", "B", "FS", -10)],
        [gate("G", [], ["B"], { targetDecisionAt: at(50 * 60) })],
      ),
    );
    const kinds = validateGraph(g).map((w) => w.kind);
    expect(kinds).toEqual(
      expect.arrayContaining([
        "planned_start_before_window",
        "deadline_after_window_end",
        "orphan_task",
        "no_owner",
        "missing_actuals",
        "negative_lag",
        "gate_without_entry_tasks",
        "gate_target_after_window_end",
      ]),
    );
  });
});
