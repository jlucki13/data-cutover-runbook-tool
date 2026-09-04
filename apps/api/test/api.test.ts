import { afterAll, beforeAll, describe, expect, it } from "vitest";
import ExcelJS from "exceljs";
import type { LlmClient } from "@cutover/ingest";
import { TRBK_CSV, at, call, createEvent, freshApp, seedUsers, type Actor, type TestContext } from "./helpers.js";
import { buildApp } from "../src/app.js";

let ctx: TestContext;
let users: Awaited<ReturnType<typeof seedUsers>>;
let eventId: string;
const taskIdByRef = new Map<string, string>();
const gateIdByName = new Map<string, string>();

let lastSummaryPrompt = "";
const fakeLlm: LlmClient = {
  async extract(req) {
    if ((req.schema as { properties?: Record<string, unknown> }).properties?.headline) {
      lastSummaryPrompt = req.user;
      return { model: "fake", raw: { headline: "Statements migration is the constraint.", summary: "Two tasks are blocked.", watchItems: [{ what: "MIG-STM", why: "Blocked and on the deciding chain." }] } };
    }
    return {
      model: "fake",
      raw: {
        tasks: [{ ref: "NOT-2", name: "Send regulator notice", workstream: "Notices", durationMinutes: 20, evidence: "NOT-2 sends the regulator notice" }],
        dependencies: [
          { predecessorRef: "MIG-NOT", successorRef: "NOT-2", type: "FS", lagMinutes: 0, confidence: 0.95, evidence: "NOT-2 sends the regulator notice once MIG-NOT has generated the customer notices" },
          { predecessorRef: "REC-STM", successorRef: "NOT-2", type: "FS", lagMinutes: 0, confidence: 0.55, evidence: "probably after statements are reconciled" },
        ],
        notes: [],
      },
    };
  },
};

/** Captures what the outbox actually delivered. */
const sent: { subject: string; body: string; to: string }[] = [];
const captureChannels = {
  email: async (to: { name: string; email: string }, subject: string, body: string) => {
    sent.push({ subject, body, to: to.email });
    return { ok: true };
  },
};

beforeAll(async () => {
  ctx = await freshApp({ llm: fakeLlm, channels: captureChannels });
  users = await seedUsers(ctx.app);
});
afterAll(async () => {
  await ctx.close();
});

async function refreshTaskIds() {
  const { body } = await call(ctx.app, { method: "GET", url: `/events/${eventId}/tasks`, as: users.auditor, expect: 200 });
  taskIdByRef.clear();
  for (const t of body) taskIdByRef.set(t.ref, t.id);
  return body as any[];
}

describe("users and auth", () => {
  it("bootstraps the first user as admin and requires an admin afterwards", async () => {
    const me = await call(ctx.app, { method: "GET", url: "/me", as: users.admin, expect: 200 });
    expect(me.body.role).toBe("admin");
    const anon = await call(ctx.app, { method: "POST", url: "/users", payload: { name: "X", email: "x@example.com" } });
    expect(anon.status).toBe(400);
    const asBuilder = await call(ctx.app, { method: "POST", url: "/users", as: users.builder, payload: { name: "X", email: "x@example.com" } });
    expect(asBuilder.status).toBe(409);
    const noAuth = await call(ctx.app, { method: "GET", url: "/events" });
    expect(noAuth.status).toBe(401);
  });

  it("resolves users by email header too", async () => {
    const r = await call(ctx.app, { method: "GET", url: "/me", headers: { "x-user-email": "PRIYA@example.com" }, expect: 200 });
    expect(r.body.name).toBe("Priya");
  });
});

describe("events", () => {
  it("builders create events; auditors cannot", async () => {
    const denied = await call(ctx.app, { method: "POST", url: "/events", as: users.auditor, payload: { name: "x", windowStart: new Date(at(0)).toISOString(), windowEnd: new Date(at(60)).toISOString() } });
    expect(denied.status).toBe(403);
    const bad = await call(ctx.app, { method: "POST", url: "/events", as: users.builder, payload: { name: "x", windowStart: new Date(at(60)).toISOString(), windowEnd: new Date(at(0)).toISOString() } });
    expect(bad.status).toBe(400);
    eventId = await createEvent(ctx.app, users.builder);
    const ev = await call(ctx.app, { method: "GET", url: `/events/${eventId}`, as: users.auditor, expect: 200 });
    expect(ev.body.status).toBe("planning");
  });
});

describe("import → review → commit", () => {
  let batchId: string;

  it("stages a CSV upload as candidates with a compile summary", async () => {
    const r = await call(ctx.app, { method: "POST", url: `/events/${eventId}/imports`, as: users.builder, expect: 201, payload: { format: "csv", filename: "trbk.csv", content: TRBK_CSV } });
    batchId = r.body.batch.id;
    expect(r.body.batch.status).toBe("review");
    expect(r.body.tasks).toHaveLength(14);
    expect(r.body.tasks.every((t: any) => t.diffKind === "add" && t.reviewState === "proposed")).toBe(true);
    expect(r.body.dependencies).toHaveLength(12);
    expect(r.body.summary).toMatchObject({ tasksAdded: 14, dependenciesAdded: 12, errors: 0 });
    expect(r.body.issues.filter((i: any) => i.severity === "error")).toEqual([]);
    const listed = await call(ctx.app, { method: "GET", url: `/events/${eventId}/imports`, as: users.auditor, expect: 200 });
    expect(listed.body).toHaveLength(1);
  });

  it("auditors cannot commit; nothing reaches the graph before commit", async () => {
    const denied = await call(ctx.app, { method: "POST", url: `/imports/${batchId}/commit`, as: users.auditor, payload: {} });
    expect(denied.status).toBe(403);
    const tasks = await call(ctx.app, { method: "GET", url: `/events/${eventId}/tasks`, as: users.auditor, expect: 200 });
    expect(tasks.body).toEqual([]);
  });

  it("commits accepted candidates, resolves owners, creates workstreams, computes a baseline", async () => {
    const r = await call(ctx.app, { method: "POST", url: `/imports/${batchId}/commit`, as: users.builder, expect: 200, payload: { acceptAllProposed: true } });
    expect(r.body).toMatchObject({ tasksCreated: 14, tasksUpdated: 0, tasksDeleted: 0, dependenciesCreated: 12, workstreamsCreated: 6 });
    expect(r.body.unmatchedOwners).toEqual(["Bala", "Nia", "Recon Team"]);
    const tasks = await refreshTaskIds();
    const mig = tasks.find((t) => t.ref === "MIG-ACC");
    expect(mig.ownerId).toBe(users.priya.id);
    expect(mig.ownerHint).toBeNull();
    const bal = tasks.find((t) => t.ref === "MIG-BAL");
    expect(bal.ownerId).toBeNull();
    expect(bal.ownerHint).toBe("Bala");
    expect(tasks.find((t) => t.ref === "REC-BAL").windowDeadline).toBe(new Date(at(14 * 60)).toISOString());
    const runs = await call(ctx.app, { method: "GET", url: `/events/${eventId}/schedule/runs`, as: users.auditor, expect: 200 });
    expect(runs.body.map((x: any) => x.kind)).toEqual(["baseline"]);
    const review = await call(ctx.app, { method: "GET", url: `/imports/${batchId}`, as: users.auditor, expect: 200 });
    expect(review.body.batch.status).toBe("committed");
    expect(review.body.tasks.every((t: any) => t.matchedTaskId)).toBe(true);
    // The batch is a record of what was decided: candidates committed under acceptAllProposed
    // are stored as accepted, not left looking un-reviewed.
    expect(review.body.tasks.every((t: any) => t.reviewState === "accepted")).toBe(true);
    expect(review.body.dependencies.every((d: any) => d.reviewState === "accepted")).toBe(true);
    expect(review.body.dependencies.every((d: any) => d.reviewedById === users.builder.id)).toBe(true);
    const again = await call(ctx.app, { method: "POST", url: `/imports/${batchId}/commit`, as: users.builder, payload: { acceptAllProposed: true } });
    expect(again.status).toBe(409);
  });

  it("a re-submitted worksheet diffs against the committed graph and only accepted changes apply", async () => {
    const accounts = `id,task,workstream,owner,duration,depends on
MIG-ACC,Migrate accounts,Accounts,Priya,200,FRZ-2
ACC-VAL,Validate account counts,Accounts,Priya,30,MIG-ACC
`;
    const r = await call(ctx.app, { method: "POST", url: `/events/${eventId}/imports`, as: users.builder, expect: 201, payload: { format: "csv", filename: "accounts-v2.csv", content: accounts } });
    const kinds = Object.fromEntries(r.body.tasks.map((t: any) => [t.ref, t.diffKind]));
    expect(kinds).toEqual({ "MIG-ACC": "change", "ACC-VAL": "add", "ACC-TMP": "remove" });
    const changed = r.body.tasks.find((t: any) => t.ref === "MIG-ACC");
    expect(changed.changes).toEqual([{ field: "plannedDurationMinutes", before: 180, after: 200 }]);
    const depKinds = Object.fromEntries(r.body.dependencies.map((d: any) => [`${d.predecessorRef}>${d.successorRef}`, d.diffKind]));
    expect(depKinds).toEqual({ "FRZ-2>MIG-ACC": "unchanged", "MIG-ACC>ACC-VAL": "add", "MIG-ACC>ACC-TMP": "remove" });

    // Reject the removal of ACC-TMP (and its dependency), accept everything else.
    const removal = r.body.tasks.find((t: any) => t.ref === "ACC-TMP");
    const removalDep = r.body.dependencies.find((d: any) => d.successorRef === "ACC-TMP");
    await call(ctx.app, {
      method: "POST",
      url: `/imports/${r.body.batch.id}/review`,
      as: users.builder,
      expect: 200,
      payload: { tasks: [{ id: removal.id, reviewState: "rejected" }], dependencies: [{ id: removalDep.id, reviewState: "rejected", note: "still needed" }], allProposed: "accepted" },
    });
    const c = await call(ctx.app, { method: "POST", url: `/imports/${r.body.batch.id}/commit`, as: users.builder, expect: 200, payload: {} });
    expect(c.body).toMatchObject({ tasksCreated: 1, tasksUpdated: 1, tasksDeleted: 0, dependenciesCreated: 1, dependenciesDeleted: 0 });
    const after = await call(ctx.app, { method: "GET", url: `/imports/${r.body.batch.id}`, as: users.auditor, expect: 200 });
    expect(after.body.tasks.find((t: any) => t.ref === "ACC-TMP").reviewState).toBe("rejected");
    expect(after.body.dependencies.find((d: any) => d.successorRef === "ACC-TMP").reviewState).toBe("rejected");
    const tasks = await refreshTaskIds();
    expect(tasks.find((t) => t.ref === "MIG-ACC").plannedDurationMinutes).toBe(200);
    expect(tasks.find((t) => t.ref === "ACC-TMP")).toBeDefined();
    expect(tasks.find((t) => t.ref === "ACC-VAL")).toBeDefined();
  });

  it("an accepted removal deletes the task and its edges", async () => {
    const accounts = `id,task,workstream,owner,duration,depends on\nMIG-ACC,Migrate accounts,Accounts,Priya,200,FRZ-2\nACC-VAL,Validate account counts,Accounts,Priya,30,MIG-ACC\n`;
    const r = await call(ctx.app, { method: "POST", url: `/events/${eventId}/imports`, as: users.builder, expect: 201, payload: { format: "csv", content: accounts } });
    const c = await call(ctx.app, { method: "POST", url: `/imports/${r.body.batch.id}/commit`, as: users.builder, expect: 200, payload: { acceptAllProposed: true } });
    expect(c.body).toMatchObject({ tasksDeleted: 1, dependenciesDeleted: 1 });
    const tasks = await refreshTaskIds();
    expect(tasks.find((t) => t.ref === "ACC-TMP")).toBeUndefined();
  });

  it("refuses to commit an import that would create a cycle or leaves refs unresolved", async () => {
    const cyc = await call(ctx.app, { method: "POST", url: `/events/${eventId}/imports`, as: users.builder, expect: 201, payload: { format: "csv", content: `id,task,workstream,duration,depends on\nFRZ-1,Declare freeze on source system,Core,30,MIG-STM\n`, options: { removalScope: "none" } } });
    expect(cyc.body.issues.some((i: any) => i.code === "cycle")).toBe(true);
    const c = await call(ctx.app, { method: "POST", url: `/imports/${cyc.body.batch.id}/commit`, as: users.builder, payload: { acceptAllProposed: true } });
    expect(c.status).toBe(409);
    await call(ctx.app, { method: "POST", url: `/imports/${cyc.body.batch.id}/discard`, as: users.builder, expect: 204 });

    const unresolved = await call(ctx.app, { method: "POST", url: `/events/${eventId}/imports`, as: users.builder, expect: 201, payload: { format: "csv", content: `id,task,workstream,duration,depends on\nX-1,New thing,Extra,30,NOPE-9\n` } });
    expect(unresolved.body.dependencies[0]).toMatchObject({ resolution: "unresolved" });
    const c2 = await call(ctx.app, { method: "POST", url: `/imports/${unresolved.body.batch.id}/commit`, as: users.builder, payload: { acceptAllProposed: true } });
    expect(c2.status).toBe(409);
    expect(c2.body.details.unresolved[0].ref).toBe("NOPE-9");
    // Rejecting the bad dependency lets the task through.
    await call(ctx.app, { method: "POST", url: `/imports/${unresolved.body.batch.id}/review`, as: users.builder, expect: 200, payload: { dependencies: [{ id: unresolved.body.dependencies[0].id, reviewState: "rejected" }] } });
    const c3 = await call(ctx.app, { method: "POST", url: `/imports/${unresolved.body.batch.id}/commit`, as: users.builder, expect: 200, payload: { acceptAllProposed: true } });
    expect(c3.body).toMatchObject({ tasksCreated: 1, dependenciesCreated: 0 });
  });

  it("imports an Excel workbook with one sheet per workstream", async () => {
    const wb = new ExcelJS.Workbook();
    const s = wb.addWorksheet("Extra");
    s.addRow(["ID", "Task", "Duration (min)", "Depends On"]);
    s.addRow(["X-2", "Second extra thing", 45, "X-1"]);
    const c2 = wb.addWorksheet("Comms");
    c2.addRow(["ID", "Task", "Duration (min)", "Depends On"]);
    c2.addRow(["COM-1", "Customer comms go out", 15, "CLS-1"]);
    const content = Buffer.from(await wb.xlsx.writeBuffer()).toString("base64");
    const r = await call(ctx.app, { method: "POST", url: `/events/${eventId}/imports`, as: users.builder, expect: 201, payload: { format: "xlsx", filename: "extra.xlsx", content, encoding: "base64" } });
    expect(r.body.batch.worksheets).toEqual(["Extra", "Comms"]);
    expect(r.body.tasks.find((t: any) => t.ref === "COM-1")).toMatchObject({ diffKind: "add", workstreamName: "Comms", worksheet: "Comms" });
    expect(r.body.tasks.find((t: any) => t.ref === "X-2")).toMatchObject({ diffKind: "add", workstreamName: "Extra", worksheet: "Extra" });
    // X-1 was committed earlier under "Extra" and this sheet no longer lists it: proposed for removal, which we reject.
    const x1 = r.body.tasks.find((t: any) => t.ref === "X-1");
    expect(x1.diffKind).toBe("remove");
    await call(ctx.app, { method: "POST", url: `/imports/${r.body.batch.id}/review`, as: users.builder, expect: 200, payload: { tasks: [{ id: x1.id, reviewState: "rejected" }] } });
    const c = await call(ctx.app, { method: "POST", url: `/imports/${r.body.batch.id}/commit`, as: users.builder, expect: 200, payload: { acceptAllProposed: true } });
    expect(c.body).toMatchObject({ tasksCreated: 2, tasksDeleted: 0, dependenciesCreated: 2, workstreamsCreated: 1 });
  });

  it("LLM-parsed dependencies below the confidence bar must be reviewed individually", async () => {
    const r = await call(ctx.app, { method: "POST", url: `/events/${eventId}/imports`, as: users.builder, expect: 201, payload: { format: "prose", content: "NOT-2 sends the regulator notice once MIG-NOT has generated the customer notices, probably after statements are reconciled." } });
    expect(r.body.batch.format).toBe("prose_llm");
    expect(r.body.tasks.filter((t: any) => t.diffKind === "remove")).toEqual([]); // prose never proposes removals
    expect(r.body.dependencies.map((d: any) => [d.predecessorRef, d.confidence])).toEqual([
      ["MIG-NOT", "0.95"],
      ["REC-STM", "0.55"],
    ]);
    const blocked = await call(ctx.app, { method: "POST", url: `/imports/${r.body.batch.id}/commit`, as: users.builder, payload: { acceptAllProposed: true } });
    expect(blocked.status).toBe(409);
    expect(blocked.body.details).toHaveLength(1);
    expect(blocked.body.details[0].predecessorRef).toBe("REC-STM");
    const low = r.body.dependencies.find((d: any) => d.predecessorRef === "REC-STM");
    await call(ctx.app, { method: "POST", url: `/imports/${r.body.batch.id}/review`, as: users.builder, expect: 200, payload: { dependencies: [{ id: low.id, reviewState: "rejected", note: "not a real dependency" }] } });
    const ok = await call(ctx.app, { method: "POST", url: `/imports/${r.body.batch.id}/commit`, as: users.builder, expect: 200, payload: { acceptAllProposed: true } });
    expect(ok.body).toMatchObject({ tasksCreated: 1, dependenciesCreated: 1 });
    await refreshTaskIds();
  });
});

describe("gates, schedule and simulation", () => {
  it("creates gates by task ref and rejects gate cycles", async () => {
    const g1 = await call(ctx.app, {
      method: "POST",
      url: `/events/${eventId}/gates`,
      as: users.builder,
      expect: 201,
      payload: { name: "Go/No-Go: switch", entryTaskRefs: ["REC-ACC", "REC-BAL", "REC-STM", "MIG-NOT"], gatedTaskRefs: ["SWI-1"], targetDecisionAt: at(16 * 60), isPointOfNoReturn: true, approverId: users.cc.id },
    });
    gateIdByName.set("G1", g1.body.id);
    const g2 = await call(ctx.app, { method: "POST", url: `/events/${eventId}/gates`, as: users.builder, expect: 201, payload: { name: "Rollback window closed", entryTaskRefs: ["RBK-1"], gatedTaskRefs: ["CLS-1"], targetDecisionAt: at(24 * 60) } });
    gateIdByName.set("G2", g2.body.id);
    const bad = await call(ctx.app, { method: "POST", url: `/events/${eventId}/gates`, as: users.builder, payload: { name: "Loop", entryTaskRefs: ["SWI-2"], gatedTaskRefs: ["FRZ-1"] } });
    expect(bad.status).toBe(409);
    const gates = await call(ctx.app, { method: "GET", url: `/events/${eventId}/gates`, as: users.auditor, expect: 200 });
    expect(gates.body.map((g: any) => g.name)).toEqual(["Go/No-Go: switch", "Rollback window closed"]);
    expect(gates.body[0].entryTaskIds).toHaveLength(4);
  });

  it("serves the plan schedule and a baseline run", async () => {
    const s = await call(ctx.app, { method: "GET", url: `/events/${eventId}/schedule`, as: users.auditor, expect: 200 });
    expect(s.body.mode).toBe("plan");
    const swi = s.body.schedule.tasks[taskIdByRef.get("SWI-1")!];
    expect(swi.earlyStart).toBe(at(16 * 60)); // waits for the gate's target time
    expect(s.body.schedule.gates[gateIdByName.get("G1")!].status).toBe("ok");
    const b = await call(ctx.app, { method: "POST", url: `/events/${eventId}/schedule/baseline`, as: users.builder, expect: 201 });
    const run = await call(ctx.app, { method: "GET", url: `/schedule-runs/${b.body.scheduleRunId}`, as: users.auditor, expect: 200 });
    expect(run.body.run.kind).toBe("baseline");
    expect(run.body.results.length).toBeGreaterThan(10);
  });

  it("simulates a what-if without side effects, and can save a scenario", async () => {
    const before = (await call(ctx.app, { method: "GET", url: `/events/${eventId}/schedule/runs`, as: users.auditor, expect: 200 })).body.length;
    const r = await call(ctx.app, { method: "POST", url: `/events/${eventId}/simulate`, as: users.cc, expect: 200, payload: { changes: [{ kind: "delay", taskId: taskIdByRef.get("MIG-STM"), minutes: 360 }] } });
    expect(r.body.impact.gates.find((g: any) => g.gateId === gateIdByName.get("G1"))).toMatchObject({ before: "ok", after: "breached" });
    expect(r.body.impact.ownersToNotify.find((o: any) => o.ownerId === users.sam.id).taskIds).toEqual([taskIdByRef.get("MIG-STM")]);
    expect(r.body.impact.unownedAffectedTaskIds.length).toBeGreaterThan(0); // Nia / Recon Team are unmatched owners
    expect(r.body.scheduleRunId).toBeUndefined();
    const after = (await call(ctx.app, { method: "GET", url: `/events/${eventId}/schedule/runs`, as: users.auditor, expect: 200 })).body.length;
    expect(after).toBe(before);
    const saved = await call(ctx.app, { method: "POST", url: `/events/${eventId}/simulate`, as: users.builder, expect: 200, payload: { changes: [{ kind: "delay", taskId: taskIdByRef.get("MIG-STM"), minutes: 360 }], save: true } });
    expect(saved.body.scheduleRunId).toBeDefined();
    const cyc = await call(ctx.app, { method: "POST", url: `/events/${eventId}/simulate`, as: users.builder, payload: { changes: [{ kind: "add_dependency", dependency: { predecessorId: taskIdByRef.get("CLS-1"), successorId: taskIdByRef.get("FRZ-1"), type: "FS", lagMinutes: 0 } }] } });
    expect(cyc.status).toBe(409);
  });
});

describe("live execution", () => {
  it("task owners update their own tasks; the change is audited and produces a live run with impact", async () => {
    await call(ctx.app, { method: "PATCH", url: `/events/${eventId}`, as: users.cc, expect: 200, payload: { status: "live" } });
    const other = await call(ctx.app, { method: "PATCH", url: `/tasks/${taskIdByRef.get("MIG-STM")}`, as: users.priya, payload: { status: "in_progress" } });
    expect(other.status).toBe(409);
    const plan = await call(ctx.app, { method: "PATCH", url: `/tasks/${taskIdByRef.get("MIG-ACC")}`, as: users.priya, payload: { plannedDurationMinutes: 10 } });
    expect(plan.status).toBe(409);

    const r = await call(ctx.app, { method: "PATCH", url: `/tasks/${taskIdByRef.get("MIG-ACC")}`, as: users.priya, expect: 200, payload: { status: "in_progress", actualStart: at(150) } });
    expect(r.body.task).toMatchObject({ status: "in_progress", actualStart: new Date(at(150)).toISOString() });
    expect(r.body.schedule.mode).toBe("live");
    expect(r.body.scheduleRunId).toBeDefined();
    const blocked = await call(ctx.app, { method: "PATCH", url: `/tasks/${taskIdByRef.get("MIG-ACC")}`, as: users.priya, expect: 200, payload: { status: "blocked", statusNote: "waiting on DBA", remainingDurationMinutes: 90 } });
    expect(blocked.body.schedule.tasks[taskIdByRef.get("MIG-ACC")!].assumption.kind).toBe("blocked_recovery");
    expect(blocked.body.impact.ownersToNotify.length).toBeGreaterThan(0);
    const latest = await call(ctx.app, { method: "GET", url: `/events/${eventId}/impact/latest`, as: users.auditor, expect: 200 });
    expect(latest.body.run.id).toBe(blocked.body.scheduleRunId);

    const audit = await call(ctx.app, { method: "GET", url: `/events/${eventId}/audit`, as: users.auditor, expect: 200 });
    const statusChanges = audit.body.filter((a: any) => a.action === "task.status_changed");
    expect(statusChanges).toHaveLength(2);
    expect(statusChanges[1]).toMatchObject({ actorId: users.priya.id, scheduleRunId: blocked.body.scheduleRunId });
    expect(statusChanges[1].before.status).toBe("in_progress");
    expect(statusChanges[1].after.status).toBe("blocked");
  });

  it("gate decisions are restricted to the approver, audited, and hold downstream work on no-go", async () => {
    const denied = await call(ctx.app, { method: "POST", url: `/gates/${gateIdByName.get("G1")}/decision`, as: users.builder, payload: { decision: "no_go" } });
    expect(denied.status).toBe(409);
    const r = await call(ctx.app, { method: "POST", url: `/gates/${gateIdByName.get("G1")}/decision`, as: users.cc, expect: 200, payload: { decision: "no_go", note: "balances not reconciled" } });
    expect(r.body.gate.decision).toBe("no_go");
    expect(r.body.schedule.heldTaskIds.map((id: string) => [...taskIdByRef.entries()].find(([, v]) => v === id)![0])).toEqual(["SWI-1", "SWI-2", "RBK-1", "CLS-1", "COM-1"]);
    const go = await call(ctx.app, { method: "POST", url: `/gates/${gateIdByName.get("G1")}/decision`, as: users.admin, expect: 200, payload: { decision: "go" } });
    expect(go.body.schedule.heldTaskIds).toEqual([]);
    expect(go.body.impact.affectedTasks.filter((a: any) => a.released)).toHaveLength(5);
    const audit = await call(ctx.app, { method: "GET", url: `/events/${eventId}/audit`, as: users.auditor, expect: 200 });
    expect(audit.body.filter((a: any) => a.action === "gate.decided")).toHaveLength(2);
  });

  it("admins manage runbook columns; others can only read them", async () => {
    const denied = await call(ctx.app, { method: "POST", url: `/events/${eventId}/columns`, as: users.builder, payload: { key: "recon_query", label: "Recon query" } });
    expect(denied.status).toBe(403);
    const col = await call(ctx.app, { method: "POST", url: `/events/${eventId}/columns`, as: users.admin, expect: 201, payload: { key: "recon_query", label: "Recon query", dataType: "text" } });
    const renamed = await call(ctx.app, { method: "PATCH", url: `/columns/${col.body.id}`, as: users.admin, expect: 200, payload: { label: "Reconciliation query" } });
    expect(renamed.body.label).toBe("Reconciliation query");
    const list = await call(ctx.app, { method: "GET", url: `/events/${eventId}/columns`, as: users.priya, expect: 200 });
    expect(list.body).toHaveLength(1);
    const dup = await call(ctx.app, { method: "POST", url: `/events/${eventId}/columns`, as: users.admin, payload: { key: "recon_query", label: "again" } });
    expect(dup.status).toBe(409);
    await call(ctx.app, { method: "DELETE", url: `/columns/${col.body.id}`, as: users.admin, expect: 204 });
  });
});

describe("notifications", () => {
  it("stays silent while an event is still in planning, and speaks once it goes live", async () => {
    // A plan under construction is full of work that is "late" against a distant window.
    // Paging owners about it would train them to ignore the channel before the event starts.
    const planId = (await call(ctx.app, { method: "POST", url: "/events", as: users.builder, expect: 201, payload: { name: "Quiet Planning Event", windowStart: new Date(at(0)).toISOString(), windowEnd: new Date(at(32 * 60)).toISOString() } })).body.id;
    const imp = await call(ctx.app, { method: "POST", url: `/events/${planId}/imports`, as: users.builder, expect: 201, payload: { format: "csv", filename: "trbk.csv", content: TRBK_CSV } });
    await call(ctx.app, { method: "POST", url: `/imports/${imp.body.batch.id}/commit`, as: users.builder, expect: 200, payload: { acceptAllProposed: true } });
    const planTasks = (await call(ctx.app, { method: "GET", url: `/events/${planId}/tasks`, as: users.auditor, expect: 200 })).body as any[];
    const migAcc = planTasks.find((t) => t.ref === "MIG-ACC").id;

    const quiet = await call(ctx.app, { method: "PATCH", url: `/tasks/${migAcc}`, as: users.builder, expect: 200, payload: { status: "blocked", statusNote: "vendor is late" } });
    expect(quiet.body.notificationsQueued).toBe(0);
    expect(quiet.body.scheduleRunId).toBeDefined(); // still audited and still recomputed
    const evaluated = await call(ctx.app, { method: "POST", url: `/events/${planId}/notifications/evaluate`, as: users.builder, expect: 200, payload: {} });
    expect(evaluated.body).toMatchObject({ evaluated: 0, enqueued: 0 });
    expect((await call(ctx.app, { method: "GET", url: `/events/${planId}/notifications`, as: users.auditor, expect: 200 })).body.notifications).toHaveLength(0);

    await call(ctx.app, { method: "PATCH", url: `/events/${planId}`, as: users.cc, expect: 200, payload: { status: "live" } });
    const live = await call(ctx.app, { method: "POST", url: `/events/${planId}/notifications/evaluate`, as: users.cc, expect: 200, payload: {} });
    expect(live.body.enqueued).toBeGreaterThan(0);
    const kinds = new Set((await call(ctx.app, { method: "GET", url: `/events/${planId}/notifications`, as: users.auditor, expect: 200 })).body.notifications.map((n: any) => n.kind));
    expect(kinds.has("task_blocked")).toBe(true); // the same fact that was silent a moment ago
  });

  it("queues notices for the owner and the command centre, and suppresses an unchanged repeat", async () => {
    sent.length = 0;
    const r = await call(ctx.app, { method: "PATCH", url: `/tasks/${taskIdByRef.get("MIG-STM")}`, as: users.sam, expect: 200, payload: { status: "blocked", statusNote: "waiting on the source system" } });
    expect(r.body.notificationsQueued).toBeGreaterThanOrEqual(0);
    const list = await call(ctx.app, { method: "GET", url: `/events/${eventId}/notifications`, as: users.auditor, expect: 200 });
    expect(list.body.notifications.length).toBeGreaterThan(0);
    const kinds = new Set(list.body.notifications.map((n: any) => n.kind));
    expect(kinds.has("task_held")).toBe(true); // work behind the earlier no-go gate
    // The command centre is on the notices it should be on.
    expect(list.body.notifications.some((n: any) => n.recipientUserId === users.cc.id)).toBe(true);
    // Owners hear about their own work.
    expect(list.body.notifications.some((n: any) => n.recipientUserId === users.priya.id)).toBe(true);

    // Re-evaluating an unchanged event adds nothing but recognises the same facts.
    const again = await call(ctx.app, { method: "POST", url: `/events/${eventId}/notifications/evaluate`, as: users.cc, expect: 200, payload: {} });
    expect(again.body.enqueued).toBe(0);
    expect(again.body.suppressed).toBeGreaterThan(0);
  });

  it("notifies again when the situation gets materially worse", async () => {
    const before = (await call(ctx.app, { method: "GET", url: `/events/${eventId}/notifications`, as: users.auditor, expect: 200 })).body.notifications.length;
    // A much later expected unblock pushes reconciliation past its deadline by a new margin.
    await call(ctx.app, { method: "PATCH", url: `/tasks/${taskIdByRef.get("MIG-BAL")}`, as: users.builder, expect: 200, payload: { status: "blocked", expectedUnblockAt: at(20 * 60) } });
    const after = (await call(ctx.app, { method: "GET", url: `/events/${eventId}/notifications`, as: users.auditor, expect: 200 })).body;
    expect(after.notifications.length).toBeGreaterThan(before);
    const breach = after.notifications.filter((n: any) => n.kind === "task_deadline_at_risk");
    expect(breach.length).toBeGreaterThan(0);
    expect(breach[0].severity).toBe("critical");
    expect(breach[0].facts.breachMinutes).toBeGreaterThan(0);
  });

  it("dispatches pending notices through the configured channel exactly once", async () => {
    sent.length = 0;
    const d = await call(ctx.app, { method: "POST", url: `/events/${eventId}/notifications/dispatch`, as: users.cc, expect: 200, payload: {} });
    expect(d.body.sent).toBeGreaterThan(0);
    expect(d.body.failed).toBe(0);
    expect(sent.length).toBe(d.body.sent);
    expect(sent[0]!.subject).toContain("[TRBK Cutover]");
    expect(sent[0]!.body).toContain("https://runbook.test/events/");
    const counts = await call(ctx.app, { method: "GET", url: `/events/${eventId}/notifications`, as: users.auditor, expect: 200 });
    expect(counts.body.counts.pending).toBe(0);
    expect(counts.body.counts.sent).toBe(d.body.sent);
    // Nothing left to send.
    const again = await call(ctx.app, { method: "POST", url: `/events/${eventId}/notifications/dispatch`, as: users.cc, expect: 200, payload: {} });
    expect(again.body).toMatchObject({ attempted: 0, sent: 0 });
  });

  it("records a gate decision as a notice to the approver", async () => {
    sent.length = 0;
    await call(ctx.app, { method: "POST", url: `/gates/${gateIdByName.get("G2")}/decision`, as: users.cc, expect: 200, payload: { decision: "go", note: "rollback window closed cleanly" } });
    const list = await call(ctx.app, { method: "GET", url: `/events/${eventId}/notifications`, as: users.auditor, expect: 200 });
    const decided = list.body.notifications.filter((n: any) => n.kind === "gate_decided");
    expect(decided.length).toBeGreaterThan(0);
    expect(decided[0].title).toContain("GO");
    expect(decided.some((n: any) => n.recipientUserId === users.cc.id)).toBe(true);
  });

  it("task owners cannot dispatch; auditors can read", async () => {
    const denied = await call(ctx.app, { method: "POST", url: `/events/${eventId}/notifications/dispatch`, as: users.priya, payload: {} });
    expect(denied.status).toBe(403);
    await call(ctx.app, { method: "GET", url: `/events/${eventId}/notifications`, as: users.auditor, expect: 200 });
  });
});

describe("summary", () => {
  it("falls back to a deterministic summary built from engine facts when no model is configured", async () => {
    // Same database, an app with no LLM: the path a deployment without credentials takes.
    const noModel = await buildApp({ db: ctx.db });
    const s = await call(noModel, { method: "GET", url: `/events/${eventId}/summary`, as: users.auditor, expect: 200 });
    await noModel.close();
    expect(s.body.model).toBeNull();
    expect(s.body.headline).toBeTruthy();
    expect(s.body.facts.counts.tasks).toBeGreaterThan(0);
    expect(s.body.facts.blocked.map((b: any) => b.ref)).toContain("MIG-STM");
    // The headline states a fact the engine computed, not an opinion.
    expect(s.body.summary).toContain("tasks are done");
  });

  it("hands the model only computed facts and returns what it wrote", async () => {
    const s = await call(ctx.app, { method: "GET", url: `/events/${eventId}/summary`, as: users.auditor, expect: 200 });
    expect(s.body.model).toBe("fake");
    expect(s.body.headline).toBe("Statements migration is the constraint.");
    expect(lastSummaryPrompt).toContain('"criticalPath"');
    expect(lastSummaryPrompt).toContain("MIG-STM");
    // No graph, no dependency list: the model cannot re-derive scheduling.
    expect(lastSummaryPrompt).not.toContain("predecessorId");
  });
});

describe("post-event report", () => {
  it("reports planned vs actual, gate decisions with approver and timestamp, and every status change", async () => {
    const r = await call(ctx.app, { method: "GET", url: `/events/${eventId}/report`, as: users.auditor, expect: 200 });
    expect(r.body.event.name).toBe("TRBK Cutover");
    expect(r.body.summary.tasks).toBeGreaterThan(10);
    expect(r.body.summary.statusChanges).toBeGreaterThan(0);
    const migAcc = r.body.tasks.find((t: any) => t.ref === "MIG-ACC");
    expect(migAcc.owner).toBe("Priya");
    expect(migAcc.actualStart).toBeTruthy();
    const decided = r.body.gates.filter((g: any) => g.decision !== "pending");
    expect(decided.length).toBeGreaterThan(0);
    expect(decided[0].decidedBy).toBeTruthy();
    expect(decided[0].decidedAt).toBeTruthy();
    expect(r.body.statusChanges[0]).toMatchObject({ taskRef: expect.any(String), to: expect.any(String) });
    expect(r.body.auditTrail.length).toBeGreaterThan(5);
    expect(r.body.notifications.length).toBeGreaterThan(0);
  });

  it("exports the audit trail and the task record as CSV, guarding against formula injection", async () => {
    const audit = await call<string>(ctx.app, { method: "GET", url: `/events/${eventId}/report?format=audit.csv`, as: users.auditor, expect: 200 });
    expect(audit.body.split("\r\n")[0]).toBe("timestamp,actor,action,entity_type,entity,detail");
    expect(audit.body.split("\r\n").length).toBeGreaterThan(5);
    const tasks = await call<string>(ctx.app, { method: "GET", url: `/events/${eventId}/report?format=tasks.csv`, as: users.auditor, expect: 200 });
    expect(tasks.body.split("\r\n")[0]).toContain("duration_variance_min");
    expect(tasks.body).toContain("MIG-ACC");

    // A note that looks like a spreadsheet formula is neutralised on export.
    await call(ctx.app, { method: "PATCH", url: `/tasks/${taskIdByRef.get("REC-ACC")}`, as: users.builder, expect: 200, payload: { status: "blocked", statusNote: "=cmd|'/c calc'!A1" } });
    const after = await call<string>(ctx.app, { method: "GET", url: `/events/${eventId}/report?format=tasks.csv`, as: users.auditor, expect: 200 });
    expect(after.body).toContain("'=cmd");
    expect(after.body).not.toMatch(/,=cmd/);
  });
});
