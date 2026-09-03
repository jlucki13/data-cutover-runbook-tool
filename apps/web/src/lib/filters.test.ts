import { describe, expect, it } from "vitest";
import { buildGraph, computeSchedule, type GraphInput } from "@cutover/engine";
import { applyFilters, EMPTY_FILTERS } from "./filters";
import { layoutGraph } from "./layout";
import { fmtDelta, fmtDuration, fmtTime } from "./format";
import { workstreamPalette } from "./colors";
import type { TaskRow } from "../api";

const T0 = Date.UTC(2026, 9, 16, 22);
const at = (m: number) => T0 + m * 60_000;
const input: GraphInput = {
  event: { windowStart: T0, windowEnd: at(600) },
  tasks: [
    { id: "a", ref: "A", name: "Freeze", plannedDurationMinutes: 60, status: "not_started", workstreamId: "core", ownerId: "u1" },
    { id: "b", ref: "B", name: "Migrate", plannedDurationMinutes: 120, status: "not_started", workstreamId: "acc" },
    { id: "c", ref: "C", name: "Notify", plannedDurationMinutes: 30, status: "not_started", workstreamId: "acc", ownerId: "u1" },
  ],
  dependencies: [
    { predecessorId: "a", successorId: "b", type: "FS", lagMinutes: 0 },
    { predecessorId: "b", successorId: "c", type: "FS", lagMinutes: 0 },
  ],
  gates: [],
};
const rows: TaskRow[] = input.tasks.map((t) => ({
  id: t.id,
  eventId: "e",
  ref: t.ref,
  name: t.name,
  description: null,
  workstreamId: t.workstreamId ?? null,
  ownerId: t.ownerId ?? null,
  ownerHint: null,
  plannedStart: null,
  plannedDurationMinutes: t.plannedDurationMinutes,
  windowDeadline: null,
  status: t.status,
  statusNote: null,
  actualStart: null,
  actualEnd: null,
  remainingDurationMinutes: null,
  expectedUnblockAt: null,
  customFields: {},
}));
const built = buildGraph(input);
if (!built.ok) throw new Error("bad graph");
const schedule = computeSchedule(built.graph, { mode: "plan", asOf: T0 });

describe("applyFilters", () => {
  it("returns everything in topological order with empty filters", () => {
    expect(applyFilters(rows, built.graph, schedule, EMPTY_FILTERS)).toEqual(["a", "b", "c"]);
  });
  it("filters by workstream, owner, search, critical and time window", () => {
    expect(applyFilters(rows, built.graph, schedule, { ...EMPTY_FILTERS, workstreams: ["acc"] })).toEqual(["b", "c"]);
    expect(applyFilters(rows, built.graph, schedule, { ...EMPTY_FILTERS, ownerId: "u1" })).toEqual(["a", "c"]);
    expect(applyFilters(rows, built.graph, schedule, { ...EMPTY_FILTERS, search: "migr" })).toEqual(["b"]);
    expect(applyFilters(rows, built.graph, schedule, { ...EMPTY_FILTERS, criticalOnly: true })).toEqual(["a", "b", "c"]);
    expect(applyFilters(rows, built.graph, schedule, { ...EMPTY_FILTERS, timeFrom: at(70), timeTo: at(100) })).toEqual(["b"]);
  });
  it("focuses on a neighborhood", () => {
    expect(applyFilters(rows, built.graph, schedule, { ...EMPTY_FILTERS, focus: { taskId: "c", radius: 1 } })).toEqual(["b", "c"]);
  });
});

describe("layoutGraph", () => {
  it("places successors to the right of predecessors", () => {
    const pos = layoutGraph(
      [
        { id: "a", width: 100, height: 40 },
        { id: "b", width: 100, height: 40 },
        { id: "c", width: 100, height: 40 },
      ],
      [
        { source: "a", target: "b" },
        { source: "b", target: "c" },
      ],
    );
    expect(pos.get("a")!.x).toBeLessThan(pos.get("b")!.x);
    expect(pos.get("b")!.x).toBeLessThan(pos.get("c")!.x);
  });
});

describe("format", () => {
  it("formats durations, deltas and times", () => {
    expect(fmtDuration(150)).toBe("2h 30m");
    expect(fmtDuration(60)).toBe("1h");
    expect(fmtDuration(5)).toBe("5m");
    expect(fmtDelta(45)).toBe("+45m");
    expect(fmtDelta(-120)).toBe("-2h");
    expect(fmtDelta(0)).toBe("0");
    expect(fmtTime(at(0), "UTC")).toMatch(/Fri.*16 Oct.*22:00/);
    expect(fmtTime(at(0), "America/New_York", { withDay: false })).toBe("18:00");
  });
});

describe("workstreamPalette", () => {
  it("assigns slots by name order, folding past eight into Other", () => {
    const ids = Array.from({ length: 10 }, (_, i) => `w${i}`);
    const p = workstreamPalette(ids, (id) => id);
    expect(p.get("w0")).toBe("#2a78d6");
    expect(p.get("w9")).toBe("#898781");
    expect(new Set(p.values()).size).toBe(9);
  });
});
