/**
 * Plain-language summaries (CLAUDE.md: LLM-assisted, never LLM-decided).
 *
 * The engine decides what is at risk; the model only puts those facts into sentences a
 * command centre can read at 3am. The prompt receives computed facts only — no raw graph,
 * no invitation to reason about scheduling — and the response is schema-constrained.
 * Every number the model is allowed to state is one we handed it.
 */
import { buildGraph, type Schedule } from "@cutover/engine";
import { evaluateNotifications, fmtMinutes, fmtTime, type DirectoryGate, type DirectoryTask } from "@cutover/notify";
import type { LlmClient } from "@cutover/ingest";
import type { Db } from "@cutover/db";
import { badRequest, notFound } from "../errors.js";
import { loadRunbook, scheduleFor } from "./runbook.js";

export interface RiskFacts {
  event: { name: string; timezone: string; status: string; windowEnd: string; projectedFinish: string | null; windowSlackMinutes: number | null; windowBreachMinutes: number };
  criticalPath: string[];
  deadlineBreaches: { ref: string; owner: string | null; minutes: number }[];
  gates: { name: string; status: string; slackMinutes: number | null; projectedReadyAt: string | null; pointOfNoReturn: boolean; restsOnAssumption: boolean }[];
  blocked: { ref: string; owner: string | null; note: string | null; assumedResumeAt: string | null }[];
  held: { ref: string; reason: string }[];
  inProgress: { ref: string; owner: string | null; projectedFinish: string | null }[];
  counts: { tasks: number; complete: number; remaining: number };
}

/** Everything the summary is allowed to talk about, computed deterministically. */
export async function riskFacts(db: Db, eventId: string, asOf = Date.now()): Promise<{ facts: RiskFacts; schedule: Schedule }> {
  const rb = await loadRunbook(db, eventId);
  const mode = rb.event.status === "live" ? "live" : "plan";
  const schedule = scheduleFor(rb.input, mode, asOf);
  const tz = rb.event.timezone;
  const t = (ms: number | undefined) => (ms === undefined ? null : fmtTime(ms, tz));
  const refOf = (id: string) => rb.tasks.find((x) => x.id === id)?.ref ?? id;
  const ownerOf = (id: string) => {
    const task = rb.tasks.find((x) => x.id === id);
    return task?.ownerId ? (rb.ownerNameById[task.ownerId] ?? null) : (task?.ownerHint ?? null);
  };
  const facts: RiskFacts = {
    event: {
      name: rb.event.name,
      timezone: tz,
      status: rb.event.status,
      windowEnd: fmtTime(rb.event.windowEnd.getTime(), tz),
      projectedFinish: t(schedule.projectedFinish),
      windowSlackMinutes: schedule.windowSlackMinutes ?? null,
      windowBreachMinutes: schedule.eventWindowBreachMinutes,
    },
    criticalPath: schedule.criticalPath.map(refOf),
    deadlineBreaches: schedule.deadlineBreaches.map((b) => ({ ref: refOf(b.taskId), owner: ownerOf(b.taskId), minutes: b.minutes })),
    gates: rb.gates.map((g) => {
      const gp = schedule.gates[g.id];
      return {
        name: g.name,
        status: gp?.status ?? "ok",
        slackMinutes: gp?.slackMinutes ?? null,
        projectedReadyAt: t(gp?.projectedReadyAt),
        pointOfNoReturn: g.isPointOfNoReturn,
        restsOnAssumption: gp?.assumed ?? false,
      };
    }),
    blocked: rb.tasks
      .filter((x) => x.status === "blocked" || x.status === "failed")
      .map((x) => ({ ref: x.ref, owner: x.ownerId ? (rb.ownerNameById[x.ownerId] ?? null) : x.ownerHint, note: x.statusNote, assumedResumeAt: t(schedule.tasks[x.id]?.assumption?.resumeAt) })),
    held: schedule.heldTaskIds.map((id) => ({ ref: refOf(id), reason: schedule.tasks[id]?.held?.reason ?? "held" })),
    inProgress: rb.tasks.filter((x) => x.status === "in_progress").map((x) => ({ ref: x.ref, owner: x.ownerId ? (rb.ownerNameById[x.ownerId] ?? null) : x.ownerHint, projectedFinish: t(schedule.tasks[x.id]?.earlyFinish) })),
    counts: {
      tasks: rb.tasks.length,
      complete: rb.tasks.filter((x) => x.status === "complete" || x.status === "skipped").length,
      remaining: rb.tasks.filter((x) => x.status !== "complete" && x.status !== "skipped").length,
    },
  };
  return { facts, schedule };
}

const SUMMARY_SCHEMA: Record<string, unknown> = {
  type: "object",
  additionalProperties: false,
  required: ["headline", "summary", "watchItems"],
  properties: {
    headline: { type: "string", description: "One sentence, under 120 characters: the single most important thing about this event right now." },
    summary: { type: "string", description: "Two to four sentences of plain language for a command centre. State what is at risk, what is driving it, and what has already been decided." },
    watchItems: {
      type: "array",
      maxItems: 5,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["what", "why"],
        properties: {
          what: { type: "string", description: "The task ref, gate name, or event-level item to watch." },
          why: { type: "string", description: "One short sentence on why it matters now." },
        },
      },
    },
  },
};

const SUMMARY_SYSTEM = `You write situation summaries for the command centre of a live data-migration cutover event.

You are given computed facts from a deterministic scheduling engine. Your job is wording, not analysis.

Rules:
- Use only the numbers, times, names and refs in the facts. Never compute or estimate a new one, never predict, never suggest a schedule change.
- If a projection is marked as resting on an assumption, say so plainly.
- Lead with what is at risk. If nothing is at risk, say the event is on track and name the nearest constraint.
- Write for someone under time pressure: short sentences, no filler, no restating the whole plan.
- Refer to tasks by their ref and gates by their name.`;

export interface RiskSummary {
  headline: string;
  summary: string;
  watchItems: { what: string; why: string }[];
  model: string;
  facts: RiskFacts;
}

export async function summarizeRisk(db: Db, eventId: string, llm: LlmClient | undefined, asOf = Date.now()): Promise<RiskSummary> {
  if (!llm) throw badRequest("summaries are not configured (no Anthropic credentials)");
  const { facts } = await riskFacts(db, eventId, asOf);
  const r = await llm.extract({ system: SUMMARY_SYSTEM, user: `Facts:\n${JSON.stringify(facts, null, 2)}`, schema: SUMMARY_SCHEMA });
  const raw = (r.raw ?? {}) as Partial<RiskSummary>;
  return {
    headline: String(raw.headline ?? "").slice(0, 300),
    summary: String(raw.summary ?? ""),
    watchItems: Array.isArray(raw.watchItems) ? raw.watchItems.slice(0, 5).map((w) => ({ what: String(w.what ?? ""), why: String(w.why ?? "") })) : [],
    model: r.model,
    facts,
  };
}

const COMMS_SCHEMA: Record<string, unknown> = {
  type: "object",
  additionalProperties: false,
  required: ["subject", "body"],
  properties: {
    subject: { type: "string" },
    body: { type: "string", description: "The message body. Plain text, no markdown headings." },
  },
};

const COMMS_SYSTEM = `You draft stakeholder communications for a live data-migration cutover event.

You are given computed facts from a deterministic scheduling engine and the audience.
Your job is wording, not analysis.

Rules:
- Use only the facts supplied. Never invent a time, a cause, a remedy, or a commitment.
- Say what the situation is, what it means for the audience, and what happens next only if the facts state it.
- No apology theatre, no speculation about blame, no promises about recovery that the facts do not support.
- The draft is for a human to review and send: end without a signature block.`;

export interface CommsDraft {
  subject: string;
  body: string;
  model: string;
}

/** Draft comms about a gate that is at risk (PRD §6.2 LLM-assisted). Human reviews before sending. */
export async function draftGateComms(db: Db, gateId: string, audience: string, llm: LlmClient | undefined, asOf = Date.now()): Promise<CommsDraft> {
  if (!llm) throw badRequest("comms drafting is not configured (no Anthropic credentials)");
  const gate = (await db.query.gate.findFirst({ where: (g, { eq }) => eq(g.id, gateId) })) as { id: string; eventId: string; name: string } | undefined;
  if (!gate) throw notFound("gate");
  const { facts, schedule } = await riskFacts(db, gate.eventId, asOf);
  const rb = await loadRunbook(db, gate.eventId);
  const built = buildGraph(rb.input);
  const g = rb.gates.find((x) => x.id === gateId);
  if (!g) throw notFound("gate");
  const gp = schedule.gates[gateId];
  const tz = rb.event.timezone;

  // Which tasks wait on this gate, and who owns them: the audience's practical stake.
  const waiting = g.gatedTaskIds.map((id) => rb.tasks.find((t) => t.id === id)).filter((t): t is NonNullable<typeof t> => !!t);
  const gateFacts = {
    gate: g.name,
    pointOfNoReturn: g.isPointOfNoReturn,
    decision: g.decision,
    targetDecisionAt: g.targetDecisionAt ? fmtTime(g.targetDecisionAt.getTime(), tz) : null,
    projectedReadyAt: gp?.projectedReadyAt ? fmtTime(gp.projectedReadyAt, tz) : null,
    slack: gp?.slackMinutes !== undefined ? fmtMinutes(gp.slackMinutes) : null,
    status: gp?.status,
    restsOnAssumption: gp?.assumed ?? false,
    tasksWaiting: waiting.map((t) => ({ ref: t.ref, name: t.name, owner: t.ownerId ? rb.ownerNameById[t.ownerId] : t.ownerHint })),
    entryWork: g.entryTaskIds.map((id) => {
      const t = rb.tasks.find((x) => x.id === id);
      const tm = schedule.tasks[id];
      return { ref: t?.ref, status: t?.status, projectedFinish: tm?.earlyFinish ? fmtTime(tm.earlyFinish, tz) : null };
    }),
    event: facts.event,
  };
  void built;
  const r = await llm.extract({ system: COMMS_SYSTEM, user: `Audience: ${audience}\n\nFacts:\n${JSON.stringify(gateFacts, null, 2)}`, schema: COMMS_SCHEMA });
  const raw = (r.raw ?? {}) as Partial<CommsDraft>;
  return { subject: String(raw.subject ?? ""), body: String(raw.body ?? ""), model: r.model };
}

/** Deterministic fallback when no model is configured: the facts, plainly stated. */
export function plainRiskSummary(facts: RiskFacts): { headline: string; summary: string; watchItems: { what: string; why: string }[] } {
  const breaches = facts.deadlineBreaches;
  const badGates = facts.gates.filter((g) => g.status === "breached" || g.status === "at_risk");
  const headline =
    facts.event.windowBreachMinutes > 0
      ? `${facts.event.name} is projected to overrun its window by ${fmtMinutes(facts.event.windowBreachMinutes)}.`
      : breaches.length > 0
        ? `${breaches.length} task${breaches.length === 1 ? "" : "s"} will miss a deadline; the worst is ${breaches[0]!.ref} by ${fmtMinutes(breaches[0]!.minutes)}.`
        : badGates.length > 0
          ? `Gate "${badGates[0]!.name}" is ${badGates[0]!.status.replace("_", " ")}.`
          : `${facts.event.name} is on track to finish at ${facts.event.projectedFinish ?? "an undetermined time"}.`;
  const parts = [
    `${facts.counts.complete} of ${facts.counts.tasks} tasks are done.`,
    badGates.length > 0 ? `${badGates.length} gate${badGates.length === 1 ? " needs" : "s need"} attention: ${badGates.map((g) => `${g.name} (${g.status.replace("_", " ")})`).join(", ")}.` : "",
    facts.blocked.length > 0 ? `${facts.blocked.length} blocked or failed: ${facts.blocked.map((b) => b.ref).join(", ")}.` : "",
    facts.held.length > 0 ? `${facts.held.length} held behind a gate or an upstream block.` : "",
    facts.criticalPath.length > 0 ? `The deciding chain is ${facts.criticalPath.join(" → ")}.` : "",
  ].filter(Boolean);
  return {
    headline,
    summary: parts.join(" "),
    watchItems: [
      ...breaches.slice(0, 3).map((b) => ({ what: b.ref, why: `Projected to miss its deadline by ${fmtMinutes(b.minutes)}${b.owner ? `, owned by ${b.owner}` : ""}.` })),
      ...badGates.slice(0, 2).map((g) => ({ what: g.name, why: `${g.status.replace("_", " ")}${g.slackMinutes !== null ? ` with ${fmtMinutes(g.slackMinutes)} of slack` : ""}${g.pointOfNoReturn ? "; this is the point of no return" : ""}.` })),
    ].slice(0, 5),
  };
}

export { evaluateNotifications, type DirectoryGate, type DirectoryTask };
