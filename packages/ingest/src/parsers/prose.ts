/**
 * Free-text / prose parser backed by an LLM (Claude Opus 5 by default, per CLAUDE.md).
 *
 * The model's only job is extraction: turn sentences like "Task 14 starts after Task 9
 * and Task 11 complete" into candidate tasks and dependencies with an exact quote as
 * evidence and a confidence score. Everything after that is deterministic: evidence is
 * checked against the source text, refs are normalized, duplicates and self-loops are
 * dropped, and the result goes through the same compile + human-review path as every
 * other format. No LLM output ever reaches the graph without review (PRD §4.1).
 *
 * The client is injected so unit tests run against a fake and the eval harness can swap
 * models.
 */
import Anthropic from "@anthropic-ai/sdk";
import type { DependencyType } from "@cutover/engine";
import type { CandidateDependency, CandidateTask, ParseIssue, ParsedPlan } from "../types.js";
import { parseDateTime } from "../text.js";

export const PROSE_PARSER_VERSION = "prose/1.0.0";
export const DEFAULT_PROSE_MODEL = "claude-opus-5";

export interface LlmExtractionRequest {
  system: string;
  user: string;
  /** JSON schema the response must satisfy. */
  schema: Record<string, unknown>;
  model?: string;
}

export interface LlmExtractionResult {
  /** Parsed JSON from the model. */
  raw: unknown;
  model: string;
  usage?: { inputTokens: number; outputTokens: number };
}

export interface LlmClient {
  extract(req: LlmExtractionRequest): Promise<LlmExtractionResult>;
}

/** Production client. Uses structured outputs so the response is schema-valid JSON. */
export function createAnthropicLlmClient(opts: { apiKey?: string; model?: string; client?: Anthropic } = {}): LlmClient {
  const client = opts.client ?? new Anthropic(opts.apiKey ? { apiKey: opts.apiKey } : {});
  const defaultModel = opts.model ?? DEFAULT_PROSE_MODEL;
  return {
    async extract(req) {
      const model = req.model ?? defaultModel;
      const stream = client.messages.stream({
        model,
        max_tokens: 32000,
        system: req.system,
        messages: [{ role: "user", content: req.user }],
        thinking: { type: "adaptive" },
        output_config: { format: { type: "json_schema", schema: req.schema } },
      } as Parameters<typeof client.messages.stream>[0]);
      const message = await stream.finalMessage();
      if (message.stop_reason === "refusal") {
        throw new Error(`Model declined the extraction request${message.stop_details?.explanation ? `: ${message.stop_details.explanation}` : ""}`);
      }
      if (message.stop_reason === "max_tokens") throw new Error("Model output was truncated (max_tokens); split the text and retry.");
      const text = message.content
        .filter((b): b is Anthropic.TextBlock => b.type === "text")
        .map((b) => b.text)
        .join("");
      return {
        raw: JSON.parse(text),
        model: message.model,
        usage: { inputTokens: message.usage.input_tokens, outputTokens: message.usage.output_tokens },
      };
    },
  };
}

// ---------------------------------------------------------------------------
// Prompt and schema
// ---------------------------------------------------------------------------

export const EXTRACTION_SCHEMA: Record<string, unknown> = {
  type: "object",
  additionalProperties: false,
  required: ["tasks", "dependencies", "notes"],
  properties: {
    tasks: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["ref", "name", "evidence"],
        properties: {
          ref: { type: "string", description: "The task's identifier exactly as the text uses it (e.g. '14', 'T-14', 'ACC-3'). If the text has no identifiers, a short stable slug of the name." },
          name: { type: "string" },
          workstream: { type: ["string", "null"] },
          owner: { type: ["string", "null"] },
          plannedStart: { type: ["string", "null"], description: "ISO 8601 date-time if the text states when the task may start; else null." },
          durationMinutes: { type: ["integer", "null"] },
          deadline: { type: ["string", "null"], description: "ISO 8601 date-time if the text states a hard finish-by time; else null." },
          evidence: { type: "string", description: "Exact quote from the source text that defines this task." },
        },
      },
    },
    dependencies: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["predecessorRef", "successorRef", "type", "lagMinutes", "confidence", "evidence"],
        properties: {
          predecessorRef: { type: "string" },
          successorRef: { type: "string" },
          type: { type: "string", enum: ["FS", "SS", "FF", "SF"] },
          lagMinutes: { type: "integer", description: "Positive = wait this long after the predecessor event; negative = may start this long before it. 0 when none is stated." },
          confidence: { type: "number", minimum: 0, maximum: 1 },
          evidence: { type: "string", description: "Exact quote from the source text that states this dependency." },
        },
      },
    },
    notes: {
      type: "array",
      items: { type: "string" },
      description: "Ambiguities a human reviewer should resolve (unclear direction, tasks mentioned but never defined, conflicting statements).",
    },
  },
};

export const EXTRACTION_SYSTEM_PROMPT = `You extract cutover-runbook structure from free text written by migration workstream owners. You output only what the text supports; a human will review every item before it enters the plan.

Tasks
- One task per distinct activity. Use the identifier the text uses as \`ref\` ("Task 14" → "14"; "ACC-3" → "ACC-3"). If a list of known tasks is supplied, map mentions onto those refs rather than inventing new ones. Only when the text has no identifiers at all, use a short slug of the name (e.g. "freeze-source").
- Fill workstream, owner, plannedStart, durationMinutes, deadline only when the text states them. Convert durations to whole minutes. Dates: ISO 8601; if no timezone is given, leave the value as a naive ISO string.

Dependencies (predecessor → successor)
- "X after Y", "X once Y completes", "X requires Y", "X needs Y done", "Y must finish before X", "Y then X" → Y is the predecessor of X, type FS.
- "X before Y", "X blocks Y", "X unblocks Y", "X feeds Y" → X is the predecessor of Y, type FS.
- "X starts when Y starts", "X and Y kick off together" → SS with Y as predecessor (note the ambiguity if the order is unclear).
- "X must finish by the time Y finishes", "X and Y finish together" → FF.
- "X starts 2 hours after Y finishes" → FS with lagMinutes 120. "X can start 30 minutes before Y finishes" → FS with lagMinutes -30.
- "in parallel", "independently", "at the same time" is NOT a dependency unless a start/finish relationship is also stated.
- Chains: "A, then B, then C" → A→B and B→C (not A→C).
- Gates and approvals ("go/no-go", "sign-off", "approval") are tasks too; work that waits on them depends on them.

Evidence and confidence
- \`evidence\` must be an exact, contiguous quote from the source text (copy it verbatim, including punctuation). Never paraphrase.
- confidence ≥ 0.9 when the relationship is stated explicitly; 0.6–0.8 when implied by order words like "then" or "next"; below 0.6 when inferred from context. Do not include a dependency you cannot quote evidence for.
- Put anything ambiguous or contradictory in \`notes\` instead of guessing.`;

// ---------------------------------------------------------------------------
// Parse
// ---------------------------------------------------------------------------

export interface ProseOptions {
  client: LlmClient;
  model?: string;
  /** Tasks already in the runbook, so mentions map onto existing refs. */
  knownTasks?: { ref: string; name: string; workstreamName?: string }[];
  timezone?: string;
  /** Extra context for the model, e.g. "This is the balances workstream's plan for the 17 Oct cutover." */
  context?: string;
  defaultWorkstream?: string;
}

interface RawTask {
  ref: string;
  name: string;
  workstream?: string | null;
  owner?: string | null;
  plannedStart?: string | null;
  durationMinutes?: number | null;
  deadline?: string | null;
  evidence: string;
}
interface RawDependency {
  predecessorRef: string;
  successorRef: string;
  type: string;
  lagMinutes: number;
  confidence: number;
  evidence: string;
}
interface RawExtraction {
  tasks?: RawTask[];
  dependencies?: RawDependency[];
  notes?: string[];
}

const ws = (s: string) => s.replace(/\s+/g, " ").trim().toLowerCase();

export function buildUserPrompt(text: string, opts: Pick<ProseOptions, "knownTasks" | "context" | "timezone">): string {
  const parts: string[] = [];
  if (opts.context) parts.push(`Context: ${opts.context}`);
  if (opts.timezone) parts.push(`Timezone for naive times: ${opts.timezone}`);
  if (opts.knownTasks && opts.knownTasks.length > 0) {
    parts.push("Known tasks in the runbook (map mentions onto these refs):");
    for (const t of opts.knownTasks) parts.push(`- ${t.ref}: ${t.name}${t.workstreamName ? ` [${t.workstreamName}]` : ""}`);
  }
  parts.push("Source text:", "<<<", text, ">>>");
  return parts.join("\n");
}

export async function parseProse(text: string, opts: ProseOptions): Promise<ParsedPlan> {
  const issues: ParseIssue[] = [];
  const tasks: CandidateTask[] = [];
  const dependencies: CandidateDependency[] = [];
  const plan: ParsedPlan = { format: "prose_llm", tasks, dependencies, issues, meta: { parserVersion: PROSE_PARSER_VERSION } };
  if (text.trim() === "") {
    issues.push({ severity: "error", code: "empty_text", message: "No text to parse." });
    return plan;
  }

  const result = await opts.client.extract({
    system: EXTRACTION_SYSTEM_PROMPT,
    user: buildUserPrompt(text, opts),
    schema: EXTRACTION_SCHEMA,
    ...(opts.model !== undefined ? { model: opts.model } : {}),
  });
  plan.meta.model = result.model;
  const raw = (result.raw ?? {}) as RawExtraction;
  const haystack = ws(text);
  const dateOpts = opts.timezone !== undefined ? { timezone: opts.timezone } : {};
  const known = new Set((opts.knownTasks ?? []).map((t) => t.ref));

  // ---- tasks (deterministic post-validation)
  const seen = new Map<string, number>();
  let line = 0;
  for (const rt of raw.tasks ?? []) {
    line++;
    const ref = String(rt.ref ?? "").trim();
    const name = String(rt.name ?? "").trim() || ref;
    if (ref === "") {
      issues.push({ severity: "warning", code: "missing_ref", message: `Model returned a task without a ref ("${name}"); skipped.`, line });
      continue;
    }
    if (seen.has(ref)) {
      issues.push({ severity: "warning", code: "duplicate_ref", message: `Model returned "${ref}" twice; kept the first.`, line, ref });
      continue;
    }
    seen.set(ref, line);
    const t: CandidateTask = { ref, name, sourceLine: line, evidence: String(rt.evidence ?? "") };
    if (t.evidence && !haystack.includes(ws(t.evidence))) {
      issues.push({ severity: "warning", code: "evidence_not_found", message: `Evidence for task "${ref}" is not a verbatim quote of the source; verify it.`, line, ref });
    }
    const wsName = rt.workstream?.trim() || opts.defaultWorkstream;
    if (wsName) t.workstreamName = wsName;
    if (rt.owner?.trim()) t.ownerName = rt.owner.trim();
    if (rt.plannedStart) {
      const v = parseDateTime(rt.plannedStart, dateOpts);
      if (v !== undefined) t.plannedStart = v;
      else issues.push({ severity: "warning", code: "bad_start", message: `Could not parse start "${rt.plannedStart}" for "${ref}".`, line, ref });
    }
    if (rt.deadline) {
      const v = parseDateTime(rt.deadline, dateOpts);
      if (v !== undefined) t.windowDeadline = v;
      else issues.push({ severity: "warning", code: "bad_deadline", message: `Could not parse deadline "${rt.deadline}" for "${ref}".`, line, ref });
    }
    if (typeof rt.durationMinutes === "number" && Number.isFinite(rt.durationMinutes) && rt.durationMinutes >= 0) t.plannedDurationMinutes = Math.round(rt.durationMinutes);
    tasks.push(t);
  }

  // ---- dependencies
  const edgeSeen = new Set<string>();
  line = 0;
  for (const rd of raw.dependencies ?? []) {
    line++;
    const p = String(rd.predecessorRef ?? "").trim();
    const s = String(rd.successorRef ?? "").trim();
    if (p === "" || s === "") {
      issues.push({ severity: "warning", code: "bad_dependency", message: "Model returned a dependency with a missing ref; skipped.", line });
      continue;
    }
    if (p === s) {
      issues.push({ severity: "warning", code: "self_dependency", message: `Model returned "${p}" depending on itself; skipped.`, line, ref: p });
      continue;
    }
    const key = `${p} ${s}`;
    if (edgeSeen.has(key)) continue;
    edgeSeen.add(key);
    const type: DependencyType = ["FS", "SS", "FF", "SF"].includes(rd.type) ? (rd.type as DependencyType) : "FS";
    if (type !== rd.type) issues.push({ severity: "warning", code: "bad_dependency_type", message: `Unknown dependency type "${rd.type}" on ${p} → ${s}; treated as FS.`, line });
    let confidence = typeof rd.confidence === "number" && Number.isFinite(rd.confidence) ? Math.min(1, Math.max(0, rd.confidence)) : 0.5;
    const evidence = String(rd.evidence ?? "");
    if (evidence === "" || !haystack.includes(ws(evidence))) {
      confidence = Math.min(confidence, 0.5);
      issues.push({ severity: "warning", code: "evidence_not_found", message: `Evidence for ${p} → ${s} is not a verbatim quote of the source; confidence capped at 0.5.`, line });
    }
    if (!seen.has(p) && !known.has(p)) issues.push({ severity: "info", code: "unresolved_ref", message: `Dependency ${p} → ${s} references "${p}", which is not defined in this text. It will be resolved against the existing runbook.`, line, ref: p });
    if (!seen.has(s) && !known.has(s)) issues.push({ severity: "info", code: "unresolved_ref", message: `Dependency ${p} → ${s} references "${s}", which is not defined in this text. It will be resolved against the existing runbook.`, line, ref: s });
    const lag = typeof rd.lagMinutes === "number" && Number.isFinite(rd.lagMinutes) ? Math.round(rd.lagMinutes) : 0;
    dependencies.push({ predecessorRef: p, successorRef: s, type, lagMinutes: lag, confidence, evidence, sourceLine: line });
  }

  for (const n of raw.notes ?? []) issues.push({ severity: "info", code: "model_note", message: String(n) });
  if (tasks.length === 0 && dependencies.length === 0) issues.push({ severity: "warning", code: "nothing_extracted", message: "The model found no tasks or dependencies in the text." });
  plan.meta.rowCount = tasks.length;
  return plan;
}
