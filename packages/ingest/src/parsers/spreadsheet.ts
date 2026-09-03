/**
 * Excel workbook parser. Each worksheet becomes its own ParsedPlan (runbook owners send
 * one worksheet per workstream); the sheet name is the default workstream when the sheet
 * has no workstream column.
 */
import ExcelJS from "exceljs";
import type { ParsedPlan, ParseOptions } from "../types.js";
import { parseTabular, type Cell } from "./csv.js";

export interface WorkbookSheet {
  name: string;
  plan: ParsedPlan;
}

export interface WorkbookOptions extends ParseOptions {
  /** Only parse these sheets (by name). Default: every non-empty sheet. */
  sheets?: string[];
  /** Use the sheet name as the workstream for tasks without one. Default true when the workbook has several sheets. */
  sheetNameAsWorkstream?: boolean;
}

function cellValue(v: ExcelJS.CellValue): Cell {
  if (v === null || v === undefined) return undefined;
  if (v instanceof Date) return v;
  if (typeof v === "string" || typeof v === "number" || typeof v === "boolean") return v;
  if (typeof v === "object") {
    if ("richText" in v) return v.richText.map((r) => r.text).join("");
    if ("result" in v) return cellValue(v.result as ExcelJS.CellValue);
    if ("text" in v) return typeof v.text === "string" ? v.text : String(v.text ?? "");
    if ("error" in v) return undefined;
  }
  return String(v);
}

export function sheetToRows(ws: ExcelJS.Worksheet): Cell[][] {
  const rows: Cell[][] = [];
  ws.eachRow({ includeEmpty: true }, (row, rowNumber) => {
    const cells: Cell[] = [];
    const values = row.values as ExcelJS.CellValue[]; // 1-based
    for (let c = 1; c < values.length; c++) cells.push(cellValue(values[c]));
    rows[rowNumber - 1] = cells;
  });
  for (let i = 0; i < rows.length; i++) if (rows[i] === undefined) rows[i] = [];
  return rows;
}

export async function parseWorkbook(data: Buffer | ArrayBuffer | Uint8Array, opts: WorkbookOptions = {}): Promise<WorkbookSheet[]> {
  const wb = new ExcelJS.Workbook();
  const buf = data instanceof ArrayBuffer ? data : data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength);
  await wb.xlsx.load(buf as ArrayBuffer);
  const candidates = wb.worksheets.filter((ws) => (opts.sheets ? opts.sheets.includes(ws.name) : ws.state !== "hidden" && ws.state !== "veryHidden"));
  const multi = candidates.length > 1;
  const out: WorkbookSheet[] = [];
  for (const ws of candidates) {
    const rows = sheetToRows(ws);
    if (rows.every((r) => r.every((c) => c === undefined || c === ""))) continue;
    const { sheets: _s, sheetNameAsWorkstream, ...parseOpts } = opts;
    const useSheetName = sheetNameAsWorkstream ?? multi;
    const plan = parseTabular(rows, {
      ...parseOpts,
      sheetName: ws.name,
      ...(useSheetName && parseOpts.defaultWorkstream === undefined ? { defaultWorkstream: ws.name } : {}),
    });
    out.push({ name: ws.name, plan });
  }
  return out;
}

export function listSheetNames(wb: ExcelJS.Workbook): string[] {
  return wb.worksheets.map((w) => w.name);
}
