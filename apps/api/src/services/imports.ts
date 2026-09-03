/**
 * Import workflow: upload → parse → compile against the committed graph → stage
 * candidates for review → commit accepted candidates in one transaction → recompute
 * the schedule. Nothing parsed (least of all by the LLM) reaches task/dependency
 * without passing through here.
 */
import { and, eq, inArray, sql } from "drizzle-orm";
import { dependency, importBatch, importCandidateDependency, importCandidateTask, task, workstream, type Db } from "@cutover/db";
import { compileWorksheets, parseCsvText, parseMsProjectXml, parseProse, parseWorkbook, type CandidateDependency, type CandidateTask, type CompileResult, type LlmClient, type ParsedPlan, type ParseIssue } from "@cutover/ingest";
import type { EngineTask, DependencyType } from "@cutover/engine";
import { badRequest, conflict, notFound } from "../errors.js";
import { writeAudit, snapshot } from "./audit.js";
import { loadRunbook, persistScheduleRun, scheduleFor, type LoadedRunbook, type Tx } from "./runbook.js";

export type ImportFormat = "csv" | "xlsx" | "ms_project_xml" | "prose";

export interface ImportOptionsInput {
  timezone?: string;
  dateOrder?: "MDY" | "DMY";
  hoursPerDay?: number;
  sheets?: string[];
  defaultWorkstream?: string;
  removalScope?: "incoming_workstreams" | "none" | "all";
  /** Prose only: extra context for the model. */
  context?: string;
  columns?: Record<string, string>;
}

export interface CreateImportArgs {
  eventId: string;
  userId: string;
  format: ImportFormat;
  filename?: string;
  content: string;
  encoding?: "utf8" | "base64";
  options?: ImportOptionsInput;
  llm?: LlmClient;
}

type BatchRow = typeof importBatch.$inferSelect;
type CandTaskRow = typeof importCandidateTask.$inferSelect;
type CandDepRow = typeof importCandidateDependency.$inferSelect;

export interface ReviewPayload {
  batch: BatchRow;
  tasks: CandTaskRow[];
  dependencies: CandDepRow[];
  issues: ParseIssue[];
  summary: Record<string, unknown> | null;
}

const toDate = (n: number | undefined | null) => (n === undefined || n === null ? null : new Date(n));
const ms = (d: Date | null | undefined) => (d ? d.getTime() : undefined);

// ---------------------------------------------------------------------------
// Parse
// ---------------------------------------------------------------------------

async function parseUpload(args: CreateImportArgs, current: LoadedRunbook): Promise<{ worksheets: { name: string; plan: ParsedPlan }[]; dbFormat: "csv" | "gantt_csv" | "ms_project_xml" | "prose_llm" }> {
  const o = args.options ?? {};
  const base = { timezone: o.timezone ?? current.event.timezone, dateOrder: o.dateOrder, hoursPerDay: o.hoursPerDay, defaultWorkstream: o.defaultWorkstream, columns: o.columns as never };
  const text = () => (args.encoding === "base64" ? Buffer.from(args.content, "base64").toString("utf8") : args.content);
  switch (args.format) {
    case "csv": {
      const plan = parseCsvText(text(), base);
      return { worksheets: [{ name: args.filename ?? "sheet", plan }], dbFormat: plan.format === "gantt_csv" ? "gantt_csv" : "csv" };
    }
    case "xlsx": {
      if (args.encoding !== "base64") throw badRequest("xlsx content must be base64-encoded");
      const sheets = await parseWorkbook(Buffer.from(args.content, "base64"), { ...base, sheets: o.sheets });
      if (sheets.length === 0) throw badRequest("workbook has no non-empty sheets");
      return { worksheets: sheets, dbFormat: sheets.some((s) => s.plan.format === "gantt_csv") ? "gantt_csv" : "csv" };
    }
    case "ms_project_xml": {
      const plan = parseMsProjectXml(text(), { timezone: base.timezone, hoursPerDay: o.hoursPerDay });
      return { worksheets: [{ name: args.filename ?? "project", plan }], dbFormat: "ms_project_xml" };
    }
    case "prose": {
      if (!args.llm) throw badRequest("prose import is not configured (no LLM client / ANTHROPIC_API_KEY)");
      const plan = await parseProse(text(), {
        client: args.llm,
        timezone: base.timezone,
        context: o.context,
        defaultWorkstream: o.defaultWorkstream,
        knownTasks: current.tasks.map((t) => ({ ref: t.ref, name: t.name, workstreamName: t.workstreamId ? current.workstreamNameById[t.workstreamId] : undefined })),
      });
      return { worksheets: [{ name: args.filename ?? "prose", plan }], dbFormat: "prose_llm" };
    }
  }
}

function compileAgainst(current: LoadedRunbook, worksheets: ParsedPlan[], removalScope: ImportOptionsInput["removalScope"]): CompileResult {
  return compileWorksheets(
    worksheets,
    {
      event: current.input.event,
      tasks: current.input.tasks,
      dependencies: current.input.dependencies,
      gates: current.input.gates,
      workstreamNameById: current.workstreamNameById,
      ownerNameById: current.ownerNameById,
    },
    { removalScope },
  );
}

// ---------------------------------------------------------------------------
// Create (upload + stage)
// ---------------------------------------------------------------------------

export async function createImport(db: Db, args: CreateImportArgs): Promise<ReviewPayload> {
  const current = await loadRunbook(db, args.eventId);
  const { worksheets, dbFormat } = await parseUpload(args, current);
  // A prose note is never a complete statement of a workstream, so it proposes no removals.
  const removalScope = args.options?.removalScope ?? (args.format === "prose" ? "none" : "incoming_workstreams");
  const compiled = compileAgainst(current, worksheets.map((w) => w.plan), removalScope);
  const sheetOfTask = new Map<string, string>();
  const sheetOfDep = new Map<string, string>();
  for (const w of worksheets) {
    for (const t of w.plan.tasks) if (!sheetOfTask.has(t.ref)) sheetOfTask.set(t.ref, w.name);
    for (const d of w.plan.dependencies) sheetOfDep.set(`${d.predecessorRef} ${d.successorRef}`, w.name);
  }
  const diffKindOfTask = new Map<string, { kind: string; changes?: unknown[] }>();
  for (const t of compiled.diff.tasks.added) diffKindOfTask.set(t.ref, { kind: "add" });
  for (const c of compiled.diff.tasks.changed) diffKindOfTask.set(c.ref, { kind: "change", changes: c.fields });
  for (const r of compiled.diff.tasks.unchanged) diffKindOfTask.set(r, { kind: "unchanged" });
  const depKey = (p: string, s: string) => `${p} ${s}`;
  const diffKindOfDep = new Map<string, string>();
  for (const d of compiled.diff.dependencies.added) diffKindOfDep.set(depKey(d.predecessorRef, d.successorRef), "add");
  for (const d of compiled.diff.dependencies.changed) diffKindOfDep.set(depKey(d.after.predecessorRef, d.after.successorRef), "change");
  for (const d of compiled.diff.dependencies.unchanged) diffKindOfDep.set(depKey(d.predecessorRef, d.successorRef), "unchanged");

  return db.transaction(async (tx) => {
    const [batch] = await tx
      .insert(importBatch)
      .values({
        eventId: args.eventId,
        format: dbFormat,
        filename: args.filename ?? null,
        rawContent: args.encoding === "base64" ? null : args.content,
        status: "review",
        parserVersion: worksheets[0]?.plan.meta.parserVersion ?? null,
        parserModel: worksheets[0]?.plan.meta.model ?? null,
        options: (args.options ?? {}) as Record<string, unknown>,
        worksheets: worksheets.map((w) => w.name),
        issues: compiled.issues,
        summary: compiled.summary,
        createdById: args.userId,
      })
      .returning();
    const batchId = batch!.id;

    const taskRows: (typeof importCandidateTask.$inferInsert)[] = compiled.tasks.map((t) => {
      const dk = diffKindOfTask.get(t.ref) ?? { kind: "add" };
      return {
        batchId,
        ref: t.ref,
        name: t.name,
        description: t.description ?? null,
        workstreamName: t.workstreamName ?? null,
        ownerName: t.ownerName ?? null,
        plannedStart: toDate(t.plannedStart),
        plannedDurationMinutes: t.plannedDurationMinutes ?? null,
        windowDeadline: toDate(t.windowDeadline),
        customFields: t.customFields ?? null,
        matchedTaskId: current.taskIdByRef.get(t.ref) ?? null,
        diffKind: dk.kind,
        changes: dk.changes ?? null,
        evidence: t.evidence ?? null,
        sourceLine: t.sourceLine ?? null,
        worksheet: sheetOfTask.get(t.ref) ?? null,
      };
    });
    for (const r of compiled.diff.tasks.removed) {
      taskRows.push({
        batchId,
        ref: r.ref,
        name: r.name,
        workstreamName: r.workstreamId ?? null, // already a name (compile maps ids to names)
        plannedDurationMinutes: r.plannedDurationMinutes,
        plannedStart: toDate(r.plannedStart),
        windowDeadline: toDate(r.windowDeadline),
        matchedTaskId: current.taskIdByRef.get(r.ref) ?? null,
        diffKind: "remove",
        evidence: "Not present in the submitted worksheet for its workstream.",
      });
    }
    if (taskRows.length > 0) for (let i = 0; i < taskRows.length; i += 500) await tx.insert(importCandidateTask).values(taskRows.slice(i, i + 500));

    const depRows: (typeof importCandidateDependency.$inferInsert)[] = compiled.dependencies.map((d) => ({
      batchId,
      predecessorRef: d.predecessorRef,
      successorRef: d.successorRef,
      type: d.type,
      lagMinutes: d.lagMinutes,
      confidence: d.confidence !== undefined ? d.confidence.toFixed(2) : null,
      evidence: d.evidence ?? null,
      diffKind: d.resolution === "unresolved" ? "add" : (diffKindOfDep.get(depKey(d.predecessorRef, d.successorRef)) ?? "add"),
      resolution: d.resolution,
      sourceLine: d.sourceLine ?? null,
      worksheet: sheetOfDep.get(depKey(d.predecessorRef, d.successorRef)) ?? null,
    }));
    for (const d of compiled.diff.dependencies.removed) {
      depRows.push({ batchId, predecessorRef: d.predecessorRef, successorRef: d.successorRef, type: d.type, lagMinutes: d.lagMinutes, diffKind: "remove", resolution: "exact", evidence: "Not present in the submitted worksheet." });
    }
    if (depRows.length > 0) for (let i = 0; i < depRows.length; i += 500) await tx.insert(importCandidateDependency).values(depRows.slice(i, i + 500));

    await writeAudit(tx, { eventId: args.eventId, entityType: "import_batch", entityId: batchId, action: "import.uploaded", after: { format: dbFormat, filename: args.filename, worksheets: worksheets.map((w) => w.name), summary: compiled.summary }, actorId: args.userId });
    return getImportReview(tx, batchId);
  });
}

// ---------------------------------------------------------------------------
// Review
// ---------------------------------------------------------------------------

export async function getImportReview(db: Tx, batchId: string): Promise<ReviewPayload> {
  const batch = (await db.select().from(importBatch).where(eq(importBatch.id, batchId)).limit(1))[0];
  if (!batch) throw notFound("import");
  const [tasks, dependencies] = await Promise.all([
    db.select().from(importCandidateTask).where(eq(importCandidateTask.batchId, batchId)).orderBy(importCandidateTask.sourceLine, importCandidateTask.ref),
    db.select().from(importCandidateDependency).where(eq(importCandidateDependency.batchId, batchId)).orderBy(importCandidateDependency.sourceLine, importCandidateDependency.predecessorRef, importCandidateDependency.successorRef),
  ]);
  return { batch, tasks, dependencies, issues: batch.issues as ParseIssue[], summary: batch.summary };
}

export interface ReviewUpdate {
  tasks?: { id: string; reviewState: "proposed" | "accepted" | "rejected" | "edited"; edits?: Record<string, unknown>; note?: string }[];
  dependencies?: { id: string; reviewState: "proposed" | "accepted" | "rejected" | "edited"; edits?: Record<string, unknown>; note?: string }[];
  /** Convenience: set every still-proposed candidate to this state. */
  allProposed?: "accepted" | "rejected";
}

export async function reviewCandidates(db: Db, batchId: string, userId: string, update: ReviewUpdate): Promise<ReviewPayload> {
  const batch = (await db.select().from(importBatch).where(eq(importBatch.id, batchId)).limit(1))[0];
  if (!batch) throw notFound("import");
  if (batch.status !== "review") throw conflict(`import is ${batch.status}, not in review`);
  await db.transaction(async (tx) => {
    for (const t of update.tasks ?? []) {
      const res = await tx
        .update(importCandidateTask)
        .set({ reviewState: t.reviewState, edits: t.edits ?? null })
        .where(and(eq(importCandidateTask.id, t.id), eq(importCandidateTask.batchId, batchId)))
        .returning({ id: importCandidateTask.id });
      if (res.length === 0) throw notFound(`candidate task ${t.id}`);
    }
    for (const d of update.dependencies ?? []) {
      const res = await tx
        .update(importCandidateDependency)
        .set({ reviewState: d.reviewState, edits: d.edits ?? null, reviewerNote: d.note ?? null, reviewedById: userId, reviewedAt: new Date() })
        .where(and(eq(importCandidateDependency.id, d.id), eq(importCandidateDependency.batchId, batchId)))
        .returning({ id: importCandidateDependency.id });
      if (res.length === 0) throw notFound(`candidate dependency ${d.id}`);
    }
    if (update.allProposed) {
      await tx.update(importCandidateTask).set({ reviewState: update.allProposed }).where(and(eq(importCandidateTask.batchId, batchId), eq(importCandidateTask.reviewState, "proposed")));
      await tx
        .update(importCandidateDependency)
        .set({ reviewState: update.allProposed, reviewedById: userId, reviewedAt: new Date() })
        .where(and(eq(importCandidateDependency.batchId, batchId), eq(importCandidateDependency.reviewState, "proposed")));
    }
  });
  return getImportReview(db, batchId);
}

// ---------------------------------------------------------------------------
// Commit
// ---------------------------------------------------------------------------

export interface CommitArgs {
  batchId: string;
  userId: string;
  /** Treat still-proposed candidates as accepted. For LLM batches only dependencies at/above `minAutoAcceptConfidence` qualify. */
  acceptAllProposed?: boolean;
  minAutoAcceptConfidence?: number;
}

export interface CommitResult {
  batchId: string;
  scheduleRunId: string;
  tasksCreated: number;
  tasksUpdated: number;
  tasksDeleted: number;
  dependenciesCreated: number;
  dependenciesUpdated: number;
  dependenciesDeleted: number;
  workstreamsCreated: number;
  unmatchedOwners: string[];
  issues: ParseIssue[];
}

function applyTaskEdits(c: CandTaskRow): CandidateTask {
  const e = (c.edits ?? {}) as Partial<Record<string, unknown>>;
  const pick = <T>(k: string, fallback: T): T => (e[k] !== undefined ? (e[k] as T) : fallback);
  const t: CandidateTask = { ref: pick("ref", c.ref), name: pick("name", c.name) };
  const desc = pick<string | null>("description", c.description);
  if (desc) t.description = desc;
  const wsn = pick<string | null>("workstreamName", c.workstreamName);
  if (wsn) t.workstreamName = wsn;
  const own = pick<string | null>("ownerName", c.ownerName);
  if (own) t.ownerName = own;
  const ps = e["plannedStart"] !== undefined ? (e["plannedStart"] as number | null) : ms(c.plannedStart);
  if (ps !== null && ps !== undefined) t.plannedStart = ps;
  const dur = pick<number | null>("plannedDurationMinutes", c.plannedDurationMinutes);
  if (dur !== null && dur !== undefined) t.plannedDurationMinutes = dur;
  const dl = e["windowDeadline"] !== undefined ? (e["windowDeadline"] as number | null) : ms(c.windowDeadline);
  if (dl !== null && dl !== undefined) t.windowDeadline = dl;
  if (c.customFields) t.customFields = c.customFields;
  if (c.evidence) t.evidence = c.evidence;
  if (c.sourceLine !== null) t.sourceLine = c.sourceLine;
  return t;
}

function applyDepEdits(c: CandDepRow): CandidateDependency {
  const e = (c.edits ?? {}) as Partial<Record<string, unknown>>;
  const d: CandidateDependency = {
    predecessorRef: (e["predecessorRef"] as string | undefined) ?? c.predecessorRef,
    successorRef: (e["successorRef"] as string | undefined) ?? c.successorRef,
    type: ((e["type"] as DependencyType | undefined) ?? c.type) as DependencyType,
    lagMinutes: (e["lagMinutes"] as number | undefined) ?? c.lagMinutes,
  };
  if (c.confidence !== null) d.confidence = Number(c.confidence);
  if (c.evidence) d.evidence = c.evidence;
  if (c.sourceLine !== null) d.sourceLine = c.sourceLine;
  return d;
}

export async function commitImport(db: Db, args: CommitArgs): Promise<CommitResult> {
  const review = await getImportReview(db, args.batchId);
  const { batch } = review;
  if (batch.status !== "review") throw conflict(`import is ${batch.status}, not in review`);
  const isLlm = batch.format === "prose_llm";
  const minConf = args.minAutoAcceptConfidence ?? 0.9;

  const accepted = (state: string) => state === "accepted" || state === "edited";
  const taskAccepted = (c: CandTaskRow) => accepted(c.reviewState) || (c.reviewState === "proposed" && !!args.acceptAllProposed);
  const depAccepted = (c: CandDepRow) => accepted(c.reviewState) || (c.reviewState === "proposed" && !!args.acceptAllProposed && (!isLlm || (c.confidence !== null && Number(c.confidence) >= minConf)));

  if (isLlm && args.acceptAllProposed) {
    const needReview = review.dependencies.filter((c) => c.reviewState === "proposed" && !(c.confidence !== null && Number(c.confidence) >= minConf));
    if (needReview.length > 0) {
      throw conflict(
        `${needReview.length} LLM-parsed dependencies are below confidence ${minConf} and must be accepted or rejected individually`,
        needReview.map((c) => ({ id: c.id, predecessorRef: c.predecessorRef, successorRef: c.successorRef, confidence: c.confidence, evidence: c.evidence })),
      );
    }
  }

  const acceptedTasks = review.tasks.filter(taskAccepted);
  const acceptedDeps = review.dependencies.filter(depAccepted);
  const removeTaskRefs = new Set(acceptedTasks.filter((c) => c.diffKind === "remove").map((c) => c.ref));
  const removeDepKeys = new Set(acceptedDeps.filter((c) => c.diffKind === "remove").map((c) => `${c.predecessorRef} ${c.successorRef}`));
  const plan: ParsedPlan = {
    format: batch.format === "prose_llm" ? "prose_llm" : batch.format === "ms_project_xml" ? "ms_project_xml" : "csv",
    tasks: acceptedTasks.filter((c) => c.diffKind !== "remove").map(applyTaskEdits),
    dependencies: acceptedDeps.filter((c) => c.diffKind !== "remove").map(applyDepEdits),
    issues: [],
    meta: { parserVersion: batch.parserVersion ?? "unknown" },
  };

  const current = await loadRunbook(db, batch.eventId);
  // Removals first: a task that has started cannot be deleted by an import.
  const removedTaskRows = current.tasks.filter((t) => removeTaskRefs.has(t.ref));
  const started = removedTaskRows.filter((t) => t.status !== "not_started");
  if (started.length > 0) throw conflict(`cannot remove tasks that have started: ${started.map((t) => t.ref).join(", ")}`);
  const removedTaskIds = new Set(removedTaskRows.map((t) => t.id));
  const refOfId = new Map(current.tasks.map((t) => [t.id, t.ref] as const));
  const removedDepRows = current.dependencies.filter((d) => removedTaskIds.has(d.predecessorTaskId) || removedTaskIds.has(d.successorTaskId) || removeDepKeys.has(`${refOfId.get(d.predecessorTaskId)} ${refOfId.get(d.successorTaskId)}`));
  const removedDepIds = new Set(removedDepRows.map((d) => d.id));
  const trimmed: LoadedRunbook = {
    ...current,
    tasks: current.tasks.filter((t) => !removedTaskIds.has(t.id)),
    dependencies: current.dependencies.filter((d) => !removedDepIds.has(d.id)),
    input: {
      ...current.input,
      tasks: current.input.tasks.filter((t) => !removedTaskIds.has(t.id)),
      dependencies: current.input.dependencies.filter((d) => !removedTaskIds.has(d.predecessorId) && !removedTaskIds.has(d.successorId) && !removeDepKeys.has(`${refOfId.get(d.predecessorId)} ${refOfId.get(d.successorId)}`)),
      gates: current.input.gates.map((g) => ({ ...g, entryTaskIds: g.entryTaskIds.filter((id) => !removedTaskIds.has(id)), gatedTaskIds: g.gatedTaskIds.filter((id) => !removedTaskIds.has(id)) })),
    },
  };
  const compiled = compileAgainst(trimmed, [plan], "none");
  const errors = compiled.issues.filter((i) => i.severity === "error");
  if (errors.length > 0 || !compiled.preview.ok) throw conflict("import cannot be committed until its errors are resolved", { issues: errors, unresolved: compiled.unresolved });

  return db.transaction(async (tx) => {
    const eventId = batch.eventId;
    // Workstreams by name.
    const wsByName = new Map(current.workstreams.map((w) => [w.name.toLowerCase(), w.id] as const));
    let workstreamsCreated = 0;
    for (const name of new Set(plan.tasks.map((t) => t.workstreamName).filter((x): x is string => !!x))) {
      if (wsByName.has(name.toLowerCase())) continue;
      const [w] = await tx.insert(workstream).values({ eventId, name }).returning();
      wsByName.set(name.toLowerCase(), w!.id);
      workstreamsCreated++;
      await writeAudit(tx, { eventId, entityType: "workstream", entityId: w!.id, action: "workstream.created", after: { name }, actorId: args.userId });
    }
    // Owners by name/email.
    const userByKey = new Map<string, string>();
    for (const u of current.users) {
      userByKey.set(u.email.toLowerCase(), u.id);
      userByKey.set(u.name.toLowerCase(), u.id);
    }
    const unmatchedOwners = new Set<string>();
    const resolveOwner = (ownerName?: string): { ownerId: string | null; ownerHint: string | null } => {
      if (!ownerName) return { ownerId: null, ownerHint: null };
      for (const part of ownerName.split(/[,;/&]| and /i).map((s) => s.trim()).filter(Boolean)) {
        const id = userByKey.get(part.toLowerCase());
        if (id) return { ownerId: id, ownerHint: ownerName.includes(",") ? ownerName : null };
      }
      unmatchedOwners.add(ownerName);
      return { ownerId: null, ownerHint: ownerName };
    };

    // Deletions.
    let dependenciesDeleted = 0;
    if (removedDepIds.size > 0) {
      for (const d of removedDepRows) await writeAudit(tx, { eventId, entityType: "dependency", entityId: d.id, action: "dependency.deleted", before: snapshot(d), actorId: args.userId });
      await tx.delete(dependency).where(inArray(dependency.id, Array.from(removedDepIds)));
      dependenciesDeleted = removedDepIds.size;
    }
    let tasksDeleted = 0;
    if (removedTaskIds.size > 0) {
      for (const t of removedTaskRows) await writeAudit(tx, { eventId, entityType: "task", entityId: t.id, action: "task.deleted", before: snapshot(t), actorId: args.userId });
      await tx.delete(task).where(inArray(task.id, Array.from(removedTaskIds)));
      tasksDeleted = removedTaskIds.size;
    }

    // Task adds / changes.
    const candByRef = new Map(plan.tasks.map((t) => [t.ref, t] as const));
    const idByRef = new Map(trimmed.tasks.map((t) => [t.ref, t.id] as const));
    let tasksCreated = 0;
    let tasksUpdated = 0;
    const source = batch.format;
    const taskValues = (c: CandidateTask): Partial<typeof task.$inferInsert> => {
      const { ownerId, ownerHint } = resolveOwner(c.ownerName);
      return {
        name: c.name,
        description: c.description ?? null,
        workstreamId: c.workstreamName ? (wsByName.get(c.workstreamName.toLowerCase()) ?? null) : null,
        ownerId,
        ownerHint,
        plannedStart: toDate(c.plannedStart),
        plannedDurationMinutes: c.plannedDurationMinutes ?? 0,
        windowDeadline: toDate(c.windowDeadline),
        ...(c.customFields ? { customFields: c.customFields } : {}),
      };
    };
    for (const added of compiled.diff.tasks.added) {
      const c = candByRef.get(added.ref)!;
      const [row] = await tx
        .insert(task)
        .values({ eventId, ref: c.ref, ...taskValues(c), source, importBatchId: batch.id, updatedAt: new Date() } as typeof task.$inferInsert)
        .returning();
      idByRef.set(c.ref, row!.id);
      tasksCreated++;
      await writeAudit(tx, { eventId, entityType: "task", entityId: row!.id, action: "task.created", after: snapshot(row), actorId: args.userId });
      await tx.update(importCandidateTask).set({ matchedTaskId: row!.id }).where(and(eq(importCandidateTask.batchId, batch.id), eq(importCandidateTask.ref, c.ref)));
    }
    for (const ch of compiled.diff.tasks.changed) {
      const c = candByRef.get(ch.ref)!;
      const id = idByRef.get(ch.ref)!;
      const before = trimmed.tasks.find((t) => t.id === id);
      const vals = taskValues(c);
      // Only touch the fields the diff reported (plus owner hint bookkeeping); never live fields.
      const set: Partial<typeof task.$inferInsert> = { updatedAt: new Date(), importBatchId: batch.id };
      for (const f of ch.fields) {
        switch (f.field) {
          case "name": set.name = vals.name; break;
          case "workstreamId": set.workstreamId = vals.workstreamId; break;
          case "ownerId": set.ownerId = vals.ownerId; set.ownerHint = vals.ownerHint; break;
          case "plannedStart": set.plannedStart = vals.plannedStart; break;
          case "plannedDurationMinutes": set.plannedDurationMinutes = vals.plannedDurationMinutes; break;
          case "windowDeadline": set.windowDeadline = vals.windowDeadline; break;
          default: break;
        }
      }
      if (c.description !== undefined) set.description = c.description;
      if (c.customFields) set.customFields = { ...(before?.customFields ?? {}), ...c.customFields };
      const [row] = await tx.update(task).set(set).where(eq(task.id, id)).returning();
      tasksUpdated++;
      await writeAudit(tx, { eventId, entityType: "task", entityId: id, action: "task.updated", before: snapshot(before), after: snapshot(row), actorId: args.userId });
    }

    // Dependencies.
    let dependenciesCreated = 0;
    let dependenciesUpdated = 0;
    for (const d of compiled.diff.dependencies.added) {
      const p = idByRef.get(d.predecessorRef);
      const s = idByRef.get(d.successorRef);
      if (!p || !s) throw conflict(`dependency ${d.predecessorRef} → ${d.successorRef} references a task that was not committed`);
      const [row] = await tx.insert(dependency).values({ eventId, predecessorTaskId: p, successorTaskId: s, type: d.type, lagMinutes: d.lagMinutes, source, importBatchId: batch.id }).returning();
      dependenciesCreated++;
      await writeAudit(tx, { eventId, entityType: "dependency", entityId: row!.id, action: "dependency.created", after: { predecessorRef: d.predecessorRef, successorRef: d.successorRef, type: d.type, lagMinutes: d.lagMinutes }, actorId: args.userId });
    }
    for (const ch of compiled.diff.dependencies.changed) {
      const p = idByRef.get(ch.after.predecessorRef)!;
      const s = idByRef.get(ch.after.successorRef)!;
      const [row] = await tx
        .update(dependency)
        .set({ type: ch.after.type, lagMinutes: ch.after.lagMinutes, updatedAt: new Date(), importBatchId: batch.id })
        .where(and(eq(dependency.predecessorTaskId, p), eq(dependency.successorTaskId, s)))
        .returning();
      if (row) {
        dependenciesUpdated++;
        await writeAudit(tx, { eventId, entityType: "dependency", entityId: row.id, action: "dependency.updated", before: ch.before, after: ch.after, actorId: args.userId });
      }
    }

    // Batch bookkeeping, schedule recompute, audit.
    await tx.update(importBatch).set({ status: "committed", committedById: args.userId, committedAt: new Date(), updatedAt: new Date() }).where(eq(importBatch.id, batch.id));
    const after = await loadRunbook(tx, eventId);
    const live = after.event.status === "live";
    const schedule = scheduleFor(after.input, live ? "live" : "plan", Date.now());
    const runId = await persistScheduleRun(tx, { eventId, kind: live ? "live" : "baseline", schedule, trigger: { type: "import.committed", batchId: batch.id }, createdById: args.userId });
    const result: CommitResult = {
      batchId: batch.id,
      scheduleRunId: runId,
      tasksCreated,
      tasksUpdated,
      tasksDeleted,
      dependenciesCreated,
      dependenciesUpdated,
      dependenciesDeleted,
      workstreamsCreated,
      unmatchedOwners: Array.from(unmatchedOwners).sort(),
      issues: compiled.issues,
    };
    await writeAudit(tx, { eventId, entityType: "import_batch", entityId: batch.id, action: "import.committed", after: { ...result, issues: undefined }, actorId: args.userId, scheduleRunId: runId });
    return result;
  });
}

export async function discardImport(db: Db, batchId: string, userId: string): Promise<void> {
  const batch = (await db.select().from(importBatch).where(eq(importBatch.id, batchId)).limit(1))[0];
  if (!batch) throw notFound("import");
  if (batch.status === "committed") throw conflict("a committed import cannot be discarded");
  await db.transaction(async (tx) => {
    await tx.update(importBatch).set({ status: "discarded", updatedAt: new Date() }).where(eq(importBatch.id, batchId));
    await writeAudit(tx, { eventId: batch.eventId, entityType: "import_batch", entityId: batchId, action: "import.discarded", actorId: userId });
  });
}

export async function listImports(db: Db, eventId: string) {
  return db.select().from(importBatch).where(eq(importBatch.eventId, eventId)).orderBy(sql`${importBatch.createdAt} desc`);
}

export type { EngineTask };
