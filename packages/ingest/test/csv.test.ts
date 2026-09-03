import { describe, expect, it } from "vitest";
import { parseCsvText, parseTabular } from "../src/index.js";

const T = (y: number, mo: number, d: number, h = 0, mi = 0) => Date.UTC(y, mo - 1, d, h, mi);

const ACCOUNTS_SHEET = `Task ID,Task Name,Workstream,Owner,Planned Start (UTC),Duration (hrs),Depends On,Deadline,Recon Query
ACC-1,Extract account master,Accounts,Priya,2026-10-17 00:30,1.5,FRZ-2,,SELECT * FROM acct
ACC-2,Load accounts to target,Accounts,Priya,,2,ACC-1,,
ACC-3,Reconcile account counts,Accounts,Recon Team,,0:45,"ACC-2, ACC-1FS+15m",2026-10-17 06:00,
ACC-4,Sign-off accounts,Accounts,Jordan,,0,ACC-3 SS+30m,,
`;

describe("parseCsvText on a realistic worksheet", () => {
  const plan = parseCsvText(ACCOUNTS_SHEET);

  it("maps headers by synonym and keeps unmapped columns as custom fields", () => {
    expect(plan.meta.columnMapping).toEqual({
      ref: "Task ID",
      predecessors: "Depends On",
      name: "Task Name",
      duration: "Duration (hrs)",
      start: "Planned Start (UTC)",
      deadline: "Deadline",
      owner: "Owner",
      workstream: "Workstream",
    });
    expect(plan.meta.unmappedColumns).toEqual(["Recon Query"]);
    expect(plan.tasks[0]!.customFields).toEqual({ recon_query: "SELECT * FROM acct" });
    expect(plan.tasks[1]!.customFields).toBeUndefined();
  });

  it("parses tasks with durations in the header's unit, dates, deadlines and owners", () => {
    expect(plan.tasks.map((t) => t.ref)).toEqual(["ACC-1", "ACC-2", "ACC-3", "ACC-4"]);
    expect(plan.tasks[0]).toMatchObject({ name: "Extract account master", workstreamName: "Accounts", ownerName: "Priya", plannedStart: T(2026, 10, 17, 0, 30), plannedDurationMinutes: 90, sourceLine: 2 });
    expect(plan.tasks[1]!.plannedDurationMinutes).toBe(120);
    expect(plan.tasks[2]).toMatchObject({ plannedDurationMinutes: 45, windowDeadline: T(2026, 10, 17, 6) });
    expect(plan.tasks[3]!.plannedDurationMinutes).toBe(0);
    expect(plan.meta.rowCount).toBe(4);
  });

  it("parses predecessor cells including type/lag suffixes and flags cross-sheet refs", () => {
    expect(plan.dependencies.map(({ predecessorRef, successorRef, type, lagMinutes }) => ({ predecessorRef, successorRef, type, lagMinutes }))).toEqual([
      { predecessorRef: "FRZ-2", successorRef: "ACC-1", type: "FS", lagMinutes: 0 },
      { predecessorRef: "ACC-1", successorRef: "ACC-2", type: "FS", lagMinutes: 0 },
      { predecessorRef: "ACC-2", successorRef: "ACC-3", type: "FS", lagMinutes: 0 },
      { predecessorRef: "ACC-1", successorRef: "ACC-3", type: "FS", lagMinutes: 15 },
      { predecessorRef: "ACC-3", successorRef: "ACC-4", type: "SS", lagMinutes: 30 },
    ]);
    expect(plan.format).toBe("gantt_csv");
    const unresolved = plan.issues.filter((i) => i.code === "unresolved_ref");
    expect(unresolved).toHaveLength(1);
    expect(unresolved[0]).toMatchObject({ severity: "info", ref: "FRZ-2", line: 2 });
    expect(plan.issues.filter((i) => i.severity === "error")).toEqual([]);
  });
});

describe("parseTabular edge cases", () => {
  it("finds the header row below title rows and tolerates blank rows", () => {
    const rows = [["Balances workstream — cutover plan"], [], ["ID", "Task", "Predecessors", "Duration"], ["BAL-1", "Extract balances", "", "30"], [], ["BAL-2", "Load balances", "BAL-1", "60"]];
    const plan = parseTabular(rows);
    expect(plan.tasks.map((t) => t.ref)).toEqual(["BAL-1", "BAL-2"]);
    expect(plan.tasks[0]!.sourceLine).toBe(4);
    expect(plan.dependencies).toHaveLength(1);
    expect(plan.format).toBe("csv");
  });

  it("reports missing refs, duplicate refs, bad values and self-dependencies as issues", () => {
    const plan = parseCsvText(`id,name,depends on,duration,start
,No id,,10,
A,First,,10,
A,Dup,,10,
B,Second,B,lots,yesterday
C,Third,"A, ???+x",5,
`);
    const codes = plan.issues.map((i) => [i.code, i.line]);
    expect(codes).toEqual(
      expect.arrayContaining([
        ["missing_ref", 2],
        ["duplicate_ref", 4],
        ["bad_duration", 5],
        ["bad_start", 5],
        ["self_dependency", 5],
        ["bad_predecessor", 6],
      ]),
    );
    expect(plan.tasks.map((t) => t.ref)).toEqual(["A", "B", "C"]);
    expect(plan.dependencies).toEqual([expect.objectContaining({ predecessorRef: "A", successorRef: "C" })]);
  });

  it("derives duration from start and finish when no duration column exists", () => {
    const plan = parseCsvText(`ref,name,start,finish\nX,Thing,2026-10-17 01:00,2026-10-17 03:30\n`);
    expect(plan.tasks[0]!.plannedDurationMinutes).toBe(150);
    expect(plan.issues.find((i) => i.code === "no_dependency_column")).toBeDefined();
  });

  it("supports a successors column and explicit column overrides", () => {
    const plan = parseCsvText(`Step,What,Then,Mins\n1,Freeze,"2, 3",30\n2,Extract,,60\n3,Notify,,5\n`, { columns: { ref: "Step", name: "What", successors: "Then", duration: "Mins" } });
    expect(plan.dependencies.map((d) => `${d.predecessorRef}>${d.successorRef}`)).toEqual(["1>2", "1>3"]);
    expect(plan.tasks[1]!.plannedDurationMinutes).toBe(60);
  });

  it("uses the name as the ref when no id column exists, and applies the default workstream", () => {
    const plan = parseCsvText(`Task,Duration\nFreeze source,30\nExtract,60\n`, { defaultWorkstream: "Core" });
    expect(plan.issues.find((i) => i.code === "no_ref_column")).toBeDefined();
    expect(plan.tasks.map((t) => [t.ref, t.workstreamName])).toEqual([
      ["Freeze source", "Core"],
      ["Extract", "Core"],
    ]);
  });

  it("applies the timezone to naive dates", () => {
    const plan = parseCsvText(`id,name,start,duration\nA,x,10/17/2026 2:00 AM,10\n`, { timezone: "America/Chicago" });
    expect(plan.tasks[0]!.plannedStart).toBe(T(2026, 10, 17, 7));
  });

  it("errors when no usable header exists", () => {
    const plan = parseCsvText(`foo,bar\n1,2\n`);
    expect(plan.issues[0]!.code).toBe("no_header");
    expect(plan.tasks).toEqual([]);
  });
});
