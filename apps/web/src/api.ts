/**
 * Thin typed client for @cutover/api. Development identity is an email stored in
 * localStorage and sent as `x-user-email` (see apps/api/src/auth.ts).
 */
import type { Change, GraphInput, ImpactReport, Schedule, TaskStatus } from "@cutover/engine";

const BASE: string = (import.meta.env.VITE_API_BASE as string | undefined) ?? "/api";
const IDENTITY_KEY = "cutover.identity";

export function getIdentity(): string {
  try {
    return localStorage.getItem(IDENTITY_KEY) ?? "";
  } catch {
    return "";
  }
}
export function setIdentity(email: string): void {
  try {
    localStorage.setItem(IDENTITY_KEY, email);
  } catch {
    /* ignore */
  }
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
  }
}

export async function api<T>(path: string, init: RequestInit & { json?: unknown } = {}): Promise<T> {
  const { json, ...rest } = init;
  const headers: Record<string, string> = { ...(rest.headers as Record<string, string> | undefined) };
  const who = getIdentity();
  if (who) headers["x-user-email"] = who;
  if (json !== undefined) headers["content-type"] = "application/json";
  const res = await fetch(`${BASE}${path}`, { ...rest, headers, body: json !== undefined ? JSON.stringify(json) : rest.body });
  if (res.status === 204) return undefined as T;
  const text = await res.text();
  let body: unknown = text;
  try {
    body = text ? JSON.parse(text) : undefined;
  } catch {
    /* keep text */
  }
  if (!res.ok) {
    const b = body as { error?: string; details?: unknown } | undefined;
    throw new ApiError(res.status, b?.error ?? `${res.status} ${res.statusText}`, b?.details);
  }
  return body as T;
}

// ---------------------------------------------------------------- shapes (mirrors the API rows)

export interface UserRow {
  id: string;
  name: string;
  email: string;
  role: "admin" | "builder" | "task_owner" | "command_center" | "auditor";
}
export interface EventRow {
  id: string;
  name: string;
  description: string | null;
  timezone: string;
  windowStart: string;
  windowEnd: string;
  status: "planning" | "live" | "closed";
  defaultBlockedRecoveryMinutes: number;
}
export interface TaskRow {
  id: string;
  eventId: string;
  ref: string;
  name: string;
  description: string | null;
  workstreamId: string | null;
  ownerId: string | null;
  ownerHint: string | null;
  plannedStart: string | null;
  plannedDurationMinutes: number;
  windowDeadline: string | null;
  status: TaskStatus;
  statusNote: string | null;
  actualStart: string | null;
  actualEnd: string | null;
  remainingDurationMinutes: number | null;
  expectedUnblockAt: string | null;
  customFields: Record<string, unknown>;
}
export interface DependencyRow {
  id: string;
  predecessorTaskId: string;
  successorTaskId: string;
  type: "FS" | "SS" | "FF" | "SF";
  lagMinutes: number;
}
export interface GateRow {
  id: string;
  name: string;
  description: string | null;
  approverId: string | null;
  targetDecisionAt: string | null;
  isPointOfNoReturn: boolean;
  decision: "pending" | "go" | "no_go";
  decidedAt: string | null;
  decisionNote: string | null;
  entryTaskIds: string[];
  gatedTaskIds: string[];
}
export interface WorkstreamRow {
  id: string;
  name: string;
  color: string | null;
}
export interface GraphPayload {
  event: EventRow;
  input: GraphInput;
  tasks: TaskRow[];
  dependencies: DependencyRow[];
  gates: GateRow[];
  workstreams: WorkstreamRow[];
  users: UserRow[];
}
export interface ImportBatch {
  id: string;
  eventId: string;
  format: string;
  filename: string | null;
  status: "uploaded" | "parsing" | "review" | "committed" | "discarded";
  worksheets: string[];
  summary: Record<string, number> | null;
  issues: ParseIssue[];
  createdAt: string;
  committedAt: string | null;
}
export interface ParseIssue {
  severity: "error" | "warning" | "info";
  code: string;
  message: string;
  line?: number;
  ref?: string;
}
export type ReviewState = "proposed" | "accepted" | "rejected" | "edited";
export interface CandidateTask {
  id: string;
  ref: string;
  name: string;
  workstreamName: string | null;
  ownerName: string | null;
  plannedStart: string | null;
  plannedDurationMinutes: number | null;
  windowDeadline: string | null;
  diffKind: "add" | "change" | "unchanged" | "remove";
  changes: { field: string; before: unknown; after: unknown }[] | null;
  reviewState: ReviewState;
  evidence: string | null;
  sourceLine: number | null;
  worksheet: string | null;
}
export interface CandidateDependency {
  id: string;
  predecessorRef: string;
  successorRef: string;
  type: "FS" | "SS" | "FF" | "SF";
  lagMinutes: number;
  confidence: string | null;
  evidence: string | null;
  diffKind: "add" | "change" | "unchanged" | "remove";
  resolution: "exact" | "loose" | "unresolved";
  reviewState: ReviewState;
  reviewerNote: string | null;
  sourceLine: number | null;
  worksheet: string | null;
}
export interface ReviewPayload {
  batch: ImportBatch;
  tasks: CandidateTask[];
  dependencies: CandidateDependency[];
  issues: ParseIssue[];
  summary: Record<string, number> | null;
}
export interface AuditEntry {
  id: number;
  entityType: string;
  entityId: string;
  action: string;
  before: Record<string, unknown> | null;
  after: Record<string, unknown> | null;
  actorId: string | null;
  scheduleRunId: string | null;
  occurredAt: string;
}

// ---------------------------------------------------------------- calls

export const me = () => api<UserRow>("/me");
export const listEvents = () => api<EventRow[]>("/events");
export const getGraph = (eventId: string) => api<GraphPayload>(`/events/${eventId}/graph`);
export const patchEvent = (eventId: string, body: Partial<Pick<EventRow, "status" | "name">>) => api<EventRow>(`/events/${eventId}`, { method: "PATCH", json: body });
export const getAudit = (eventId: string) => api<AuditEntry[]>(`/events/${eventId}/audit`);

export interface TaskPatch {
  status?: TaskStatus;
  statusNote?: string | null;
  actualStart?: number | null;
  actualEnd?: number | null;
  remainingDurationMinutes?: number | null;
  expectedUnblockAt?: number | null;
}
export interface LiveChangeResult {
  task?: TaskRow;
  gate?: GateRow;
  scheduleRunId: string;
  schedule: Schedule;
  impact: ImpactReport;
}
export const patchTask = (taskId: string, body: TaskPatch) => api<LiveChangeResult>(`/tasks/${taskId}`, { method: "PATCH", json: body });
export const decideGate = (gateId: string, decision: "pending" | "go" | "no_go", note?: string) => api<LiveChangeResult>(`/gates/${gateId}/decision`, { method: "POST", json: { decision, note } });
export const saveScenario = (eventId: string, changes: Change[], mode: "plan" | "live", asOf: number) =>
  api<{ scheduleRunId?: string; schedule: Schedule; impact: ImpactReport }>(`/events/${eventId}/simulate`, { method: "POST", json: { changes, mode, asOf, save: true } });

export const listImports = (eventId: string) => api<ImportBatch[]>(`/events/${eventId}/imports`);
export const getImport = (batchId: string) => api<ReviewPayload>(`/imports/${batchId}`);
export interface CreateImportBody {
  format: "csv" | "xlsx" | "ms_project_xml" | "prose";
  filename?: string;
  content: string;
  encoding?: "utf8" | "base64";
  options?: { timezone?: string; removalScope?: "incoming_workstreams" | "none" | "all"; defaultWorkstream?: string; context?: string; dateOrder?: "MDY" | "DMY" };
}
export const createImport = (eventId: string, body: CreateImportBody) => api<ReviewPayload>(`/events/${eventId}/imports`, { method: "POST", json: body });
export interface ReviewBody {
  tasks?: { id: string; reviewState: ReviewState }[];
  dependencies?: { id: string; reviewState: ReviewState; note?: string }[];
  allProposed?: "accepted" | "rejected";
}
export const reviewImport = (batchId: string, body: ReviewBody) => api<ReviewPayload>(`/imports/${batchId}/review`, { method: "POST", json: body });
export const commitImport = (batchId: string, acceptAllProposed: boolean) => api<Record<string, unknown>>(`/imports/${batchId}/commit`, { method: "POST", json: { acceptAllProposed } });
export const discardImport = (batchId: string) => api<void>(`/imports/${batchId}/discard`, { method: "POST" });
