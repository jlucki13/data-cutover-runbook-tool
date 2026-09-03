import { describe, expect, it } from "vitest";
import { EXTRACTION_SCHEMA, EXTRACTION_SYSTEM_PROMPT, buildUserPrompt, parseProse, type LlmClient, type LlmExtractionRequest } from "../src/index.js";

const TEXT = `Balances workstream plan.
Task 9 (extract balances, 30 min) starts once the source freeze is confirmed.
Task 11 (load balances) takes about 1 hour and needs Task 9 done.
Task 14 starts after Task 9 and Task 11 complete; allow 2 hours after Task 11 finishes for the batch to settle.
Task 15 reconciles balances and must finish by 06:00; it can start 15 minutes before Task 14 finishes.`;

function fakeClient(payload: unknown, capture?: (r: LlmExtractionRequest) => void): LlmClient {
  return {
    async extract(req) {
      capture?.(req);
      return { raw: payload, model: "fake-model" };
    },
  };
}

describe("parseProse", () => {
  it("passes the system prompt, schema, known tasks and text to the model", async () => {
    let seen: LlmExtractionRequest | undefined;
    await parseProse(TEXT, { client: fakeClient({ tasks: [], dependencies: [], notes: [] }, (r) => (seen = r)), knownTasks: [{ ref: "FRZ-1", name: "Source freeze", workstreamName: "Core" }], context: "Balances plan", timezone: "America/New_York" });
    expect(seen!.system).toBe(EXTRACTION_SYSTEM_PROMPT);
    expect(seen!.schema).toBe(EXTRACTION_SCHEMA);
    expect(seen!.user).toBe(buildUserPrompt(TEXT, { knownTasks: [{ ref: "FRZ-1", name: "Source freeze", workstreamName: "Core" }], context: "Balances plan", timezone: "America/New_York" }));
    expect(seen!.user).toContain("- FRZ-1: Source freeze [Core]");
    expect(seen!.user).toContain(TEXT);
  });

  it("validates model output deterministically: evidence, refs, types, confidence, duplicates", async () => {
    const plan = await parseProse(TEXT, {
      client: fakeClient({
        tasks: [
          { ref: "9", name: "Extract balances", durationMinutes: 30, evidence: "Task 9 (extract balances, 30 min) starts once the source freeze is confirmed." },
          { ref: "11", name: "Load balances", durationMinutes: 60, evidence: "Task 11 (load balances) takes about 1 hour" },
          { ref: "14", name: "Task 14", evidence: "Task 14 starts after Task 9 and Task 11 complete" },
          { ref: "15", name: "Reconcile balances", deadline: "2026-10-17T06:00:00", evidence: "Task 15 reconciles balances and must finish by 06:00" },
          { ref: "15", name: "dup", evidence: "x" },
          { ref: "", name: "no ref", evidence: "x" },
        ],
        dependencies: [
          { predecessorRef: "FRZ-1", successorRef: "9", type: "FS", lagMinutes: 0, confidence: 0.85, evidence: "starts once the source freeze is confirmed" },
          { predecessorRef: "9", successorRef: "11", type: "FS", lagMinutes: 0, confidence: 0.95, evidence: "needs Task 9 done" },
          { predecessorRef: "9", successorRef: "14", type: "FS", lagMinutes: 0, confidence: 0.95, evidence: "Task 14 starts after Task 9 and Task 11 complete" },
          { predecessorRef: "11", successorRef: "14", type: "FS", lagMinutes: 120, confidence: 0.9, evidence: "allow 2 hours after Task 11 finishes" },
          { predecessorRef: "14", successorRef: "15", type: "FS", lagMinutes: -15, confidence: 0.9, evidence: "it can start 15 minutes before Task 14 finishes" },
          { predecessorRef: "14", successorRef: "15", type: "SS", lagMinutes: 0, confidence: 0.4, evidence: "dup" },
          { predecessorRef: "11", successorRef: "9", type: "XX", lagMinutes: 0, confidence: 1.7, evidence: "this sentence is not in the text" },
          { predecessorRef: "9", successorRef: "9", type: "FS", lagMinutes: 0, confidence: 1, evidence: "Task 9" },
        ],
        notes: ["Direction of Task 15 vs Task 14 assumed from 'before'."],
      }),
      knownTasks: [{ ref: "FRZ-1", name: "Source freeze" }],
      timezone: "UTC",
    });

    expect(plan.format).toBe("prose_llm");
    expect(plan.meta.model).toBe("fake-model");
    expect(plan.tasks.map((t) => t.ref)).toEqual(["9", "11", "14", "15"]);
    expect(plan.tasks[3]!.windowDeadline).toBe(Date.UTC(2026, 9, 17, 6));
    expect(plan.dependencies.map(({ predecessorRef, successorRef, type, lagMinutes, confidence }) => ({ predecessorRef, successorRef, type, lagMinutes, confidence }))).toEqual([
      { predecessorRef: "FRZ-1", successorRef: "9", type: "FS", lagMinutes: 0, confidence: 0.85 },
      { predecessorRef: "9", successorRef: "11", type: "FS", lagMinutes: 0, confidence: 0.95 },
      { predecessorRef: "9", successorRef: "14", type: "FS", lagMinutes: 0, confidence: 0.95 },
      { predecessorRef: "11", successorRef: "14", type: "FS", lagMinutes: 120, confidence: 0.9 },
      { predecessorRef: "14", successorRef: "15", type: "FS", lagMinutes: -15, confidence: 0.9 },
      { predecessorRef: "11", successorRef: "9", type: "FS", lagMinutes: 0, confidence: 0.5 }, // bad type → FS, fake evidence → capped
    ]);
    const codes = plan.issues.map((i) => i.code);
    expect(codes).toEqual(expect.arrayContaining(["duplicate_ref", "missing_ref", "bad_dependency_type", "evidence_not_found", "self_dependency", "model_note"]));
    expect(plan.issues.filter((i) => i.code === "unresolved_ref")).toEqual([]); // FRZ-1 is a known task
  });

  it("handles empty text and empty extractions", async () => {
    const empty = await parseProse("   ", { client: fakeClient({}) });
    expect(empty.issues[0]!.code).toBe("empty_text");
    const nothing = await parseProse("Nothing useful here.", { client: fakeClient({ tasks: [], dependencies: [], notes: [] }) });
    expect(nothing.issues[0]!.code).toBe("nothing_extracted");
  });
});
