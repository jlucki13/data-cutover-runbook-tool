import type { Graph, TaskId } from "./types.js";
import { compareRef } from "./util.js";

function traverse(graph: Graph, start: TaskId, dir: "out" | "in", maxDepth: number): TaskId[] {
  if (!graph.tasks.has(start)) throw new Error(`unknown task ${start}`);
  const edges = dir === "out" ? graph.outEdges : graph.inEdges;
  const seen = new Set<TaskId>([start]);
  let frontier: TaskId[] = [start];
  const result: TaskId[] = [];
  for (let depth = 0; depth < maxDepth && frontier.length > 0; depth++) {
    const next: TaskId[] = [];
    for (const id of frontier) {
      for (const e of edges.get(id)!) {
        const n = dir === "out" ? e.successorId : e.predecessorId;
        if (!seen.has(n)) {
          seen.add(n);
          next.push(n);
          result.push(n);
        }
      }
    }
    frontier = next;
  }
  const pos = new Map(graph.order.map((id, i) => [id, i] as const));
  return result.sort((a, b) => pos.get(a)! - pos.get(b)!);
}

/** All tasks reachable downstream (transitively, through gates too), in topological order. */
export function downstreamOf(graph: Graph, taskId: TaskId, maxDepth = Infinity): TaskId[] {
  return traverse(graph, taskId, "out", maxDepth);
}

/** All tasks upstream (transitively, through gates too), in topological order. */
export function upstreamOf(graph: Graph, taskId: TaskId, maxDepth = Infinity): TaskId[] {
  return traverse(graph, taskId, "in", maxDepth);
}

/** Local neighborhood for the zoomed graph view: self plus up/downstream within `radius` hops. */
export function neighborhood(graph: Graph, taskId: TaskId, radius = 2): TaskId[] {
  const ids = new Set<TaskId>([taskId, ...upstreamOf(graph, taskId, radius), ...downstreamOf(graph, taskId, radius)]);
  const pos = new Map(graph.order.map((id, i) => [id, i] as const));
  return Array.from(ids).sort((a, b) => pos.get(a)! - pos.get(b)!);
}

export function topologicalOrder(graph: Graph): TaskId[] {
  return [...graph.order];
}

const byRef = (graph: Graph) => (a: TaskId, b: TaskId) => compareRef(graph.tasks.get(a)!.ref, graph.tasks.get(b)!.ref);

/** Tasks with no predecessors, sorted by ref. */
export function sources(graph: Graph): TaskId[] {
  return graph.order.filter((id) => graph.inEdges.get(id)!.length === 0).sort(byRef(graph));
}

/** Tasks with no successors, sorted by ref. */
export function sinks(graph: Graph): TaskId[] {
  return graph.order.filter((id) => graph.outEdges.get(id)!.length === 0).sort(byRef(graph));
}
