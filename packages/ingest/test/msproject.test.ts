import { describe, expect, it } from "vitest";
import { parseMsProjectXml } from "../src/index.js";

const T = (y: number, mo: number, d: number, h = 0, mi = 0) => Date.UTC(y, mo - 1, d, h, mi);

const XML = `<?xml version="1.0" encoding="UTF-8"?>
<Project xmlns="http://schemas.microsoft.com/project">
  <Name>TRBK cutover</Name>
  <StartDate>2026-10-16T22:00:00</StartDate>
  <MinutesPerDay>1440</MinutesPerDay>
  <Tasks>
    <Task><UID>0</UID><ID>0</ID><Name>TRBK cutover</Name><OutlineLevel>0</OutlineLevel><Summary>1</Summary></Task>
    <Task><UID>1</UID><ID>1</ID><Name>Core</Name><WBS>1</WBS><OutlineLevel>1</OutlineLevel><Summary>1</Summary><Duration>PT4H0M0S</Duration><Start>2026-10-16T22:00:00</Start></Task>
    <Task><UID>2</UID><ID>2</ID><Name>Declare freeze</Name><WBS>1.1</WBS><OutlineLevel>2</OutlineLevel><Summary>0</Summary><Milestone>0</Milestone>
      <Duration>PT0H30M0S</Duration><Start>2026-10-16T22:00:00</Start><Finish>2026-10-16T22:30:00</Finish><ConstraintType>0</ConstraintType><Notes>Comms go out first.</Notes></Task>
    <Task><UID>3</UID><ID>3</ID><Name>Final extract</Name><WBS>1.2</WBS><OutlineLevel>2</OutlineLevel><Summary>0</Summary>
      <Duration>PT2H0M0S</Duration><Start>2026-10-16T22:30:00</Start><Finish>2026-10-17T00:30:00</Finish>
      <PredecessorLink><PredecessorUID>2</PredecessorUID><Type>1</Type><LinkLag>0</LinkLag><LagFormat>7</LagFormat></PredecessorLink></Task>
    <Task><UID>4</UID><ID>4</ID><Name>Accounts</Name><WBS>2</WBS><OutlineLevel>1</OutlineLevel><Summary>1</Summary></Task>
    <Task><UID>5</UID><ID>5</ID><Name>Migrate accounts</Name><WBS>2.1</WBS><OutlineLevel>2</OutlineLevel><Summary>0</Summary>
      <Duration>PT3H0M0S</Duration><Start>2026-10-17T00:30:00</Start><Deadline>2026-10-17T06:00:00</Deadline>
      <PredecessorLink><PredecessorUID>3</PredecessorUID><Type>1</Type><LinkLag>300</LinkLag><LagFormat>7</LagFormat></PredecessorLink></Task>
    <Task><UID>6</UID><ID>6</ID><Name>Reconcile accounts</Name><WBS>2.2</WBS><OutlineLevel>2</OutlineLevel><Summary>0</Summary>
      <Duration>PT1H0M0S</Duration><Start>2026-10-17T03:30:00</Start>
      <PredecessorLink><PredecessorUID>5</PredecessorUID><Type>3</Type><LinkLag>600</LinkLag><LagFormat>7</LagFormat></PredecessorLink>
      <PredecessorLink><PredecessorUID>4</PredecessorUID><Type>1</Type><LinkLag>0</LinkLag></PredecessorLink></Task>
    <Task><UID>7</UID><ID>7</ID><Name>Batch window opens</Name><WBS>2.3</WBS><OutlineLevel>2</OutlineLevel><Summary>0</Summary><Milestone>1</Milestone>
      <Duration>PT0H0M0S</Duration><Start>2026-10-17T02:00:00</Start><ConstraintType>4</ConstraintType><ConstraintDate>2026-10-17T02:00:00</ConstraintDate></Task>
    <Task><UID>8</UID><ID>8</ID><Name>Late starter</Name><WBS>2.4</WBS><OutlineLevel>2</OutlineLevel><Summary>0</Summary>
      <Duration>PT1H0M0S</Duration><Start>2026-10-17T05:00:00</Start><ConstraintType>7</ConstraintType><ConstraintDate>2026-10-17T08:00:00</ConstraintDate></Task>
    <Task><UID>9</UID><ID>9</ID><Name>Inactive thing</Name><WBS>2.5</WBS><OutlineLevel>2</OutlineLevel><Summary>0</Summary><Active>0</Active><Duration>PT1H0M0S</Duration></Task>
  </Tasks>
  <Resources>
    <Resource><UID>1</UID><Name>Priya</Name></Resource>
    <Resource><UID>2</UID><Name>Sam</Name></Resource>
  </Resources>
  <Assignments>
    <Assignment><UID>1</UID><TaskUID>5</TaskUID><ResourceUID>1</ResourceUID></Assignment>
    <Assignment><UID>2</UID><TaskUID>5</TaskUID><ResourceUID>2</ResourceUID></Assignment>
    <Assignment><UID>3</UID><TaskUID>2</TaskUID><ResourceUID>2</ResourceUID></Assignment>
  </Assignments>
</Project>`;

describe("parseMsProjectXml", () => {
  const plan = parseMsProjectXml(XML);

  it("imports leaf tasks with WBS refs, workstreams from top-level summaries, owners, notes and durations", () => {
    expect(plan.meta.columnMapping).toEqual({ ref: "WBS" });
    expect(plan.tasks.map((t) => [t.ref, t.name, t.workstreamName, t.plannedDurationMinutes, t.ownerName])).toEqual([
      ["1.1", "Declare freeze", "Core", 30, "Sam"],
      ["1.2", "Final extract", "Core", 120, undefined],
      ["2.1", "Migrate accounts", "Accounts", 180, "Priya, Sam"],
      ["2.2", "Reconcile accounts", "Accounts", 60, undefined],
      ["2.3", "Batch window opens", "Accounts", 0, undefined],
      ["2.4", "Late starter", "Accounts", 60, undefined],
    ]);
    expect(plan.tasks[0]!.description).toBe("Comms go out first.");
  });

  it("maps link types and lag (tenths of minutes), skips summary links with a warning", () => {
    expect(plan.dependencies.map(({ predecessorRef, successorRef, type, lagMinutes }) => ({ predecessorRef, successorRef, type, lagMinutes }))).toEqual([
      { predecessorRef: "1.1", successorRef: "1.2", type: "FS", lagMinutes: 0 },
      { predecessorRef: "1.2", successorRef: "2.1", type: "FS", lagMinutes: 30 },
      { predecessorRef: "2.1", successorRef: "2.2", type: "SS", lagMinutes: 60 },
    ]);
    expect(plan.issues.find((i) => i.code === "summary_predecessor")).toMatchObject({ ref: "2.2" });
  });

  it("derives planned starts from constraints or from an unlinked later start, and deadlines", () => {
    const byRef = Object.fromEntries(plan.tasks.map((t) => [t.ref, t]));
    expect(byRef["1.1"]!.plannedStart).toBeUndefined(); // starts at project start, no constraint
    expect(byRef["1.2"]!.plannedStart).toBeUndefined(); // driven by predecessor
    expect(byRef["2.3"]!.plannedStart).toBe(T(2026, 10, 17, 2)); // SNET constraint
    expect(byRef["2.4"]!.plannedStart).toBe(T(2026, 10, 17, 5)); // no preds, later than project start
    expect(byRef["2.4"]!.windowDeadline).toBe(T(2026, 10, 17, 8)); // FNLT
    expect(byRef["2.1"]!.windowDeadline).toBe(T(2026, 10, 17, 6)); // Deadline element
  });

  it("skips inactive tasks and applies the timezone to naive timestamps", () => {
    expect(plan.tasks.find((t) => t.name === "Inactive thing")).toBeUndefined();
    expect(plan.issues.find((i) => i.code === "inactive_task")).toBeDefined();
    const ny = parseMsProjectXml(XML, { timezone: "America/New_York" });
    expect(ny.tasks.find((t) => t.ref === "2.3")!.plannedStart).toBe(T(2026, 10, 17, 6));
  });

  it("can use IDs instead of WBS and reports non-project XML", () => {
    const byId = parseMsProjectXml(XML, { refField: "id" });
    expect(byId.tasks.map((t) => t.ref)).toEqual(["2", "3", "5", "6", "7", "8"]);
    expect(parseMsProjectXml("<foo/>").issues[0]!.code).toBe("not_msproject");
    expect(parseMsProjectXml("<Project><Tasks").issues[0]!.code).toMatch(/invalid_xml|not_msproject/);
  });
});
