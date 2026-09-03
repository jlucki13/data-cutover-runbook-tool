import { neighborhood, type Graph, type Schedule, type TaskId, type TaskStatus } from "@cutover/engine";
import type { TaskRow } from "../api";

export interface Filters {
  /** null = all workstreams. */
  workstreams: string[] | null;
  statuses: TaskStatus[] | null;
  ownerId: string | null;
  search: string;
  criticalOnly: boolean;
  /** Zoom to the neighborhood of one task. */
  focus: { taskId: TaskId; radius: number } | null;
  /** Time window in ms; tasks whose projected span overlaps it. */
  timeFrom: number | null;
  timeTo: number | null;
}

export const EMPTY_FILTERS: Filters = { workstreams: null, statuses: null, ownerId: null, search: "", criticalOnly: false, focus: null, timeFrom: null, timeTo: null };

export function isFiltering(f: Filters): boolean {
  return f.workstreams !== null || f.statuses !== null || f.ownerId !== null || f.search.trim() !== "" || f.criticalOnly || f.focus !== null || f.timeFrom !== null || f.timeTo !== null;
}

/** Task ids that pass the filters, in the graph's topological order. */
export function applyFilters(tasks: TaskRow[], graph: Graph | undefined, schedule: Schedule, f: Filters): TaskId[] {
  const byId = new Map(tasks.map((t) => [t.id, t] as const));
  let ids: TaskId[] = graph ? [...graph.order] : tasks.map((t) => t.id);
  if (f.focus && graph && graph.tasks.has(f.focus.taskId)) {
    const n = new Set(neighborhood(graph, f.focus.taskId, f.focus.radius));
    ids = ids.filter((id) => n.has(id));
  }
  const q = f.search.trim().toLowerCase();
  const ws = f.workstreams ? new Set(f.workstreams) : null;
  const st = f.statuses ? new Set(f.statuses) : null;
  return ids.filter((id) => {
    const t = byId.get(id);
    if (!t) return false;
    if (ws && !(t.workstreamId && ws.has(t.workstreamId))) return false;
    if (st && !st.has(t.status)) return false;
    if (f.ownerId && t.ownerId !== f.ownerId) return false;
    if (q && !(t.ref.toLowerCase().includes(q) || t.name.toLowerCase().includes(q))) return false;
    const tm = schedule.tasks[id];
    if (f.criticalOnly && !tm?.isCritical) return false;
    if ((f.timeFrom !== null || f.timeTo !== null) && tm) {
      const es = tm.earlyStart;
      const ef = tm.earlyFinish;
      if (es === undefined || ef === undefined) return f.timeFrom === null; // held tasks have no span; show only when no lower bound
      if (f.timeFrom !== null && ef < f.timeFrom) return false;
      if (f.timeTo !== null && es > f.timeTo) return false;
    }
    return true;
  });
}
