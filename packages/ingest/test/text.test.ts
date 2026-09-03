import { describe, expect, it } from "vitest";
import { detectDelimiter, excelSerialToUtc, headerToKey, looseRef, normalizeHeader, parseCsv, parseDateTime, parseDurationMinutes, parsePredecessorCell } from "../src/index.js";

describe("parseCsv", () => {
  it("handles quotes, escaped quotes, embedded newlines and CRLF", () => {
    const rows = parseCsv('id,name\r\n1,"Freeze, source"\r\n2,"Say ""hi""\nthen go"\r\n');
    expect(rows).toEqual([
      ["id", "name"],
      ["1", "Freeze, source"],
      ["2", 'Say "hi"\nthen go'],
    ]);
  });
  it("auto-detects tab and semicolon delimiters and strips a BOM", () => {
    expect(detectDelimiter("a\tb\tc\n1\t2\t3")).toBe("\t");
    expect(detectDelimiter("a;b;c\n1;2;3")).toBe(";");
    expect(parseCsv("﻿a,b\n1,2")).toEqual([
      ["a", "b"],
      ["1", "2"],
    ]);
  });
});

describe("headers", () => {
  it("normalizes and keys headers", () => {
    expect(normalizeHeader("Planned Start (UTC)")).toBe("plannedstart");
    expect(normalizeHeader("Depends-On IDs")).toBe("dependsonids");
    expect(headerToKey("Recon Owner #2")).toBe("recon_owner_2");
    expect(headerToKey("2nd check")).toBe("c2nd_check");
  });
});

describe("parseDurationMinutes", () => {
  it.each([
    ["90", 90],
    ["90m", 90],
    ["1.5h", 90],
    ["2h 30m", 150],
    ["2h30m", 150],
    ["1d 4h", 28 * 60],
    ["01:30", 90],
    ["1:30:30", 91],
    ["PT1H30M", 90],
    ["P1DT2H", 26 * 60],
    ["45 mins", 45],
    ["3 hours", 180],
    ["", undefined],
    ["soon", undefined],
    ["2h and 3 bananas", undefined],
  ])("%s → %s", (input, expected) => {
    expect(parseDurationMinutes(input)).toBe(expected);
  });
  it("respects hoursPerDay and the bare unit", () => {
    expect(parseDurationMinutes("1d", { hoursPerDay: 8 })).toBe(480);
    expect(parseDurationMinutes("2", { bareUnit: "hours" })).toBe(120);
    expect(parseDurationMinutes(1.5, { bareUnit: "hours" })).toBe(90);
  });
});

describe("parsePredecessorCell", () => {
  const known = new Set(["T-9", "T-11", "T-14FS", "ACC-3"]);
  it("splits on commas/semicolons/newlines and parses type + lag suffixes", () => {
    const { tokens, bad } = parsePredecessorCell("T-9, T-11FS+2h; ACC-3 SS-30m\n14FF+1:30", known);
    expect(bad).toEqual([]);
    expect(tokens.map(({ ref, type, lagMinutes }) => ({ ref, type, lagMinutes }))).toEqual([
      { ref: "T-9", type: "FS", lagMinutes: 0 },
      { ref: "T-11", type: "FS", lagMinutes: 120 },
      { ref: "ACC-3", type: "SS", lagMinutes: -30 },
      { ref: "14", type: "FF", lagMinutes: 90 },
    ]);
  });
  it("prefers an exact known ref over the suffix grammar", () => {
    const { tokens } = parsePredecessorCell("T-14FS", known);
    expect(tokens[0]).toMatchObject({ ref: "T-14FS", type: "FS" });
  });
  it("bare numeric lag is minutes, and a hyphenated ref is not a negative lag", () => {
    expect(parsePredecessorCell("T-9+45", known).tokens[0]).toMatchObject({ lagMinutes: 45 });
    expect(parsePredecessorCell("ACC-1", new Set()).tokens[0]).toMatchObject({ ref: "ACC-1", type: "FS", lagMinutes: 0 });
    expect(parsePredecessorCell("ACC-1 -30", new Set()).tokens[0]).toMatchObject({ ref: "ACC-1", lagMinutes: -30 });
    expect(parsePredecessorCell("ACC-1-30m", new Set()).tokens[0]).toMatchObject({ ref: "ACC-1", lagMinutes: -30 });
    expect(parsePredecessorCell("ACC-1FS-30", new Set()).tokens[0]).toMatchObject({ ref: "ACC-1", type: "FS", lagMinutes: -30 });
  });
  it("reports unparseable tokens", () => {
    expect(parsePredecessorCell("T-9+abc", known).bad).toEqual(["T-9+abc"]);
  });
});

describe("parseDateTime", () => {
  const T = (y: number, mo: number, d: number, h = 0, mi = 0) => Date.UTC(y, mo - 1, d, h, mi);
  it("parses ISO with and without offsets", () => {
    expect(parseDateTime("2026-10-17T02:00:00Z")).toBe(T(2026, 10, 17, 2));
    expect(parseDateTime("2026-10-17T02:00:00-04:00")).toBe(T(2026, 10, 17, 6));
    expect(parseDateTime("2026-10-17 02:00")).toBe(T(2026, 10, 17, 2));
    expect(parseDateTime("2026-10-17")).toBe(T(2026, 10, 17));
  });
  it("interprets naive values in the given timezone (DST-aware)", () => {
    expect(parseDateTime("2026-10-17 02:00", { timezone: "America/New_York" })).toBe(T(2026, 10, 17, 6));
    expect(parseDateTime("2026-01-17 02:00", { timezone: "America/New_York" })).toBe(T(2026, 1, 17, 7));
    expect(parseDateTime("2026-10-17 02:00", { timezone: "Europe/London" })).toBe(T(2026, 10, 17, 1));
  });
  it("parses US and day-first numeric dates and 12-hour clocks", () => {
    expect(parseDateTime("10/17/2026 2:00 AM")).toBe(T(2026, 10, 17, 2));
    expect(parseDateTime("17/10/2026 14:30")).toBe(T(2026, 10, 17, 14, 30)); // 17 cannot be a month
    expect(parseDateTime("03/04/2026", { dateOrder: "DMY" })).toBe(T(2026, 4, 3));
    expect(parseDateTime("03/04/2026")).toBe(T(2026, 3, 4));
    expect(parseDateTime("10/17/26 12:15 pm")).toBe(T(2026, 10, 17, 12, 15));
  });
  it("parses month-name formats", () => {
    expect(parseDateTime("17 Oct 2026 02:00")).toBe(T(2026, 10, 17, 2));
    expect(parseDateTime("Oct 17, 2026 2:00 PM")).toBe(T(2026, 10, 17, 14));
    expect(parseDateTime("Sat 17 October 2026 02:00")).toBe(T(2026, 10, 17, 2));
  });
  it("handles Date objects, Excel serials and garbage", () => {
    expect(parseDateTime(new Date(T(2026, 10, 17, 2)))).toBe(T(2026, 10, 17, 2));
    expect(excelSerialToUtc(T(2026, 10, 17, 2) / 86_400_000 + 25569)).toBe(T(2026, 10, 17, 2));
    expect(parseDateTime("next Tuesday")).toBeUndefined();
    expect(parseDateTime("")).toBeUndefined();
  });
});

describe("looseRef", () => {
  it("ignores case, whitespace and zero padding", () => {
    expect(looseRef("T-014")).toBe(looseRef("t-14"));
    expect(looseRef("ACC 3")).toBe(looseRef("acc3"));
    expect(looseRef("T-10")).not.toBe(looseRef("T-1"));
  });
});
