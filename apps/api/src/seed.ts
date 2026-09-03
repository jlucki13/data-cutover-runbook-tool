/**
 * Seed a development database with the TRBK-style mock cutover:
 * users, the event, the runbook (via the import pipeline, so the audit trail is real),
 * and the two gates. Idempotent-ish: skips if an event named "TRBK Cutover" exists.
 *
 *   DATABASE_URL=postgres://cutover:cutover@localhost:5432/cutover pnpm --filter @cutover/api seed
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { eq } from "drizzle-orm";
import { appUser, createDb, event } from "@cutover/db";
import { buildApp } from "./app.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const db = createDb();
const app = await buildApp({ db });

const existing = await db.select().from(event).where(eq(event.name, "TRBK Cutover")).limit(1);
if (existing.length > 0) {
  console.log("TRBK Cutover already seeded:", existing[0]!.id);
  process.exit(0);
}

async function ensureUser(name: string, email: string, role: string, adminId?: string): Promise<string> {
  const found = await db.select().from(appUser).where(eq(appUser.email, email)).limit(1);
  if (found[0]) return found[0].id;
  const res = await app.inject({ method: "POST", url: "/users", headers: adminId ? { "x-user-id": adminId } : {}, payload: { name, email, role } });
  if (res.statusCode !== 201) throw new Error(`create user ${email}: ${res.body}`);
  return res.json().id as string;
}

const admin = await ensureUser("Jordan", "jordan@example.com", "admin");
const users: Record<string, string> = {};
for (const [name, email, role] of [
  ["Ops Lead", "ops@example.com", "builder"],
  ["Priya", "priya@example.com", "task_owner"],
  ["Bala", "bala@example.com", "task_owner"],
  ["Sam", "sam@example.com", "task_owner"],
  ["Nia", "nia@example.com", "task_owner"],
  ["Recon Team", "recon@example.com", "task_owner"],
  ["Command Center", "cc@example.com", "command_center"],
  ["Auditor", "audit@example.com", "auditor"],
] as const) {
  users[name] = await ensureUser(name, email, role, admin);
}

const H = { "x-user-id": admin };
const evRes = await app.inject({
  method: "POST",
  url: "/events",
  headers: H,
  payload: { name: "TRBK Cutover", description: "Mock core conversion weekend", timezone: "UTC", windowStart: "2026-10-16T22:00:00Z", windowEnd: "2026-10-18T06:00:00Z" },
});
const ev = evRes.json();
console.log("event", ev.id);

const csv = readFileSync(path.join(here, "../seed/trbk.csv"), "utf8");
const imp = await app.inject({ method: "POST", url: `/events/${ev.id}/imports`, headers: H, payload: { format: "csv", filename: "trbk.csv", content: csv } });
if (imp.statusCode !== 201) throw new Error(imp.body);
const batch = imp.json().batch;
const commit = await app.inject({ method: "POST", url: `/imports/${batch.id}/commit`, headers: H, payload: { acceptAllProposed: true } });
if (commit.statusCode !== 200) throw new Error(commit.body);
console.log("import committed", commit.json());

for (const g of [
  { name: "Go/No-Go: switch to target", entryTaskRefs: ["REC-ACC", "REC-BAL", "REC-STM", "MIG-NOT"], gatedTaskRefs: ["SWI-1"], targetDecisionAt: Date.parse("2026-10-17T14:00:00Z"), isPointOfNoReturn: true, approverId: users["Command Center"] },
  { name: "Rollback window closed", entryTaskRefs: ["RBK-1"], gatedTaskRefs: ["CLS-1"], targetDecisionAt: Date.parse("2026-10-17T22:00:00Z"), approverId: users["Command Center"] },
]) {
  const r = await app.inject({ method: "POST", url: `/events/${ev.id}/gates`, headers: H, payload: g });
  if (r.statusCode !== 201) throw new Error(r.body);
  console.log("gate", r.json().name);
}
const base = await app.inject({ method: "POST", url: `/events/${ev.id}/schedule/baseline`, headers: H });
console.log("baseline run", base.json().scheduleRunId, "critical path", base.json().schedule.criticalPath);
await app.close();
process.exit(0);
