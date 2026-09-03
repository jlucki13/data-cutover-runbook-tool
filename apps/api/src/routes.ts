import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { and, asc, eq, sql } from "drizzle-orm";
import { appUser, auditLogEntry, event, eventColumn, gate, gateTask, scheduleRun, scheduleTaskResult, task, workstream, type Db } from "@cutover/db";
import type { LlmClient } from "@cutover/ingest";
import { requireAuth, requireRole } from "./auth.js";
import { badRequest, conflict, notFound } from "./errors.js";
import * as S from "./schemas.js";
import { writeAudit, snapshot } from "./services/audit.js";
import { commitImport, createImport, discardImport, getImportReview, listImports, reviewCandidates } from "./services/imports.js";
import { decideGate, simulate, updateTask } from "./services/live.js";
import { latestRun, loadRunbook, persistScheduleRun, scheduleFor } from "./services/runbook.js";

export interface RouteDeps {
  db: Db;
  llm?: LlmClient;
}

export async function registerRoutes(fastify: FastifyInstance, deps: RouteDeps): Promise<void> {
  const app = fastify.withTypeProvider<ZodTypeProvider>();
  const { db } = deps;

  app.get("/health", async () => ({ ok: true }));

  // ------------------------------------------------------------------ users
  app.post("/users", { schema: { body: S.createUserBody } }, async (req, reply) => {
    const count = await db.select({ n: sql<number>`count(*)::int` }).from(appUser);
    const bootstrap = (count[0]?.n ?? 0) === 0;
    if (!bootstrap) {
      if (!req.user) throw badRequest("set x-user-id (admin) to create users");
      if (req.user.role !== "admin") throw conflict("only admins can create users");
    }
    const [u] = await db.insert(appUser).values({ ...req.body, role: bootstrap ? "admin" : req.body.role }).returning();
    return reply.code(201).send(u);
  });
  app.get("/users", { preHandler: requireAuth }, async () => db.select().from(appUser).orderBy(asc(appUser.name)));
  app.get("/me", { preHandler: requireAuth }, async (req) => req.user);

  // ----------------------------------------------------------------- events
  app.post("/events", { preHandler: requireRole("builder"), schema: { body: S.createEventBody } }, async (req, reply) => {
    if (req.body.windowEnd <= req.body.windowStart) throw badRequest("windowEnd must be after windowStart");
    const [ev] = await db.insert(event).values({ ...req.body, createdById: req.user!.id }).returning();
    await writeAudit(db, { eventId: ev!.id, entityType: "event", entityId: ev!.id, action: "event.created", after: snapshot(ev), actorId: req.user!.id });
    return reply.code(201).send(ev);
  });
  app.get("/events", { preHandler: requireAuth }, async () => db.select().from(event).orderBy(asc(event.windowStart)));
  app.get("/events/:id", { preHandler: requireAuth, schema: { params: S.idParam } }, async (req) => {
    const ev = (await db.select().from(event).where(eq(event.id, req.params.id)).limit(1))[0];
    if (!ev) throw notFound("event");
    return ev;
  });
  app.patch("/events/:id", { preHandler: requireRole("builder", "command_center"), schema: { params: S.idParam, body: S.updateEventBody } }, async (req) => {
    const before = (await db.select().from(event).where(eq(event.id, req.params.id)).limit(1))[0];
    if (!before) throw notFound("event");
    const [after] = await db.update(event).set({ ...req.body, updatedAt: new Date() }).where(eq(event.id, req.params.id)).returning();
    await writeAudit(db, { eventId: before.id, entityType: "event", entityId: before.id, action: req.body.status && req.body.status !== before.status ? "event.status_changed" : "event.updated", before: snapshot(before), after: snapshot(after), actorId: req.user!.id });
    return after;
  });

  /** The graph as the engine sees it, plus the lookups the UI needs to label it. */
  app.get("/events/:id/graph", { preHandler: requireAuth, schema: { params: S.idParam } }, async (req) => {
    const rb = await loadRunbook(db, req.params.id);
    return {
      event: rb.event,
      input: rb.input,
      tasks: rb.tasks,
      dependencies: rb.dependencies,
      gates: rb.gates,
      workstreams: rb.workstreams,
      users: rb.users.map((u) => ({ id: u.id, name: u.name, email: u.email, role: u.role })),
    };
  });
  app.get("/events/:id/workstreams", { preHandler: requireAuth, schema: { params: S.idParam } }, async (req) => db.select().from(workstream).where(eq(workstream.eventId, req.params.id)).orderBy(asc(workstream.name)));
  app.get("/events/:id/audit", { preHandler: requireAuth, schema: { params: S.idParam } }, async (req) =>
    db.select().from(auditLogEntry).where(eq(auditLogEntry.eventId, req.params.id)).orderBy(asc(auditLogEntry.occurredAt), asc(auditLogEntry.id)),
  );

  // ---------------------------------------------------------------- columns (admin)
  app.get("/events/:id/columns", { preHandler: requireAuth, schema: { params: S.idParam } }, async (req) => db.select().from(eventColumn).where(eq(eventColumn.eventId, req.params.id)).orderBy(asc(eventColumn.position), asc(eventColumn.key)));
  app.post("/events/:id/columns", { preHandler: requireRole("admin"), schema: { params: S.idParam, body: S.columnBody } }, async (req, reply) => {
    const [col] = await db.insert(eventColumn).values({ ...req.body, eventId: req.params.id, createdById: req.user!.id }).returning();
    await writeAudit(db, { eventId: req.params.id, entityType: "event_column", entityId: col!.id, action: "column.created", after: snapshot(col), actorId: req.user!.id });
    return reply.code(201).send(col);
  });
  app.patch("/columns/:id", { preHandler: requireRole("admin"), schema: { params: S.idParam, body: S.columnPatchBody } }, async (req) => {
    const before = (await db.select().from(eventColumn).where(eq(eventColumn.id, req.params.id)).limit(1))[0];
    if (!before) throw notFound("column");
    const [after] = await db.update(eventColumn).set({ ...req.body, updatedAt: new Date() }).where(eq(eventColumn.id, req.params.id)).returning();
    await writeAudit(db, { eventId: before.eventId, entityType: "event_column", entityId: before.id, action: "column.updated", before: snapshot(before), after: snapshot(after), actorId: req.user!.id });
    return after;
  });
  app.delete("/columns/:id", { preHandler: requireRole("admin"), schema: { params: S.idParam } }, async (req, reply) => {
    const before = (await db.select().from(eventColumn).where(eq(eventColumn.id, req.params.id)).limit(1))[0];
    if (!before) throw notFound("column");
    await db.delete(eventColumn).where(eq(eventColumn.id, req.params.id));
    await writeAudit(db, { eventId: before.eventId, entityType: "event_column", entityId: before.id, action: "column.deleted", before: snapshot(before), actorId: req.user!.id });
    return reply.code(204).send();
  });

  // ---------------------------------------------------------------- imports
  app.post("/events/:id/imports", { preHandler: requireRole("builder"), schema: { params: S.idParam, body: S.createImportBody }, bodyLimit: 50 * 1024 * 1024 }, async (req, reply) => {
    const review = await createImport(db, { eventId: req.params.id, userId: req.user!.id, ...req.body, llm: deps.llm });
    return reply.code(201).send(review);
  });
  app.get("/events/:id/imports", { preHandler: requireAuth, schema: { params: S.idParam } }, async (req) => listImports(db, req.params.id));
  app.get("/imports/:id", { preHandler: requireAuth, schema: { params: S.idParam } }, async (req) => getImportReview(db, req.params.id));
  app.post("/imports/:id/review", { preHandler: requireRole("builder"), schema: { params: S.idParam, body: S.reviewBody } }, async (req) => reviewCandidates(db, req.params.id, req.user!.id, req.body));
  app.post("/imports/:id/commit", { preHandler: requireRole("builder"), schema: { params: S.idParam, body: S.commitBody } }, async (req) => commitImport(db, { batchId: req.params.id, userId: req.user!.id, ...req.body }));
  app.post("/imports/:id/discard", { preHandler: requireRole("builder"), schema: { params: S.idParam } }, async (req, reply) => {
    await discardImport(db, req.params.id, req.user!.id);
    return reply.code(204).send();
  });

  // --------------------------------------------------------------- schedule
  app.post("/events/:id/schedule/baseline", { preHandler: requireRole("builder"), schema: { params: S.idParam } }, async (req, reply) => {
    const rb = await loadRunbook(db, req.params.id);
    const schedule = scheduleFor(rb.input, "plan", Date.now());
    const id = await persistScheduleRun(db, { eventId: rb.event.id, kind: "baseline", schedule, trigger: { type: "baseline.requested" }, createdById: req.user!.id });
    await writeAudit(db, { eventId: rb.event.id, entityType: "schedule_run", entityId: id, action: "baseline.computed", actorId: req.user!.id, scheduleRunId: id });
    return reply.code(201).send({ scheduleRunId: id, schedule });
  });
  /** Current schedule, computed on demand (not persisted). Live events default to live mode. */
  app.get("/events/:id/schedule", { preHandler: requireAuth, schema: { params: S.idParam, querystring: S.scheduleQuery } }, async (req) => {
    const rb = await loadRunbook(db, req.params.id);
    const mode = req.query.mode ?? (rb.event.status === "live" ? "live" : "plan");
    const asOf = req.query.asOf ?? Date.now();
    return { mode, asOf, schedule: scheduleFor(rb.input, mode, asOf) };
  });
  app.get("/events/:id/schedule/runs", { preHandler: requireAuth, schema: { params: S.idParam } }, async (req) =>
    db.select({ id: scheduleRun.id, kind: scheduleRun.kind, asOf: scheduleRun.asOf, computedAt: scheduleRun.computedAt, trigger: scheduleRun.trigger, engineVersion: scheduleRun.engineVersion }).from(scheduleRun).where(eq(scheduleRun.eventId, req.params.id)).orderBy(sql`${scheduleRun.computedAt} desc`).limit(100),
  );
  app.get("/schedule-runs/:id", { preHandler: requireAuth, schema: { params: S.idParam } }, async (req) => {
    const run = (await db.select().from(scheduleRun).where(eq(scheduleRun.id, req.params.id)).limit(1))[0];
    if (!run) throw notFound("schedule run");
    const results = await db.select().from(scheduleTaskResult).where(eq(scheduleTaskResult.runId, run.id));
    return { run, results };
  });
  app.get("/events/:id/impact/latest", { preHandler: requireAuth, schema: { params: S.idParam } }, async (req) => {
    const run = (await latestRun(db, req.params.id, "live")) ?? (await latestRun(db, req.params.id, "scenario"));
    if (!run) return { run: null, impact: null };
    return { run, impact: run.impact };
  });
  app.post("/events/:id/simulate", { preHandler: requireRole("builder", "command_center"), schema: { params: S.idParam, body: S.simulateBody } }, async (req) =>
    simulate(db, req.params.id, req.body.changes, { mode: req.body.mode, asOf: req.body.asOf, save: req.body.save, actorId: req.user!.id }),
  );

  // ------------------------------------------------------------------ tasks
  app.get("/events/:id/tasks", { preHandler: requireAuth, schema: { params: S.idParam } }, async (req) => db.select().from(task).where(eq(task.eventId, req.params.id)).orderBy(asc(task.ref)));
  app.get("/tasks/:id", { preHandler: requireAuth, schema: { params: S.idParam } }, async (req) => {
    const t = (await db.select().from(task).where(eq(task.id, req.params.id)).limit(1))[0];
    if (!t) throw notFound("task");
    return t;
  });
  app.patch("/tasks/:id", { preHandler: requireRole("builder", "command_center", "task_owner"), schema: { params: S.idParam, body: S.taskPatchBody } }, async (req) => {
    const t = (await db.select().from(task).where(eq(task.id, req.params.id)).limit(1))[0];
    if (!t) throw notFound("task");
    const u = req.user!;
    const planFields = ["plannedStart", "plannedDurationMinutes", "windowDeadline", "name", "ownerId", "workstreamId"] as const;
    if (u.role === "task_owner") {
      if (t.ownerId !== u.id) throw conflict("task owners can only update their own tasks");
      if (planFields.some((f) => req.body[f] !== undefined)) throw conflict("task owners can update status and estimates, not the plan");
    }
    return updateTask(db, req.params.id, req.body, u.id);
  });

  // ------------------------------------------------------------------ gates
  app.get("/events/:id/gates", { preHandler: requireAuth, schema: { params: S.idParam } }, async (req) => (await loadRunbook(db, req.params.id)).gates);
  app.post("/events/:id/gates", { preHandler: requireRole("builder"), schema: { params: S.idParam, body: S.createGateBody } }, async (req, reply) => {
    const rb = await loadRunbook(db, req.params.id);
    const ids = (refs: string[]) =>
      refs.map((r) => {
        const id = rb.taskIdByRef.get(r);
        if (!id) throw badRequest(`unknown task ref "${r}"`);
        return id;
      });
    const entry = ids(req.body.entryTaskRefs);
    const gated = ids(req.body.gatedTaskRefs);
    const both = entry.filter((id) => gated.includes(id));
    if (both.length > 0) throw badRequest("a task cannot be both an entry and a gated task of the same gate");
    const g = await db.transaction(async (tx) => {
      const [row] = await tx
        .insert(gate)
        .values({
          eventId: req.params.id,
          name: req.body.name,
          description: req.body.description ?? null,
          approverId: req.body.approverId ?? null,
          targetDecisionAt: req.body.targetDecisionAt !== undefined ? new Date(req.body.targetDecisionAt) : null,
          isPointOfNoReturn: req.body.isPointOfNoReturn,
        })
        .returning();
      const links = [...entry.map((taskId) => ({ gateId: row!.id, taskId, role: "entry" as const })), ...gated.map((taskId) => ({ gateId: row!.id, taskId, role: "gated" as const }))];
      if (links.length > 0) await tx.insert(gateTask).values(links);
      await writeAudit(tx, { eventId: req.params.id, entityType: "gate", entityId: row!.id, action: "gate.created", after: { ...snapshot(row), entryTaskRefs: req.body.entryTaskRefs, gatedTaskRefs: req.body.gatedTaskRefs }, actorId: req.user!.id });
      return row!;
    });
    // Reject a gate that would create a cycle.
    const after = await loadRunbook(db, req.params.id);
    try {
      scheduleFor(after.input, "plan", Date.now());
    } catch (e) {
      await db.delete(gateTask).where(eq(gateTask.gateId, g.id));
      await db.delete(gate).where(and(eq(gate.id, g.id), eq(gate.eventId, req.params.id)));
      throw e;
    }
    return reply.code(201).send({ ...g, entryTaskIds: entry, gatedTaskIds: gated });
  });
  app.post("/gates/:id/decision", { preHandler: requireRole("command_center", "builder"), schema: { params: S.idParam, body: S.gateDecisionBody } }, async (req) => {
    const g = (await db.select().from(gate).where(eq(gate.id, req.params.id)).limit(1))[0];
    if (!g) throw notFound("gate");
    if (g.approverId && g.approverId !== req.user!.id && req.user!.role !== "admin") throw conflict("only the designated approver (or an admin) can decide this gate");
    return decideGate(db, req.params.id, req.body.decision, req.body.note, req.user!.id);
  });
}
