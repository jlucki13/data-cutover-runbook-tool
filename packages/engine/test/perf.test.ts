import { describe, expect, it } from "vitest";
import { buildGraph, computeSchedule, simulateChanges } from "../src/index.js";
import { T0, at, randomDag } from "./helpers.js";

/**
 * PRD §7: full downstream impact for ~1,000 tasks in "a few seconds".
 * Jordan: events range from 100 to 15,000 tasks. We target full recompute + impact diff
 * well under one second at 15k on CI hardware; the assertions below are deliberately loose
 * so they never flake, and the measured numbers are printed for the record.
 */
const CASES: [number, number][] = [
  [1_000, 500],
  [5_000, 1_500],
  [15_000, 4_000],
];

describe("performance", () => {
  it.each(CASES)("%i tasks: build + schedule + simulate within %i ms", (n, budgetMs) => {
    const input = randomDag(n, 42 + n, 3, { withGates: true, withDeadlines: true });
    const edges = input.dependencies.length;

    const t0 = performance.now();
    const built = buildGraph(input);
    if (!built.ok) throw new Error("build failed");
    const t1 = performance.now();
    const baseline = computeSchedule(built.graph, { mode: "plan", asOf: T0 });
    const t2 = performance.now();
    const victim = input.tasks[Math.floor(n * 0.1)]!.id;
    const r = simulateChanges(input, baseline, [{ kind: "delay", taskId: victim, minutes: 240 }], { mode: "plan", asOf: T0 });
    const t3 = performance.now();
    if (!r.ok) throw new Error("simulate failed");

    const liveInput = { ...input, tasks: input.tasks.map((t, i) => (i % 3 === 0 ? { ...t, status: "complete" as const, actualStart: at(0), actualEnd: at(30) } : t)) };
    const t4 = performance.now();
    const lb = buildGraph(liveInput);
    if (!lb.ok) throw new Error("live build failed");
    computeSchedule(lb.graph, { mode: "live", asOf: at(120) });
    const t5 = performance.now();

    const ms = (a: number, b: number) => Math.round(b - a);
    // eslint-disable-next-line no-console
    console.log(
      `[perf] n=${n} edges=${edges} build=${ms(t0, t1)}ms schedule=${ms(t1, t2)}ms simulate(build+schedule+diff)=${ms(t2, t3)}ms live=${ms(t4, t5)}ms affected=${r.impact.affectedTasks.length}`,
    );
    expect(t3 - t0).toBeLessThan(budgetMs);
    expect(r.impact.affectedTasks.length).toBeGreaterThan(0);
  });
});
