/**
 * Seed a rehearsal event whose window straddles *now*, so live mode has something real to
 * show: work already done, work in flight, a blocked task with an assumed recovery, two
 * pending gates and a deadline within reach. The plan seed (`seed.ts`) is a future-dated
 * event for exercising planning; this one is for exercising the command centre.
 *
 *   DATABASE_URL=... pnpm --filter @cutover/api seed:live
 *
 * Times are computed from the clock at seed time, so re-seeding a stale database gives a
 * fresh, current picture. Idempotent by event name: pass SEED_LIVE_NAME to make another.
 */
import { eq } from "drizzle-orm";
import { appUser, createDb, event, task } from "@cutover/db";
import { buildApp } from "./app.js";

const NAME = process.env.SEED_LIVE_NAME ?? "Meridian Rehearsal";
const db = createDb();
const app = await buildApp({ db });

const existing = await db.select().from(event).where(eq(event.name, NAME)).limit(1);
if (existing.length > 0) {
  console.log(`"${NAME}" already seeded: ${existing[0]!.id} (set SEED_LIVE_NAME to seed another)`);
  process.exit(0);
}

const MIN = 60_000;
const HOUR = 60 * MIN;
const now = Date.now();
/** Anchor the runbook five hours back, on the hour, so the picture is legible. */
const t0 = Math.floor((now - 5 * HOUR) / HOUR) * HOUR;
const at = (minutesFromT0: number) => t0 + minutesFromT0 * MIN;
// Shape of the rehearsal: a window with real slack, a gate the blocked task threatens, and
// a later gate already breached — enough to read at a glance and still leave room to push
// it over the edge from the Simulate tab. Override to make a harder or easier picture.
const WINDOW_HOURS = Number(process.env.WINDOW_HOURS ?? 20);
const GATE1_H = Number(process.env.GATE1_H ?? 13);
const GATE2_H = Number(process.env.GATE2_H ?? 18);
const stamp = (ms: number) => new Date(ms).toISOString().slice(0, 16).replace("T", " ");

const admins = await db.select().from(appUser).where(eq(appUser.role, "admin")).limit(1);
const adminId = admins[0]?.id;
if (!adminId) {
  console.error("no admin user: run `pnpm --filter @cutover/api seed` first");
  process.exit(1);
}
const H = { "x-user-id": adminId };
const users = Object.fromEntries((await db.select().from(appUser)).map((u) => [u.name, u.id] as const));

const post = async (url: string, payload: unknown, ok = 201) => {
  const res = await app.inject({ method: "POST", url, headers: H, payload: payload as object });
  if (res.statusCode !== ok) throw new Error(`POST ${url} -> ${res.statusCode}: ${res.body}`);
  return res.json();
};
const patch = async (url: string, payload: unknown) => {
  const res = await app.inject({ method: "PATCH", url, headers: H, payload: payload as object });
  if (res.statusCode !== 200) throw new Error(`PATCH ${url} -> ${res.statusCode}: ${res.body}`);
  return res.json();
};

const ev = await post("/events", {
  name: NAME,
  description: "Rehearsal window around the current time — for exercising live mode",
  timezone: "UTC",
  windowStart: new Date(t0).toISOString(),
  windowEnd: new Date(t0 + WINDOW_HOURS * HOUR).toISOString(),
});
console.log("event", ev.id, `${stamp(t0)} → ${stamp(t0 + WINDOW_HOURS * HOUR)} UTC`);

// The runbook arrives the way a real one does: as a worksheet through the import pipeline,
// so the audit trail and the import history are genuine rather than fabricated rows.
const rows: string[][] = [
  ["FRZ-1", "Declare freeze on source system", "Core", "Ops Lead", stamp(at(0)), "30", "", ""],
  ["FRZ-2", "Final source extract", "Core", "Ops Lead", "", "120", "FRZ-1", ""],
  ["MIG-ACC", "Migrate accounts", "Accounts", "Priya", "", "180", "FRZ-2", ""],
  ["MIG-BAL", "Migrate balances", "Balances", "Bala", "", "150", "MIG-ACC", ""],
  ["MIG-STM", "Migrate statements", "Statements", "Sam", "", "240", "MIG-ACC", ""],
  ["MIG-NOT", "Generate customer notices", "Notices", "Nia", "", "90", "MIG-BAL, MIG-STM", ""],
  ["REC-ACC", "Reconcile accounts", "Reconciliation", "Recon Team", "", "60", "MIG-ACC", ""],
  ["REC-BAL", "Reconcile balances", "Reconciliation", "Recon Team", "", "90", "MIG-BAL", stamp(at(11 * 60))],
  ["REC-STM", "Reconcile statements", "Reconciliation", "Recon Team", "", "60", "MIG-STM", ""],
  ["SWI-1", "Switch routing to target platform", "Core", "Ops Lead", "", "60", "", ""],
  ["SWI-2", "Smoke test target platform", "Core", "Ops Lead", "", "45", "SWI-1", ""],
  ["RBK-1", "Rollback-eligible window monitoring", "Core", "Ops Lead", "", "240", "SWI-2", ""],
  ["CLS-1", "Close event and release comms", "Core", "Ops Lead", "", "30", "", ""],
];
const header = ["Task ID", "Task Name", "Workstream", "Owner", "Planned Start (UTC)", "Duration (min)", "Depends On", "Deadline"];
const csv = [header, ...rows].map((r) => r.map((c) => (c.includes(",") ? `"${c}"` : c)).join(",")).join("\n");
const imp = await post(`/events/${ev.id}/imports`, { format: "csv", filename: "rehearsal.csv", content: csv });
console.log("import committed", await post(`/imports/${imp.batch.id}/commit`, { acceptAllProposed: true }, 200));

for (const g of [
  {
    name: "Go/No-Go: switch to target",
    entryTaskRefs: ["REC-ACC", "REC-BAL", "REC-STM", "MIG-NOT"],
    gatedTaskRefs: ["SWI-1"],
    targetDecisionAt: at(GATE1_H * 60),
    isPointOfNoReturn: true,
    approverId: users["Command Center"],
  },
  { name: "Rollback window closed", entryTaskRefs: ["RBK-1"], gatedTaskRefs: ["CLS-1"], targetDecisionAt: at(GATE2_H * 60), approverId: users["Command Center"] },
]) {
  console.log("gate", (await post(`/events/${ev.id}/gates`, g)).name);
}
await post(`/events/${ev.id}/schedule/baseline`, {}, 201);

// The history first, while the event is still in planning: each status lands in the audit
// log and drives a real recompute, but nobody is paged for work that already happened.
const idOf = Object.fromEntries((await db.select().from(task).where(eq(task.eventId, ev.id))).map((t) => [t.ref, t.id] as const));
const updates: [string, Record<string, unknown>][] = [
  ["FRZ-1", { status: "complete", actualStart: at(0), actualEnd: at(35) }],
  ["FRZ-2", { status: "complete", actualStart: at(35), actualEnd: at(170) }],
  // Ran 40 minutes long: enough to eat float without breaching anything by itself.
  ["MIG-ACC", { status: "complete", actualStart: at(170), actualEnd: now - 30 * MIN }],
  ["MIG-BAL", { status: "in_progress", actualStart: now - 25 * MIN, remainingDurationMinutes: 120 }],
  ["MIG-STM", { status: "blocked", statusNote: "source extract short ~400k rows; vendor re-running", expectedUnblockAt: now + 90 * MIN }],
];
for (const [ref, body] of updates) {
  await patch(`/tasks/${idOf[ref]}`, body);
  console.log(`${ref} → ${body.status}`);
}

// Now go live: one evaluation against the state as it stands, the way an event actually starts.
await patch(`/events/${ev.id}`, { status: "live" });
const notes = await post(`/events/${ev.id}/notifications/evaluate`, {}, 200);
console.log("notifications:", notes);
console.log(`\nOpen the web app, pick "${NAME}", and start on the Dashboard.`);
await app.close();
process.exit(0);
