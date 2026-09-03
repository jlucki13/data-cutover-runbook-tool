import { buildGraph, computeSchedule } from "../src/index.js";
import type {
  DependencyType,
  EngineDependency,
  EngineEvent,
  EngineGate,
  EngineTask,
  Graph,
  GraphInput,
  Schedule,
  ScheduleOptions,
} from "../src/index.js";

/** Friday 2026-10-16 22:00 UTC — a typical cutover-weekend start. */
export const T0 = Date.UTC(2026, 9, 16, 22, 0, 0);
export const MIN = 60_000;
/** Absolute instant N minutes after T0. */
export const at = (minutes: number): number => T0 + minutes * MIN;
/** Minutes after T0 for an absolute instant. */
export const rel = (ms: number | undefined): number | undefined => (ms === undefined ? undefined : Math.round((ms - T0) / MIN));

export const DEFAULT_EVENT: EngineEvent = { windowStart: T0, windowEnd: at(32 * 60) };

type TaskExtra = Partial<Omit<EngineTask, "id" | "ref" | "name" | "plannedDurationMinutes" | "status">> & { status?: EngineTask["status"]; ref?: string; name?: string };

export function task(id: string, durationMinutes: number, extra: TaskExtra = {}): EngineTask {
  const { status, ref, name, ...rest } = extra;
  const t: EngineTask = { id, ref: ref ?? id, name: name ?? ref ?? id, plannedDurationMinutes: durationMinutes, status: status ?? "not_started" };
  for (const [k, v] of Object.entries(rest)) if (v !== undefined) (t as unknown as Record<string, unknown>)[k] = v;
  return t;
}

export function dep(predecessorId: string, successorId: string, type: DependencyType = "FS", lagMinutes = 0): EngineDependency {
  return { predecessorId, successorId, type, lagMinutes };
}

export function gate(
  id: string,
  entryTaskIds: string[],
  gatedTaskIds: string[],
  extra: Partial<Omit<EngineGate, "id" | "entryTaskIds" | "gatedTaskIds">> = {},
): EngineGate {
  const g: EngineGate = { id, name: id, entryTaskIds, gatedTaskIds, decision: "pending", isPointOfNoReturn: false };
  for (const [k, v] of Object.entries(extra)) if (v !== undefined) (g as unknown as Record<string, unknown>)[k] = v;
  return g;
}

export function input(tasks: EngineTask[], dependencies: EngineDependency[] = [], gates: EngineGate[] = [], event: Partial<EngineEvent> = {}): GraphInput {
  return { event: { ...DEFAULT_EVENT, ...event }, tasks, dependencies, gates };
}

export function build(i: GraphInput): Graph {
  const r = buildGraph(i);
  if (!r.ok) throw new Error("buildGraph failed: " + JSON.stringify(r.errors));
  return r.graph;
}

export function plan(i: GraphInput, opts: Partial<ScheduleOptions> = {}): Schedule {
  return computeSchedule(build(i), { mode: "plan", asOf: T0, ...opts });
}

export function live(i: GraphInput, asOfMinutes: number, opts: Partial<ScheduleOptions> = {}): Schedule {
  return computeSchedule(build(i), { mode: "live", asOf: at(asOfMinutes), ...opts });
}

/** Compact view of a task's timing in minutes-after-T0, for readable assertions. */
export function view(s: Schedule, id: string) {
  const t = s.tasks[id];
  if (!t) throw new Error(`no timing for ${id}`);
  return {
    es: rel(t.earlyStart),
    ef: rel(t.earlyFinish),
    ls: rel(t.lateStart),
    lf: rel(t.lateFinish),
    float: t.totalFloatMinutes,
    critical: t.isCritical,
    held: t.held?.reason,
    drivenBy: t.drivenBy,
    breach: t.deadlineBreachMinutes,
  };
}

/** Deterministic PRNG (mulberry32) for property/perf tests. */
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function shuffle<T>(arr: T[], rand: () => number): T[] {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [a[i], a[j]] = [a[j]!, a[i]!];
  }
  return a;
}

/**
 * Layered random DAG: `n` tasks in ~sqrt(n) layers, each task depending on 1..maxIn tasks
 * from earlier layers. Refs are zero-padded so natural and lexical order agree.
 */
export function randomDag(n: number, seed: number, maxIn = 3, opts: { withGates?: boolean; withDeadlines?: boolean } = {}): GraphInput {
  const rand = rng(seed);
  const layers = Math.max(2, Math.round(Math.sqrt(n)));
  const tasks: EngineTask[] = [];
  const deps: EngineDependency[] = [];
  const byLayer: string[][] = Array.from({ length: layers }, () => []);
  const types: DependencyType[] = ["FS", "FS", "FS", "FS", "SS", "FF", "SF"];
  const pad = String(n).length;
  for (let i = 0; i < n; i++) {
    const layer = Math.min(layers - 1, Math.floor((i / n) * layers));
    const id = `T${String(i).padStart(pad, "0")}`;
    const extra: TaskExtra = { ownerId: `owner-${i % 17}`, workstreamId: `ws-${layer % 5}` };
    if (opts.withDeadlines && rand() < 0.1) extra.windowDeadline = at(Math.floor(rand() * 32 * 60));
    tasks.push(task(id, 5 + Math.floor(rand() * 120), extra));
    byLayer[layer]!.push(id);
    if (layer > 0) {
      const k = 1 + Math.floor(rand() * maxIn);
      const seen = new Set<string>();
      for (let j = 0; j < k; j++) {
        const pl = Math.floor(rand() * layer);
        const cands = byLayer[pl]!;
        if (cands.length === 0) continue;
        const p = cands[Math.floor(rand() * cands.length)]!;
        if (seen.has(p)) continue;
        seen.add(p);
        deps.push(dep(p, id, types[Math.floor(rand() * types.length)]!, rand() < 0.2 ? Math.floor(rand() * 60) - 15 : 0));
      }
    }
  }
  const gates: EngineGate[] = [];
  if (opts.withGates) {
    const mid = Math.floor(layers / 2);
    gates.push(gate("G-mid", byLayer[mid - 1]!.slice(0, 5), byLayer[mid]!.slice(0, 5), { targetDecisionAt: at(16 * 60) }));
  }
  return input(tasks, deps, gates, { windowEnd: at(72 * 60) });
}
