import type {
  BuildResult,
  Edge,
  EngineGate,
  EngineTask,
  GateId,
  Graph,
  GraphError,
  GraphInput,
  GraphWarning,
  TaskId,
} from "./types.js";
import { MinHeap, compareRef } from "./util.js";

/**
 * Validate a GraphInput and build an indexed, topologically ordered Graph.
 * Gates are folded into the edge set as synthetic FS edges (entry -> gated) so that
 * cycle detection, CPM, and downstream traversal all see them without special cases.
 */
export function buildGraph(input: GraphInput): BuildResult {
  const errors: GraphError[] = [];
  const tasks = new Map<TaskId, EngineTask>();
  const byRef = new Map<string, TaskId[]>();

  for (const t of input.tasks) {
    if (tasks.has(t.id)) {
      errors.push({ kind: "duplicate_task_id", taskId: t.id });
      continue;
    }
    tasks.set(t.id, t);
    const list = byRef.get(t.ref) ?? [];
    list.push(t.id);
    byRef.set(t.ref, list);
    if (!Number.isFinite(t.plannedDurationMinutes) || t.plannedDurationMinutes < 0) {
      errors.push({ kind: "invalid_duration", taskId: t.id, value: t.plannedDurationMinutes });
    }
  }
  for (const [ref, ids] of byRef) {
    if (ids.length > 1) errors.push({ kind: "duplicate_task_ref", ref, taskIds: ids });
  }

  const outEdges = new Map<TaskId, Edge[]>();
  const inEdges = new Map<TaskId, Edge[]>();
  for (const id of tasks.keys()) {
    outEdges.set(id, []);
    inEdges.set(id, []);
  }
  const addEdge = (e: Edge) => {
    outEdges.get(e.predecessorId)!.push(e);
    inEdges.get(e.successorId)!.push(e);
  };

  const seenEdges = new Set<string>();
  for (const d of input.dependencies) {
    let bad = false;
    if (!tasks.has(d.predecessorId)) {
      errors.push({ kind: "unknown_task", taskId: d.predecessorId, referencedBy: `dependency -> ${d.successorId}` });
      bad = true;
    }
    if (!tasks.has(d.successorId)) {
      errors.push({ kind: "unknown_task", taskId: d.successorId, referencedBy: `dependency ${d.predecessorId} ->` });
      bad = true;
    }
    if (bad) continue;
    if (d.predecessorId === d.successorId) {
      errors.push({ kind: "self_loop", taskId: d.predecessorId });
      continue;
    }
    const key = `${d.predecessorId} ${d.successorId}`;
    if (seenEdges.has(key)) {
      errors.push({ kind: "duplicate_edge", predecessorId: d.predecessorId, successorId: d.successorId });
      continue;
    }
    seenEdges.add(key);
    addEdge({ predecessorId: d.predecessorId, successorId: d.successorId, type: d.type, lagMinutes: d.lagMinutes });
  }

  const gates = new Map<GateId, EngineGate>();
  const gatesByGatedTask = new Map<TaskId, GateId[]>();
  for (const g of input.gates) {
    if (gates.has(g.id)) {
      errors.push({ kind: "duplicate_gate_id", gateId: g.id });
      continue;
    }
    let bad = false;
    for (const tid of [...g.entryTaskIds, ...g.gatedTaskIds]) {
      if (!tasks.has(tid)) {
        errors.push({ kind: "gate_unknown_task", gateId: g.id, taskId: tid });
        bad = true;
      }
    }
    const entry = new Set(g.entryTaskIds);
    for (const tid of g.gatedTaskIds) {
      if (entry.has(tid)) {
        errors.push({ kind: "gate_task_both_roles", gateId: g.id, taskId: tid });
        bad = true;
      }
    }
    if (bad) continue;
    gates.set(g.id, g);
    for (const gt of new Set(g.gatedTaskIds)) {
      const list = gatesByGatedTask.get(gt) ?? [];
      list.push(g.id);
      gatesByGatedTask.set(gt, list);
      for (const e of new Set(g.entryTaskIds)) {
        addEdge({ predecessorId: e, successorId: gt, type: "FS", lagMinutes: 0, viaGateId: g.id });
      }
    }
  }

  if (errors.length > 0) return { ok: false, errors };

  // Deterministic edge ordering (by counterpart ref) so traversals are stable.
  const refOf = (id: TaskId) => tasks.get(id)!.ref;
  for (const list of outEdges.values()) list.sort((a, b) => compareRef(refOf(a.successorId), refOf(b.successorId)));
  for (const list of inEdges.values()) list.sort((a, b) => compareRef(refOf(a.predecessorId), refOf(b.predecessorId)));
  for (const list of gatesByGatedTask.values()) list.sort();

  // Kahn's algorithm with a ref-ordered heap => unique topological order.
  const indeg = new Map<TaskId, number>();
  for (const [id, list] of inEdges) indeg.set(id, list.length);
  const heap = new MinHeap<TaskId>((a, b) => compareRef(refOf(a), refOf(b)));
  for (const [id, n] of indeg) if (n === 0) heap.push(id);
  const order: TaskId[] = [];
  while (heap.size > 0) {
    const id = heap.pop()!;
    order.push(id);
    for (const e of outEdges.get(id)!) {
      const n = indeg.get(e.successorId)! - 1;
      indeg.set(e.successorId, n);
      if (n === 0) heap.push(e.successorId);
    }
  }
  if (order.length !== tasks.size) {
    const cycle = findCycle(tasks, outEdges, indeg);
    return { ok: false, errors: [{ kind: "cycle", taskIds: cycle, refs: cycle.map(refOf) }] };
  }

  return {
    ok: true,
    graph: { input, tasks, gates, order, outEdges, inEdges, gatesByGatedTask },
  };
}

/** Find one cycle among nodes with remaining in-degree > 0 (all of which lie on or lead into a cycle). */
function findCycle(tasks: Map<TaskId, EngineTask>, out: Map<TaskId, Edge[]>, indeg: Map<TaskId, number>): TaskId[] {
  const remaining = new Set<TaskId>();
  for (const [id, n] of indeg) if (n > 0) remaining.add(id);
  const start = Array.from(remaining).sort((a, b) => compareRef(tasks.get(a)!.ref, tasks.get(b)!.ref))[0]!;
  const stack: TaskId[] = [];
  const onStack = new Set<TaskId>();
  const visited = new Set<TaskId>();
  const dfs = (id: TaskId): TaskId[] | null => {
    visited.add(id);
    stack.push(id);
    onStack.add(id);
    for (const e of out.get(id)!) {
      const s = e.successorId;
      if (!remaining.has(s)) continue;
      if (onStack.has(s)) {
        const i = stack.indexOf(s);
        return stack.slice(i).concat(s);
      }
      if (!visited.has(s)) {
        const r = dfs(s);
        if (r) return r;
      }
    }
    stack.pop();
    onStack.delete(id);
    return null;
  };
  return dfs(start) ?? [start];
}

/** Non-fatal issues worth surfacing to the builder. */
export function validateGraph(graph: Graph): GraphWarning[] {
  const w: GraphWarning[] = [];
  const { windowStart, windowEnd } = graph.input.event;
  for (const id of graph.order) {
    const t = graph.tasks.get(id)!;
    if (graph.inEdges.get(id)!.length === 0 && graph.outEdges.get(id)!.length === 0) w.push({ kind: "orphan_task", taskId: id });
    if (!t.ownerId) w.push({ kind: "no_owner", taskId: id });
    if (t.plannedStart !== undefined && t.plannedStart < windowStart) w.push({ kind: "planned_start_before_window", taskId: id });
    if (t.windowDeadline !== undefined && t.windowDeadline < windowStart) w.push({ kind: "deadline_before_window_start", taskId: id });
    if (t.windowDeadline !== undefined && t.windowDeadline > windowEnd) w.push({ kind: "deadline_after_window_end", taskId: id });
    if (
      (t.status === "complete" && (t.actualStart === undefined || t.actualEnd === undefined)) ||
      (t.status === "in_progress" && t.actualStart === undefined)
    ) {
      w.push({ kind: "missing_actuals", taskId: id, status: t.status });
    }
    for (const e of graph.outEdges.get(id)!) {
      if (!e.viaGateId && e.lagMinutes < 0) w.push({ kind: "negative_lag", predecessorId: e.predecessorId, successorId: e.successorId });
    }
  }
  for (const g of graph.gates.values()) {
    if (g.entryTaskIds.length === 0) w.push({ kind: "gate_without_entry_tasks", gateId: g.id });
    if (g.gatedTaskIds.length === 0) w.push({ kind: "gate_without_gated_tasks", gateId: g.id });
    if (g.targetDecisionAt !== undefined && g.targetDecisionAt > windowEnd) w.push({ kind: "gate_target_after_window_end", gateId: g.id });
  }
  return w;
}
