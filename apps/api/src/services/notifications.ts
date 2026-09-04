/**
 * Notification outbox: evaluate the deterministic rules against a schedule, enqueue one
 * row per (notice, recipient, channel), and deliver through pluggable channels.
 *
 * Deduplication is a unique index on (event, dedupe_key, recipient, channel): the rules
 * package emits a stable key per "fact in this state", so re-evaluating an unchanged
 * event inserts nothing and a materially worse state notifies again.
 */
import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";
import { appUser, notification, type Db } from "@cutover/db";
import { buildGraph, type Schedule } from "@cutover/engine";
import { evaluateNotifications, render, type Channel, type DirectoryGate, type DirectoryTask, type Notification, type NotifyInput } from "@cutover/notify";
import { notFound } from "../errors.js";
import { loadRunbook, type Tx } from "./runbook.js";

export type NotificationRow = typeof notification.$inferSelect;

export interface DeliveryResult {
  ok: boolean;
  error?: string;
}

/** A delivery channel. `slack` and `email` are wired from env; `log` is the always-available default. */
export interface Channels {
  email?: (to: { name: string; email: string }, subject: string, body: string) => Promise<DeliveryResult>;
  slack?: (to: { name: string; slackUserId?: string | null }, subject: string, body: string) => Promise<DeliveryResult>;
  log?: (to: { name: string; email: string }, subject: string, body: string) => Promise<DeliveryResult>;
}

/**
 * Default channels. Email uses SMTP when SMTP_URL is set; Slack posts to an incoming
 * webhook when SLACK_WEBHOOK_URL is set (reusing the existing connector rather than
 * building an integration). Anything unconfigured falls back to `log`, so a deployment
 * without credentials still records exactly what it would have sent.
 */
export function defaultChannels(env: NodeJS.ProcessEnv = process.env): Channels {
  const channels: Channels = {
    log: async (to, subject, body) => {
      // eslint-disable-next-line no-console
      console.log(`[notify:log] → ${to.name} <${to.email}>: ${subject}\n${body}\n`);
      return { ok: true };
    },
  };
  if (env.SLACK_WEBHOOK_URL) {
    const url = env.SLACK_WEBHOOK_URL;
    channels.slack = async (to, _subject, body) => {
      try {
        const res = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text: to.slackUserId ? `<@${to.slackUserId}> ${body}` : body }) });
        return res.ok ? { ok: true } : { ok: false, error: `slack webhook ${res.status}` };
      } catch (e) {
        return { ok: false, error: (e as Error).message };
      }
    };
  }
  if (env.SMTP_URL) {
    const smtpUrl = env.SMTP_URL;
    const from = env.SMTP_FROM ?? "cutover@localhost";
    channels.email = async (to, subject, body) => {
      try {
        // Imported lazily so a deployment without email does not need the dependency loaded.
        const { createTransport } = await import("nodemailer");
        const transport = createTransport(smtpUrl);
        await transport.sendMail({ from, to: to.email, subject, text: body });
        return { ok: true };
      } catch (e) {
        return { ok: false, error: (e as Error).message };
      }
    };
  }
  return channels;
}

/** Channels a recipient can actually be reached on, given what is configured. */
export function channelsFor(user: { email: string; slackUserId: string | null }, available: Channels): Channel[] | ["log"] {
  const out: Channel[] = [];
  if (available.email && user.email) out.push("email");
  if (available.slack && user.slackUserId) out.push("slack");
  return out.length > 0 ? out : (["log"] as ["log"]);
}

export interface EnqueueArgs {
  eventId: string;
  schedule: Schedule;
  before?: Schedule;
  scheduleRunId?: string;
  channels?: Channels;
  asOf?: number;
}

export interface EnqueueResult {
  evaluated: number;
  enqueued: number;
  suppressed: number;
  notifications: Notification[];
}

/** Evaluate the rules and insert anything not already queued or sent. */
export async function enqueueNotifications(db: Tx, args: EnqueueArgs): Promise<EnqueueResult> {
  const rb = await loadRunbook(db, args.eventId);
  const built = buildGraph(rb.input);
  if (!built.ok) return { evaluated: 0, enqueued: 0, suppressed: 0, notifications: [] };
  const available = args.channels ?? defaultChannels();
  const asOf = args.asOf ?? args.schedule.asOf;

  const tasks: DirectoryTask[] = rb.tasks.map((t) => ({
    id: t.id,
    ref: t.ref,
    name: t.name,
    ownerId: t.ownerId ?? undefined,
    ownerName: t.ownerId ? rb.ownerNameById[t.ownerId] : (t.ownerHint ?? undefined),
    workstreamName: t.workstreamId ? rb.workstreamNameById[t.workstreamId] : undefined,
    status: t.status,
    windowDeadline: t.windowDeadline?.getTime(),
    statusNote: t.statusNote ?? undefined,
  }));
  const gates: DirectoryGate[] = rb.gates.map((g) => ({
    id: g.id,
    name: g.name,
    approverId: g.approverId ?? undefined,
    approverName: g.approverId ? rb.ownerNameById[g.approverId] : undefined,
    targetDecisionAt: g.targetDecisionAt?.getTime(),
    isPointOfNoReturn: g.isPointOfNoReturn,
    decision: g.decision,
    decidedAt: g.decidedAt?.getTime(),
    decidedByName: g.decidedById ? rb.ownerNameById[g.decidedById] : undefined,
  }));
  const commandCentreUserIds = rb.users.filter((u) => u.isActive && (u.role === "command_center" || u.role === "admin")).map((u) => u.id);

  const input: NotifyInput = {
    event: { id: rb.event.id, name: rb.event.name, timezone: rb.event.timezone, windowEnd: rb.event.windowEnd.getTime(), status: rb.event.status },
    tasks,
    gates,
    schedule: args.schedule,
    before: args.before,
    commandCentreUserIds,
    asOf,
  };
  const candidates = evaluateNotifications(built.graph, input);
  const userById = new Map(rb.users.map((u) => [u.id, u] as const));

  const rows: (typeof notification.$inferInsert)[] = [];
  for (const n of candidates) {
    for (const r of n.recipients) {
      const u = userById.get(r.userId);
      if (!u || !u.isActive) continue;
      for (const channel of channelsFor(u, available)) {
        rows.push({
          eventId: args.eventId,
          kind: n.kind,
          severity: n.severity,
          entityType: n.entityType,
          entityId: n.entityType === "event" ? null : n.entityId,
          title: n.title,
          body: n.body,
          facts: n.facts,
          dedupeKey: n.dedupeKey,
          recipientUserId: r.userId,
          recipientReason: r.reason,
          channel,
          scheduleRunId: args.scheduleRunId ?? null,
        });
      }
    }
  }
  let enqueued = 0;
  for (let i = 0; i < rows.length; i += 200) {
    const chunk = rows.slice(i, i + 200);
    const inserted = await db.insert(notification).values(chunk).onConflictDoNothing().returning({ id: notification.id });
    enqueued += inserted.length;
  }
  return { evaluated: candidates.length, enqueued, suppressed: rows.length - enqueued, notifications: candidates };
}

export interface DispatchResult {
  attempted: number;
  sent: number;
  failed: number;
}

/** Deliver pending notifications. Safe to call repeatedly; failures keep their attempt count. */
export async function dispatchNotifications(db: Db, eventId: string, opts: { channels?: Channels; limit?: number; baseUrl?: string } = {}): Promise<DispatchResult> {
  const available = opts.channels ?? defaultChannels();
  const rb = await loadRunbook(db, eventId);
  const pending = await db
    .select()
    .from(notification)
    .where(and(eq(notification.eventId, eventId), eq(notification.status, "pending")))
    .orderBy(asc(notification.createdAt))
    .limit(opts.limit ?? 200);
  const userById = new Map(rb.users.map((u) => [u.id, u] as const));
  let sent = 0;
  let failed = 0;
  for (const row of pending) {
    const u = row.recipientUserId ? userById.get(row.recipientUserId) : undefined;
    if (!u) {
      await db.update(notification).set({ status: "suppressed", lastError: "recipient not found" }).where(eq(notification.id, row.id));
      continue;
    }
    const link = opts.baseUrl ? `${opts.baseUrl.replace(/\/$/, "")}/events/${eventId}` : undefined;
    const msg = render(
      { kind: row.kind as Notification["kind"], severity: row.severity, entityType: row.entityType as Notification["entityType"], entityId: row.entityId ?? eventId, title: row.title, body: row.body, facts: row.facts, recipients: [], dedupeKey: row.dedupeKey },
      row.channel === "log" ? "email" : row.channel,
      { eventName: rb.event.name, ...(link ? { link } : {}) },
    );
    const send = row.channel === "slack" ? available.slack : row.channel === "email" ? available.email : available.log;
    const result: DeliveryResult = send ? await send({ name: u.name, email: u.email, slackUserId: u.slackUserId } as never, msg.subject, msg.body) : { ok: false, error: `channel ${row.channel} is not configured` };
    if (result.ok) {
      sent++;
      await db.update(notification).set({ status: "sent", sentAt: new Date(), subject: msg.subject, renderedBody: msg.body, attempts: row.attempts + 1, lastError: null }).where(eq(notification.id, row.id));
    } else {
      failed++;
      await db.update(notification).set({ status: "failed", subject: msg.subject, renderedBody: msg.body, attempts: row.attempts + 1, lastError: result.error ?? "unknown error" }).where(eq(notification.id, row.id));
    }
  }
  return { attempted: pending.length, sent, failed };
}

export async function listNotifications(db: Db, eventId: string, opts: { status?: string; limit?: number } = {}) {
  const where = opts.status ? and(eq(notification.eventId, eventId), eq(notification.status, opts.status as "pending")) : eq(notification.eventId, eventId);
  return db.select().from(notification).where(where).orderBy(desc(notification.createdAt)).limit(opts.limit ?? 200);
}

export async function retryNotifications(db: Db, ids: string[]): Promise<number> {
  if (ids.length === 0) return 0;
  const rows = await db.update(notification).set({ status: "pending", lastError: null }).where(and(inArray(notification.id, ids), eq(notification.status, "failed"))).returning({ id: notification.id });
  return rows.length;
}

export async function notificationCounts(db: Db, eventId: string): Promise<Record<string, number>> {
  const rows = await db
    .select({ status: notification.status, n: sql<number>`count(*)::int` })
    .from(notification)
    .where(eq(notification.eventId, eventId))
    .groupBy(notification.status);
  const out: Record<string, number> = { pending: 0, sent: 0, failed: 0, suppressed: 0 };
  for (const r of rows) out[r.status] = r.n;
  return out;
}

export async function requireEvent(db: Db, eventId: string): Promise<void> {
  const rows = await db.select({ id: appUser.id }).from(appUser).limit(1);
  void rows;
  const rb = await loadRunbook(db, eventId).catch(() => undefined);
  if (!rb) throw notFound("event");
}
