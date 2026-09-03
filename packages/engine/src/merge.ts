import type { EngineDependency, EngineTask, GraphDiff, GraphInput, RefDependency, TaskFieldChange } from "./types.js";
import { compareRef } from "./util.js";

export interface DiffOptions {
  /**
   * Which current tasks the incoming set is authoritative for. Tasks matching the scope
   * that are absent from `incoming.tasks` are reported as removed; tasks outside the scope
   * are never removed. Default: everything (a full re-import).
   *
   * Runbook owners submit per-workstream worksheets, so the usual call is
   * `{ scope: (t) => t.workstreamId === "<ws>" }`.
   */
  scope?: (task: EngineTask) => boolean;
  /** Task fields compared for "changed". Default: the planning-relevant fields. */
  compareFields?: (keyof EngineTask)[];
}

const DEFAULT_FIELDS: (keyof EngineTask)[] = [
  "name",
  "ownerId",
  "workstreamId",
  "plannedStart",
  "plannedDurationMinutes",
  "windowDeadline",
];

const depKey = (d: RefDependency) => `${d.predecessorRef} ${d.successorRef}`;

/** Express id-based dependencies by ref, dropping any whose endpoints are unknown. */
export function toRefDependencies(tasks: EngineTask[], deps: EngineDependency[]): RefDependency[] {
  const refOf = new Map(tasks.map((t) => [t.id, t.ref] as const));
  const out: RefDependency[] = [];
  for (const d of deps) {
    const p = refOf.get(d.predecessorId);
    const s = refOf.get(d.successorId);
    if (p !== undefined && s !== undefined) out.push({ predecessorRef: p, successorRef: s, type: d.type, lagMinutes: d.lagMinutes });
  }
  return out;
}

/**
 * Diff an incoming (partial) plan against the current one, keyed by task ref.
 * Used by the import review step so a re-submitted worksheet is merged, not blindly overwritten.
 */
export function diffGraphInputs(
  current: Pick<GraphInput, "tasks" | "dependencies">,
  incoming: { tasks?: EngineTask[]; dependencies?: RefDependency[] },
  opts: DiffOptions = {},
): GraphDiff {
  const fields = opts.compareFields ?? DEFAULT_FIELDS;
  const scope = opts.scope ?? (() => true);
  const curByRef = new Map(current.tasks.map((t) => [t.ref, t] as const));
  const incTasks = incoming.tasks ?? [];
  const incByRef = new Map(incTasks.map((t) => [t.ref, t] as const));

  const added: EngineTask[] = [];
  const changed: GraphDiff["tasks"]["changed"] = [];
  const unchanged: string[] = [];
  for (const t of incTasks) {
    const cur = curByRef.get(t.ref);
    if (!cur) {
      added.push(t);
      continue;
    }
    const diffs: TaskFieldChange[] = [];
    for (const f of fields) {
      if (cur[f] !== t[f]) diffs.push({ field: f, before: cur[f], after: t[f] });
    }
    if (diffs.length > 0) changed.push({ ref: t.ref, before: cur, after: t, fields: diffs });
    else unchanged.push(t.ref);
  }
  const removed: EngineTask[] = incoming.tasks ? current.tasks.filter((t) => scope(t) && !incByRef.has(t.ref)) : [];

  // Dependencies: compare within the incoming scope. Current edges touching a scoped task
  // count as "current"; incoming edges are authoritative for those.
  const curDeps = toRefDependencies(current.tasks, current.dependencies);
  const scopedRefs = new Set(current.tasks.filter(scope).map((t) => t.ref));
  const curScoped = curDeps.filter((d) => scopedRefs.has(d.predecessorRef) || scopedRefs.has(d.successorRef));
  const curMap = new Map(curScoped.map((d) => [depKey(d), d] as const));
  const incDeps = incoming.dependencies ?? [];
  const incMap = new Map(incDeps.map((d) => [depKey(d), d] as const));

  const depAdded: RefDependency[] = [];
  const depChanged: GraphDiff["dependencies"]["changed"] = [];
  const depUnchanged: RefDependency[] = [];
  for (const d of incDeps) {
    const cur = curMap.get(depKey(d));
    if (!cur) depAdded.push(d);
    else if (cur.type !== d.type || cur.lagMinutes !== d.lagMinutes) depChanged.push({ before: cur, after: d });
    else depUnchanged.push(d);
  }
  const depRemoved: RefDependency[] = incoming.dependencies ? curScoped.filter((d) => !incMap.has(depKey(d))) : [];

  const known = new Set<string>([...curByRef.keys(), ...incByRef.keys()]);
  const unresolved = new Set<string>();
  for (const d of incDeps) {
    if (!known.has(d.predecessorRef)) unresolved.add(d.predecessorRef);
    if (!known.has(d.successorRef)) unresolved.add(d.successorRef);
  }

  const byRef = (a: { ref: string }, b: { ref: string }) => compareRef(a.ref, b.ref);
  const byDep = (a: RefDependency, b: RefDependency) =>
    compareRef(a.predecessorRef, b.predecessorRef) || compareRef(a.successorRef, b.successorRef);
  return {
    tasks: {
      added: added.sort(byRef),
      removed: removed.sort(byRef),
      changed: changed.sort(byRef),
      unchanged: unchanged.sort(compareRef),
    },
    dependencies: {
      added: depAdded.sort(byDep),
      removed: depRemoved.sort(byDep),
      changed: depChanged.sort((a, b) => byDep(a.after, b.after)),
      unchanged: depUnchanged.sort(byDep),
    },
    unresolvedRefs: Array.from(unresolved).sort(compareRef),
  };
}
