/**
 * Column-based parser for CSV/TSV text and spreadsheet rows.
 *
 * Fully deterministic. Detects the header row, maps headers to fields via synonyms
 * (overridable), parses predecessor cells with optional type/lag suffixes
 * ("T-9", "14FS+2h", "ACC-3 SS-30m"), durations, and dates. Unmapped columns are kept
 * as custom fields so admin-defined columns survive import.
 */
import type { CandidateDependency, CandidateTask, CsvField, ParseIssue, ParseOptions, ParsedPlan } from "../types.js";
import { headerToKey, MINUTE_MS, normalizeHeader, parseCsv, parseDateTime, parseDurationMinutes, parsePredecessorCell } from "../text.js";

export const CSV_PARSER_VERSION = "csv/1.0.0";

export type Cell = string | number | boolean | Date | null | undefined;

const SYNONYMS: Record<CsvField, string[]> = {
  ref: ["id", "taskid", "ref", "reference", "taskref", "taskno", "tasknumber", "no", "num", "key", "wbs", "activityid", "stepid", "step", "seq", "line", "item", "runbookid", "uid"],
  name: ["taskname", "name", "task", "activity", "activityname", "title", "summary", "tasktitle", "action", "step", "stepname", "activitydescription"],
  description: ["description", "desc", "details", "detail", "notes", "note", "comment", "comments", "instructions"],
  predecessors: ["predecessors", "predecessor", "preds", "pred", "dependson", "dependencies", "dependency", "depends", "prerequisite", "prerequisites", "prereq", "prereqs", "after", "blockedby", "requires", "upstream", "predecessorids", "dependsonids", "waitsfor", "startsafter"],
  successors: ["successors", "successor", "blocks", "unblocks", "downstream", "next", "succ", "successorids"],
  workstream: ["workstream", "stream", "team", "area", "track", "group", "domain", "module", "phase", "swimlane", "lane", "datadomain"],
  owner: ["owner", "assignee", "assignedto", "assigned", "responsible", "resource", "resources", "resourcenames", "who", "lead", "contact", "poc", "executor", "taskowner"],
  start: ["start", "plannedstart", "startdate", "starttime", "scheduledstart", "begin", "startdatetime", "earliest", "notbefore", "startnoearlierthan", "snet", "earlieststart", "plannedstarttime", "targetstart"],
  finish: ["finish", "end", "plannedend", "plannedfinish", "enddate", "finishdate", "endtime", "finishtime", "scheduledfinish", "targetfinish", "plannedfinishtime"],
  duration: ["duration", "durationmin", "durationmins", "durationminutes", "durationhrs", "durationhours", "durationhr", "estimate", "est", "effort", "plannedduration", "length", "mins", "minutes", "hours", "hrs", "estduration", "estimatedduration", "durationdays"],
  deadline: ["deadline", "due", "duedate", "duetime", "latestfinish", "mustfinishby", "finishby", "windowdeadline", "hardstop", "latest", "nolaterthan", "finishnolaterthan", "fnlt", "latestfinishtime", "mustcompleteby", "sla"],
};

/** Fields whose synonyms overlap ("step" is both ref-ish and name-ish): resolve in this priority order. */
const FIELD_PRIORITY: CsvField[] = ["ref", "predecessors", "successors", "name", "duration", "start", "finish", "deadline", "owner", "workstream", "description"];

export interface ColumnMapping {
  fields: Partial<Record<CsvField, number>>;
  headers: string[];
  headerRow: number;
  unmapped: number[];
}

/** Find the header row (first row within the first 15 that maps ≥2 fields, else row 0) and map its columns. */
export function detectColumns(rows: Cell[][], override: ParseOptions["columns"] = {}): ColumnMapping {
  let best: ColumnMapping | undefined;
  const limit = Math.min(rows.length, 15);
  for (let r = 0; r < limit; r++) {
    const m = mapHeaders(rows[r]!.map(cellToString), r, override);
    const n = Object.keys(m.fields).length;
    if (n >= 2 && (m.fields.ref !== undefined || m.fields.name !== undefined)) return m;
    if (!best || n > Object.keys(best.fields).length) best = m;
  }
  return best ?? { fields: {}, headers: [], headerRow: 0, unmapped: [] };
}

function mapHeaders(headers: string[], headerRow: number, override: NonNullable<ParseOptions["columns"]>): ColumnMapping {
  const fields: Partial<Record<CsvField, number>> = {};
  const used = new Set<number>();
  const norm = headers.map(normalizeHeader);
  // explicit overrides first
  for (const [field, header] of Object.entries(override) as [CsvField, string][]) {
    const idx = headers.findIndex((h) => h.trim().toLowerCase() === header.trim().toLowerCase());
    if (idx >= 0) {
      fields[field] = idx;
      used.add(idx);
    }
  }
  for (const field of FIELD_PRIORITY) {
    if (fields[field] !== undefined) continue;
    const syns = SYNONYMS[field];
    // exact synonym match wins over "contains" match
    let idx = norm.findIndex((h, i) => !used.has(i) && h !== "" && syns.includes(h));
    if (idx < 0) idx = norm.findIndex((h, i) => !used.has(i) && h !== "" && syns.some((s) => s.length >= 4 && (h.startsWith(s) || h.endsWith(s))));
    if (idx >= 0) {
      fields[field] = idx;
      used.add(idx);
    }
  }
  const unmapped = headers.map((_, i) => i).filter((i) => !used.has(i) && headers[i]!.trim() !== "");
  return { fields, headers, headerRow, unmapped };
}

export function cellToString(c: Cell): string {
  if (c === null || c === undefined) return "";
  if (c instanceof Date) return Number.isNaN(c.getTime()) ? "" : c.toISOString();
  if (typeof c === "number") return Number.isInteger(c) ? String(c) : String(c);
  if (typeof c === "boolean") return c ? "true" : "false";
  return c.trim();
}

/** Unit for bare numbers in a duration column, read from the raw header ("Duration (hrs)" → hours). */
function unitFromHeader(header: string): "minutes" | "hours" | "days" {
  const h = header.toLowerCase().replace(/[^a-z]+/g, " ");
  if (/\b(hour|hours|hr|hrs)\b/.test(h)) return "hours";
  if (/\b(day|days)\b/.test(h)) return "days";
  return "minutes";
}

export interface TabularOptions extends ParseOptions {
  sheetName?: string;
}

/** Parse already-tokenized rows (from CSV text or a spreadsheet) into a ParsedPlan. */
export function parseTabular(rows: Cell[][], opts: TabularOptions = {}): ParsedPlan {
  const issues: ParseIssue[] = [];
  const tasks: CandidateTask[] = [];
  const dependencies: CandidateDependency[] = [];
  const mapping = detectColumns(rows, opts.columns);
  const f = mapping.fields;
  const meta: ParsedPlan["meta"] = {
    parserVersion: CSV_PARSER_VERSION,
    rowCount: 0,
    columnMapping: Object.fromEntries(Object.entries(f).map(([k, i]) => [k, mapping.headers[i as number] ?? ""])),
    unmappedColumns: mapping.unmapped.map((i) => mapping.headers[i]!),
    ...(opts.sheetName !== undefined ? { sheetName: opts.sheetName } : {}),
  };
  const plan: ParsedPlan = { format: "csv", tasks, dependencies, issues, meta };

  if (f.ref === undefined && f.name === undefined) {
    issues.push({ severity: "error", code: "no_header", message: "Could not find a header row with a task ID or task name column." });
    return plan;
  }
  if (f.ref === undefined) issues.push({ severity: "warning", code: "no_ref_column", message: `No task ID column found; using "${mapping.headers[f.name!]}" as the ID.` });
  if (f.predecessors === undefined && f.successors === undefined) {
    issues.push({ severity: "warning", code: "no_dependency_column", message: "No predecessor/successor column found; only tasks will be imported." });
  }

  const dateOpts = { ...(opts.timezone !== undefined ? { timezone: opts.timezone } : {}), ...(opts.dateOrder !== undefined ? { dateOrder: opts.dateOrder } : {}) };
  const durOpts = { hoursPerDay: opts.hoursPerDay ?? 24, bareUnit: f.duration !== undefined ? unitFromHeader(mapping.headers[f.duration]!) : ("minutes" as const) };
  const get = (row: Cell[], field: CsvField): Cell => (f[field] === undefined ? undefined : row[f[field]!]);
  const str = (row: Cell[], field: CsvField): string => cellToString(get(row, field));
  const col = (field: CsvField): { column?: string } => (f[field] !== undefined ? { column: mapping.headers[f[field]!]! } : {});
  const dateInput = (c: Cell): string | number | Date | undefined => (c === null || c === undefined || typeof c === "boolean" ? undefined : c);

  // Pass 1: tasks and refs.
  const rowRecords: { line: number; row: Cell[]; ref: string }[] = [];
  const seen = new Map<string, number>();
  for (let r = mapping.headerRow + 1; r < rows.length; r++) {
    const row = rows[r]!;
    if (row.every((c) => cellToString(c) === "")) continue;
    const line = r + 1;
    meta.rowCount!++;
    const ref = (f.ref !== undefined ? str(row, "ref") : str(row, "name")).trim();
    if (ref === "") {
      issues.push({ severity: "error", code: "missing_ref", message: "Row has no task ID; skipped.", line });
      continue;
    }
    const dup = seen.get(ref);
    if (dup !== undefined) {
      issues.push({ severity: "error", code: "duplicate_ref", message: `Task ID "${ref}" already appeared on row ${dup}; this row is skipped.`, line, ref });
      continue;
    }
    seen.set(ref, line);
    let name = str(row, "name");
    if (name === "") {
      name = ref;
      issues.push({ severity: "warning", code: "missing_name", message: `Task "${ref}" has no name; using its ID.`, line, ref });
    }
    const t: CandidateTask = { ref, name, sourceLine: line, evidence: row.map(cellToString).filter((s) => s !== "").join(" | ").slice(0, 300) };
    const desc = str(row, "description");
    if (desc) t.description = desc;
    const ws = str(row, "workstream") || opts.defaultWorkstream;
    if (ws) t.workstreamName = ws;
    const owner = str(row, "owner");
    if (owner) t.ownerName = owner;

    const startRaw = get(row, "start");
    const start = cellToString(startRaw) === "" ? undefined : parseDateTime(dateInput(startRaw), dateOpts);
    if (startRaw !== undefined && cellToString(startRaw) !== "" && start === undefined) issues.push({ severity: "warning", code: "bad_start", message: `Could not parse start "${cellToString(startRaw)}".`, line, ref, ...col("start") });
    if (start !== undefined) t.plannedStart = start;

    const finishRaw = get(row, "finish");
    const finish = cellToString(finishRaw) === "" ? undefined : parseDateTime(dateInput(finishRaw), dateOpts);
    if (finishRaw !== undefined && cellToString(finishRaw) !== "" && finish === undefined) issues.push({ severity: "warning", code: "bad_finish", message: `Could not parse finish "${cellToString(finishRaw)}".`, line, ref, ...col("finish") });

    const durRaw = get(row, "duration");
    let dur = durRaw instanceof Date ? undefined : durRaw === undefined || cellToString(durRaw) === "" ? undefined : parseDurationMinutes(durRaw as string | number, durOpts);
    if (durRaw !== undefined && cellToString(durRaw) !== "" && dur === undefined) issues.push({ severity: "warning", code: "bad_duration", message: `Could not parse duration "${cellToString(durRaw)}".`, line, ref, ...col("duration") });
    if (dur === undefined && start !== undefined && finish !== undefined) {
      dur = Math.round((finish - start) / MINUTE_MS);
      if (dur < 0) {
        issues.push({ severity: "warning", code: "finish_before_start", message: "Finish is before start; duration ignored.", line, ref });
        dur = undefined;
      }
    }
    if (dur !== undefined) t.plannedDurationMinutes = dur;
    else issues.push({ severity: "warning", code: "missing_duration", message: `Task "${ref}" has no duration; it will be treated as a 0-minute milestone until edited.`, line, ref });

    const dlRaw = get(row, "deadline");
    const dl = cellToString(dlRaw) === "" ? undefined : parseDateTime(dateInput(dlRaw), dateOpts);
    if (dlRaw !== undefined && cellToString(dlRaw) !== "" && dl === undefined) issues.push({ severity: "warning", code: "bad_deadline", message: `Could not parse deadline "${cellToString(dlRaw)}".`, line, ref, ...col("deadline") });
    if (dl !== undefined) t.windowDeadline = dl;

    const custom: Record<string, string> = {};
    for (const i of mapping.unmapped) {
      const v = cellToString(row[i]);
      if (v !== "") custom[headerToKey(mapping.headers[i]!)] = v;
    }
    if (Object.keys(custom).length > 0) t.customFields = custom;

    tasks.push(t);
    rowRecords.push({ line, row, ref });
  }

  // Pass 2: dependencies (refs are known now, so "T-14FS" style suffixes can be disambiguated).
  const known = new Set(tasks.map((t) => t.ref));
  let sawGanttSyntax = false;
  const edgeSeen = new Set<string>();
  const addDep = (pred: string, succ: string, tok: { type: CandidateDependency["type"]; lagMinutes: number; raw: string }, line: number) => {
    if (pred === succ) {
      issues.push({ severity: "error", code: "self_dependency", message: `Task "${succ}" depends on itself; ignored.`, line, ref: succ });
      return;
    }
    const key = `${pred} ${succ}`;
    if (edgeSeen.has(key)) {
      issues.push({ severity: "warning", code: "duplicate_dependency", message: `Dependency ${pred} → ${succ} listed more than once; kept the first.`, line, ref: succ });
      return;
    }
    edgeSeen.add(key);
    if (tok.type !== "FS" || tok.lagMinutes !== 0) sawGanttSyntax = true;
    dependencies.push({ predecessorRef: pred, successorRef: succ, type: tok.type, lagMinutes: tok.lagMinutes, evidence: tok.raw, sourceLine: line });
    if (!known.has(pred) || !known.has(succ)) {
      const missing = !known.has(pred) ? pred : succ;
      issues.push({ severity: "info", code: "unresolved_ref", message: `Dependency ${pred} → ${succ} references "${missing}", which is not in this sheet. It will be resolved against other worksheets and the existing runbook.`, line, ref: missing });
    }
  };
  for (const { line, row, ref } of rowRecords) {
    const predCell = str(row, "predecessors");
    if (predCell) {
      const { tokens, bad } = parsePredecessorCell(predCell, known, { hoursPerDay: opts.hoursPerDay ?? 24 });
      for (const b of bad) issues.push({ severity: "error", code: "bad_predecessor", message: `Could not parse predecessor "${b}" for task "${ref}".`, line, ref });
      for (const tok of tokens) addDep(tok.ref, ref, tok, line);
    }
    const succCell = str(row, "successors");
    if (succCell) {
      const { tokens, bad } = parsePredecessorCell(succCell, known, { hoursPerDay: opts.hoursPerDay ?? 24 });
      for (const b of bad) issues.push({ severity: "error", code: "bad_successor", message: `Could not parse successor "${b}" for task "${ref}".`, line, ref });
      for (const tok of tokens) addDep(ref, tok.ref, tok, line);
    }
  }
  if (sawGanttSyntax) plan.format = "gantt_csv";
  return plan;
}

/** Parse CSV/TSV text. Delimiter is auto-detected from the first line. */
export function parseCsvText(text: string, opts: TabularOptions = {}): ParsedPlan {
  return parseTabular(parseCsv(text), opts);
}
