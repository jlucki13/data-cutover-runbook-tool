/**
 * Integration-test harness: a dedicated Postgres database (TEST_DATABASE_URL, default
 * cutover_test on localhost) is wiped and migrated from scratch, then the Fastify app is
 * built against it. Tests exercise the real HTTP surface via `app.inject`.
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { schema, type Db } from "@cutover/db";
import type { LlmClient } from "@cutover/ingest";
import type { FastifyInstance, InjectOptions } from "fastify";
import { buildApp } from "../src/app.js";

const here = path.dirname(fileURLToPath(import.meta.url));
export const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL ?? "postgres://cutover:cutover@localhost:5432/cutover_test";

async function ensureDatabase(): Promise<void> {
  const u = new URL(TEST_DATABASE_URL);
  const dbName = u.pathname.slice(1);
  u.pathname = "/postgres";
  const admin = postgres(u.toString(), { max: 1 });
  try {
    const rows = await admin`select 1 from pg_database where datname = ${dbName}`;
    if (rows.length === 0) await admin.unsafe(`create database "${dbName}"`);
  } finally {
    await admin.end();
  }
}

export interface TestContext {
  app: FastifyInstance;
  db: Db;
  close: () => Promise<void>;
}

export async function freshApp(opts: { llm?: LlmClient } = {}): Promise<TestContext> {
  await ensureDatabase();
  const client = postgres(TEST_DATABASE_URL, { max: 5 });
  await client.unsafe("drop schema if exists drizzle cascade; drop schema public cascade; create schema public;");
  const db = drizzle(client, { schema });
  await migrate(db, { migrationsFolder: path.join(here, "../../../packages/db/drizzle") });
  const app = await buildApp({ db, llm: opts.llm });
  return {
    app,
    db,
    close: async () => {
      await app.close();
      await client.end();
    },
  };
}

export interface Actor {
  id: string;
  headers: Record<string, string>;
}

/** Bootstrap the first admin (no auth needed while the user table is empty), then create the rest. */
export async function seedUsers(app: FastifyInstance): Promise<Record<"admin" | "builder" | "priya" | "sam" | "cc" | "auditor", Actor>> {
  const mk = async (payload: Record<string, unknown>, as?: Actor): Promise<Actor> => {
    const res = await app.inject({ method: "POST", url: "/users", headers: as?.headers ?? {}, payload });
    if (res.statusCode !== 201) throw new Error(`seed user failed: ${res.statusCode} ${res.body}`);
    const id = res.json().id as string;
    return { id, headers: { "x-user-id": id } };
  };
  const admin = await mk({ name: "Jordan", email: "jordan@example.com", role: "admin" });
  const builder = await mk({ name: "Ops Lead", email: "ops@example.com", role: "builder" }, admin);
  const priya = await mk({ name: "Priya", email: "priya@example.com", role: "task_owner" }, admin);
  const sam = await mk({ name: "Sam", email: "sam@example.com", role: "task_owner" }, admin);
  const cc = await mk({ name: "Command Center", email: "cc@example.com", role: "command_center" }, admin);
  const auditor = await mk({ name: "Auditor", email: "audit@example.com", role: "auditor" }, admin);
  return { admin, builder, priya, sam, cc, auditor };
}

export async function call<T = any>(app: FastifyInstance, opts: InjectOptions & { as?: Actor; expect?: number }): Promise<{ status: number; body: T }> {
  const { as, expect, ...rest } = opts;
  const res = await app.inject({ ...rest, headers: { ...(as?.headers ?? {}), ...(rest.headers as Record<string, string> | undefined) } });
  const body = res.body ? (res.headers["content-type"]?.toString().includes("json") ? res.json() : res.body) : undefined;
  if (expect !== undefined && res.statusCode !== expect) throw new Error(`${rest.method} ${rest.url}: expected ${expect}, got ${res.statusCode}: ${res.body}`);
  return { status: res.statusCode, body: body as T };
}

export const T0 = Date.UTC(2026, 9, 16, 22);
export const at = (min: number) => T0 + min * 60_000;

export const TRBK_CSV = `Task ID,Task Name,Workstream,Owner,Planned Start (UTC),Duration (min),Depends On,Deadline
FRZ-1,Declare freeze on source system,Core,Ops Lead,2026-10-16 22:00,30,,
FRZ-2,Final source extract,Core,Ops Lead,,120,FRZ-1,
MIG-ACC,Migrate accounts,Accounts,Priya,,180,FRZ-2,
ACC-TMP,Temporary accounts check,Accounts,Priya,,15,MIG-ACC,
MIG-BAL,Migrate balances,Balances,Bala,,150,MIG-ACC,
MIG-STM,Migrate statements,Statements,Sam,,240,MIG-ACC,
MIG-NOT,Generate customer notices,Notices,Nia,,90,"MIG-BAL, MIG-STM",
REC-ACC,Reconcile accounts,Reconciliation,Recon Team,,60,MIG-ACC,
REC-BAL,Reconcile balances,Reconciliation,Recon Team,,90,MIG-BAL,2026-10-17 12:00
REC-STM,Reconcile statements,Reconciliation,Recon Team,,60,MIG-STM,
SWI-1,Switch routing to target platform,Core,Ops Lead,,60,,
SWI-2,Smoke test target platform,Core,Ops Lead,,45,SWI-1,
RBK-1,Rollback-eligible window monitoring,Core,Ops Lead,,240,SWI-2,
CLS-1,Close event and release comms,Core,Ops Lead,,30,,
`;

export async function createEvent(app: FastifyInstance, as: Actor): Promise<string> {
  const r = await call(app, { method: "POST", url: "/events", as, expect: 201, payload: { name: "TRBK Cutover", windowStart: new Date(T0).toISOString(), windowEnd: new Date(at(32 * 60)).toISOString() } });
  return r.body.id as string;
}
