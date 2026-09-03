/**
 * Ingestion contract. Every parser (CSV/spreadsheet, MS Project XML, LLM prose)
 * produces the same `ParsedPlan`, which the compile step merges, resolves and diffs
 * against the committed graph. Nothing here touches the database.
 *
 * Instants are epoch ms (UTC); durations and lags are integer minutes, as in the engine.
 */
import type { DependencyType } from "@cutover/engine";

export type SourceFormat = "csv" | "gantt_csv" | "ms_project_xml" | "prose_llm" | "manual";

export interface CandidateTask {
  /** Human ID from the source (merge key). Trimmed, never empty. */
  ref: string;
  name: string;
  description?: string;
  workstreamName?: string;
  ownerName?: string;
  plannedStart?: number;
  plannedDurationMinutes?: number;
  windowDeadline?: number;
  /** Values for admin-defined columns, keyed by normalized header. */
  customFields?: Record<string, string>;
  /** Source row / sentence that produced this candidate. */
  evidence?: string;
  /** 1-based source line/row (or sentence index for prose). */
  sourceLine?: number;
}

export interface CandidateDependency {
  predecessorRef: string;
  successorRef: string;
  type: DependencyType;
  lagMinutes: number;
  /** 0..1 for LLM output; undefined for deterministic parsers. */
  confidence?: number;
  evidence?: string;
  sourceLine?: number;
}

export type IssueSeverity = "error" | "warning" | "info";

export interface ParseIssue {
  severity: IssueSeverity;
  code: string;
  message: string;
  line?: number;
  column?: string;
  ref?: string;
}

export interface ParsedPlan {
  format: SourceFormat;
  tasks: CandidateTask[];
  dependencies: CandidateDependency[];
  issues: ParseIssue[];
  meta: {
    parserVersion: string;
    rowCount?: number;
    columnMapping?: Record<string, string>;
    unmappedColumns?: string[];
    sheetName?: string;
    model?: string;
  };
}

export interface ParseOptions {
  /** IANA zone applied to date-times that carry no offset. Default "UTC". */
  timezone?: string;
  /** Order for ambiguous numeric dates like 03/04/2026. Default "MDY". */
  dateOrder?: "MDY" | "DMY";
  /** Hours in a "day" when a duration/lag is given in days. Cutovers run 24×7, so default 24. */
  hoursPerDay?: number;
  /** Explicit header → field mapping, overriding auto-detection. */
  columns?: Partial<Record<CsvField, string>>;
  /** Workstream to assign to tasks that carry none (e.g. the worksheet's tab name). */
  defaultWorkstream?: string;
}

export type CsvField =
  | "ref"
  | "name"
  | "description"
  | "predecessors"
  | "successors"
  | "workstream"
  | "owner"
  | "start"
  | "finish"
  | "duration"
  | "deadline";
