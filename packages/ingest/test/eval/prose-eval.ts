/**
 * Prose-parser eval. Runs the fixture cases through the real model and reports
 * dependency precision/recall/F1 plus task-ref recall per case and overall.
 *
 * Usage:  pnpm --filter @cutover/ingest eval:prose [--model claude-opus-5] [--runs 1]
 * Needs Anthropic credentials (ANTHROPIC_API_KEY or an `ant auth login` profile).
 *
 * CLAUDE.md: default to Claude Opus 5; escalate to Fable only if this eval shows Opus
 * falling short on free-text dependency parsing specifically. Compare with
 * `--model claude-fable-5-1` before deciding.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { createAnthropicLlmClient, parseProse, DEFAULT_PROSE_MODEL } from "../../src/index.js";

interface Case {
  name: string;
  text: string;
  knownTasks?: { ref: string; name: string }[];
  expected: {
    tasks: string[];
    dependencies: { p: string; s: string; type?: string; lag?: number }[];
    forbidden?: { p: string; s: string }[];
  };
}

const here = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const arg = (name: string, def: string) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1]! : def;
};
const model = arg("--model", DEFAULT_PROSE_MODEL);
const runs = Number(arg("--runs", "1"));
const threshold = Number(arg("--min-f1", "0.85"));

const cases = JSON.parse(readFileSync(path.join(here, "../fixtures/prose/cases.json"), "utf8")) as Case[];
const client = createAnthropicLlmClient({ model });
const key = (p: string, s: string) => `${p}>${s}`;

let tp = 0;
let fp = 0;
let fn = 0;
let taskHits = 0;
let taskTotal = 0;
let forbiddenHits = 0;
let typeLagMisses = 0;
let inputTokens = 0;
let outputTokens = 0;

console.log(`model=${model} runs=${runs} cases=${cases.length}\n`);
for (let run = 1; run <= runs; run++) {
  for (const c of cases) {
    const started = Date.now();
    let plan;
    try {
      plan = await parseProse(c.text, { client, ...(c.knownTasks ? { knownTasks: c.knownTasks } : {}) });
    } catch (e) {
      console.log(`✗ ${c.name}: ${(e as Error).message}`);
      fn += c.expected.dependencies.length;
      taskTotal += c.expected.tasks.length;
      continue;
    }
    const got = new Map(plan.dependencies.map((d) => [key(d.predecessorRef, d.successorRef), d] as const));
    const want = new Map(c.expected.dependencies.map((d) => [key(d.p, d.s), d] as const));
    let ctp = 0;
    let cfp = 0;
    let cfn = 0;
    for (const [k, w] of want) {
      const g = got.get(k);
      if (!g) cfn++;
      else {
        ctp++;
        if ((w.type !== undefined && g.type !== w.type) || (w.lag !== undefined && g.lagMinutes !== w.lag)) typeLagMisses++;
      }
    }
    for (const k of got.keys()) if (!want.has(k)) cfp++;
    const forb = (c.expected.forbidden ?? []).filter((f) => got.has(key(f.p, f.s))).length;
    const gotRefs = new Set(plan.tasks.map((t) => t.ref));
    const th = c.expected.tasks.filter((r) => gotRefs.has(r)).length;
    tp += ctp;
    fp += cfp;
    fn += cfn;
    forbiddenHits += forb;
    taskHits += th;
    taskTotal += c.expected.tasks.length;
    const prec = ctp + cfp === 0 ? 1 : ctp / (ctp + cfp);
    const rec = ctp + cfn === 0 ? 1 : ctp / (ctp + cfn);
    const evidenceWarnings = plan.issues.filter((i) => i.code === "evidence_not_found").length;
    console.log(
      `${cfn === 0 && cfp === 0 && forb === 0 ? "✓" : "✗"} ${c.name}  deps P=${prec.toFixed(2)} R=${rec.toFixed(2)}  tasks ${th}/${c.expected.tasks.length}` +
        `${forb > 0 ? `  FORBIDDEN=${forb}` : ""}${evidenceWarnings > 0 ? `  evidence-warnings=${evidenceWarnings}` : ""}  ${Date.now() - started}ms`,
    );
    if (cfp > 0) console.log(`    extra: ${Array.from(got.keys()).filter((k) => !want.has(k)).join(", ")}`);
    if (cfn > 0) console.log(`    missing: ${Array.from(want.keys()).filter((k) => !got.has(k)).join(", ")}`);
  }
}
void inputTokens;
void outputTokens;
const precision = tp + fp === 0 ? 1 : tp / (tp + fp);
const recall = tp + fn === 0 ? 1 : tp / (tp + fn);
const f1 = precision + recall === 0 ? 0 : (2 * precision * recall) / (precision + recall);
console.log(`\noverall  deps P=${precision.toFixed(3)} R=${recall.toFixed(3)} F1=${f1.toFixed(3)}  type/lag misses=${typeLagMisses}  forbidden=${forbiddenHits}  task refs ${taskHits}/${taskTotal}`);
console.log(f1 >= threshold && forbiddenHits === 0 ? `PASS (F1 ≥ ${threshold})` : `BELOW BAR (F1 < ${threshold} or forbidden edges present)`);
process.exit(f1 >= threshold && forbiddenHits === 0 ? 0 : 1);
