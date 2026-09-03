/**
 * Microsoft Project XML (MSPDI) parser. Deterministic.
 *
 * Mapping decisions (see docs/proposals/0001 §3 for the model they feed):
 *  - Summary tasks are not imported as tasks; the nearest outline-level-1 summary
 *    ancestor becomes the workstream name of its descendants.
 *  - ref = WBS when every task has one, else the visible ID (override with `refField`).
 *  - PredecessorLink.Type: 0=FF, 1=FS, 2=SF, 3=SS. LinkLag is in tenths of a minute.
 *  - plannedStart comes from Start-No-Earlier-Than / Must-Start-On constraints; a task
 *    with no predecessors whose Start is after the project start also gets its Start as a
 *    constraint (MS Project would otherwise have scheduled it at project start).
 *  - windowDeadline = min(Deadline, Finish-No-Later-Than / Must-Finish-On constraint).
 *  - Naive MSPDI timestamps are interpreted in `timezone` (default UTC).
 */
import { XMLParser } from "fast-xml-parser";
import type { DependencyType } from "@cutover/engine";
import type { CandidateDependency, CandidateTask, ParseIssue, ParseOptions, ParsedPlan } from "../types.js";
import { parseDateTime, parseDurationMinutes } from "../text.js";

export const MSPROJECT_PARSER_VERSION = "msproject/1.0.0";

export interface MsProjectOptions extends Pick<ParseOptions, "timezone" | "hoursPerDay"> {
  refField?: "wbs" | "id" | "uid" | "auto";
  /** Import summary tasks as tasks too (default false). */
  includeSummaries?: boolean;
}

const LINK_TYPES: Record<number, DependencyType> = { 0: "FF", 1: "FS", 2: "SF", 3: "SS" };

interface XTask {
  UID?: number | string;
  ID?: number | string;
  Name?: string;
  WBS?: string;
  OutlineLevel?: number | string;
  Summary?: number | string;
  Milestone?: number | string;
  Active?: number | string;
  Duration?: string;
  Start?: string;
  Finish?: string;
  Deadline?: string;
  ConstraintType?: number | string;
  ConstraintDate?: string;
  Notes?: string;
  PredecessorLink?: XLink[];
}
interface XLink {
  PredecessorUID?: number | string;
  Type?: number | string;
  LinkLag?: number | string;
  LagFormat?: number | string;
}
interface XProject {
  Name?: string;
  StartDate?: string;
  MinutesPerDay?: number | string;
  Tasks?: { Task?: XTask[] };
  Resources?: { Resource?: { UID?: number | string; Name?: string }[] };
  Assignments?: { Assignment?: { TaskUID?: number | string; ResourceUID?: number | string }[] };
}

const num = (v: number | string | undefined): number | undefined => {
  if (v === undefined || v === "") return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
};
const str = (v: unknown): string => (v === undefined || v === null ? "" : String(v).trim());

export function parseMsProjectXml(xml: string, opts: MsProjectOptions = {}): ParsedPlan {
  const issues: ParseIssue[] = [];
  const tasks: CandidateTask[] = [];
  const dependencies: CandidateDependency[] = [];
  const plan: ParsedPlan = { format: "ms_project_xml", tasks, dependencies, issues, meta: { parserVersion: MSPROJECT_PARSER_VERSION } };

  const parser = new XMLParser({
    ignoreAttributes: true,
    removeNSPrefix: true,
    parseTagValue: false,
    trimValues: true,
    isArray: (name) => ["Task", "PredecessorLink", "Resource", "Assignment"].includes(name),
  });
  let project: XProject | undefined;
  try {
    project = (parser.parse(xml) as { Project?: XProject }).Project;
  } catch (e) {
    issues.push({ severity: "error", code: "invalid_xml", message: `Could not parse XML: ${(e as Error).message}` });
    return plan;
  }
  if (!project || !project.Tasks) {
    issues.push({ severity: "error", code: "not_msproject", message: "No <Project><Tasks> element found; is this an MS Project XML export?" });
    return plan;
  }
  const dateOpts = opts.timezone !== undefined ? { timezone: opts.timezone } : {};
  const hoursPerDay = opts.hoursPerDay ?? (num(project.MinutesPerDay) !== undefined ? num(project.MinutesPerDay)! / 60 : 24);
  const projectStart = parseDateTime(project.StartDate, dateOpts);

  const xtasks = (project.Tasks.Task ?? []).filter((t) => str(t.Name) !== "" || num(t.UID) !== 0);
  const real = xtasks.filter((t) => num(t.UID) !== 0 && str(t.Active) !== "0");
  const refField = opts.refField ?? "auto";
  const useWbs = refField === "wbs" || (refField === "auto" && real.length > 0 && real.every((t) => str(t.WBS) !== ""));
  const refOf = (t: XTask): string => (refField === "uid" ? str(t.UID) : useWbs ? str(t.WBS) : str(t.ID));
  plan.meta.columnMapping = { ref: refField === "uid" ? "UID" : useWbs ? "WBS" : "ID" };

  // Owners from assignments.
  const resourceName = new Map<string, string>();
  for (const r of project.Resources?.Resource ?? []) if (str(r.UID) !== "" && str(r.Name) !== "") resourceName.set(str(r.UID), str(r.Name));
  const ownersByTask = new Map<string, string[]>();
  for (const a of project.Assignments?.Assignment ?? []) {
    const name = resourceName.get(str(a.ResourceUID));
    if (!name) continue;
    const list = ownersByTask.get(str(a.TaskUID)) ?? [];
    if (!list.includes(name)) list.push(name);
    ownersByTask.set(str(a.TaskUID), list);
  }

  // Walk in document order, tracking summary ancestors by outline level.
  const summaryStack: { level: number; name: string }[] = [];
  const byUid = new Map<string, { ref: string; summary: boolean }>();
  const seenRefs = new Map<string, number>();
  let line = 0;
  for (const t of xtasks) {
    line++;
    const uid = str(t.UID);
    if (uid === "0") continue; // project summary row
    const level = num(t.OutlineLevel) ?? 1;
    const isSummary = str(t.Summary) === "1";
    while (summaryStack.length > 0 && summaryStack[summaryStack.length - 1]!.level >= level) summaryStack.pop();
    const workstream = summaryStack[0]?.name;
    if (isSummary) {
      summaryStack.push({ level, name: str(t.Name) || `Summary ${uid}` });
      byUid.set(uid, { ref: refOf(t), summary: true });
      if (!opts.includeSummaries) continue;
    }
    if (str(t.Active) === "0") {
      issues.push({ severity: "info", code: "inactive_task", message: `Inactive task "${str(t.Name)}" skipped.`, line });
      continue;
    }
    const ref = refOf(t);
    if (ref === "") {
      issues.push({ severity: "error", code: "missing_ref", message: `Task "${str(t.Name)}" has no ${plan.meta.columnMapping.ref}; skipped.`, line });
      continue;
    }
    if (seenRefs.has(ref)) {
      issues.push({ severity: "error", code: "duplicate_ref", message: `Ref "${ref}" already used (task "${str(t.Name)}"); skipped.`, line, ref });
      continue;
    }
    seenRefs.set(ref, line);
    byUid.set(uid, { ref, summary: isSummary });

    const cand: CandidateTask = { ref, name: str(t.Name) || ref, sourceLine: line, evidence: `UID ${uid}${str(t.WBS) ? ` WBS ${str(t.WBS)}` : ""}: ${str(t.Name)}` };
    if (workstream) cand.workstreamName = workstream;
    const owners = ownersByTask.get(uid);
    if (owners && owners.length > 0) cand.ownerName = owners.join(", ");
    const notes = str(t.Notes);
    if (notes) cand.description = notes;

    const dur = str(t.Milestone) === "1" ? 0 : parseDurationMinutes(t.Duration, { hoursPerDay });
    if (dur === undefined) issues.push({ severity: "warning", code: "bad_duration", message: `Could not parse duration "${str(t.Duration)}" for "${ref}".`, line, ref });
    else cand.plannedDurationMinutes = dur;

    const ctype = num(t.ConstraintType);
    const cdate = parseDateTime(t.ConstraintDate, dateOpts);
    const start = parseDateTime(t.Start, dateOpts);
    const hasPreds = (t.PredecessorLink ?? []).length > 0;
    if ((ctype === 2 || ctype === 4) && cdate !== undefined) cand.plannedStart = cdate;
    else if (!hasPreds && start !== undefined && projectStart !== undefined && start > projectStart) cand.plannedStart = start;
    else if (!hasPreds && start !== undefined && projectStart === undefined) cand.plannedStart = start;

    const deadline = parseDateTime(t.Deadline, dateOpts);
    const finishConstraint = (ctype === 3 || ctype === 7) && cdate !== undefined ? cdate : undefined;
    const dl = [deadline, finishConstraint].filter((x): x is number => x !== undefined);
    if (dl.length > 0) cand.windowDeadline = Math.min(...dl);
    if (ctype === 1 || ctype === 5 || ctype === 6) issues.push({ severity: "info", code: "constraint_ignored", message: `Constraint type ${ctype} on "${ref}" has no equivalent and was ignored.`, line, ref });

    tasks.push(cand);
  }

  // Dependencies, resolved by UID → ref. Links to summary tasks are re-pointed to nothing (warned).
  const edgeSeen = new Set<string>();
  line = 0;
  for (const t of xtasks) {
    line++;
    const uid = str(t.UID);
    const me = byUid.get(uid);
    if (!me || (me.summary && !opts.includeSummaries)) continue;
    for (const l of t.PredecessorLink ?? []) {
      const p = byUid.get(str(l.PredecessorUID));
      if (!p) {
        issues.push({ severity: "warning", code: "unknown_predecessor", message: `Task "${me.ref}" links to unknown UID ${str(l.PredecessorUID)}; ignored.`, line, ref: me.ref });
        continue;
      }
      if (p.summary && !opts.includeSummaries) {
        issues.push({ severity: "warning", code: "summary_predecessor", message: `Task "${me.ref}" depends on summary task "${p.ref}"; summary links are not imported. Add the dependency to the specific task instead.`, line, ref: me.ref });
        continue;
      }
      const type = LINK_TYPES[num(l.Type) ?? 1] ?? "FS";
      const lagTenths = num(l.LinkLag) ?? 0;
      const lagFormat = num(l.LagFormat);
      let lagMinutes = Math.round(lagTenths / 10);
      if (lagFormat !== undefined && [19, 20, 35, 36, 37, 38, 39, 40, 41, 42, 43, 44, 45, 46, 47, 48, 49, 50, 51, 52, 53].includes(lagFormat) && lagTenths !== 0) {
        // Percentage lag formats depend on the predecessor's duration; not supported.
        issues.push({ severity: "warning", code: "percent_lag", message: `Percentage lag on ${p.ref} → ${me.ref} is not supported; lag set to 0.`, line, ref: me.ref });
        lagMinutes = 0;
      }
      const key = `${p.ref} ${me.ref}`;
      if (edgeSeen.has(key) || p.ref === me.ref) continue;
      edgeSeen.add(key);
      dependencies.push({ predecessorRef: p.ref, successorRef: me.ref, type, lagMinutes, evidence: `PredecessorLink UID ${str(l.PredecessorUID)} type ${str(l.Type)} lag ${str(l.LinkLag)}`, sourceLine: line });
    }
  }
  plan.meta.rowCount = tasks.length;
  return plan;
}
