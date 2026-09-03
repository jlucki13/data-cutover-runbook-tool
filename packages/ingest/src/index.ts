/**
 * @cutover/ingest — dependency ingestion.
 *
 * Deterministic parsers (CSV/TSV, Excel workbooks, MS Project XML), an LLM prose parser
 * behind an injectable client, and the worksheet compile step that merges per-workstream
 * sheets, resolves refs, diffs against the committed graph and dry-runs the engine.
 */
export * from "./types.js";
export { parseCsv, detectDelimiter, normalizeHeader, headerToKey, parseDurationMinutes, parsePredecessorCell, parseDateTime, zonedToUtc, excelSerialToUtc, looseRef } from "./text.js";
export { parseCsvText, parseTabular, detectColumns, cellToString, CSV_PARSER_VERSION, type Cell, type ColumnMapping, type TabularOptions } from "./parsers/csv.js";
export { parseWorkbook, sheetToRows, type WorkbookSheet, type WorkbookOptions } from "./parsers/spreadsheet.js";
export { parseMsProjectXml, MSPROJECT_PARSER_VERSION, type MsProjectOptions } from "./parsers/msproject.js";
export {
  parseProse,
  createAnthropicLlmClient,
  buildUserPrompt,
  EXTRACTION_SCHEMA,
  EXTRACTION_SYSTEM_PROMPT,
  PROSE_PARSER_VERSION,
  DEFAULT_PROSE_MODEL,
  type LlmClient,
  type LlmExtractionRequest,
  type LlmExtractionResult,
  type ProseOptions,
} from "./parsers/prose.js";
export { compileWorksheets, type CompileOptions, type CompileResult, type CurrentRunbook, type ResolvedDependency } from "./compile.js";
