import { describe, expect, it } from "vitest";
import ExcelJS from "exceljs";
import { parseWorkbook } from "../src/index.js";

async function workbook(): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  const acc = wb.addWorksheet("Accounts");
  acc.addRow(["ID", "Task", "Owner", "Start", "Duration (min)", "Depends On"]);
  acc.addRow(["ACC-1", "Extract accounts", "Priya", new Date(Date.UTC(2026, 9, 17, 0, 30)), 90, "FRZ-2"]);
  acc.addRow(["ACC-2", { richText: [{ text: "Load " }, { text: "accounts" }] }, "Priya", null, 120, "ACC-1"]);
  acc.addRow(["ACC-3", "Reconcile", "Recon", null, { formula: "B2*1", result: 45 }, "ACC-2, BAL-2"]);
  const bal = wb.addWorksheet("Balances");
  bal.addRow(["ID", "Task", "Duration (min)", "Depends On"]);
  bal.addRow(["BAL-1", "Extract balances", 30, "ACC-1"]);
  bal.addRow(["BAL-2", "Load balances", 60, "BAL-1"]);
  wb.addWorksheet("Notes").addRow(["Just some notes"]);
  const hidden = wb.addWorksheet("Scratch");
  hidden.state = "hidden";
  hidden.addRow(["ID", "Task"]);
  hidden.addRow(["X", "ignore me"]);
  return Buffer.from(await wb.xlsx.writeBuffer());
}

describe("parseWorkbook", () => {
  it("parses each visible sheet, using the sheet name as the default workstream", async () => {
    const sheets = await parseWorkbook(await workbook());
    expect(sheets.map((s) => s.name)).toEqual(["Accounts", "Balances", "Notes"]);
    const acc = sheets[0]!.plan;
    expect(acc.tasks.map((t) => [t.ref, t.name, t.workstreamName, t.plannedDurationMinutes])).toEqual([
      ["ACC-1", "Extract accounts", "Accounts", 90],
      ["ACC-2", "Load accounts", "Accounts", 120],
      ["ACC-3", "Reconcile", "Accounts", 45],
    ]);
    expect(acc.tasks[0]!.plannedStart).toBe(Date.UTC(2026, 9, 17, 0, 30));
    expect(acc.dependencies.map((d) => `${d.predecessorRef}>${d.successorRef}`)).toEqual(["FRZ-2>ACC-1", "ACC-1>ACC-2", "ACC-2>ACC-3", "BAL-2>ACC-3"]);
    const bal = sheets[1]!.plan;
    expect(bal.tasks.every((t) => t.workstreamName === "Balances")).toBe(true);
    expect(sheets[2]!.plan.issues[0]!.code).toBe("no_header");
  });

  it("restricts to named sheets and can keep the workstream column authoritative", async () => {
    const sheets = await parseWorkbook(await workbook(), { sheets: ["Balances"], sheetNameAsWorkstream: false });
    expect(sheets).toHaveLength(1);
    expect(sheets[0]!.plan.tasks[0]!.workstreamName).toBeUndefined();
  });
});
