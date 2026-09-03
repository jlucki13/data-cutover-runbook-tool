/**
 * Load an event's graph from Postgres into the engine's plain-data input, and persist
 * engine output as schedule runs. The engine itself never sees the database.
 */
import { and, asc, desc, eq, inArray } from "drizzle-orm";
import {
  appUser,
  dependency,
  event,
  gate,
  gateTask,
  scheduleRun,
  scheduleTaskResult,
  task,
  workstream,
  type Db,
} from "@cutover/db";
import {
  ENGINE_VERSION,
  buildGraph,
  computeSchedule,
  type EngineDependency,
  type EngineGate,
  type EngineTask,
  type GraphInput,
  type ImpactReport,
  type Schedule,
  type ScheduleMode,
} from "@cutover/engine";
import { conflict, notFound } from "../errors.js";

export type Tx = Db | Parameters<Parameters<Db["transaction"]>[0]>[0];

export type EventRow = typeof event.$inferSelect;
export type TaskRow = typeof task.$inferSelect;
export type DependencyRow = typeof dependency.$inferSelect;
export type GateRow = typeof gate.$inferSelect;
export type WorkstreamRow = typeof workstream.$inferSelect;
export type UserRow = typeof appUser.$inferSelect;

export interface LoadedRunbook {
  event: EventRow;
  tasks: TaskRow[];
  dependencies: DependencyRow[];
  gates: (GateRow & { entryTaskIds: string[]; gatedTaskIds: string[] })[];
  workstreams: WorkstreamRow[];
  users: UserRow[];
  input: GraphInput;
  workstreamNameById: Record<string, string>;
  ownerNameById: Record<string, string>;
  taskIdByRef: Map<string, string>;
}

const ms = (d: Date | null | undefined): number | undefined => (d ? d.getTime() : undefined);
const opt = <T>(k: string, v: T | undefined) => (v === undefined || v === null ? {} : { [k]: v });

export function toEngineTask(t: TaskRow): EngineTask {
  return {
    id: t.id,
    ref: t.ref,
    name: t.name,
    plannedDurationMinutes: t.plannedDurationMinutes,
    status: t.status,
    ...opt("ownerId", t.ownerId ?? undefined),
    ...opt("workstreamId", t.workstreamId ?? undefined),
    ...opt("plannedStart", ms(t.plannedStart)),
    ...opt("windowDeadline", ms(t.windowDeadline)),
    ...opt("actualStart", ms(t.actualStart)),
    ...opt("actualEnd", ms(t.actualEnd)),
    ...opt("remainingDurationMinutes", t.remainingDurationMinutes ?? undefined),
    ...opt("expectedUnblockAt", ms(t.expectedUnblockAt)),
  } as EngineTask;
}

export function toEngineDependency(d: DependencyRow): EngineDependency {
  return { predecessorId: d.predecessorTaskId, successorId: d.successorTaskId, type: d.type, lagMinutes: d.lagMinutes };
}

export function toEngineGate(g: LoadedRunbook["gates"][number]): EngineGate {
  return {
    id: g.id,
    name: g.name,
    entryTaskIds: g.entryTaskIds,
    gatedTaskIds: g.gatedTaskIds,
    decision: g.decision,
    isPointOfNoReturn: g.isPointOfNoReturn,
    ...opt("decidedAt", ms(g.decidedAt)),
    ...opt("targetDecisionAt", ms(g.targetDecisionAt)),
  } as EngineGate;
}

export async function loadRunbook(db: Tx, eventId: string): Promise<LoadedRunbook> {
  const ev = (await db.select().from(event).where(eq(event.id, eventId)).limit(1))[0];
  if (!ev) throw notFound("event");
  const [tasks, deps, gates, gts, wss, users] = await Promise.all([
    db.select().from(task).where(eq(task.eventId, eventId)).orderBy(asc(task.ref)),
    db.select().from(dependency).where(eq(dependency.eventId, eventId)),
    db.select().from(gate).where(eq(gate.eventId, eventId)).orderBy(asc(gate.name)),
    db
      .select({ gateId: gateTask.gateId, taskId: gateTask.taskId, role: gateTask.role })
      .from(gateTask)
      .innerJoin(gate, eq(gate.id, gateTask.gateId))
      .where(eq(gate.eventId, eventId)),
    db.select().from(workstream).where(eq(workstream.eventId, eventId)),
    db.select().from(appUser),
  ]);
  const fullGates = gates.map((g) => ({
    ...g,
    entryTaskIds: gts.filter((x) => x.gateId === g.id && x.role === "entry").map((x) => x.taskId).sort(),
    gatedTaskIds: gts.filter((x) => x.gateId === g.id && x.role === "gated").map((x) => x.taskId).sort(),
  }));
  const input: GraphInput = {
    event: { windowStart: ev.windowStart.getTime(), windowEnd: ev.windowEnd.getTime(), defaultBlockedRecoveryMinutes: ev.defaultBlockedRecoveryMinutes },
    tasks: tasks.map(toEngineTask),
    dependencies: deps.map(toEngineDependency),
    gates: fullGates.map(toEngineGate),
  };
  return {
    event: ev,
    tasks,
    dependencies: deps,
    gates: fullGates,
    workstreams: wss,
    users,
    input,
    workstreamNameById: Object.fromEntries(wss.map((w) => [w.id, w.name])),
    ownerNameById: Object.fromEntries(users.map((u) => [u.id, u.name])),
    taskIdByRef: new Map(tasks.map((t) => [t.ref, t.id])),
  };
}

export function scheduleFor(input: GraphInput, mode: ScheduleMode, asOf: number): Schedule {
  const built = buildGraph(input);
  if (!built.ok) throw conflict("the committed graph is invalid", built.errors);
  return computeSchedule(built.graph, { mode, asOf });
}

export interface PersistRunArgs {
  eventId: string;
  kind: "baseline" | "live" | "scenario";
  schedule: Schedule;
  trigger: Record<string, unknown>;
  impact?: ImpactReport;
  basedOnRunId?: string;
  createdById?: string;
}

/** Store a schedule run and its per-task results. Returns the run id. */
export async function persistScheduleRun(db: Tx, args: PersistRunArgs): Promise<string> {
  const [run] = await db
    .insert(scheduleRun)
    .values({
      eventId: args.eventId,
      kind: args.kind,
      asOf: new Date(args.schedule.asOf),
      trigger: args.trigger,
      impact: (args.impact ?? null) as Record<string, unknown> | null,
      engineVersion: ENGINE_VERSION,
      basedOnRunId: args.basedOnRunId ?? null,
      createdById: args.createdById ?? null,
    })
    .returning({ id: scheduleRun.id });
  const rows = Object.values(args.schedule.tasks).map((t) => ({
    runId: run!.id,
    taskId: t.taskId,
    earlyStart: t.earlyStart !== undefined ? new Date(t.earlyStart) : null,
    earlyFinish: t.earlyFinish !== undefined ? new Date(t.earlyFinish) : null,
    lateStart: t.lateStart !== undefined ? new Date(t.lateStart) : null,
    lateFinish: t.lateFinish !== undefined ? new Date(t.lateFinish) : null,
    totalFloatMinutes: t.totalFloatMinutes ?? null,
    isCritical: t.isCritical,
    deadlineBreachMinutes: t.deadlineBreachMinutes ?? null,
    heldReason: t.held ? `${t.held.reason}${t.held.byGateId ? `:gate:${t.held.byGateId}` : ""}${t.held.byTaskIds ? `:${t.held.byTaskIds.join(",")}` : ""}` : null,
  }));
  for (let i = 0; i < rows.length; i += 1000) await db.insert(scheduleTaskResult).values(rows.slice(i, i + 1000));
  return run!.id;
}

export async function latestRun(db: Tx, eventId: string, kind: "baseline" | "live" | "scenario") {
  return (await db.select().from(scheduleRun).where(and(eq(scheduleRun.eventId, eventId), eq(scheduleRun.kind, kind))).orderBy(desc(scheduleRun.computedAt)).limit(1))[0];
}

export async function tasksByIds(db: Tx, ids: string[]): Promise<TaskRow[]> {
  if (ids.length === 0) return [];
  return db.select().from(task).where(inArray(task.id, ids));
}
