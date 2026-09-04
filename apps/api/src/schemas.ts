import { z } from "zod";

export const uuid = z.uuid();
export const idParam = z.object({ id: uuid });

export const roleSchema = z.enum(["admin", "builder", "task_owner", "command_center", "auditor"]);

export const createUserBody = z.object({
  name: z.string().min(1),
  email: z.email(),
  role: roleSchema.default("task_owner"),
  slackUserId: z.string().optional(),
});

export const createEventBody = z.object({
  name: z.string().min(1),
  description: z.string().optional(),
  timezone: z.string().default("UTC"),
  windowStart: z.coerce.date(),
  windowEnd: z.coerce.date(),
  defaultBlockedRecoveryMinutes: z.number().int().min(0).default(30),
});

export const updateEventBody = createEventBody.partial().extend({ status: z.enum(["planning", "live", "closed"]).optional() });

export const columnBody = z.object({
  key: z.string().regex(/^[a-z][a-z0-9_]{0,63}$/),
  builtinKey: z.string().nullable().optional(),
  label: z.string().min(1),
  dataType: z.enum(["text", "number", "boolean", "date", "datetime", "duration_minutes", "select", "user"]).default("text"),
  config: z.record(z.string(), z.unknown()).default({}),
  position: z.number().int().default(0),
  isVisible: z.boolean().default(true),
  isRequired: z.boolean().default(false),
});
export const columnPatchBody = columnBody.partial();

export const createImportBody = z.object({
  format: z.enum(["csv", "xlsx", "ms_project_xml", "prose"]),
  filename: z.string().optional(),
  content: z.string().min(1),
  encoding: z.enum(["utf8", "base64"]).default("utf8"),
  options: z
    .object({
      timezone: z.string().optional(),
      dateOrder: z.enum(["MDY", "DMY"]).optional(),
      hoursPerDay: z.number().positive().optional(),
      sheets: z.array(z.string()).optional(),
      defaultWorkstream: z.string().optional(),
      removalScope: z.enum(["incoming_workstreams", "none", "all"]).optional(),
      context: z.string().optional(),
      columns: z.record(z.string(), z.string()).optional(),
    })
    .optional(),
});

const reviewState = z.enum(["proposed", "accepted", "rejected", "edited"]);
export const reviewBody = z.object({
  tasks: z.array(z.object({ id: uuid, reviewState, edits: z.record(z.string(), z.unknown()).optional(), note: z.string().optional() })).optional(),
  dependencies: z.array(z.object({ id: uuid, reviewState, edits: z.record(z.string(), z.unknown()).optional(), note: z.string().optional() })).optional(),
  allProposed: z.enum(["accepted", "rejected"]).optional(),
});

export const commitBody = z.object({
  acceptAllProposed: z.boolean().default(false),
  minAutoAcceptConfidence: z.number().min(0).max(1).optional(),
});

const taskStatus = z.enum(["not_started", "in_progress", "blocked", "complete", "failed", "skipped"]);
const epochMs = z.number().int();

export const taskPatchBody = z.object({
  status: taskStatus.optional(),
  statusNote: z.string().nullable().optional(),
  actualStart: epochMs.nullable().optional(),
  actualEnd: epochMs.nullable().optional(),
  remainingDurationMinutes: z.number().int().min(0).nullable().optional(),
  expectedUnblockAt: epochMs.nullable().optional(),
  plannedStart: epochMs.nullable().optional(),
  plannedDurationMinutes: z.number().int().min(0).optional(),
  windowDeadline: epochMs.nullable().optional(),
  name: z.string().min(1).optional(),
  ownerId: uuid.nullable().optional(),
  workstreamId: uuid.nullable().optional(),
  customFields: z.record(z.string(), z.unknown()).optional(),
});

export const createGateBody = z.object({
  name: z.string().min(1),
  description: z.string().optional(),
  approverId: uuid.optional(),
  targetDecisionAt: epochMs.optional(),
  isPointOfNoReturn: z.boolean().default(false),
  entryTaskRefs: z.array(z.string()).default([]),
  gatedTaskRefs: z.array(z.string()).default([]),
});

export const gateDecisionBody = z.object({
  decision: z.enum(["pending", "go", "no_go"]),
  note: z.string().optional(),
});

const depType = z.enum(["FS", "SS", "FF", "SF"]);
export const changeSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("set_planned_start"), taskId: z.string(), plannedStart: epochMs.optional() }),
  z.object({ kind: z.literal("set_duration"), taskId: z.string(), plannedDurationMinutes: z.number().int().min(0) }),
  z.object({ kind: z.literal("set_deadline"), taskId: z.string(), windowDeadline: epochMs.optional() }),
  z.object({ kind: z.literal("delay"), taskId: z.string(), minutes: z.number().int() }),
  z.object({ kind: z.literal("set_status"), taskId: z.string(), status: taskStatus, at: epochMs, remainingDurationMinutes: z.number().int().min(0).optional(), expectedUnblockAt: epochMs.optional() }),
  z.object({ kind: z.literal("set_expected_unblock"), taskId: z.string(), expectedUnblockAt: epochMs.optional() }),
  z.object({ kind: z.literal("set_gate_decision"), gateId: z.string(), decision: z.enum(["pending", "go", "no_go"]), at: epochMs }),
  z.object({ kind: z.literal("add_dependency"), dependency: z.object({ predecessorId: z.string(), successorId: z.string(), type: depType, lagMinutes: z.number().int() }) }),
  z.object({ kind: z.literal("remove_dependency"), predecessorId: z.string(), successorId: z.string() }),
]);

export const simulateBody = z.object({
  changes: z.array(changeSchema),
  mode: z.enum(["plan", "live"]).optional(),
  asOf: epochMs.optional(),
  save: z.boolean().default(false),
});

export const scheduleQuery = z.object({ mode: z.enum(["plan", "live"]).optional(), asOf: z.coerce.number().int().optional() });

export const notificationQuery = z.object({ status: z.enum(["pending", "sent", "failed", "suppressed"]).optional(), limit: z.coerce.number().int().min(1).max(500).optional() });
export const dispatchBody = z.object({ limit: z.number().int().min(1).max(500).optional() });
export const retryBody = z.object({ ids: z.array(uuid).min(1) });
export const summaryQuery = z.object({ asOf: z.coerce.number().int().optional() });
export const commsBody = z.object({ audience: z.string().min(1).default("workstream leads and the programme sponsor") });
export const reportQuery = z.object({ format: z.enum(["json", "audit.csv", "tasks.csv"]).default("json") });
