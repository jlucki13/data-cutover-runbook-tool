import { auditLogEntry } from "@cutover/db";
import type { Tx } from "./runbook.js";

export interface AuditArgs {
  eventId: string;
  entityType: "event" | "task" | "dependency" | "gate" | "import_batch" | "workstream" | "event_column" | "schedule_run";
  entityId: string;
  action: string;
  before?: unknown;
  after?: unknown;
  actorId?: string | null;
  scheduleRunId?: string | null;
}

/** Append one audit entry. The table rejects UPDATE/DELETE at the database level. */
export async function writeAudit(db: Tx, a: AuditArgs): Promise<number> {
  const [row] = await db
    .insert(auditLogEntry)
    .values({
      eventId: a.eventId,
      entityType: a.entityType,
      entityId: a.entityId,
      action: a.action,
      before: (a.before ?? null) as Record<string, unknown> | null,
      after: (a.after ?? null) as Record<string, unknown> | null,
      actorId: a.actorId ?? null,
      scheduleRunId: a.scheduleRunId ?? null,
    })
    .returning({ id: auditLogEntry.id });
  return row!.id;
}

/** Plain-JSON snapshot of a row for before/after columns (Dates → ISO). */
export function snapshot<T extends object>(row: T | undefined | null, fields?: (keyof T)[]): Record<string, unknown> | undefined {
  if (!row) return undefined;
  const out: Record<string, unknown> = {};
  for (const k of (fields ?? (Object.keys(row) as (keyof T)[])) as string[]) {
    const v = (row as Record<string, unknown>)[k];
    out[k] = v instanceof Date ? v.toISOString() : v;
  }
  return out;
}
