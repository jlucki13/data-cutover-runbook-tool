import { describe, expect, it } from "vitest";
import { buildGraph, computeSchedule, simulateChanges } from "../src/index.js";
import type { GraphInput, Schedule } from "../src/index.js";
import { MIN, at, randomDag, rng, shuffle, T0 } from "./helpers.js";
import { trbkEvent } from "./fixtures/trbk.js";

function scheduleOf(i: GraphInput, mode: "plan" | "live", asOf: number): Schedule {
  const r = buildGraph(i);
  if (!r.ok) throw new Error(JSON.stringify(r.errors));
  return computeSchedule(r.graph, { mode, asOf });
}

/** Randomise statuses/actuals so live rules get exercised. */
function liveify(i: GraphInput, seed: number, asOf: number): GraphInput {
  const rand = rng(seed);
  return {
    ...i,
    tasks: i.tasks.map((t, idx) => {
      const roll = rand();
      const start = asOf - Math.floor(rand() * 300) * MIN;
      if (idx < i.tasks.length * 0.3 && roll < 0.8) return { ...t, status: "complete", actualStart: start - 60 * MIN, actualEnd: start };
      if (roll < 0.1) return { ...t, status: "in_progress", actualStart: start };
      if (roll < 0.15) return { ...t, status: "blocked", ...(rand() < 0.5 ? { expectedUnblockAt: asOf + 45 * MIN } : {}) };
      if (roll < 0.17) return { ...t, status: "failed", actualStart: start };
      if (roll < 0.19) return { ...t, status: "skipped", actualEnd: start };
      return t;
    }),
  };
}

describe("determinism", () => {
  it("shuffling input arrays yields a byte-identical schedule", () => {
    const base = trbkEvent();
    const expected = JSON.stringify(scheduleOf(base, "plan", T0));
    for (let seed = 1; seed <= 20; seed++) {
      const rand = rng(seed);
      const shuffled: GraphInput = {
        event: base.event,
        tasks: shuffle(base.tasks, rand),
        dependencies: shuffle(base.dependencies, rand),
        gates: shuffle(base.gates, rand).map((g) => ({ ...g, entryTaskIds: shuffle(g.entryTaskIds, rand), gatedTaskIds: shuffle(g.gatedTaskIds, rand) })),
      };
      expect(JSON.stringify(scheduleOf(shuffled, "plan", T0))).toBe(expected);
    }
  });

  it("holds for large random graphs in live mode too", () => {
    const asOf = at(6 * 60);
    const base = liveify(randomDag(800, 7, 3, { withGates: true, withDeadlines: true }), 7, asOf);
    const expected = JSON.stringify(scheduleOf(base, "live", asOf));
    const rand = rng(99);
    const shuffled: GraphInput = { ...base, tasks: shuffle(base.tasks, rand), dependencies: shuffle(base.dependencies, rand) };
    expect(JSON.stringify(scheduleOf(shuffled, "live", asOf))).toBe(expected);
  });

  it("simulateChanges is a pure function of (input, changes, opts)", () => {
    const i = trbkEvent();
    const baseline = scheduleOf(i, "plan", T0);
    const a = simulateChanges(i, baseline, [{ kind: "delay", taskId: "MIG-STM", minutes: 360 }], { mode: "plan", asOf: T0 });
    const b = simulateChanges(i, baseline, [{ kind: "delay", taskId: "MIG-STM", minutes: 360 }], { mode: "plan", asOf: T0 });
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });
});

describe("schedule invariants on random DAGs (property test)", () => {
  const seeds = Array.from({ length: 25 }, (_, k) => 1000 + k);

  it.each(seeds)("seed %i: every constraint holds, floats are consistent", (seed) => {
    const asOf = at(5 * 60);
    const plainInput = randomDag(300, seed, 3, { withGates: true, withDeadlines: true });
    for (const [mode, i] of [
      ["plan", plainInput],
      ["live", liveify(plainInput, seed, asOf)],
    ] as const) {
      const built = buildGraph(i);
      if (!built.ok) throw new Error(JSON.stringify(built.errors));
      const g = built.graph;
      const s = computeSchedule(g, { mode, asOf });
      const ev = i.event;
      let maxEf = -Infinity;

      for (const id of g.order) {
        const tm = s.tasks[id]!;
        const t = g.tasks.get(id)!;
        if (tm.held) {
          expect(tm.earlyStart).toBeUndefined();
          continue;
        }
        const es = tm.earlyStart!;
        const ef = tm.earlyFinish!;
        expect(ef).toBeGreaterThanOrEqual(es);
        maxEf = Math.max(maxEf, ef);

        const pinned = mode === "live" && (t.status === "complete" || t.status === "skipped" || t.status === "in_progress" || ((t.status === "blocked" || t.status === "failed") && t.actualStart !== undefined));
        if (!pinned) {
          // Not-started work respects window/planned start, "now" in live mode, and every predecessor.
          expect(es).toBeGreaterThanOrEqual(t.plannedStart ?? ev.windowStart);
          if (mode === "live") expect(es).toBeGreaterThanOrEqual(asOf);
          for (const e of g.inEdges.get(id)!) {
            const p = s.tasks[e.predecessorId]!;
            const lag = e.lagMinutes * MIN;
            const dur = ef - es;
            const bound = e.type === "FS" ? p.earlyFinish! + lag : e.type === "SS" ? p.earlyStart! + lag : e.type === "FF" ? p.earlyFinish! + lag - dur : p.earlyStart! + lag - dur;
            expect(es).toBeGreaterThanOrEqual(bound);
          }
          // drivenBy is exact: at least one constraint equals ES, unless floor/now drives it.
          const floor = Math.max(t.plannedStart ?? ev.windowStart, mode === "live" ? asOf : -Infinity, tm.assumption?.resumeAt ?? -Infinity);
          if (es !== floor) expect(tm.drivenBy.length).toBeGreaterThan(0);
        }

        // Late dates: LS = LF - effective duration; float = LF - EF; LF <= window end and deadline.
        expect(tm.lateStart! + (ef - es)).toBe(tm.lateFinish!);
        expect(tm.totalFloatMinutes).toBe(Math.round((tm.lateFinish! - ef) / MIN));
        expect(tm.lateFinish!).toBeLessThanOrEqual(ev.windowEnd);
        if (t.windowDeadline !== undefined) {
          expect(tm.lateFinish!).toBeLessThanOrEqual(t.windowDeadline);
          if (ef > t.windowDeadline) expect(tm.deadlineBreachMinutes).toBe(Math.round((ef - t.windowDeadline) / MIN));
          else expect(tm.deadlineBreachMinutes).toBeUndefined();
        }
        // Backward pass: our LF never exceeds what any unstarted successor allows.
        for (const e of g.outEdges.get(id)!) {
          const sc = s.tasks[e.successorId]!;
          const st = g.tasks.get(e.successorId)!;
          const succPinned = mode === "live" && st.status !== "not_started" && !((st.status === "blocked" || st.status === "failed") && st.actualStart === undefined);
          if (sc.held || succPinned) continue;
          const lag = e.lagMinutes * MIN;
          const dur = ef - es;
          const bound = e.type === "FS" ? sc.lateStart! - lag : e.type === "SS" ? sc.lateStart! - lag + dur : e.type === "FF" ? sc.lateFinish! - lag : sc.lateFinish! - lag + dur;
          expect(tm.lateFinish!).toBeLessThanOrEqual(bound);
        }
        // Critical flag is exactly float <= 0 for unfinished work.
        const done = mode === "live" && (t.status === "complete" || t.status === "skipped");
        expect(tm.isCritical).toBe(!done && tm.totalFloatMinutes! <= 0);
      }

      expect(s.projectedFinish).toBe(maxEf === -Infinity ? undefined : maxEf);
      // No breach anywhere => the longest path has exactly zero float and the critical path is non-empty.
      if (s.eventWindowBreachMinutes === 0 && s.deadlineBreaches.length === 0 && s.heldTaskIds.length === 0) {
        const floats = g.order.map((id) => s.tasks[id]!.totalFloatMinutes!);
        expect(Math.min(...floats)).toBe(0);
        expect(s.criticalPath.length).toBeGreaterThan(0);
      }
      // Canonical path: all critical, consecutive pairs are edges.
      for (let k = 0; k < s.criticalPath.length; k++) {
        const id = s.criticalPath[k]!;
        expect(s.tasks[id]!.isCritical).toBe(true);
        if (k > 0) expect(g.outEdges.get(s.criticalPath[k - 1]!)!.some((e) => e.successorId === id)).toBe(true);
      }
      expect(s.criticalTaskIds).toEqual(g.order.filter((id) => s.tasks[id]!.isCritical));
    }
  });
});
