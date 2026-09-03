/**
 * The event model the views share: the graph payload from the API, the engine graph,
 * the current schedule (computed in the browser with the same engine the server uses),
 * and an optional what-if scenario layered on top.
 */
import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { buildGraph, computeSchedule, simulateChanges, type Change, type Graph, type ImpactReport, type Schedule, type ScheduleMode, type TaskId } from "@cutover/engine";
import { getGraph, type GraphPayload, type TaskRow, type UserRow, type WorkstreamRow } from "../api";
import { workstreamPalette } from "./colors";

export function useNow(intervalMs: number | null): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (intervalMs === null) return;
    const t = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(t);
  }, [intervalMs]);
  return now;
}

export interface EventModel {
  payload: GraphPayload;
  graph: Graph;
  mode: ScheduleMode;
  asOf: number;
  baseline: Schedule;
  /** Scenario result when changes are set; otherwise undefined. */
  scenario?: { schedule: Schedule; impact: ImpactReport; graph: Graph };
  /** The schedule the views display: scenario if active, else baseline. */
  schedule: Schedule;
  taskById: Map<TaskId, TaskRow>;
  userById: Map<string, UserRow>;
  workstreamById: Map<string, WorkstreamRow>;
  colorOf: (task: TaskRow) => string;
  ownerName: (task: TaskRow) => string;
  refOf: (id: TaskId) => string;
  tz: string;
  graphError?: string;
}

export function useEventModel(eventId: string, changes: Change[]): { model?: EventModel; isLoading: boolean; error?: Error; refetch: () => void } {
  const q = useQuery({ queryKey: ["graph", eventId], queryFn: () => getGraph(eventId), refetchInterval: (query) => (query.state.data?.event.status === "live" ? 30_000 : false) });
  const payload = q.data;
  const mode: ScheduleMode = payload?.event.status === "live" ? "live" : "plan";
  const now = useNow(mode === "live" ? 30_000 : null);
  const asOf = mode === "live" ? now : payload ? Date.parse(payload.event.windowStart) : now;

  const model = useMemo<EventModel | undefined>(() => {
    if (!payload) return undefined;
    const built = buildGraph(payload.input);
    const taskById = new Map(payload.tasks.map((t) => [t.id, t] as const));
    const userById = new Map(payload.users.map((u) => [u.id, u] as const));
    const workstreamById = new Map(payload.workstreams.map((w) => [w.id, w] as const));
    const palette = workstreamPalette(
      payload.workstreams.map((w) => w.id),
      (id) => workstreamById.get(id)?.name ?? id,
    );
    const colorOf = (t: TaskRow) => (t.workstreamId ? (palette.get(t.workstreamId) ?? "#898781") : "#898781");
    const ownerName = (t: TaskRow) => (t.ownerId ? (userById.get(t.ownerId)?.name ?? "?") : (t.ownerHint ?? "unassigned"));
    const refOf = (id: TaskId) => taskById.get(id)?.ref ?? id;
    if (!built.ok) {
      const empty = { mode, asOf, tasks: {}, gates: {}, criticalPath: [], criticalTaskIds: [], eventWindowBreachMinutes: 0, deadlineBreaches: [], heldTaskIds: [] } as Schedule;
      return { payload, graph: undefined as unknown as Graph, mode, asOf, baseline: empty, schedule: empty, taskById, userById, workstreamById, colorOf, ownerName, refOf, tz: payload.event.timezone, graphError: JSON.stringify(built.errors) };
    }
    const baseline = computeSchedule(built.graph, { mode, asOf });
    let scenario: EventModel["scenario"];
    if (changes.length > 0) {
      const r = simulateChanges(payload.input, baseline, changes, { mode, asOf });
      if (r.ok) scenario = { schedule: r.schedule, impact: r.impact, graph: r.graph };
    }
    return { payload, graph: built.graph, mode, asOf, baseline, scenario, schedule: scenario?.schedule ?? baseline, taskById, userById, workstreamById, colorOf, ownerName, refOf, tz: payload.event.timezone };
  }, [payload, mode, asOf, changes]);

  return { model, isLoading: q.isLoading, error: q.error ?? undefined, refetch: () => void q.refetch() };
}
